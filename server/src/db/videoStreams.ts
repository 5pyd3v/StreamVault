import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { pool } from './pool.js';

export type StreamQuality = '360p' | '480p' | '720p' | '1080p' | '4K';
export type StreamStatus = 'pending' | 'encoding' | 'done' | 'failed';

export interface VideoStreamRow extends RowDataPacket {
  id: number;
  video_id: number;
  quality: StreamQuality;
  bitrate: number;
  path: string;
  size: number;
  status: StreamStatus;
  created_at: Date;
}

export interface VideoStreamInput {
  quality: StreamQuality;
  bitrate: number;
  path: string;
  size: number;
  status?: StreamStatus;
}

/** Was `video.streams.push(stream); await video.save()` -- now its own row, its own atomic INSERT. */
export async function addVideoStream(videoId: string | number, stream: VideoStreamInput): Promise<VideoStreamRow> {
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO video_streams (video_id, quality, bitrate, path, size, status) VALUES (?, ?, ?, ?, ?, ?)`,
    [videoId, stream.quality, stream.bitrate, stream.path, stream.size, stream.status ?? 'done']
  );
  const [rows] = await pool.query<VideoStreamRow[]>('SELECT * FROM video_streams WHERE id = ?', [result.insertId]);
  return rows[0]!;
}

/** Insertion order is already deterministic (the encoder loops applicable qualities ascending), so plain id-order suffices. */
export async function listVideoStreams(videoId: string | number): Promise<VideoStreamRow[]> {
  const [rows] = await pool.query<VideoStreamRow[]>(
    'SELECT * FROM video_streams WHERE video_id = ? ORDER BY id ASC',
    [videoId]
  );
  return rows;
}

export async function deleteVideoStreams(videoId: string | number): Promise<void> {
  await pool.query('DELETE FROM video_streams WHERE video_id = ?', [videoId]);
}
