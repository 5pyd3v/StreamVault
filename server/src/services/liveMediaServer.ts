import { Server } from 'socket.io';
import { ChildProcess } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import NodeMediaServer from 'node-media-server';
import {
  findChannelByStreamKey,
  setChannelLive,
  setChannelOffline,
  setChannelError,
} from '../db/liveChannels.js';
import { startLiveTranscode, captureChannelPosterIfMissing } from './liveEncoder.js';
import { handleRecordingFinished } from './liveRecording.js';
import { emitChannelLive, emitChannelOffline, emitChannelError } from '../socket/handlers.js';

/** Active ffmpeg transcode processes, keyed by channel id. */
const transcoders = new Map<string, ChildProcess>();
/** Active RTMP ingest session ids (node-media-server internal ids), keyed by channel id. */
const rtmpSessions = new Map<string, string>();

let nms: NodeMediaServer | null = null;

/** Grace period for ffmpeg to flush the recording after the publisher disconnects. */
const FLUSH_TIMEOUT_MS = 15000;

function log(message: string): void {
  console.log(`[live-rtmp] ${message}`);
}

/** streamPath looks like "/live/<streamKey>". */
function parseStreamPath(streamPath: string): { app: string; streamKey: string } {
  const parts = String(streamPath || '').split('/').filter(Boolean);
  return { app: parts[0] || '', streamKey: parts[1] || '' };
}

function rejectSession(id: string, reason: string): void {
  log(`Rejecting session ${id}: ${reason}`);
  try {
    nms?.getSession(id)?.reject();
  } catch (e: any) {
    console.error(`[live-rtmp] Failed to reject session ${id}: ${e.message}`);
  }
}

/**
 * Starts the RTMP ingest server.
 *
 * Config intentionally contains ONLY an `rtmp` block: node-media-server's run()
 * starts a sub-server per config key present, so omitting `http`/`trans` means
 * it never opens a second HTTP port and never uses its own limited transcoder.
 * All transcoding is our own ffmpeg spawn (see liveEncoder.ts) and the HLS
 * output is served by the existing Express static /uploads route.
 */
export function startLiveMediaServer(io: Server): NodeMediaServer {
  const port = Number(process.env.RTMP_PORT) || 1935;

  const server = new NodeMediaServer({
    rtmp: {
      port,
      chunk_size: 60000,
      gop_cache: true,
      ping: 30,
      ping_timeout: 60,
    },
  });
  nms = server;

  // ── prePublish: authenticate the stream key before accepting the ingest ────
  server.on('prePublish', (id, streamPath) => {
    void (async () => {
      const { app, streamKey } = parseStreamPath(streamPath);
      if (!streamKey) return rejectSession(id, 'missing stream key');
      try {
        const channel = await findChannelByStreamKey(streamKey);
        if (!channel) return rejectSession(id, 'unknown stream key');
        if (!channel.is_enabled) return rejectSession(id, `channel "${channel.slug}" is disabled`);
        if (channel.rtmp_app && channel.rtmp_app !== app) {
          return rejectSession(id, `wrong rtmp app "${app}" (expected "${channel.rtmp_app}")`);
        }
        log(`Accepted publish for channel "${channel.slug}" (session ${id})`);
      } catch (err: any) {
        console.error(`[live-rtmp] prePublish lookup failed: ${err.message}`);
        rejectSession(id, 'lookup failure');
      }
    })();
  });

  // ── postPublish: flip the channel live and kick off the transcode ──────────
  server.on('postPublish', (id, streamPath) => {
    void (async () => {
      const { streamKey } = parseStreamPath(streamPath);
      let channelId = '';
      try {
        const channel = await findChannelByStreamKey(streamKey);
        if (!channel) return rejectSession(id, 'unknown stream key');

        channelId = String(channel.id);
        const sessionId = uuidv4();

        await setChannelLive(channel.id, sessionId);

        rtmpSessions.set(channelId, id);
        log(`🔴 ${channel.slug} is LIVE (session ${sessionId})`);
        // The row came back from a *WithKey lookup, so drop the secret before it
        // reaches the socket layer -- emitChannelLive broadcasts to every client.
        const { stream_key: _streamKey, ...safeChannel } = channel;
        emitChannelLive(io, safeChannel);

        const proc = startLiveTranscode(channel, sessionId);
        transcoders.set(channelId, proc);

        // Channels without a poster get one grabbed off their own HLS output as
        // soon as the first segment lands. Fire-and-forget by design — it must
        // never delay or fail the live-start flow.
        captureChannelPosterIfMissing(channelId);

        proc.on('close', () => {
          if (transcoders.get(channelId) === proc) transcoders.delete(channelId);
          void handleRecordingFinished(channelId, sessionId);
        });
      } catch (err: any) {
        console.error(`[live-rtmp] postPublish failed: ${err.message}`);
        if (channelId) {
          await setChannelError(channelId, err.message).catch(() => { /* best effort */ });
          emitChannelError(io, channelId, err.message);
        }
        rejectSession(id, 'startup failure');
      }
    })();
  });

  // ── donePublish: publisher disconnected ───────────────────────────────────
  server.on('donePublish', (id, streamPath) => {
    void (async () => {
      const { streamKey } = parseStreamPath(streamPath);
      try {
        const channel = await findChannelByStreamKey(streamKey);
        if (!channel) return;

        const channelId = String(channel.id);
        await setChannelOffline(channel.id);

        rtmpSessions.delete(channelId);
        log(`⚫ ${channel.slug} went offline (session ${id})`);
        emitChannelOffline(io, channelId);

        // ffmpeg normally exits on its own once the loopback pull hits EOF, which
        // is what flushes the recording cleanly. Only force it if it hangs around.
        const proc = transcoders.get(channelId);
        if (proc) {
          setTimeout(() => {
            if (transcoders.get(channelId) === proc && !proc.killed) {
              log(`ffmpeg for ${channelId} did not exit within ${FLUSH_TIMEOUT_MS}ms — terminating`);
              try { proc.kill(); } catch { /* already gone */ }
            }
          }, FLUSH_TIMEOUT_MS).unref?.();
        }
      } catch (err: any) {
        console.error(`[live-rtmp] donePublish failed: ${err.message}`);
      }
    })();
  });

  server.run();
  log(`RTMP ingest listening on rtmp://0.0.0.0:${port}/live`);
  return server;
}

/**
 * Force-stop a channel's broadcast: kicks the RTMP publisher (so a revoked key
 * can't keep streaming) and terminates the transcode process. Returns true when
 * something was actually stopped.
 */
export function stopChannelStream(channelId: string): boolean {
  let stopped = false;

  const sessionId = rtmpSessions.get(channelId);
  if (sessionId) {
    try {
      nms?.getSession(sessionId)?.reject();
      stopped = true;
    } catch (e: any) {
      console.error(`[live-rtmp] Failed to kick session ${sessionId}: ${e.message}`);
    }
    rtmpSessions.delete(channelId);
  }

  const proc = transcoders.get(channelId);
  if (proc) {
    try {
      proc.kill();
      stopped = true;
    } catch (e: any) {
      console.error(`[live-rtmp] Failed to kill transcoder for ${channelId}: ${e.message}`);
    }
    transcoders.delete(channelId);
  }

  if (stopped) log(`Force-stopped channel ${channelId}`);
  return stopped;
}

/** True when a transcode process is currently running for this channel. */
export function isChannelStreaming(channelId: string): boolean {
  return transcoders.has(channelId);
}
