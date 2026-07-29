import express from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { fileURLToPath } from 'url';
import LiveChannel, { generateStreamKey, generateUniqueSlug } from '../models/LiveChannel.js';
import { protect, requireAdmin, AuthRequest } from '../middleware/auth.js';
import { stopChannelStream } from '../services/liveMediaServer.js';
import { storageDir } from '../services/liveEncoder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function storageBase(): string {
  return process.env.STORAGE_LOCAL_PATH
    ? path.resolve(process.env.STORAGE_LOCAL_PATH)
    : path.join(__dirname, '..', '..', 'uploads');
}

// Same disk-path → /uploads URL conversion used by routes/videos.ts
function toUrl(fsPath: string | undefined): string {
  if (!fsPath) return '';
  const base = storageBase();
  let rel: string;
  if (path.isAbsolute(fsPath)) {
    rel = path.relative(base, fsPath).replace(/\\/g, '/');
  } else {
    rel = fsPath.replace(/\\/g, '/');
  }
  return rel.startsWith('..') ? '' : `/uploads/${rel}`;
}

function rtmpUrlFor(rtmpApp: string, streamKey: string): string {
  const host = process.env.PUBLIC_RTMP_HOST || 'localhost';
  const port = process.env.RTMP_PORT || 1935;
  return `rtmp://${host}:${port}/${rtmpApp || 'live'}/${streamKey}`;
}

// ── Poster uploads (same multer-on-disk pattern as routes/upload.ts) ─────────
const MAX_POSTER_BYTES = (Number(process.env.MAX_POSTER_SIZE_MB) || 8) * 1024 * 1024;
const POSTER_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif']);

const posterStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = storageDir('posters');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  // Timestamped so a replacement never collides with the file it replaces, and
  // never with the `{channelId}.jpg` name reserved for auto-captured posters.
  filename: (req: any, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeExt = POSTER_EXTENSIONS.has(ext) ? ext : '.jpg';
    cb(null, `${req.params.id}_${Date.now()}${safeExt}`);
  },
});

const posterUpload = multer({
  storage: posterStorage,
  limits: { fileSize: MAX_POSTER_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are accepted'));
    }
    cb(null, true);
  },
});

/** Best-effort removal of a poster file that is no longer referenced. */
function removePosterFile(fsPath: string | undefined | null): void {
  if (!fsPath) return;
  try {
    if (fs.existsSync(fsPath)) fs.rmSync(fsPath, { force: true });
  } catch (e: any) {
    console.warn(`[live] Could not delete old poster ${fsPath}: ${e.message}`);
  }
}

/** Shape returned to regular (non-admin) viewers — never contains the stream key. */
// A channel whose broadcast blew up (`status: 'error'`) is reported as `offline`
// to viewers -- the raw error state is an operational detail for admins only,
// and hlsUrl is already '' for anything not live so playability was never implied.
function publicShape(c: any) {
  const id = String(c._id);
  return {
    _id: c._id,
    name: c.name,
    slug: c.slug,
    description: c.description,
    category: c.category,
    posterUrl: toUrl(c.posterPath),
    status: c.status === 'error' ? 'offline' : c.status,
    liveStartedAt: c.liveStartedAt,
    hlsUrl: c.status === 'live' ? `/uploads/hls/live/${id}/master.m3u8` : '',
  };
}

const router = express.Router();

