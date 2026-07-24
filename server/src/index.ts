import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import mongoose from 'mongoose';
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
import { registerSocketHandlers } from './socket/handlers.js';
import Video from './models/Video.js';
import { startEncodingPipeline } from './services/encoder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ensure upload dirs exist (respects STORAGE_LOCAL_PATH)
const STORAGE_BASE = process.env.STORAGE_LOCAL_PATH
  ? path.resolve(process.env.STORAGE_LOCAL_PATH)
  : path.join(__dirname, '..', 'uploads');
['', 'temp', 'videos', 'thumbnails', 'hls']
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

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

const PORT = Number(process.env.PORT) || 5001;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/streamvault';

mongoose.connect(MONGO_URI).then(async () => {
  console.log('✅ MongoDB connected');
  httpServer.listen(PORT, () => console.log(`🚀 StreamVault API → http://localhost:${PORT}`));

  // Resume any videos stuck in processing/encoding from a previous crashed run
  try {
    const stuck = await Video.find({ status: { $in: ['processing', 'encoding'] } });
    for (const v of stuck) {
      if (v.originalPath && fs.existsSync(v.originalPath)) {
        console.log(`♻️  Resuming stuck encode: ${v._id}`);
        v.encodingProgress = 0;
        v.encodingStage = 'Resuming after restart';
        v.encodingError = undefined;
        v.streams = [] as any;
        await v.save();
        startEncodingPipeline(v._id.toString(), v.originalPath, v.owner.toString());
      } else {
        console.warn(`⚠️  Marking as failed (source missing): ${v._id}`);
        v.status = 'failed';
        v.encodingError = 'Source file missing after server restart';
        await v.save();
      }
    }
  } catch (e: any) {
    console.error('Resume-stuck error:', e.message);
  }
}).catch(err => { console.error('❌ MongoDB failed:', err.message); process.exit(1); });
