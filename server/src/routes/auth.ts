import express from 'express';
import jwt from 'jsonwebtoken';
import {
  findUserById,
  findUserByEmail,
  createUser,
  countUsers,
  comparePassword,
  updateLastLogin,
  updatePassword,
  toPublicUser,
} from '../db/users.js';
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

    const exists = await findUserByEmail(email);
    if (exists) return res.status(409).json({ error: 'Email already registered' });

    // First user becomes admin
    const count = await countUsers();
    const created = await createUser({ name, email, password, organization, role: count === 0 ? 'admin' : 'viewer' });

    await updateLastLogin(created.id);
    // Re-read so the response carries the freshly stamped lastLogin, exactly like
    // the old `user.lastLogin = new Date(); await user.save();` did.
    const row = (await findUserById(created.id)) ?? created;

    const id = String(created.id);
    const token = signToken(id);
    const refreshToken = signRefresh(id);

    res.status(201).json({ token, refreshToken, user: toPublicUser(row) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Login ─────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const found = await findUserByEmail(email);
    if (!found || !(await comparePassword(password, found.password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (!found.active) return res.status(403).json({ error: 'Account suspended' });

    await updateLastLogin(found.id);
    const row = (await findUserById(found.id)) ?? found;

    const id = String(found.id);
    const token = signToken(id);
    const refreshToken = signRefresh(id);

    res.json({ token, refreshToken, user: toPublicUser(row) });
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
    const user = await findUserById(decoded.id);
    if (!user) return res.status(401).json({ error: 'User not found' });
    res.json({ token: signToken(String(user.id)) });
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

    const user = await findUserById(req.user!._id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const valid = await comparePassword(currentPassword, user.password);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    await updatePassword(user.id, newPassword);
    res.json({ message: 'Password changed successfully' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
