import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { pool } from './pool.js';
import { listVideoStreams, type VideoStreamRow } from './videoStreams.js';

/**
 * mysql2 auto-parses native MySQL `JSON` columns into real JS values (arrays/
 * objects) before this code ever sees them -- it does NOT hand back a raw
 * string to `JSON.parse` yourself, despite what the column's TS type here
 * implies. `JSON.parse(anArray)` coerces its argument to a string first
 * (`String([])` === `''`), and `JSON.parse('')` throws "Unexpected end of
 * JSON input" -- which silently flipped every finished encode with an empty
 * `tags`/`encoding_log` array to `status: 'failed'` (the error was caught by
 * `startEncodingPipeline`'s catch block right after real success) and 500'd
 * `GET /api/videos` for any account with such a video in the list. Handles
 * both the already-parsed value (the actual mysql2 behavior) and a raw
 * string (in case of a different driver config) defensively.
 */
export function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value as T;
  if (value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export type VideoStatus = 'uploading' | 'processing' | 'encoding' | 'published' | 'failed' | 'draft' | 'archived';
export type SourceType = 'upload' | 'live-recording';

export interface VideoRow extends RowDataPacket {
  id: number;
  title: string;
  description: string;
  owner_id: number;
  status: VideoStatus;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  duration: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  audio_codec: string;
  bitrate: number;
  original_path: string;
  hls_path: string;
  thumbnail_path: string;
  preview_path: string;
  tags: string | null; // JSON column, comes back as a string
  folder: string;
  views: number;
  encoding_log: string | null; // JSON column
  source_type: SourceType;
  source_channel_id: number | null;
  encoding_job_id: string | null;
  encoding_progress: number;
  encoding_stage: string;
  encoding_error: string | null;
  created_at: Date;
  updated_at: Date;
  // present only when the query joins users
  owner_name?: string;
  owner_email?: string;
}

/** Row (+ owner join, + optional preloaded streams) -> the same camelCase shape `.toObject()` used to produce, so route-level `addUrls()` needs no changes. */
export function toApiVideo(row: VideoRow, streams: VideoStreamRow[] = []) {
  return {
    _id: String(row.id),
    title: row.title,
    description: row.description,
    owner: { _id: String(row.owner_id), name: row.owner_name ?? '', email: row.owner_email ?? '' },
    status: row.status,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    duration: row.duration,
    width: row.width,
    height: row.height,
    fps: Number(row.fps),
    codec: row.codec,
    audioCodec: row.audio_codec,
    bitrate: row.bitrate,
    originalPath: row.original_path,
    hlsPath: row.hls_path,
    thumbnailPath: row.thumbnail_path,
    previewPath: row.preview_path,
    streams: streams.map(s => ({ quality: s.quality, bitrate: s.bitrate, path: s.path, size: Number(s.size), status: s.status })),
    tags: parseJsonColumn(row.tags, [] as string[]),
    folder: row.folder,
    views: Number(row.views),
    encodingLog: parseJsonColumn(row.encoding_log, [] as string[]),
    sourceType: row.source_type,
    sourceChannel: row.source_channel_id ? String(row.source_channel_id) : undefined,
    encodingJobId: row.encoding_job_id ?? undefined,
    encodingProgress: row.encoding_progress,
    encodingStage: row.encoding_stage,
    encodingError: row.encoding_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Loads a video row + its streams and shapes it exactly like `toApiVideo` -- the one function routes should call for a single video. */
export async function getApiVideo(id: string | number) {
  const video = await findVideoByIdWithOwner(id);
  if (!video) return null;
  const streams = await listVideoStreams(id);
  return toApiVideo(video, streams);
}

export async function findVideoById(id: string | number): Promise<VideoRow | null> {
  const [rows] = await pool.query<VideoRow[]>('SELECT * FROM videos WHERE id = ? LIMIT 1', [id]);
  return rows[0] ?? null;
}

export async function findVideoByIdWithOwner(id: string | number): Promise<VideoRow | null> {
  const [rows] = await pool.query<VideoRow[]>(
    `SELECT v.*, u.name AS owner_name, u.email AS owner_email
     FROM videos v JOIN users u ON u.id = v.owner_id
     WHERE v.id = ? LIMIT 1`,
    [id]
  );
  return rows[0] ?? null;
}

// Whitelisted sort fields only -- `sort` is a raw client query param, never
// interpolate it into SQL directly. Anything not listed here falls back to
// the default (matches Mongoose silently ignoring an unrecognized sort key).
const SORT_COLUMNS: Record<string, string> = {
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  title: 'title',
  views: 'views',
  sizeBytes: 'size_bytes',
  duration: 'duration',
};

function parseSort(sort: string): string {
  const desc = sort.startsWith('-');
  const key = desc ? sort.slice(1) : sort;
  const column = SORT_COLUMNS[key] || 'created_at';
  return `${column} ${desc ? 'DESC' : 'ASC'}`;
}

export interface ListVideosOptions {
  status?: string; // 'all' | a specific VideoStatus | undefined
  isAdmin: boolean;
  search?: string;
  folder?: string;
  page: number;
  limit: number;
  sort: string;
}

export async function listVideos(opts: ListVideosOptions): Promise<{ rows: VideoRow[]; total: number }> {
  const where: string[] = [];
  const params: any[] = [];

  if (!opts.isAdmin) {
    where.push('v.status = ?');
    params.push('published');
  } else if (opts.status && opts.status !== 'all') {
    where.push('v.status = ?');
    params.push(opts.status);
  }
  if (opts.folder) {
    where.push('v.folder = ?');
    params.push(opts.folder);
  }
  if (opts.search) {
    // Mongo's $text search (title + tags) has no 1:1 MySQL equivalent across a
    // JSON column, so: FULLTEXT on title, plus a wildcard JSON_SEARCH over tags.
    where.push('(MATCH(v.title) AGAINST (? IN NATURAL LANGUAGE MODE) OR v.title LIKE ? OR JSON_SEARCH(v.tags, "one", ?) IS NOT NULL)');
    params.push(opts.search, `%${opts.search}%`, `%${opts.search}%`);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const orderSql = parseSort(opts.sort);
  // LIMIT/OFFSET as placeholders can misbehave across MySQL/mysql2 versions,
  // so they're inlined -- but only ever as clamped, guaranteed-safe integers.
  const safeLimit = Math.min(200, Math.max(1, Number.isFinite(opts.limit) ? Math.floor(opts.limit) : 50));
  const safePage = Math.max(1, Number.isFinite(opts.page) ? Math.floor(opts.page) : 1);
  const offset = Math.max(0, (safePage - 1) * safeLimit);

  const [rows] = await pool.query<VideoRow[]>(
    `SELECT v.*, u.name AS owner_name, u.email AS owner_email
     FROM videos v JOIN users u ON u.id = v.owner_id
     ${whereSql}
     ORDER BY ${orderSql}
     LIMIT ${safeLimit} OFFSET ${offset}`,
    params
  );
  const [countRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM videos v ${whereSql}`,
    params
  );
  return { rows, total: Number(countRows[0]!.n) };
}

export interface CreateVideoInput {
  title: string;
  description?: string;
  ownerId: number;
  originalName: string;
  mimeType?: string;
  sizeBytes?: number;
  originalPath?: string;
  status?: VideoStatus;
  sourceType?: SourceType;
  sourceChannelId?: number | null;
  tags?: string[];
  folder?: string;
}

export async function createVideo(input: CreateVideoInput): Promise<VideoRow> {
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO videos
       (title, description, owner_id, status, original_name, mime_type, size_bytes,
        original_path, tags, folder, source_type, source_channel_id, encoding_log)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.title,
      input.description ?? '',
      input.ownerId,
      input.status ?? 'uploading',
      input.originalName,
      input.mimeType ?? '',
      input.sizeBytes ?? 0,
      input.originalPath ?? '',
      JSON.stringify(input.tags ?? []),
      input.folder ?? 'root',
      input.sourceType ?? 'upload',
      input.sourceChannelId ?? null,
      JSON.stringify([]),
    ]
  );
  const created = await findVideoById(result.insertId);
  if (!created) throw new Error('Failed to load video after insert');
  return created;
}

/** Generic partial-update -- pass camelCase keys matching VideoRow's logical fields; only whitelisted columns are writable. */
export interface VideoPatch {
  title?: string;
  description?: string;
  tags?: string[];
  folder?: string;
  status?: VideoStatus;
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  codec?: string;
  audioCodec?: string;
  bitrate?: number;
  thumbnailPath?: string;
  hlsPath?: string;
  views?: number;
  encodingProgress?: number;
  encodingStage?: string;
  encodingError?: string | null;
  encodingLog?: string[];
}

const PATCH_COLUMNS: Record<keyof VideoPatch, string> = {
  title: 'title',
  description: 'description',
  tags: 'tags',
  folder: 'folder',
  status: 'status',
  duration: 'duration',
  width: 'width',
  height: 'height',
  fps: 'fps',
  codec: 'codec',
  audioCodec: 'audio_codec',
  bitrate: 'bitrate',
  thumbnailPath: 'thumbnail_path',
  hlsPath: 'hls_path',
  views: 'views',
  encodingProgress: 'encoding_progress',
  encodingStage: 'encoding_stage',
  encodingError: 'encoding_error',
  encodingLog: 'encoding_log',
};

export async function updateVideo(id: string | number, patch: VideoPatch): Promise<void> {
  const sets: string[] = [];
  const params: any[] = [];
  for (const key of Object.keys(patch) as Array<keyof VideoPatch>) {
    const column = PATCH_COLUMNS[key];
    if (!column) continue;
    let value: any = (patch as any)[key];
    if (key === 'tags' || key === 'encodingLog') value = JSON.stringify(value ?? []);
    sets.push(`${column} = ?`);
    params.push(value);
  }
  if (sets.length === 0) return;
  params.push(id);
  await pool.query(`UPDATE videos SET ${sets.join(', ')} WHERE id = ?`, params);
}

/** Appends one line to the JSON encoding_log array in a single round trip (no read-modify-write race). */
export async function appendEncodingLog(id: string | number, line: string): Promise<void> {
  await pool.query(
    `UPDATE videos SET encoding_log = JSON_ARRAY_APPEND(COALESCE(encoding_log, JSON_ARRAY()), '$', ?) WHERE id = ?`,
    [line, id]
  );
}

export async function incrementViews(id: string | number): Promise<void> {
  await pool.query('UPDATE videos SET views = views + 1 WHERE id = ?', [id]);
}

export async function markVideoFailed(id: string | number, errorMessage: string): Promise<void> {
  await pool.query(
    `UPDATE videos SET status = 'failed', encoding_error = ?, encoding_stage = 'Failed' WHERE id = ?`,
    [errorMessage, id]
  );
}

export async function deleteVideo(id: string | number): Promise<void> {
  await pool.query('DELETE FROM videos WHERE id = ?', [id]); // video_streams cascade via FK
}

export async function findVideosByStatuses(statuses: VideoStatus[]): Promise<VideoRow[]> {
  const [rows] = await pool.query<VideoRow[]>(
    `SELECT * FROM videos WHERE status IN (${statuses.map(() => '?').join(',')})`,
    statuses
  );
  return rows;
}

export interface VideoStatsResult {
  total: number;
  totalSize: number;
  totalViews: number;
  byStatus: Record<string, number>;
}

export async function videoStats(ownerId: number | null): Promise<VideoStatsResult> {
  const where = ownerId !== null ? 'WHERE owner_id = ?' : '';
  const params = ownerId !== null ? [ownerId] : [];
  const [totals] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total, COALESCE(SUM(size_bytes),0) AS totalSize, COALESCE(SUM(views),0) AS totalViews FROM videos ${where}`,
    params
  );
  const [byStatusRows] = await pool.query<RowDataPacket[]>(
    `SELECT status, COUNT(*) AS n FROM videos ${where} GROUP BY status`,
    params
  );
  const byStatus: Record<string, number> = {};
  for (const r of byStatusRows) byStatus[r.status] = Number(r.n);
  const t = totals[0]!;
  return { total: Number(t.total), totalSize: Number(t.totalSize), totalViews: Number(t.totalViews), byStatus };
}

export interface StorageStatsResult {
  totalSizeBytes: number;
  totalVideos: number;
}

export async function storageStats(): Promise<StorageStatsResult> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT COALESCE(SUM(size_bytes),0) AS totalSize, COUNT(*) AS count FROM videos'
  );
  return { totalSizeBytes: Number(rows[0]!.totalSize), totalVideos: Number(rows[0]!.count) };
}

export async function largestPublishedVideos(limit = 10): Promise<Array<Pick<VideoRow, 'id' | 'title' | 'size_bytes' | 'thumbnail_path'>>> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, title, size_bytes, thumbnail_path FROM videos WHERE status = 'published' ORDER BY size_bytes DESC LIMIT ?`,
    [limit]
  );
  return rows as any;
}
