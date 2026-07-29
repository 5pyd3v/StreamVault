import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

import authRoutes from './routes/auth.js';
import videoRoutes from './routes/videos.js';
import uploadRoutes from './routes/upload.js';
import encodingRoutes from './routes/encoding.js';
import storageRoutes from './routes/storage.js';
import adminRoutes from './routes/admin.js';
import liveRoutes from './routes/live.js';
import { registerSocketHandlers } from './socket/handlers.js';
import { testConnection } from './db/pool.js';
import { findVideosByStatuses, updateVideo } from './db/videos.js';
import { deleteVideoStreams } from './db/videoStreams.js';
import { resetStuckLiveChannels } from './db/liveChannels.js';
import { deleteExpiredSessions } from './db/uploadSessions.js';
import { startEncodingPipeline } from './services/encoder.js';
import { startLiveMediaServer } from './services/liveMediaServer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ensure upload dirs exist (respects STORAGE_LOCAL_PATH)
const STORAGE_BASE = process.env.STORAGE_LOCAL_PATH
  ? path.resolve(process.env.STORAGE_LOCAL_PATH)
  : path.join(__dirname, '..', 'uploads');
['', 'temp', 'videos', 'thumbnails', 'hls', 'recordings', 'hls/live', 'posters']
  .forEach(sub => fs.mkdirSync(path.join(STORAGE_BASE, sub), { recursive: true }));

// Also keep temp dir separate if UPLOAD_TEMP_PATH is set
if (process.env.UPLOAD_TEMP_PATH) {
  fs.mkdirSync(path.resolve(process.env.UPLOAD_TEMP_PATH), { recursive: true });
}

const app = express();
const httpServer = createServer(app);

export const io = new Server(httpServer, {
  cors: { origin: process.env.CLIENT_URL || 'http://localhost:5173', credentials: true },
});

registerSocketHandlers(io);

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173', credentials: true }));
app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(STORAGE_BASE, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.m3u8')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache');
    } else if (filePath.endsWith('.ts')) {
      res.setHeader('Content-Type', 'video/mp2t');
    } else if (filePath.endsWith('.mp4')) {
      res.setHeader('Content-Type', 'video/mp4');
    }
  },
}));

// Rate limiters
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many auth attempts, please try again later' } });

app.use('/api/', apiLimiter);
app.use('/api/auth', authLimiter);
app.use('/api/auth',     authRoutes);
app.use('/api/videos',   videoRoutes);
app.use('/api/upload',   uploadRoutes);
app.use('/api/encoding', encodingRoutes);
app.use('/api/storage',  storageRoutes);
app.use('/api/admin',    adminRoutes);
app.use('/api/live',     liveRoutes);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

const PORT = Number(process.env.PORT) || 5001;

testConnection().then(async () => {
  console.log('✅ MySQL connected');
  httpServer.listen(PORT, () => console.log(`🚀 StreamVault API → http://localhost:${PORT}`));

  // RTMP ingest for OBS (transcoding + HLS output handled by our own ffmpeg pipeline)
  try {
    startLiveMediaServer(io);
  } catch (e: any) {
    console.error('❌ Live media server failed to start:', e.message);
  }

  // No broadcast can survive a restart — clear stale live state
  try {
    await resetStuckLiveChannels();
  } catch (e: any) {
    console.error('Live channel reset error:', e.message);
  }

  // Resume any videos stuck in processing/encoding from a previous crashed run
  try {
    const stuck = await findVideosByStatuses(['processing', 'encoding']);
    for (const v of stuck) {
      const videoId = String(v.id);
      if (v.original_path && fs.existsSync(v.original_path)) {
        console.log(`♻️  Resuming stuck encode: ${videoId}`);
        await deleteVideoStreams(videoId);
        await updateVideo(videoId, { encodingProgress: 0, encodingStage: 'Resuming after restart', encodingError: null });
        startEncodingPipeline(videoId, v.original_path, String(v.owner_id));
      } else {
        console.warn(`⚠️  Marking as failed (source missing): ${videoId}`);
        await updateVideo(videoId, { status: 'failed', encodingError: 'Source file missing after server restart' });
      }
    }
  } catch (e: any) {
    console.error('Resume-stuck error:', e.message);
  }

  // MongoDB had a TTL index auto-deleting expired upload sessions; MySQL has no
  // equivalent, so run the same cleanup on a timer instead.
  setInterval(() => {
    deleteExpiredSessions().catch(e => console.error('Expired-session cleanup error:', e.message));
  }, 60 * 60 * 1000).unref();
}).catch(err => { console.error('❌ MySQL failed:', err.message); process.exit(1); });
