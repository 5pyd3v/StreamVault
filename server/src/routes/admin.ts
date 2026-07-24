import express from 'express';
import fs from 'fs';
import User from '../models/User.js';
import Video from '../models/Video.js';
import UploadSession from '../models/UploadSession.js';
import { protect, requireAdmin, AuthRequest } from '../middleware/auth.js';

const router = express.Router();

router.use(protect, requireAdmin);

// ── Users ─────────────────────────────────────────────────────────────────────
router.get('/users', async (_req, res) => {
  try {
    const users = await User.find().select('-password -otp -twoFactorSecret').sort('-createdAt');
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
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { ...(role !== undefined && { role }), ...(active !== undefined && { active }) },
      { new: true }
    ).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/users/:id', async (req: AuthRequest, res) => {
  try {
    if (req.params.id === req.user!._id.toString()) {
      return res.status(400).json({ error: 'Cannot delete own account' });
    }
    await User.findByIdAndDelete(req.params.id);
    res.json({ message: 'User deleted' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Platform stats ────────────────────────────────────────────────────────────
router.get('/stats', async (_req, res) => {
  try {
    const [users, videos, sessions] = await Promise.all([
      User.countDocuments(),
      Video.countDocuments(),
      UploadSession.countDocuments({ status: 'active' }),
    ]);
    const failedJobs = await Video.countDocuments({ status: 'failed' });
    const encodingJobs = await Video.countDocuments({ status: 'encoding' });
    res.json({ users, videos, activeSessions: sessions, failedJobs, encodingJobs });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Cleanup orphaned videos (missing files on disk) ──────────────────────────
router.post('/cleanup', async (_req, res) => {
  try {
    const videos = await Video.find();
    const orphans: string[] = [];
    for (const v of videos) {
      const hasOriginal = v.originalPath && fs.existsSync(v.originalPath);
      const hasHls = v.hlsPath && fs.existsSync(v.hlsPath);
      if (!hasOriginal && !hasHls) {
        orphans.push(v._id.toString());
        await v.deleteOne();
      }
    }
    // Also purge stale upload sessions
    const staleSessions = await UploadSession.deleteMany({ status: { $in: ['done', 'error'] } });
    res.json({ removed: orphans.length, orphanIds: orphans, staleSessions: staleSessions.deletedCount });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
