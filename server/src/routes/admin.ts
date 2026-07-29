import express from 'express';
import fs from 'fs';
import { listUsers, updateUserRoleActive, deleteUser, countUsers, toPublicUser } from '../db/users.js';
import { videoStats, deleteVideo } from '../db/videos.js';
import { countActiveSessions, deleteStaleSessions } from '../db/uploadSessions.js';
import { pool } from '../db/pool.js';
import type { RowDataPacket } from 'mysql2';
import { protect, requireAdmin, AuthRequest } from '../middleware/auth.js';

const router = express.Router();

router.use(protect, requireAdmin);

// ── Users ─────────────────────────────────────────────────────────────────────
router.get('/users', async (_req, res) => {
  try {
    // `toPublicUser` already strips password / twoFactorSecret / rememberTokens,
    // matching the old `.select('-password -otp -twoFactorSecret')`.
    const users = (await listUsers()).map(toPublicUser);
    res.json(users);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/users/:id', async (req: AuthRequest, res) => {
  try {
    if (req.params.id === req.user!._id.toString()) {
      return res.status(400).json({ error: 'Cannot modify own role' });
    }
    const { role, active } = req.body;
    const user = await updateUserRoleActive(req.params.id, {
      ...(role !== undefined && { role }),
      ...(active !== undefined && { active }),
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(toPublicUser(user));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/users/:id', async (req: AuthRequest, res) => {
  try {
    if (req.params.id === req.user!._id.toString()) {
      return res.status(400).json({ error: 'Cannot delete own account' });
    }
    await deleteUser(req.params.id);
    res.json({ message: 'User deleted' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Platform stats ────────────────────────────────────────────────────────────
router.get('/stats', async (_req, res) => {
  try {
    const [users, sessions, stats] = await Promise.all([
      countUsers(),
      countActiveSessions(),
      videoStats(null), // null = every owner, admin-wide totals
    ]);
    res.json({
      users,
      videos: stats.total,
      activeSessions: sessions,
      failedJobs: stats.byStatus['failed'] || 0,
      encodingJobs: stats.byStatus['encoding'] || 0,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Cleanup orphaned videos (missing files on disk) ──────────────────────────
router.post('/cleanup', async (_req, res) => {
  try {
    const [rows] = await pool.query<RowDataPacket[]>('SELECT id, original_path, hls_path FROM videos');
    const orphans: string[] = [];
    for (const v of rows) {
      const hasOriginal = v.original_path && fs.existsSync(v.original_path);
      const hasHls = v.hls_path && fs.existsSync(v.hls_path);
      if (!hasOriginal && !hasHls) {
        orphans.push(String(v.id));
        await deleteVideo(v.id);
      }
    }
    // Also purge stale upload sessions
    const staleSessions = await deleteStaleSessions();
    res.json({ removed: orphans.length, orphanIds: orphans, staleSessions });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
