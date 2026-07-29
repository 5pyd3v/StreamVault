import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { storageStats, largestPublishedVideos } from '../db/videos.js';
import { protect, requireAdmin, AuthRequest } from '../middleware/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = express.Router();

// Site-wide storage aggregates are ops data — admin only (matches admin.ts).
router.use(protect, requireAdmin);

function getUploadsDir(): string {
  return process.env.STORAGE_LOCAL_PATH
    ? path.resolve(process.env.STORAGE_LOCAL_PATH)
    : path.join(__dirname, '..', '..', 'uploads');
}

// Same disk-path -> /uploads/... conversion videos.ts does. It isn't shared
// because the storage-base helper isn't either: each router keeps its own copy,
// so this follows the pattern already in place rather than introducing a module.
function toUrl(fsPath: string | undefined | null): string {
  if (!fsPath) return '';
  const base = getUploadsDir();
  let rel: string;
  if (path.isAbsolute(fsPath)) {
    rel = path.relative(base, fsPath).replace(/\\/g, '/');
  } else {
    rel = fsPath.replace(/\\/g, '/');
  }
  return rel.startsWith('..') ? '' : `/uploads/${rel}`;
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

router.get('/stats', async (_req: AuthRequest, res) => {
  try {
    const { totalVideos, totalSizeBytes } = await storageStats();

    const diskUsed = dirSize(getUploadsDir());

    res.json({
      totalVideos,
      totalSizeBytes,
      diskUsedBytes: diskUsed,
      provider: process.env.STORAGE_PROVIDER || 'local',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/largest', async (_req, res) => {
  try {
    const rows = await largestPublishedVideos(10);
    // The old response was raw Mongoose docs from `.select('title sizeBytes
    // thumbnailPath')`, i.e. `_id` + those three camelCase fields — reproduced
    // here from the snake_case columns. `thumbnailUrl` is added alongside (not
    // instead of) `thumbnailPath`, so existing consumers are unaffected.
    res.json(rows.map(row => ({
      _id: String(row.id),
      title: row.title,
      sizeBytes: Number(row.size_bytes),
      thumbnailPath: row.thumbnail_path,
      thumbnailUrl: toUrl(row.thumbnail_path),
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
