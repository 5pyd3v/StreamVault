import express from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { protect, AuthRequest } from '../middleware/auth.js';

const router = express.Router();

const signToken = (id: string) =>
  jwt.sign({ id }, process.env.JWT_SECRET!, { expiresIn: (process.env.JWT_EXPIRES_IN || '7d') as any });

const signRefresh = (id: string) =>
  jwt.sign({ id }, process.env.JWT_REFRESH_SECRET!, { expiresIn: (process.env.JWT_REFRESH_EXPIRES_IN || '30d') as any });

// ── Register ──────────────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, organization } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password are required' });

    const exists = await User.findOne({ email });
    if (exists) return res.status(409).json({ error: 'Email already registered' });

    // First user becomes admin
    const count = await User.countDocuments();
    const user = await User.create({ name, email, password, organization, role: count === 0 ? 'admin' : 'viewer' });

    user.lastLogin = new Date();
    await user.save();

    const token = signToken(user.id);
    const refreshToken = signRefresh(user.id);

    res.status(201).json({ token, refreshToken, user });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Login ─────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = await User.findOne({ email }).select('+password');
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (!user.active) return res.status(403).json({ error: 'Account suspended' });

    user.lastLogin = new Date();
    await user.save();

    const token = signToken(user.id);
    const refreshToken = signRefresh(user.id);

    res.json({ token, refreshToken, user });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Refresh token ─────────────────────────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(401).json({ error: 'No refresh token' });
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET!) as { id: string };
    const user = await User.findById(decoded.id);
    if (!user) return res.status(401).json({ error: 'User not found' });
    res.json({ token: signToken(user.id) });
  } catch {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// ── Me ────────────────────────────────────────────────────────────────────────
router.get('/me', protect, (req: AuthRequest, res) => {
  res.json(req.user);
});

// ── Change password ───────────────────────────────────────────────────────────
router.post('/change-password', protect, async (req: AuthRequest, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword are required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    const user = await User.findById(req.user!._id).select('+password');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const valid = await user.comparePassword(currentPassword);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    user.password = newPassword;
    await user.save();
    res.json({ message: 'Password changed successfully' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;