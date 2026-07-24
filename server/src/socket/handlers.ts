import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';

export function registerSocketHandlers(io: Server): void {
  // Authenticate socket connections
  io.use(async (socket: Socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error('Authentication required'));
    try {
      const decoded = jwt.verify(String(token), process.env.JWT_SECRET!) as { id: string };
      const user = await User.findById(decoded.id).select('_id name email role');
      if (!user) return next(new Error('User not found'));
      (socket as any).user = user;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const user = (socket as any).user;
    console.log(`[Socket] Connected: ${user.email}`);

    // Join user's personal room for targeted updates
    socket.join(`user:${user._id}`);

    // Admins join the admin room for global events
    if (user.role === 'admin') socket.join('admin');

    socket.on('disconnect', () => {
      console.log(`[Socket] Disconnected: ${user.email}`);
    });

    // Client can request specific video room to receive encoding events
    socket.on('watch:video', (videoId: string) => {
      socket.join(`video:${videoId}`);
    });

    socket.on('unwatch:video', (videoId: string) => {
      socket.leave(`video:${videoId}`);
    });
  });
}

// Emit encoding progress (called from encoder service)
export function emitEncodingProgress(
  io: Server,
  videoId: string,
  ownerId: string,
  payload: {
    stage: string;
    progress: number;
    detail?: string;
    streams?: any[];
  }
): void {
  const event = { videoId, ...payload, ts: new Date().toISOString() };
  io.to(`video:${videoId}`).emit('encoding:progress', event);
  io.to(`user:${ownerId}`).emit('encoding:progress', event);
  io.to('admin').emit('encoding:progress', event);
}

export function emitEncodingDone(io: Server, videoId: string, ownerId: string, video: any): void {
  const event = { videoId, video, ts: new Date().toISOString() };
  io.to(`video:${videoId}`).emit('encoding:done', event);
  io.to(`user:${ownerId}`).emit('encoding:done', event);
  io.to('admin').emit('encoding:done', event);
}

export function emitEncodingError(io: Server, videoId: string, ownerId: string, error: string): void {
  const event = { videoId, error, ts: new Date().toISOString() };
  io.to(`video:${videoId}`).emit('encoding:error', event);
  io.to(`user:${ownerId}`).emit('encoding:error', event);
  io.to('admin').emit('encoding:error', event);
}
