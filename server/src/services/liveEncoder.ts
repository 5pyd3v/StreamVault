import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import LiveChannel, { ILiveChannel } from '../models/LiveChannel.js';
import { io } from '../index.js';
import { emitChannelError } from '../socket/handlers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function storageDir(...parts: string[]): string {
  const base = process.env.STORAGE_LOCAL_PATH
    ? path.resolve(process.env.STORAGE_LOCAL_PATH)
    : path.join(__dirname, '..', '..', 'uploads');
  return path.join(base, ...parts);
}

const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';

/**
 * Live rendition ladder. Scale/bitrate values mirror encoder.ts's QUALITIES so
 * VOD and live look consistent — but live only runs the rungs listed in
 * LIVE_QUALITIES (default 360p + 480p + 720p), never the full 4-rung VOD
 * ladder, since simultaneous live x264 encodes don't scale like sequential
 * VOD jobs.
 *
 * The default deliberately does NOT include the 'source' passthrough rung
 * anymore. 'source' is a `-c:v copy` of OBS's raw output with no forced
 * keyframes (a stream copy can't be re-keyframed), so its segment/keyframe
 * boundaries don't line up with the transcoded rungs', which use a shared
 * `-force_key_frames` expression to stay frame-aligned with each other. When
 * hls.js's ABR switches between two renditions whose boundaries don't match,
 * the switch can briefly re-decode overlapping audio -- heard as doubled or
 * (compounding on repeated switches) tripled audio. All-transcoded, all
 * frame-aligned rungs is what makes a clean, glitch-free live ABR switch
 * possible; 'source' is still supported for anyone who wants a zero-CPU top
 * tier and accepts that tradeoff, just no longer the default.
 */
interface LiveRendition {
  name: string;
  /** Empty for the passthrough ('source') rendition. */
  scale: string;
  bitrate: string;
  maxrate: string;
  bufsize: string;
}

const LIVE_QUALITY_PRESETS: Record<string, Omit<LiveRendition, 'name'>> = {
  '360p': { scale: '640:360',  bitrate: '600k',  maxrate: '660k',  bufsize: '1200k' },
  '480p': { scale: '854:480',  bitrate: '1200k', maxrate: '1320k', bufsize: '2400k' },
  '720p': { scale: '1280:720', bitrate: '2400k', maxrate: '2640k', bufsize: '4800k' },
};

const SOURCE_RENDITION: LiveRendition = { name: 'source', scale: '', bitrate: '', maxrate: '', bufsize: '' };

function log(channelId: string, message: string): void {
  console.log(`[live:${channelId}] ${message}`);
}

/** Parse LIVE_QUALITIES into an ordered, de-duplicated rendition list. */
export function resolveRenditions(): LiveRendition[] {
  const raw = (process.env.LIVE_QUALITIES || '360p,480p,720p')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  const seen = new Set<string>();
  const renditions: LiveRendition[] = [];
  for (const name of raw) {
    if (seen.has(name)) continue;
    if (name === 'source') {
      seen.add(name);
      renditions.push(SOURCE_RENDITION);
    } else if (LIVE_QUALITY_PRESETS[name]) {
      seen.add(name);
      renditions.push({ name, ...LIVE_QUALITY_PRESETS[name] });
    } else {
      console.warn(`[live] Unknown LIVE_QUALITIES entry "${name}" — ignored`);
    }
  }
  return renditions.length > 0 ? renditions : [SOURCE_RENDITION];
}

/** Absolute path of the per-channel live HLS master playlist. */
export function liveHlsMasterPath(channelId: string): string {
  return storageDir('hls', 'live', channelId, 'master.m3u8');
}

/** Absolute path of a broadcast's raw recording. */
export function recordingPathFor(channelId: string, sessionId: string): string {
  return storageDir('recordings', channelId, `${sessionId}.mp4`);
}

/**
 * Absolute path of a channel's *auto-captured* poster. Admin-uploaded posters
 * deliberately use a different filename (`{id}_{timestamp}.{ext}`) so the two
 * can never overwrite each other.
 */
export function autoPosterPathFor(channelId: string): string {
  return storageDir('posters', `${channelId}.jpg`);
}

async function markChannelError(channelId: string, message: string): Promise<void> {
  try {
    await LiveChannel.findByIdAndUpdate(channelId, {
      status: 'error',
      lastError: message,
      liveHlsPath: '',
    });
  } catch (e: any) {
    console.error(`[live:${channelId}] Failed to persist error state: ${e.message}`);
  }
  emitChannelError(io, channelId, message);
}

/**
 * Spawn the single ffmpeg process that re-pulls the just-published RTMP stream
 * over loopback and fans it out into (a) a fragmented-MP4 recording tee and
 * (b) a multi-variant live HLS ladder under uploads/hls/live/{channelId}.
 */
