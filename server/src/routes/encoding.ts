import express from 'express';
import fs from 'fs';
import Video from '../models/Video.js';
import { protect, requireAdmin, AuthRequest } from '../middleware/auth.js';
import { startEncodingPipeline, generateThumbnailOptions, updateVideoThumbnail } from '../services/encoder.js';

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
router.get('/jobs', protect, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const match: any = { status: { $in: ['processing', 'encoding'] } };
    if (req.user!.role !== 'admin') match.owner = req.user!._id;

    const videos = await Video.find(match)
      .select('title originalName encodingProgress encodingStage encodingError status createdAt sizeBytes')
      .sort('-createdAt')
      .limit(20);

    res.json({ jobs: videos });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Single job status ─────────────────────────────────────────────────────────
router.get('/jobs/:id', protect, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const video = await Video.findById(req.params.id)
      .select('title encodingProgress encodingStage encodingLog encodingError status streams');
    if (!video) return res.status(404).json({ error: 'Not found' });
    res.json(video);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Retry failed encoding ─────────────────────────────────────────────────────
router.post('/jobs/:id/retry', protect, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video) return res.status(404).json({ error: 'Not found' });
    if (req.user!.role !== 'admin' && video.owner.toString() !== req.user!._id.toString()) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    // Allow retry for failed OR stuck-in-processing videos (in case server restarted)
    if (!['failed', 'processing', 'encoding'].includes(video.status)) {
      return res.status(400).json({ error: `Cannot retry a ${video.status} video` });
    }
    // Verify source file still exists
    if (!video.originalPath || !fs.existsSync(video.originalPath)) {
      video.status = 'failed';
      video.encodingError = 'Original source file no longer exists on disk. Please re-upload.';
      await video.save();
      return res.status(400).json({ error: video.encodingError });
    }

    video.status = 'processing';
    video.encodingProgress = 0;
    video.encodingStage = 'Queued for retry';
    video.encodingError = undefined;
    video.encodingLog = [];
    video.streams = [] as any;
    await video.save();

    startEncodingPipeline(video._id.toString(), video.originalPath, video.owner.toString());
    res.json({ message: 'Encoding retried', videoId: video._id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Thumbnail generation ──────────────────────────────────────────────────────
router.post('/thumbnails/:id/generate', protect, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video) return res.status(404).json({ error: 'Video not found' });
    if (req.user!.role !== 'admin' && video.owner.toString() !== req.user!._id.toString()) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!video.originalPath || !fs.existsSync(video.originalPath)) {
      return res.status(400).json({ error: 'Original video file not found' });
    }

    const thumbnails = await generateThumbnailOptions(video._id.toString(), video.originalPath);
    res.json({ thumbnails });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/thumbnails/:id/select', protect, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { thumbnailPath } = req.body;
    if (!thumbnailPath) return res.status(400).json({ error: 'thumbnailPath required' });

    const video = await Video.findById(req.params.id);
    if (!video) return res.status(404).json({ error: 'Video not found' });
    if (req.user!.role !== 'admin' && video.owner.toString() !== req.user!._id.toString()) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await updateVideoThumbnail(video._id.toString(), thumbnailPath);
    res.json({ message: 'Thumbnail updated', thumbnailPath });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;