// ── Public (any authenticated role) ───────────────────────────────────────────
// Registered before the admin sub-router so /channels/public isn't swallowed by
// the admin /channels/:id routes.
router.get('/channels/public', protect, async (_req: AuthRequest, res) => {
  try {
    const channels = await LiveChannel.find({ isEnabled: true }).sort({ status: 1, name: 1 });
    res.json(channels.map(publicShape));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/channels/:slug', protect, async (req: AuthRequest, res) => {
  try {
    const channel = await LiveChannel.findOne({ slug: req.params.slug, isEnabled: true });
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    res.json(publicShape(channel));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin ─────────────────────────────────────────────────────────────────────
const adminRouter = express.Router();
adminRouter.use(protect, requireAdmin);

// Create a channel. This is the ONLY response that returns the raw stream key
// by default — everywhere else it's stripped by the schema's select:false.
adminRouter.post('/', async (req: AuthRequest, res) => {
  try {
    const { name, description, category, recordEnabled } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });

    const slug = await generateUniqueSlug(String(name));
    const streamKey = generateStreamKey();

    const channel = await LiveChannel.create({
      name: String(name).trim(),
      slug,
      description: description || '',
      category: category || '',
      owner: req.user!._id,
      streamKey,
      recordEnabled: recordEnabled === undefined ? true : !!recordEnabled,
    });

    res.status(201).json({
      ...channel.toObject(),
      streamKey,
      rtmpUrl: rtmpUrlFor(channel.rtmpApp, streamKey),
      posterUrl: toUrl(channel.posterPath),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// List all channels (streamKey omitted by the schema's select:false)
adminRouter.get('/', async (_req: AuthRequest, res) => {
  try {
    const channels = await LiveChannel.find().sort('-createdAt').populate('owner', 'name email');
    res.json(channels.map(c => ({
      ...c.toObject(),
      posterUrl: toUrl(c.posterPath),
      hlsUrl: c.status === 'live' ? `/uploads/hls/live/${String(c._id)}/master.m3u8` : '',
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Explicit re-reveal of an existing key
adminRouter.get('/:id/reveal', async (req: AuthRequest, res) => {
  try {
    const channel = await LiveChannel.findById(req.params.id).select('+streamKey');
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    res.json({
      streamKey: channel.streamKey,
      rtmpUrl: rtmpUrlFor(channel.rtmpApp, channel.streamKey),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.patch('/:id', async (req: AuthRequest, res) => {
  try {
    const { name, description, category, recordEnabled, isEnabled } = req.body;
    const channel = await LiveChannel.findById(req.params.id);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    if (name !== undefined) channel.name = String(name).trim();
    if (description !== undefined) channel.description = description;
    if (category !== undefined) channel.category = category;
    if (recordEnabled !== undefined) channel.recordEnabled = !!recordEnabled;
    if (isEnabled !== undefined) channel.isEnabled = !!isEnabled;
    await channel.save();

    // Disabling a channel mid-broadcast should actually cut it off
    if (isEnabled !== undefined && !channel.isEnabled) stopChannelStream(req.params.id);

    res.json({ ...channel.toObject(), posterUrl: toUrl(channel.posterPath) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Upload (or replace) the channel poster. Multipart, field name "poster".
// An uploaded poster always outranks the auto-captured one — see
// captureChannelPosterIfMissing() in services/liveEncoder.ts.
adminRouter.post('/:id/poster', posterUpload.single('poster'), async (req: AuthRequest, res) => {
  const uploaded = req.file;
  try {
    if (!uploaded) return res.status(400).json({ error: 'poster image file required' });

    const channel = await LiveChannel.findById(req.params.id);
    if (!channel) {
      removePosterFile(uploaded.path);
      return res.status(404).json({ error: 'Channel not found' });
    }

    const previousPath = channel.posterPath;
    channel.posterPath = uploaded.path;
    await channel.save();

    // Drop the file we just replaced (admin-uploaded or auto-captured) so old
    // posters don't pile up in uploads/posters.
    if (previousPath && previousPath !== channel.posterPath) removePosterFile(previousPath);

    res.json({ ...channel.toObject(), posterUrl: toUrl(channel.posterPath) });
  } catch (err: any) {
    removePosterFile(uploaded?.path);
    res.status(500).json({ error: err.message });
  }
});

// Rotate the key — any in-flight broadcast is using the now-invalid old key
adminRouter.post('/:id/regenerate-key', async (req: AuthRequest, res) => {
  try {
    const channel = await LiveChannel.findById(req.params.id).select('+streamKey');
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    channel.streamKey = generateStreamKey();
    channel.status = 'offline';
    channel.currentSessionId = null;
    channel.liveHlsPath = '';
    await channel.save();

    const stopped = stopChannelStream(req.params.id);

    res.json({
      streamKey: channel.streamKey,
      rtmpUrl: rtmpUrlFor(channel.rtmpApp, channel.streamKey),
      stopped,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Admin kill switch
adminRouter.post('/:id/stop', async (req: AuthRequest, res) => {
  try {
    const channel = await LiveChannel.findById(req.params.id);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    const stopped = stopChannelStream(req.params.id);
    channel.status = 'offline';
    channel.currentSessionId = null;
    channel.liveHlsPath = '';
    channel.viewerCount = 0;
    await channel.save();

    res.json({ message: stopped ? 'Stream stopped' : 'No active stream', stopped });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Delete the channel. Replay Video docs created from past broadcasts are left alone.
adminRouter.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const channel = await LiveChannel.findById(req.params.id);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    stopChannelStream(req.params.id);

    // Best-effort cleanup of this channel's live HLS working directory
    try {
      const liveDir = path.join(storageBase(), 'hls', 'live', String(channel._id));
      if (fs.existsSync(liveDir)) fs.rmSync(liveDir, { recursive: true, force: true });
    } catch { /* ignore cleanup failures */ }

    // And its poster, uploaded or auto-captured
    removePosterFile(channel.posterPath);

    await channel.deleteOne();
    res.json({ message: 'Channel deleted' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.use('/channels', adminRouter);

export default router;
