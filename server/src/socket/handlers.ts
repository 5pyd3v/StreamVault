import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { findUserById, toPublicUser } from '../db/users.js';

export function registerSocketHandlers(io: Server): void {
  // Authenticate socket connections
  io.use(async (socket: Socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error('Authentication required'));
    try {
      const decoded = jwt.verify(String(token), process.env.JWT_SECRET!) as { id: string };
      const row = await findUserById(decoded.id);
      if (!row) return next(new Error('User not found'));
      // Same minimal projection the old `.select('_id name email role')` produced.
      const { _id, name, email, role } = toPublicUser(row);
      (socket as any).user = { _id, name, email, role };
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

    // Client can request a specific live channel room to receive live events
    socket.on('watch:channel', (channelId: string) => {
      socket.join(`channel:${channelId}`);
    });

    socket.on('unwatch:channel', (channelId: string) => {
      socket.leave(`channel:${channelId}`);
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

// ── Live channel events (called from the live media server / live encoder) ────
// Strip the secret stream key before anything leaves the process. `channel`
// is now a raw MySQL row (snake_case `stream_key`, numeric `id`, no `_id`) --
// callers like `liveMediaServer.ts`'s postPublish pass rows straight from
// `findChannelByStreamKey`, which explicitly includes the key.
function publicChannel(channel: any): any {
  const obj = { ...channel };
  delete obj.stream_key;
  delete obj.streamKey; // defensive: harmless no-op if a caller ever passes an already-shaped object instead
  return obj;
}

// Emit a channel going live (broadcast globally so browse pages react without subscribing)
export function emitChannelLive(io: Server, channel: any): void {
  const safe = publicChannel(channel);
  const channelId = String(channel.id ?? channel._id);
  const event = { channelId, channel: safe, ts: new Date().toISOString() };
  io.to(`channel:${channelId}`).emit('live:started', event);
  io.to('admin').emit('live:started', event);
  io.emit('live:started', event);
}

export function emitChannelOffline(io: Server, channelId: string): void {
  const event = { channelId, ts: new Date().toISOString() };
  io.to(`channel:${channelId}`).emit('live:ended', event);
  io.to('admin').emit('live:ended', event);
  io.emit('live:ended', event);
}

export function emitChannelError(io: Server, channelId: string, error: string): void {
  const event = { channelId, error, ts: new Date().toISOString() };
  io.to(`channel:${channelId}`).emit('live:error', event);
  io.to('admin').emit('live:error', event);
  io.emit('live:error', event);
}