export function startLiveTranscode(channel: ILiveChannel, sessionId: string): ChildProcess {
  const channelId = String(channel._id);
  const renditions = resolveRenditions();
  const segTime = Number(process.env.LIVE_HLS_SEGMENT_TIME) || 4;
  // DVR window: how far back a viewer can seek before segments roll off and
  // get deleted from disk. Too small (the old hardcoded 6 segments / ~24s)
  // means any backward seek almost immediately targets an already-deleted
  // segment, which forces hls.js to snap back to the live edge -- that's the
  // "rewind doesn't work" bug. list_size is derived from a seconds budget so
  // it stays correct regardless of segment duration.
  const dvrSeconds = Number(process.env.LIVE_HLS_DVR_SECONDS) || 180;
  const listSize = Math.max(6, Math.ceil(dvrSeconds / segTime));
  const rtmpPort = Number(process.env.RTMP_PORT) || 1935;
  const rtmpApp = channel.rtmpApp || 'live';
  const inputUrl = `rtmp://127.0.0.1:${rtmpPort}/${rtmpApp}/${channel.streamKey}`;

  // Recording target — one file per broadcast session
  const recordDir = storageDir('recordings', channelId);
  fs.mkdirSync(recordDir, { recursive: true });
  const recordingPath = recordingPathFor(channelId, sessionId);

  // HLS target — fixed per-channel dir (stable URL), wiped per broadcast so
  // stale segments from a previous run never linger.
  const hlsDir = storageDir('hls', 'live', channelId);
  fs.rmSync(hlsDir, { recursive: true, force: true });
  fs.mkdirSync(hlsDir, { recursive: true });
  for (const r of renditions) fs.mkdirSync(path.join(hlsDir, r.name), { recursive: true });

  const segmentPattern = path.join(hlsDir, '%v', 'seg_%04d.ts').replace(/\\/g, '/');
  const playlistPattern = path.join(hlsDir, '%v', 'index.m3u8').replace(/\\/g, '/');
  const varStreamMap = renditions.map((r, i) => `v:${i},a:${i},name:${r.name}`).join(' ');

  // ── filter_complex: only the transcoded rungs go through the graph.
  // The 'source' rung is mapped straight off the input so it can use -c:v copy
  // (a filtered stream can never be stream-copied).
  const scaled = renditions.filter(r => r.name !== 'source');
  const args: string[] = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-fflags', '+genpts',
    '-i', inputUrl,
  ];

  if (scaled.length > 0) {
    const splitOutputs = scaled.map((_, k) => `[s${k}]`).join('');
    const chains = scaled.map((r, k) => {
      const idx = renditions.indexOf(r);
      const [w, h] = r.scale.split(':');
      return `[s${k}]scale=w=${w}:h=${h}:force_original_aspect_ratio=decrease,` +
             `scale=trunc(iw/2)*2:trunc(ih/2)*2[v${idx}]`;
    });
    args.push('-filter_complex', `[0:v]split=${scaled.length}${splitOutputs};${chains.join(';')}`);
  }

  // ── Output 1: recording tee (fragmented MP4 — a live source can't use
  // +faststart, which needs to rewrite the moov atom on close).
  args.push(
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c', 'copy',
    '-f', 'mp4',
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    recordingPath,
  );

  // ── Output 2: multi-variant live HLS
  for (let i = 0; i < renditions.length; i++) {
    args.push('-map', renditions[i].name === 'source' ? '0:v:0' : `[v${i}]`);
  }
  for (let i = 0; i < renditions.length; i++) {
    args.push('-map', '0:a:0');
  }
  for (let i = 0; i < renditions.length; i++) {
    const r = renditions[i];
    if (r.name === 'source') {
      args.push(`-c:v:${i}`, 'copy');
    } else {
      args.push(
        `-c:v:${i}`, 'libx264',
        `-preset:v:${i}`, 'veryfast',
        `-profile:v:${i}`, 'main',
        `-pix_fmt:v:${i}`, 'yuv420p',
        `-b:v:${i}`, r.bitrate,
        `-maxrate:v:${i}`, r.maxrate,
        `-bufsize:v:${i}`, r.bufsize,
        `-sc_threshold:v:${i}`, '0',
        `-force_key_frames:v:${i}`, `expr:gte(t,n_forced*${segTime})`,
      );
    }
  }
  args.push(
    '-c:a', 'copy',
    '-f', 'hls',
    '-hls_time', String(segTime),
    '-hls_list_size', String(listSize),
    '-hls_flags', 'delete_segments+independent_segments',
    '-hls_segment_type', 'mpegts',
    '-master_pl_name', 'master.m3u8',
    '-var_stream_map', varStreamMap,
    '-hls_segment_filename', segmentPattern,
    playlistPattern,
  );

  log(channelId, `ffmpeg ${renditions.map(r => r.name).join('+')} → ${hlsDir}`);

  const proc = spawn(FFMPEG_BIN, args, { windowsHide: true });
  const startedAt = Date.now();
  let stderrTail = '';

  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    stderrTail = (stderrTail + text).slice(-2000);
    console.log(`[live:${channelId}] ${text.trim()}`);
  });

  proc.on('error', (err: Error) => {
    log(channelId, `❌ ffmpeg spawn error: ${err.message}`);
    void markChannelError(channelId, `ffmpeg spawn failed: ${err.message}`);
  });

  proc.on('close', (code, signal) => {
    const elapsed = Date.now() - startedAt;
    log(channelId, `ffmpeg exited (code=${code} signal=${signal}) after ${Math.round(elapsed / 1000)}s`);
    // A near-instant non-zero exit means the pipeline never came up at all.
    if (code !== 0 && signal === null && elapsed < 5000) {
      void markChannelError(channelId, `Live transcode failed to start: ${stderrTail.slice(-500) || `exit code ${code}`}`);
    }
  });

  return proc;
}

