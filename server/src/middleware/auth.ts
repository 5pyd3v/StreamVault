import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { findUserById, toPublicUser, PublicUser } from '../db/users.js';

export interface AuthRequest extends Request {
  user?: PublicUser;
}

export const protect = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { id: string };
    // MySQL stores `active` as TINYINT(1) -> check the raw 0/1 before shaping.
    const row = await findUserById(decoded.id);
    if (!row || !row.active) return res.status(401).json({ error: 'Unauthorized' });
    req.user = toPublicUser(row);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

export const requireAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
};

export const requireEditor = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!['admin', 'editor'].includes(req.user?.role || '')) {
    return res.status(403).json({ error: 'Editor access required' });
  }
  next();
};
