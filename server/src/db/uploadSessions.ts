import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { pool } from './pool.js';

export type UploadStatus = 'active' | 'merging' | 'done' | 'error';

export interface UploadSessionRow extends RowDataPacket {
  id: number;
  upload_id: string;
  owner_id: number;
  filename: string;
  mime_type: string;
  total_size: number;
  total_chunks: number;
  chunk_size: number;
  status: UploadStatus;
  temp_dir: string;
  video_id: number | null;
  error_message: string | null;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface UploadChunkRow extends RowDataPacket {
  id: number;
  upload_session_id: number;
  chunk_index: number;
  size: number;
  hash: string;
  received_at: Date;
}

const EXPIRES_MS = 48 * 60 * 60 * 1000;

export async function findActiveSession(ownerId: number, filename: string, totalSize: number): Promise<UploadSessionRow | null> {
  const [rows] = await pool.query<UploadSessionRow[]>(
    `SELECT * FROM upload_sessions WHERE owner_id = ? AND filename = ? AND total_size = ? AND status = 'active' LIMIT 1`,
    [ownerId, filename, totalSize]
  );
  return rows[0] ?? null;
}

/** Owner scoping is baked into the WHERE clause -- it's the authorization boundary, not just app-level filtering, matching the old Mongoose query. */
export async function findSessionByUploadId(uploadId: string, ownerId: number): Promise<UploadSessionRow | null> {
  const [rows] = await pool.query<UploadSessionRow[]>(
    'SELECT * FROM upload_sessions WHERE upload_id = ? AND owner_id = ? LIMIT 1',
    [uploadId, ownerId]
  );
  return rows[0] ?? null;
}

export interface CreateSessionInput {
  uploadId: string;
  ownerId: number;
  filename: string;
  mimeType: string;
  totalSize: number;
  totalChunks: number;
  chunkSize: number;
  tempDir: string;
}

export async function createSession(input: CreateSessionInput): Promise<UploadSessionRow> {
  const expiresAt = new Date(Date.now() + EXPIRES_MS);
  await pool.query<ResultSetHeader>(
    `INSERT INTO upload_sessions (upload_id, owner_id, filename, mime_type, total_size, total_chunks, chunk_size, temp_dir, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.uploadId, input.ownerId, input.filename, input.mimeType, input.totalSize, input.totalChunks, input.chunkSize, input.tempDir, expiresAt]
  );
  const created = await findSessionByUploadId(input.uploadId, input.ownerId);
  if (!created) throw new Error('Failed to load upload session after insert');
  return created;
}

export async function getReceivedChunks(sessionId: number): Promise<UploadChunkRow[]> {
  const [rows] = await pool.query<UploadChunkRow[]>(
    'SELECT * FROM upload_chunks WHERE upload_session_id = ? ORDER BY chunk_index ASC',
    [sessionId]
  );
  return rows;
}

export async function countReceivedChunks(sessionId: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS n FROM upload_chunks WHERE upload_session_id = ?',
    [sessionId]
  );
  return Number(rows[0]!.n);
}

/** INSERT ... ON DUPLICATE KEY -- a re-uploaded chunk just no-ops instead of needing an app-level existence check + array scan. */
export async function recordChunk(sessionId: number, chunkIndex: number, size: number, hash: string): Promise<void> {
  await pool.query(
    `INSERT INTO upload_chunks (upload_session_id, chunk_index, size, hash)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE size = VALUES(size), hash = VALUES(hash)`,
    [sessionId, chunkIndex, size, hash]
  );
}

export async function setSessionStatus(sessionId: number, status: UploadStatus, errorMessage?: string): Promise<void> {
  await pool.query('UPDATE upload_sessions SET status = ?, error_message = ? WHERE id = ?', [status, errorMessage ?? null, sessionId]);
}

export async function setSessionVideoId(sessionId: number, videoId: number): Promise<void> {
  await pool.query(`UPDATE upload_sessions SET status = 'done', video_id = ? WHERE id = ?`, [videoId, sessionId]);
}

/** Replaces MongoDB's TTL index (auto-delete past `expiresAt`) -- called on an interval from index.ts. */
export async function deleteExpiredSessions(): Promise<number> {
  const [result] = await pool.query<ResultSetHeader>('DELETE FROM upload_sessions WHERE expires_at < NOW()');
  return result.affectedRows;
}

export async function deleteStaleSessions(): Promise<number> {
  const [result] = await pool.query<ResultSetHeader>(
    `DELETE FROM upload_sessions WHERE status IN ('done', 'error')`
  );
  return result.affectedRows;
}

export async function countActiveSessions(): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM upload_sessions WHERE status = 'active'`);
  return Number(rows[0]!.n);
}
