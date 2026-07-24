import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Video from '../models/Video.js';
import { protect, AuthRequest } from '../middleware/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = express.Router();

function getUploadsDir(): string {
  return process.env.STORAGE_LOCAL_PATH
    ? path.resolve(process.env.STORAGE_LOCAL_PATH)
    : path.join(__dirname, '..', '..', 'uploads');
}

function dirSize(dirPath: string): number {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}

router.get('/stats', protect, async (_req: AuthRequest, res) => {
  try {
    const [agg] = await Video.aggregate([
      { $group: { _id: null, totalSize: { $sum: '$sizeBytes' }, count: { $sum: 1 } } },
    ]);

    const diskUsed = dirSize(getUploadsDir());

    res.json({
      totalVideos: agg?.count || 0,
      totalSizeBytes: agg?.totalSize || 0,
      diskUsedBytes: diskUsed,
      provider: process.env.STORAGE_PROVIDER || 'local',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/largest', protect, async (_req, res) => {
  try {
    const videos = await Video.find({ status: 'published' })
      .select('title sizeBytes thumbnailPath')
      .sort('-sizeBytes')
      .limit(10);
    res.json(videos);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
