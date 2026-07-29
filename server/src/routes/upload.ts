import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { protect, requireAdmin, AuthRequest } from '../middleware/auth.js';
import UploadSession from '../models/UploadSession.js';
import Video from '../models/Video.js';
import { startEncodingPipeline } from '../services/encoder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHUNK_SIZE = (Number(process.env.CHUNK_SIZE_MB) || 5) * 1024 * 1024;
const MAX_FILE_BYTES = (Number(process.env.MAX_FILE_SIZE_GB) || 100) * 1024 * 1024 * 1024;

function getTempDir(): string {
  const p = process.env.UPLOAD_TEMP_PATH
    ? path.resolve(process.env.UPLOAD_TEMP_PATH)
    : path.join(__dirname, '..', '..', 'uploads', 'temp');
  fs.mkdirSync(p, { recursive: true });
  return p;
}

const chunkStorage = multer.diskStorage({
  destination: (req: any, _file, cb) => {
    const dir = path.join(getTempDir(), req.body.uploadId || 'unknown');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, _file, cb) => cb(null, `chunk_${Date.now()}`),
});

const upload = multer({
  storage: chunkStorage,
  limits: { fileSize: CHUNK_SIZE + 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('video/') && file.mimetype !== 'application/octet-stream') {
      return cb(new Error('Only video files are accepted'));
    }
    cb(null, true);
  },
});

const router = express.Router();

// Ingest is an admin-only surface: regular users consume the catalogue, they
// never contribute to it. Every route below is `protect` + `requireAdmin`, and
// on /chunk the guard deliberately runs *before* multer so a rejected upload
// never lands a byte on disk.

