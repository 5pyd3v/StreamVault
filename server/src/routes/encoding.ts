import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../db/pool.js';
import { findVideoById, updateVideo, type VideoRow } from '../db/videos.js';
import { listVideoStreams, deleteVideoStreams } from '../db/videoStreams.js';
import { protect, requireAdmin, AuthRequest } from '../middleware/auth.js';
import { startEncodingPipeline, generateThumbnailOptions } from '../services/encoder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function storageBase(): string {
  return process.env.STORAGE_LOCAL_PATH
    ? path.resolve(process.env.STORAGE_LOCAL_PATH)
    : path.join(__dirname, '..', '..', 'uploads');
}

const router = express.Router();

// Everything in this router is admin-only.
//
// The owner-or-admin checks below used to be the boundary, but now that only
// admins can upload, "owner" and "admin" have converged — except for videos
// owned by non-admins from *before* uploads were locked down, which would
// otherwise still let a regular user kick off FFmpeg work. The per-route
// ownership checks are kept as defence in depth for editor-owned content.
// This also closes GET /jobs/:id, which had no ownership check at all and
// leaked the title / encoding log / failure reason of any video by id.

// ── Active encoding jobs ──────────────────────────────────────────────────────
// `listVideos` filters on a single status, but this needs both 'processing' and
// 'encoding' at once (the old `$in`), so it drops to a local parameterised query.
// The admin/owner split is folded into one predicate: the first placeholder is 1
// for admins, which short-circuits the owner match to always-true; for everyone
// else it is 0 and only their own rows survive.
router.get('/jobs', protect, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const isAdmin = req.user!.role === 'admin';
    const [rows] = await pool.query<VideoRow[]>(
      `SELECT * FROM videos
       WHERE status IN ('processing', 'encoding')
         AND (? = 1 OR owner_id = ?)
       ORDER BY created_at DESC
       LIMIT 20`,
      [isAdmin ? 1 : 0, Number(req.user!._id) || 0]
    );

    // Same projection the old `.select(...)` produced (Mongoose always keeps _id).
    const jobs = rows.map(row => ({
      _id: String(row.id),
      title: row.title,
      originalName: row.original_name,
      encodingProgress: row.encoding_progress,
      encodingStage: row.encoding_stage,
      encodingError: row.encoding_error ?? undefined,
      status: row.status,
      createdAt: row.created_at,
      sizeBytes: Number(row.size_bytes),
    }));

    res.json({ jobs });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Single job status ─────────────────────────────────────────────────────────
router.get('/jobs/:id', protect, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const video = await findVideoById(req.params.id);
    if (!video) return res.status(404).json({ error: 'Not found' });
    const streams = await listVideoStreams(req.params.id);

    res.json({
      _id: String(video.id),
      title: video.title,
      encodingProgress: video.encoding_progress,
      encodingStage: video.encoding_stage,
      encodingLog: video.encoding_log ? JSON.parse(video.encoding_log) : [],
      encodingError: video.encoding_error ?? undefined,
      status: video.status,
      streams: streams.map(s => ({
        quality: s.quality,
        bitrate: s.bitrate,
        path: s.path,
        size: Number(s.size),
        status: s.status,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Retry failed encoding ─────────────────────────────────────────────────────
router.post('/jobs/:id/retry', protect, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const video = await findVideoById(req.params.id);
    if (!video) return res.status(404).json({ error: 'Not found' });
    if (req.user!.role !== 'admin' && String(video.owner_id) !== req.user!._id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    // Allow retry for failed OR stuck-in-processing videos (in case server restarted)
    if (!['failed', 'processing', 'encoding'].includes(video.status)) {
      return res.status(400).json({ error: `Cannot retry a ${video.status} video` });
    }
    // Verify source file still exists
    if (!video.original_path || !fs.existsSync(video.original_path)) {
      const encodingError = 'Original source file no longer exists on disk. Please re-upload.';
      await updateVideo(req.params.id, { status: 'failed', encodingError });
      return res.status(400).json({ error: encodingError });
    }

    // Streams are their own table now, so the old `video.streams = []` wipe is a
    // delete — done before the status flip so a concurrent read never sees
    // "processing" alongside the previous run's finished renditions.
    await deleteVideoStreams(req.params.id);
    await updateVideo(req.params.id, {
      status: 'processing',
      encodingProgress: 0,
      encodingStage: 'Queued for retry',
      encodingError: null,
      encodingLog: [],
    });

    startEncodingPipeline(String(video.id), video.original_path, String(video.owner_id));
    res.json({ message: 'Encoding retried', videoId: String(video.id) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Thumbnail generation ──────────────────────────────────────────────────────
router.post('/thumbnails/:id/generate', protect, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const video = await findVideoById(req.params.id);
    if (!video) return res.status(404).json({ error: 'Video not found' });
    if (req.user!.role !== 'admin' && String(video.owner_id) !== req.user!._id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!video.original_path || !fs.existsSync(video.original_path)) {
      return res.status(400).json({ error: 'Original video file not found' });
    }

    const thumbnails = await generateThumbnailOptions(String(video.id), video.original_path);
    res.json({ thumbnails });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/thumbnails/:id/select', protect, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { thumbnailPath } = req.body;
    if (!thumbnailPath) return res.status(400).json({ error: 'thumbnailPath required' });

    const video = await findVideoById(req.params.id);
    if (!video) return res.status(404).json({ error: 'Video not found' });
    if (req.user!.role !== 'admin' && String(video.owner_id) !== req.user!._id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Writes through `updateVideo` rather than encoder.ts's `updateVideoThumbnail`
    // so this route doesn't depend on that helper surviving the encoder rewrite.
    // The rel -> abs conversion it did is kept: `generateThumbnailOptions` hands
    // the client paths relative to the storage base, but the column stores
    // absolute ones, and `toUrl()` in videos.ts relies on that.
    await updateVideo(req.params.id, {
      thumbnailPath: path.join(storageBase(), thumbnailPath),
    });
    res.json({ message: 'Thumbnail updated', thumbnailPath });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
