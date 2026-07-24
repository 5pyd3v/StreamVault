import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Video from '../models/Video.js';
import { protect, requireEditor, AuthRequest } from '../middleware/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function storageBase(): string {
  return process.env.STORAGE_LOCAL_PATH
    ? path.resolve(process.env.STORAGE_LOCAL_PATH)
    : path.join(__dirname, '..', '..', 'uploads');
}

function toUrl(fsPath: string | undefined): string {
  if (!fsPath) return '';
  const base = storageBase();
  // Handle both absolute paths and paths already relative to storage base
  let rel: string;
  if (path.isAbsolute(fsPath)) {
    rel = path.relative(base, fsPath).replace(/\\/g, '/');
  } else {
    rel = fsPath.replace(/\\/g, '/');
  }
  return rel.startsWith('..') ? '' : `/uploads/${rel}`;
}

function addUrls(v: any) {
  const obj = v.toObject ? v.toObject() : { ...v };
  obj.hlsUrl       = toUrl(obj.hlsPath);
  obj.thumbnailUrl = toUrl(obj.thumbnailPath);
  // Add per-quality HLS URLs derived from master path
  if (obj.hlsPath && obj.streams && obj.streams.length > 0) {
    const masterDir = path.dirname(obj.hlsPath);
    obj.streams = obj.streams.map((s: any) => {
      const qualityPlaylist = path.join(masterDir, s.quality, 'index.m3u8');
      return {
        ...s,
        hlsUrl: toUrl(qualityPlaylist),
        downloadUrl: toUrl(s.path),
      };
    });
  }
  obj.downloadUrl = toUrl(obj.originalPath);
  return obj;
}

const router = express.Router();

// ── List videos (owned) ───────────────────────────────────────────────────────
router.get('/', protect, async (req: AuthRequest, res) => {
  try {
    const { status, search, folder, page = 1, limit = 50, sort = '-createdAt' } = req.query;
    const query: any = req.user!.role === 'admin' ? {} : { owner: req.user!._id };
    if (status && status !== 'all') query.status = status;
    if (folder) query.folder = folder;
    if (search) query.$text = { $search: String(search) };

    const videos = await Video.find(query)
      .sort(String(sort))
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit))
      .populate('owner', 'name email');

    const total = await Video.countDocuments(query);
    res.json({ videos: videos.map(addUrls), total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Get single video ──────────────────────────────────────────────────────────
router.get('/:id', protect, async (req: AuthRequest, res) => {
  try {
    const video = await Video.findById(req.params.id).populate('owner', 'name email');
    if (!video) return res.status(404).json({ error: 'Video not found' });
    if (req.user!.role !== 'admin' && video.owner._id.toString() !== req.user!._id.toString()) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    video.views += 1;
    await video.save();
    res.json(addUrls(video));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Update video ──────────────────────────────────────────────────────────────
router.patch('/:id', protect, requireEditor, async (req: AuthRequest, res) => {
  try {
    const { title, description, tags, folder, status } = req.body;
    const video = await Video.findById(req.params.id);
    if (!video) return res.status(404).json({ error: 'Video not found' });
    if (req.user!.role !== 'admin' && video.owner.toString() !== req.user!._id.toString()) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (title !== undefined) video.title = title;
    if (description !== undefined) video.description = description;
    if (tags !== undefined) video.tags = tags;
    if (folder !== undefined) video.folder = folder;
    if (status !== undefined && ['draft','archived'].includes(status)) video.status = status;
    await video.save();
    res.json(addUrls(video));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Delete video ──────────────────────────────────────────────────────────────
router.delete('/:id', protect, requireEditor, async (req: AuthRequest, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video) return res.status(404).json({ error: 'Not found' });
    if (req.user!.role !== 'admin' && video.owner.toString() !== req.user!._id.toString()) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Clean up files from disk (best-effort, non-blocking)
    const base = storageBase();
    const toDelete: string[] = [];
    if (video.originalPath) toDelete.push(video.originalPath);
    if (video.thumbnailPath) toDelete.push(video.thumbnailPath);
    // HLS directory: base/hls/{videoId}
    toDelete.push(path.join(base, 'hls', video._id.toString()));
    for (const p of toDelete) {
      try {
        if (fs.existsSync(p)) {
          const stat = fs.statSync(p);
          stat.isDirectory() ? fs.rmSync(p, { recursive: true, force: true }) : fs.unlinkSync(p);
        }
      } catch { /* ignore individual cleanup failures */ }
    }

    await video.deleteOne();
    res.json({ message: 'Video deleted' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Stats ─────────────────────────────────────────────────────────────────────
router.get('/meta/stats', protect, async (req: AuthRequest, res) => {
  try {
    const match = req.user!.role === 'admin' ? {} : { owner: req.user!._id };
    const [agg] = await Video.aggregate([
      { $match: match },
      { $group: {
        _id: null,
        total: { $sum: 1 },
        totalSize: { $sum: '$sizeBytes' },
        totalViews: { $sum: '$views' },
        byStatus: { $push: '$status' },
      }},
    ]);
    res.json(agg || { total: 0, totalSize: 0, totalViews: 0 });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
