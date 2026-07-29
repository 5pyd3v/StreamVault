import crypto from 'crypto';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { pool } from './pool.js';

export type ChannelStatus = 'offline' | 'starting' | 'live' | 'error';

// Never includes stream_key -- callers that need the secret must use the
// explicit `WithKey` variants below (mirrors the Mongoose `select: false` field).
const PUBLIC_COLUMNS = `
  id, name, slug, description, category, poster_path, owner_id, rtmp_app, is_enabled,
  status, current_session_id, live_started_at, last_error, live_hls_path,
  record_enabled, viewer_count, created_at, updated_at
`;

export interface LiveChannelRow extends RowDataPacket {
  id: number;
  name: string;
  slug: string;
  description: string;
  category: string;
  poster_path: string;
  owner_id: number;
  rtmp_app: string;
  is_enabled: number;
  status: ChannelStatus;
  current_session_id: string | null;
  live_started_at: Date | null;
  last_error: string;
  live_hls_path: string;
  record_enabled: number;
  viewer_count: number;
  created_at: Date;
  updated_at: Date;
  stream_key?: string; // only present when fetched via a *WithKey function
}

/** Generate a fresh OBS stream key -- identical output shape to the old Mongoose helper. */
export function generateStreamKey(): string {
  return crypto.randomBytes(24).toString('hex');
}

export function slugify(input: string): string {
  const slug = String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '');
  return slug || 'channel';
}

export async function generateUniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  let candidate = base;
  for (let attempt = 0; attempt < 10; attempt++) {
    const [rows] = await pool.query<RowDataPacket[]>('SELECT 1 FROM live_channels WHERE slug = ? LIMIT 1', [candidate]);
    if (rows.length === 0) return candidate;
    candidate = `${base}-${crypto.randomBytes(2).toString('hex')}`;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export async function findChannelById(id: string | number): Promise<LiveChannelRow | null> {
  const [rows] = await pool.query<LiveChannelRow[]>(`SELECT ${PUBLIC_COLUMNS} FROM live_channels WHERE id = ? LIMIT 1`, [id]);
  return rows[0] ?? null;
}

export async function findChannelByIdWithKey(id: string | number): Promise<LiveChannelRow | null> {
  const [rows] = await pool.query<LiveChannelRow[]>(`SELECT ${PUBLIC_COLUMNS}, stream_key FROM live_channels WHERE id = ? LIMIT 1`, [id]);
  return rows[0] ?? null;
}

export async function findChannelBySlug(slug: string, enabledOnly = false): Promise<LiveChannelRow | null> {
  const sql = enabledOnly
    ? `SELECT ${PUBLIC_COLUMNS} FROM live_channels WHERE slug = ? AND is_enabled = 1 LIMIT 1`
    : `SELECT ${PUBLIC_COLUMNS} FROM live_channels WHERE slug = ? LIMIT 1`;
  const [rows] = await pool.query<LiveChannelRow[]>(sql, [slug]);
  return rows[0] ?? null;
}

/** Looked up on every RTMP publish/play event -- needs the secret key to authenticate the stream. */
export async function findChannelByStreamKey(streamKey: string): Promise<LiveChannelRow | null> {
  const [rows] = await pool.query<LiveChannelRow[]>(
    `SELECT ${PUBLIC_COLUMNS}, stream_key FROM live_channels WHERE stream_key = ? LIMIT 1`,
    [streamKey]
  );
  return rows[0] ?? null;
}

export async function listEnabledChannels(): Promise<LiveChannelRow[]> {
  const [rows] = await pool.query<LiveChannelRow[]>(
    `SELECT ${PUBLIC_COLUMNS} FROM live_channels WHERE is_enabled = 1 ORDER BY status ASC, name ASC`
  );
  return rows;
}

// Same explicit, key-free column list as PUBLIC_COLUMNS, just qualified for the join below.
const PUBLIC_COLUMNS_QUALIFIED = `
  lc.id, lc.name, lc.slug, lc.description, lc.category, lc.poster_path, lc.owner_id, lc.rtmp_app, lc.is_enabled,
  lc.status, lc.current_session_id, lc.live_started_at, lc.last_error, lc.live_hls_path,
  lc.record_enabled, lc.viewer_count, lc.created_at, lc.updated_at
`;

export async function listAllChannels(): Promise<Array<LiveChannelRow & { owner_name: string; owner_email: string }>> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT ${PUBLIC_COLUMNS_QUALIFIED}, u.name AS owner_name, u.email AS owner_email
     FROM live_channels lc
     JOIN users u ON u.id = lc.owner_id
     ORDER BY lc.created_at DESC`
  );
  return rows as Array<LiveChannelRow & { owner_name: string; owner_email: string }>;
}

export interface CreateChannelInput {
  name: string;
  slug: string;
  description?: string;
  category?: string;
  ownerId: number;
  streamKey: string;
  recordEnabled?: boolean;
}

export async function createChannel(input: CreateChannelInput): Promise<LiveChannelRow> {
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO live_channels (name, slug, description, category, owner_id, stream_key, record_enabled, last_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, '')`,
    [
      input.name.trim(),
      input.slug,
      input.description ?? '',
      input.category ?? '',
      input.ownerId,
      input.streamKey,
      input.recordEnabled === false ? 0 : 1,
    ]
  );
  const created = await findChannelByIdWithKey(result.insertId);
  if (!created) throw new Error('Failed to load channel after insert');
  return created;
}

