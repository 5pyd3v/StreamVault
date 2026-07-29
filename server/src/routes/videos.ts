import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  listVideos,
  getApiVideo,
  toApiVideo,
  findVideoById,
  findVideoByIdWithOwner,
  updateVideo,
  incrementViews,
  deleteVideo,
  videoStats,
  type VideoPatch,
} from '../db/videos.js';
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

// ── List videos ───────────────────────────────────────────────────────────────
// Admins get the whole collection (they need drafts/failures for the management
// views). Everyone else gets the *published catalogue* — every published video,
// regardless of owner, and nothing else. This replaces the old owner-scoping:
// now that only admins can upload, scoping a viewer to their own videos would
// hand them an empty library instead of the catalogue.
//
// The `status` query param is honoured for admins only; a non-admin asking for
// `?status=failed` still gets published-only rather than overriding the filter.
// `listVideos` owns that rule now, together with the folder filter, the search
// replacement for Mongo's `$text`, and safe pagination.
//
// Streams are deliberately not loaded per row: they live in their own table now,
// so fetching them would cost an extra query per video, and nothing that consumes
// the list response reads `streams` — only the single-video endpoint does.
router.get('/', protect, async (req: AuthRequest, res) => {
  try {
    const { status, search, folder, page = 1, limit = 50, sort = '-createdAt' } = req.query;
    const isAdmin = req.user!.role === 'admin';

    const { rows, total } = await listVideos({
      status: status !== undefined ? String(status) : undefined,
      isAdmin,
      search: search ? String(search) : undefined,
      folder: folder ? String(folder) : undefined,
      page: Number(page),
      limit: Number(limit),
      sort: String(sort),
    });

    const videos = rows.map(row => addUrls(toApiVideo(row)));
    res.json({ videos, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Get single video ──────────────────────────────────────────────────────────
// Mirrors the list rule so a deep link into the player resolves: a non-admin may
// fetch any *published* video (that's the catalogue they browse), or one they
// own. Anything still draft/processing/failed/archived stays admin-or-owner only.
router.get('/:id', protect, async (req: AuthRequest, res) => {
  try {
    const video = await getApiVideo(req.params.id);
    if (!video) return res.status(404).json({ error: 'Video not found' });
    const isAdmin = req.user!.role === 'admin';
    // Both sides are already plain strings (the shaping stringifies owner._id).
    const isOwner = video.owner._id === req.user!._id;
    if (!isAdmin && !isOwner && video.status !== 'published') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    await incrementViews(req.params.id);
    // Reflect the bump in this response too, as the old read-modify-save did.
    video.views += 1;
    res.json(addUrls(video));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Update video ──────────────────────────────────────────────────────────────
router.patch('/:id', protect, requireEditor, async (req: AuthRequest, res) => {
  try {
    const { title, description, tags, folder, status } = req.body;
    const video = await findVideoByIdWithOwner(req.params.id);
    if (!video) return res.status(404).json({ error: 'Video not found' });
    // Raw row: `owner_id` is a number, so stringify it before comparing.
    if (req.user!.role !== 'admin' && String(video.owner_id) !== req.user!._id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Only the keys actually supplied get written; omitted ones keep their value,
    // matching the old assign-only-if-defined-then-save behaviour.
    const patch: VideoPatch = {};
    if (title !== undefined) patch.title = title;
    if (description !== undefined) patch.description = description;
    if (tags !== undefined) patch.tags = tags;
    if (folder !== undefined) patch.folder = folder;
    if (status !== undefined && ['draft', 'archived'].includes(status)) patch.status = status;
    await updateVideo(req.params.id, patch);

    const updated = await getApiVideo(req.params.id);
    res.json(addUrls(updated));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Delete video ──────────────────────────────────────────────────────────────
router.delete('/:id', protect, requireEditor, async (req: AuthRequest, res) => {
  try {
    const video = await findVideoById(req.params.id);
    if (!video) return res.status(404).json({ error: 'Not found' });
    if (req.user!.role !== 'admin' && String(video.owner_id) !== req.user!._id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Clean up files from disk (best-effort, non-blocking)
    const base = storageBase();
    const toDelete: string[] = [];
    if (video.original_path) toDelete.push(video.original_path);
    if (video.thumbnail_path) toDelete.push(video.thumbnail_path);
    // HLS directory: base/hls/{videoId}
    toDelete.push(path.join(base, 'hls', String(video.id)));
    for (const p of toDelete) {
      try {
        if (fs.existsSync(p)) {
          const stat = fs.statSync(p);
          stat.isDirectory() ? fs.rmSync(p, { recursive: true, force: true }) : fs.unlinkSync(p);
        }
      } catch { /* ignore individual cleanup failures */ }
    }

    await deleteVideo(req.params.id); // video_streams rows cascade via FK
    res.json({ message: 'Video deleted' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Stats ─────────────────────────────────────────────────────────────────────
router.get('/meta/stats', protect, async (req: AuthRequest, res) => {
  try {
    const isAdmin = req.user!.role === 'admin';
    // Already returns zeros when nothing matches, so the old `|| {…}` fallback
    // has nothing left to guard against.
    const stats = await videoStats(isAdmin ? null : Number(req.user!._id));
    res.json(stats);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
