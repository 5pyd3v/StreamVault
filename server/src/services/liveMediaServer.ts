import { Server } from 'socket.io';
import { ChildProcess } from 'child_process';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import NodeMediaServer from 'node-media-server';
import {
  findChannelByStreamKey,
  setChannelLive,
  setChannelOffline,
  setChannelError,
} from '../db/liveChannels.js';
import { startLiveTranscode, captureChannelPosterIfMissing, recordingPathFor } from './liveEncoder.js';
import { handleRecordingFinished } from './liveRecording.js';
import { emitChannelLive, emitChannelOffline, emitChannelError } from '../socket/handlers.js';

/** Active ffmpeg transcode processes, keyed by channel id. */
const transcoders = new Map<string, ChildProcess>();
/** Active RTMP ingest session ids (node-media-server internal ids), keyed by channel id. */
const rtmpSessions = new Map<string, string>();
/** Current broadcast session id (the uuid used for recording/transcode file paths), keyed by channel id. */
const channelSessions = new Map<string, string>();
/** Pending offline/finalize teardown timers from donePublish, keyed by channel id -- cancelled if the same channel republishes within the grace window. */
const pendingTeardowns = new Map<string, { timer: NodeJS.Timeout; sessionId: string }>();
/** Session ids whose recording should be discarded (a reconnect made them stale) instead of finalized into a VOD. */
const discardedSessions = new Set<string>();
/** Channels currently being force-stopped by an admin -- skips the reconnect grace window so the UI reflects offline immediately. */
const forceStopping = new Set<string>();

let nms: NodeMediaServer | null = null;

/** Grace period for ffmpeg to flush the recording after the publisher disconnects. */
const FLUSH_TIMEOUT_MS = 15000;
/** How long to wait for the same stream key to republish before treating a disconnect as a real end-of-broadcast. */
const RECONNECT_GRACE_MS = Number(process.env.LIVE_RECONNECT_GRACE_MS) || 10000;

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

        // Reconnect within the grace window: cancel the pending offline
        // transition and discard the stale (partial) recording instead of
        // publishing it as a replay -- viewers never saw an "ended" event for
        // this blip, so there's nothing worth finalizing.
        const pending = pendingTeardowns.get(channelId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingTeardowns.delete(channelId);
          discardedSessions.add(pending.sessionId);
          log(`${channel.slug} reconnected within grace window — discarding stale session ${pending.sessionId}`);
        }

        const sessionId = uuidv4();
        channelSessions.set(channelId, sessionId);

        await setChannelLive(channel.id, sessionId);

        rtmpSessions.set(channelId, id);
        log(`🔴 ${channel.slug} is LIVE (session ${sessionId})`);
        // The row came back from a *WithKey lookup, so drop the secret before it
        // reaches the socket layer -- emitChannelLive broadcasts to every client.
        const { stream_key: _streamKey, ...safeChannel } = channel;
        emitChannelLive(io, safeChannel);

        let latestProc: ChildProcess;
        const proc = await startLiveTranscode(channel, sessionId, {
          onProcessReplaced: (newProc) => {
            latestProc = newProc;
            if (transcoders.has(channelId)) transcoders.set(channelId, newProc);
          },
          onExit: () => {
            if (transcoders.get(channelId) === latestProc) transcoders.delete(channelId);
            if (discardedSessions.delete(sessionId)) {
              const staleRecording = recordingPathFor(channelId, sessionId);
              try {
                if (fs.existsSync(staleRecording)) fs.unlinkSync(staleRecording);
              } catch (e: any) {
                console.error(`[live-rtmp] Failed to discard stale recording ${staleRecording}: ${e.message}`);
              }
            } else {
              void handleRecordingFinished(channelId, sessionId);
            }
          },
        });
        latestProc = proc;
        transcoders.set(channelId, proc);

        // Channels without a poster get one grabbed off their own HLS output as
        // soon as the first segment lands. Fire-and-forget by design — it must
        // never delay or fail the live-start flow.
        captureChannelPosterIfMissing(channelId);
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
  // Doesn't immediately flip the channel offline -- a brief OBS/network blip
  // shouldn't flash "stream ended" to every viewer or publish a few seconds of
  // replay. The channel only actually goes offline (and its recording gets
  // finalized) if nothing republishes with the same stream key within the
  // grace window; see postPublish's `pendingTeardowns` handling above.
  server.on('donePublish', (id, streamPath) => {
    void (async () => {
      const { streamKey } = parseStreamPath(streamPath);
      try {
        const channel = await findChannelByStreamKey(streamKey);
        if (!channel) return;

        const channelId = String(channel.id);
        const sessionId = channelSessions.get(channelId);
        rtmpSessions.delete(channelId);

        const goOffline = async () => {
          if (channelSessions.get(channelId) === sessionId) channelSessions.delete(channelId);
          await setChannelOffline(channel.id).catch(() => { /* best effort */ });
          log(`⚫ ${channel.slug} went offline (session ${id})`);
          emitChannelOffline(io, channelId);
        };

        if (forceStopping.delete(channelId)) {
          // Admin-initiated stop: reflect offline immediately, no grace window.
          pendingTeardowns.delete(channelId);
          await goOffline();
        } else {
          log(`${channel.slug} publisher disconnected (session ${id}) — waiting ${RECONNECT_GRACE_MS}ms for reconnect`);
          const timer = setTimeout(() => {
            pendingTeardowns.delete(channelId);
            void goOffline();
          }, RECONNECT_GRACE_MS);
          timer.unref?.();
          if (sessionId) pendingTeardowns.set(channelId, { sessionId, timer });
        }

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
  forceStopping.add(channelId); // donePublish skips the reconnect grace window for this channel

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

/** Channel ids with an active transcode process right now (for the admin diagnostics endpoint). */
export function listActiveChannelIds(): string[] {
  return Array.from(transcoders.keys());
}