export interface ChannelPatch {
  name?: string;
  description?: string;
  category?: string;
  recordEnabled?: boolean;
  isEnabled?: boolean;
}

export async function updateChannel(id: string | number, patch: ChannelPatch): Promise<LiveChannelRow | null> {
  const sets: string[] = [];
  const params: any[] = [];
  if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name.trim()); }
  if (patch.description !== undefined) { sets.push('description = ?'); params.push(patch.description); }
  if (patch.category !== undefined) { sets.push('category = ?'); params.push(patch.category); }
  if (patch.recordEnabled !== undefined) { sets.push('record_enabled = ?'); params.push(patch.recordEnabled ? 1 : 0); }
  if (patch.isEnabled !== undefined) { sets.push('is_enabled = ?'); params.push(patch.isEnabled ? 1 : 0); }
  if (sets.length > 0) {
    params.push(id);
    await pool.query(`UPDATE live_channels SET ${sets.join(', ')} WHERE id = ?`, params);
  }
  return findChannelById(id);
}

export async function regenerateStreamKey(id: string | number): Promise<string> {
  const newKey = generateStreamKey();
  await pool.query('UPDATE live_channels SET stream_key = ? WHERE id = ?', [newKey, id]);
  return newKey;
}

export async function setChannelPoster(id: string | number, posterPath: string): Promise<void> {
  await pool.query('UPDATE live_channels SET poster_path = ? WHERE id = ?', [posterPath, id]);
}

/**
 * Atomic conditional claim: only writes if nobody has already set a poster,
 * so a late auto-capture can never clobber an admin's manual upload that
 * landed while it was running. Mirrors the old Mongoose `$or`/`$exists`
 * conditional `updateOne`.
 */
export async function claimChannelPosterIfEmpty(id: string | number, posterPath: string): Promise<boolean> {
  const [result] = await pool.query<ResultSetHeader>(
    `UPDATE live_channels SET poster_path = ? WHERE id = ? AND (poster_path = '' OR poster_path IS NULL)`,
    [posterPath, id]
  );
  return result.affectedRows > 0;
}

export async function setChannelLive(id: string | number, sessionId: string): Promise<void> {
  await pool.query(
    `UPDATE live_channels SET status = 'live', current_session_id = ?, live_started_at = NOW(), last_error = '' WHERE id = ?`,
    [sessionId, id]
  );
}

export async function setChannelOffline(id: string | number): Promise<void> {
  await pool.query(
    `UPDATE live_channels SET status = 'offline', current_session_id = NULL, live_hls_path = '' WHERE id = ?`,
    [id]
  );
}

export async function setChannelError(id: string | number, message: string): Promise<void> {
  await pool.query(
    `UPDATE live_channels SET status = 'error', last_error = ?, live_hls_path = '' WHERE id = ?`,
    [message, id]
  );
}

/** Startup recovery: any channel left "live"/"starting" from a crashed process gets reset. */
export async function resetStuckLiveChannels(): Promise<void> {
  await pool.query(
    `UPDATE live_channels SET status = 'offline', current_session_id = NULL, live_hls_path = '', viewer_count = 0
     WHERE status IN ('live', 'starting')`
  );
}

export async function deleteChannel(id: string | number): Promise<void> {
  await pool.query('DELETE FROM live_channels WHERE id = ?', [id]);
}