// ── Automatic poster capture ─────────────────────────────────────────────────
// A channel with no admin-uploaded poster gets one grabbed off its own live HLS
// output shortly after it goes live. Strictly best-effort: every failure path
// here is logged and swallowed, and none of it runs on the live-start path.

/** How long to wait for the transcode to publish its first segment. */
const POSTER_WAIT_TIMEOUT_MS = Number(process.env.LIVE_POSTER_TIMEOUT_MS) || 45000;
const POSTER_POLL_INTERVAL_MS = 1000;

/** Channels with a capture attempt already in flight. */
const posterJobs = new Set<string>();

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms).unref?.(); });
}

/**
 * Resolve the first *completely written* HLS segment for any active rendition.
 *
 * Polling the playlist rather than the directory is the robust part: ffmpeg only
 * appends a segment to index.m3u8 once it has finished writing it, so anything
 * listed there is a closed file that's safe to decode. Returns null on timeout.
 */
async function waitForFirstSegment(channelId: string, timeoutMs: number): Promise<string | null> {
  const hlsDir = storageDir('hls', 'live', channelId);
  const renditions = resolveRenditions();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const r of renditions) {
      const dir = path.join(hlsDir, r.name);
      let manifest: string;
      try {
        manifest = fs.readFileSync(path.join(dir, 'index.m3u8'), 'utf8');
      } catch {
        continue; // playlist not written yet
      }
      const firstEntry = manifest
        .split('\n')
        .map(line => line.trim())
        .find(line => line.length > 0 && !line.startsWith('#'));
      if (!firstEntry) continue;

      const segPath = path.join(dir, path.basename(firstEntry));
      try {
        if (fs.statSync(segPath).size > 0) return segPath;
      } catch {
        // Segment already rolled off the DVR window — try the next rendition.
      }
    }
    await sleep(POSTER_POLL_INTERVAL_MS);
  }
  return null;
}

/** Single still frame out of `inputPath` — same flags as encoder.ts's VOD thumbnails. */
function grabStillFrame(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', inputPath,
      '-frames:v', '1',
      '-q:v', '2',
      outputPath,
    ], { windowsHide: true });

    let stderrTail = '';
    proc.stderr?.on('data', (chunk: Buffer) => { stderrTail = (stderrTail + chunk.toString()).slice(-500); });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(stderrTail.trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

/**
 * Fire-and-forget: capture a poster frame for `channelId` from its live HLS
 * output, but only while the channel still has no poster of its own.
 *
 * Returns immediately — callers (postPublish) must never wait on this.
 */
export function captureChannelPosterIfMissing(channelId: string): void {
  if (posterJobs.has(channelId)) return;
  posterJobs.add(channelId);

  void (async () => {
    try {
      const current = await LiveChannel.findById(channelId).select('posterPath');
      if (!current) return;
      if (current.posterPath && current.posterPath.trim()) return; // already has one

      const segment = await waitForFirstSegment(channelId, POSTER_WAIT_TIMEOUT_MS);
      if (!segment) {
        log(channelId, 'poster auto-capture skipped — no HLS segment appeared in time');
        return;
      }

      const outPath = autoPosterPathFor(channelId);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      await grabStillFrame(segment, outPath);
      if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
        throw new Error('ffmpeg produced an empty poster file');
      }

      // Re-check against the DB, not the stale doc read above: an admin could
      // have uploaded a real poster while we were waiting for the segment, and
      // a manual poster always wins. The condition lives in the query so the
      // check and the write are a single atomic operation.
      const claim = await LiveChannel.updateOne(
        { _id: channelId, $or: [{ posterPath: '' }, { posterPath: null }, { posterPath: { $exists: false } }] },
        { $set: { posterPath: outPath } },
      );

      if (claim.modifiedCount > 0) {
        log(channelId, `auto-captured poster → ${outPath}`);
      } else {
        // Someone else won the race. Drop our frame — this filename is only ever
        // used by auto-capture, so we can never be deleting a manual upload.
        fs.rmSync(outPath, { force: true });
        log(channelId, 'poster auto-capture discarded — a poster was set while capturing');
      }
    } catch (e: any) {
      // Never critical path: a missing poster must not disturb the broadcast.
      log(channelId, `poster auto-capture failed: ${e.message}`);
    } finally {
      posterJobs.delete(channelId);
    }
  })();
}