// ── Init upload session ───────────────────────────────────────────────────────
router.post('/init', protect, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { filename, totalSize, mimeType } = req.body;
    if (!filename || !totalSize) return res.status(400).json({ error: 'filename and totalSize required' });
    if (Number(totalSize) > MAX_FILE_BYTES) {
      return res.status(413).json({ error: `File exceeds maximum size of ${process.env.MAX_FILE_SIZE_GB || 100} GB` });
    }

    // Check for existing active session (resume support)
    const existing = await UploadSession.findOne({
      owner: req.user!._id,
      filename,
      totalSize: Number(totalSize),
      status: 'active',
    });
    if (existing) {
      const receivedIndexes = existing.receivedChunks.map(c => c.index).sort((a, b) => a - b);
      // Find the first missing chunk index for resume
      let resumeFrom = 0;
      for (let i = 0; i < existing.totalChunks; i++) {
        if (!receivedIndexes.includes(i)) { resumeFrom = i; break; }
        resumeFrom = i + 1;
      }
      return res.json({
        uploadId: existing.uploadId,
        totalChunks: existing.totalChunks,
        chunkSize: existing.chunkSize,
        resumeFrom: resumeFrom < existing.totalChunks ? resumeFrom : 0,
      });
    }

    const uploadId = uuidv4();
    const totalChunks = Math.ceil(Number(totalSize) / CHUNK_SIZE);
    const tempDir = path.join(getTempDir(), uploadId);
    fs.mkdirSync(tempDir, { recursive: true });

    const session = await UploadSession.create({
      uploadId,
      owner: req.user!._id,
      filename,
      mimeType: mimeType || 'video/mp4',
      totalSize: Number(totalSize),
      totalChunks,
      chunkSize: CHUNK_SIZE,
      tempDir,
    });

    res.json({ uploadId, totalChunks, chunkSize: CHUNK_SIZE });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Upload single chunk ───────────────────────────────────────────────────────
router.post('/chunk', protect, requireAdmin, upload.single('chunk'), async (req: AuthRequest, res) => {
  try {
    const { uploadId, chunkIndex, totalChunks, hash } = req.body;
    if (!uploadId || chunkIndex === undefined || !req.file) {
      return res.status(400).json({ error: 'uploadId, chunkIndex, and chunk file required' });
    }

    const session = await UploadSession.findOne({ uploadId, owner: req.user!._id });
    if (!session) return res.status(404).json({ error: 'Upload session not found' });
    if (session.status !== 'active') return res.status(409).json({ error: 'Session not active' });

    // Rename to deterministic filename
    const destPath = path.join(session.tempDir, `chunk_${chunkIndex.toString().padStart(6, '0')}`);
    fs.renameSync(req.file.path, destPath);

    // Verify hash if provided
    let computedHash = '';
    if (hash) {
      const data = fs.readFileSync(destPath);
      computedHash = crypto.createHash('sha256').update(data).digest('hex');
      if (computedHash !== hash) {
        fs.unlinkSync(destPath);
        return res.status(400).json({ error: 'Chunk hash mismatch', expected: hash, got: computedHash });
      }
    }

    const alreadyReceived = session.receivedChunks.some(c => c.index === Number(chunkIndex));
    if (!alreadyReceived) {
      session.receivedChunks.push({
        index: Number(chunkIndex),
        size: req.file.size,
        hash: computedHash || hash || '',
        receivedAt: new Date(),
      });
      await session.save();
    }

    const received = session.receivedChunks.length;
    const total = session.totalChunks;

    res.json({
      chunkIndex: Number(chunkIndex),
      received,
      total,
      progress: Math.round((received / total) * 100),
      complete: received >= total,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Merge chunks + start pipeline ────────────────────────────────────────────
router.post('/merge', protect, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { uploadId } = req.body;
    const session = await UploadSession.findOne({ uploadId, owner: req.user!._id });
    if (!session) return res.status(404).json({ error: 'Session not found' });

    if (session.receivedChunks.length < session.totalChunks) {
      return res.status(400).json({
        error: 'Not all chunks received',
        received: session.receivedChunks.length,
        expected: session.totalChunks,
      });
    }

    session.status = 'merging';
    await session.save();

    const ext = path.extname(session.filename);
    const storageBase = process.env.STORAGE_LOCAL_PATH
      ? path.resolve(process.env.STORAGE_LOCAL_PATH)
      : path.join(__dirname, '..', '..', 'uploads');
    const videosDir = path.join(storageBase, 'videos');
    fs.mkdirSync(videosDir, { recursive: true });
    const outputPath = path.join(videosDir, `${uuidv4()}${ext}`);

    // Merge chunks sequentially using proper streaming (handles large files)
    const sortedChunks = [...session.receivedChunks].sort((a, b) => a.index - b.index);

    await new Promise<void>((resolve, reject) => {
      const writeStream = fs.createWriteStream(outputPath);
      writeStream.on('error', reject);
      writeStream.on('finish', resolve);

      (async () => {
        try {
          for (const chunk of sortedChunks) {
            const chunkPath = path.join(session.tempDir, `chunk_${chunk.index.toString().padStart(6, '0')}`);
            if (!fs.existsSync(chunkPath)) {
              throw new Error(`Missing chunk file: ${chunkPath}`);
            }
            await new Promise<void>((resolveChunk, rejectChunk) => {
              const readStream = fs.createReadStream(chunkPath);
              readStream.on('error', rejectChunk);
              readStream.on('end', () => resolveChunk());
              readStream.pipe(writeStream, { end: false });
            });
          }
          writeStream.end();
        } catch (err) {
          writeStream.destroy();
          reject(err);
        }
      })();
    });

    // Verify output file exists and has correct size
    const outStat = fs.statSync(outputPath);
    if (outStat.size === 0) {
      throw new Error('Merged file is empty');
    }
    console.log(`[upload] Merged ${sortedChunks.length} chunks → ${outputPath} (${outStat.size} bytes)`);

    // Create video record
    const video = await Video.create({
      title: session.filename.replace(ext, '').replace(/_/g, ' '),
      owner: session.owner,
      originalName: session.filename,
      mimeType: session.mimeType,
      sizeBytes: session.totalSize,
      originalPath: outputPath,
      status: 'processing',
    });

    session.status = 'done';
    session.videoId = video._id as any;
    await session.save();

    // Cleanup temp chunks
    fs.rmSync(session.tempDir, { recursive: true, force: true });

    // Start async encoding pipeline (non-blocking)
    startEncodingPipeline(video._id.toString(), outputPath, video.owner.toString());

    res.json({ videoId: video._id, message: 'Merge complete, encoding started' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Get session status ────────────────────────────────────────────────────────
router.get('/status/:uploadId', protect, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const session = await UploadSession.findOne({ uploadId: req.params.uploadId, owner: req.user!._id });
    if (!session) return res.status(404).json({ error: 'Not found' });
    res.json({
      uploadId: session.uploadId,
      status: session.status,
      received: session.receivedChunks.length,
      total: session.totalChunks,
      progress: Math.round((session.receivedChunks.length / session.totalChunks) * 100),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
