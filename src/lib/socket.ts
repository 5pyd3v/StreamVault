import { io, Socket } from "socket.io-client";
import { getToken } from "./api";

export interface EncodingProgressEvent {
  videoId: string;
  stage: string;
  progress: number;
  detail?: string;
  ts: string;
}

export interface EncodingDoneEvent {
  videoId: string;
  video: unknown;
  ts: string;
}

export interface EncodingErrorEvent {
  videoId: string;
  error: string;
  ts: string;
}

/**
 * `live:started` carries the raw LiveChannel document (minus the stream key),
 * *not* the `publicShape` the REST endpoints return — so it has `posterPath`
 * rather than `posterUrl` and never carries `hlsUrl`. Consumers should treat
 * `channel` as advisory and derive the playlist URL from `channelId`
 * (see `liveHlsUrlFor` in lib/api).
 */
export interface LiveStartedEvent {
  channelId: string;
  channel?: {
    _id?: string;
    name?: string;
    slug?: string;
    description?: string;
    category?: string;
    status?: string;
    liveStartedAt?: string;
    [key: string]: unknown;
  };
  ts: string;
}

export interface LiveEndedEvent {
  channelId: string;
  ts: string;
}

export interface LiveErrorEvent {
  channelId: string;
  error: string;
  ts: string;
}

let _socket: Socket | null = null;

export function getSocket(): Socket {
  if (!_socket) {
    _socket = io("/", {
      auth: { token: getToken() },
      autoConnect: false,
      transports: ["websocket", "polling"],
    });
  }
  return _socket;
}

export function connectSocket(): void {
  const socket = getSocket();
  // Update auth token in case it changed (e.g. after login)
  socket.auth = { token: getToken() };
  if (!socket.connected) socket.connect();
}

export function disconnectSocket(): void {
  _socket?.disconnect();
  _socket = null;
}

export function watchVideo(videoId: string): void {
  getSocket().emit("watch:video", videoId);
}

export function unwatchVideo(videoId: string): void {
  getSocket().emit("unwatch:video", videoId);
}

// ── Live channel rooms (mirror of the watch:video pattern above) ──────────────

export function watchChannel(channelId: string): void {
  getSocket().emit("watch:channel", channelId);
}

export function unwatchChannel(channelId: string): void {
  getSocket().emit("unwatch:channel", channelId);
}
