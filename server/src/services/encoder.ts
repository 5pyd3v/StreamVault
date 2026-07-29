import ffmpeg from 'fluent-ffmpeg';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { io } from '../index.js';
import { emitEncodingProgress, emitEncodingDone, emitEncodingError } from '../socket/handlers.js';
import {
  findVideoById, updateVideo, appendEncodingLog, markVideoFailed, getApiVideo,
} from '../db/videos.js';
import { addVideoStream } from '../db/videoStreams.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function storageDir(...parts: string[]): string {
  const base = process.env.STORAGE_LOCAL_PATH
    ? path.resolve(process.env.STORAGE_LOCAL_PATH)
    : path.join(__dirname, '..', '..', 'uploads');
  return path.join(base, ...parts);
}

const HLS_BASE = storageDir('hls');
const THUMB_BASE = storageDir('thumbnails');
const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';

if (process.env.FFMPEG_PATH) ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
if (process.env.FFPROBE_PATH) ffmpeg.setFfprobePath(process.env.FFPROBE_PATH);

// How many different *videos* may encode at once, server-wide. This is now
// the only concurrency knob that matters: since a single video's renditions
// all encode in one ffmpeg process (see below), the old per-rendition
// concurrency limiter has nothing left to bound.
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_JOBS) || 4;
let activeJobs = 0;
const jobQueue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  return new Promise(resolve => {
    if (activeJobs < MAX_CONCURRENT) {
      activeJobs++;
      resolve();
    } else {
      jobQueue.push(() => { activeJobs++; resolve(); });
    }
  });
}

function releaseSlot(): void {
  activeJobs--;
  const next = jobQueue.shift();
  if (next) next();
}

// Quality presets - only encode up to source resolution
const QUALITIES = [
  { name: '360p',  scale: '640:360',   bitrate: '600k',  audioBitrate: '96k'  },
  { name: '480p',  scale: '854:480',   bitrate: '1200k', audioBitrate: '128k' },
  { name: '720p',  scale: '1280:720',  bitrate: '2400k', audioBitrate: '128k' },
  { name: '1080p', scale: '1920:1080', bitrate: '4800k', audioBitrate: '192k' },
];

function log(videoId: string, message: string): void {
  console.log(`[encoder:${videoId}] ${message}`);
}

async function probe(filePath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => err ? reject(err) : resolve(data));
  });
}

async function getVideoDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      resolve(Math.floor(data.format.duration || 0));
    });
  });
}

/**
 * Generate multiple thumbnails at different timestamps for user selection
 * Returns array of thumbnail paths
 */
async function generateThumbnails(
  videoId: string,
  inputPath: string,
  outputDir: string,
  timestamps: number[] = [0.05, 0.15, 0.25, 0.35, 0.5, 0.65, 0.75, 0.9]
): Promise<string[]> {
  const results: string[] = [];
  const duration = await getVideoDuration(inputPath);
  if (duration <= 0) {
    console.warn(`[encoder:${videoId}] Cannot determine video duration for thumbnails`);
    return results;
  }

  for (const tsPercent of timestamps) {
    const timestamp = Math.max(0.1, Math.floor(duration * tsPercent));
    const thumbFilename = `${videoId}_thumb_${Math.round(tsPercent * 100)}.jpg`;
    const thumbPath = path.join(outputDir, thumbFilename);

    try {
      await new Promise<void>((resolve, reject) => {
        ffmpeg(inputPath)
          .inputOptions(['-ss', String(timestamp)])
          .outputOptions(['-frames:v', '1', '-q:v', '2'])
          .output(thumbPath)
          .on('end', () => resolve())
          .on('error', (err) => reject(err))
          .run();
      });
      if (fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 0) {
        results.push(thumbPath);
      }
    } catch (e: any) {
      console.warn(`[encoder:${videoId}] Thumbnail at ${tsPercent * 100}% failed: ${e.message}`);
      // Continue with other thumbnails instead of failing
    }
  }

  return results;
}

// ── Hardware-accelerated, single-decode multi-output encoding ─────────────────
//
// The old pipeline ran one whole separate ffmpeg process PER quality rendition,
// each one independently re-decoding the entire source video from scratch --
// for a 4-rung 1080p job that's 4x redundant decoding before any encoding even
// starts, almost certainly the dominant cost behind multi-hour encode times.
// This redesign mirrors the single-process multi-output architecture already
// proven in services/liveEncoder.ts: one input, one decode, N encode branches
// via `-filter_complex split`, each branch its own `-map`/output. Hardware
// encoding (NVENC preferred, QSV/AMF as alternates) is attempted first when
// available, with automatic fallback to software libx264 if the hardware path
// fails to come up (wrong GPU vendor / missing driver in production vs. here).

type EncoderBackend = 'nvenc' | 'qsv' | 'amf' | 'software';

let cachedEncoderCaps: Set<string> | null = null;

/** Probes the ffmpeg *binary* (not the runtime GPU) once, cached for the process lifetime. */
async function probeAvailableEncoders(): Promise<Set<string>> {
  if (cachedEncoderCaps) return cachedEncoderCaps;
  return new Promise(resolve => {
    let out = '';
    const proc = spawn(FFMPEG_BIN, ['-hide_banner', '-encoders'], { windowsHide: true });
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    proc.on('close', () => {
      const caps = new Set<string>();
      for (const enc of ['h264_nvenc', 'h264_qsv', 'h264_amf']) if (out.includes(enc)) caps.add(enc);
      cachedEncoderCaps = caps;
      resolve(caps);
    });
    proc.on('error', () => { cachedEncoderCaps = new Set(); resolve(cachedEncoderCaps); });
  });
}

async function resolveEncoderBackend(): Promise<EncoderBackend> {
  const configured = (process.env.ENCODER_HWACCEL || 'auto').toLowerCase();
  if (configured === 'software' || configured === 'none') return 'software';
  if (configured === 'nvenc' || configured === 'qsv' || configured === 'amf') return configured;
  const caps = await probeAvailableEncoders();
  if (caps.has('h264_nvenc')) return 'nvenc';
  if (caps.has('h264_qsv')) return 'qsv';
  if (caps.has('h264_amf')) return 'amf';
  return 'software';
}

function parseKbps(bitrateStr: string): number {
  return parseInt(bitrateStr, 10) || 0;
}

function buildEncodeArgs(
  inputPath: string,
  outputPaths: Record<string, string>,
  qualities: typeof QUALITIES,
  backend: EncoderBackend
): string[] {
  const args: string[] = ['-hide_banner', '-loglevel', 'warning', '-y'];
  // Hardware decode is only wired up for the NVENC/CUDA path -- QSV/AMF hwaccel
  // decode flags vary too much by platform/driver to safely auto-enable, and
  // encode-side hardware acceleration alone (still used for those backends
  // below) already captures most of the win.
  if (backend === 'nvenc') args.push('-hwaccel', 'cuda');
  args.push('-i', inputPath);

  const splitOutputs = qualities.map((_, k) => `[s${k}]`).join('');
  const chains = qualities.map((q, k) => {
    const [w, h] = q.scale.split(':');
    return `[s${k}]scale=w=${w}:h=${h}:force_original_aspect_ratio=decrease,` +
           `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,scale=trunc(iw/2)*2:trunc(ih/2)*2[v${k}]`;
  });
  args.push('-filter_complex', `[0:v]split=${qualities.length}${splitOutputs};${chains.join(';')}`);

  for (let i = 0; i < qualities.length; i++) {
    const q = qualities[i];
    const kbps = parseKbps(q.bitrate);
    const maxrate = `${Math.round(kbps * 1.1)}k`;
    const bufsize = `${Math.round(kbps * 2)}k`;

    args.push('-map', `[v${i}]`, '-map', '0:a:0?');

    if (backend === 'nvenc') {
      args.push(
        '-c:v', 'h264_nvenc',
        '-preset', process.env.ENCODER_NVENC_PRESET || 'p4',
        '-rc', 'vbr', '-b:v', q.bitrate, '-maxrate', maxrate, '-bufsize', bufsize,
      );
    } else if (backend === 'qsv') {
      args.push('-c:v', 'h264_qsv', '-preset', 'veryfast', '-b:v', q.bitrate, '-maxrate', maxrate);
    } else if (backend === 'amf') {
      args.push('-c:v', 'h264_amf', '-quality', 'speed', '-b:v', q.bitrate, '-maxrate', maxrate);
    } else {
      args.push(
        '-c:v', 'libx264',
        '-preset', process.env.ENCODER_SOFTWARE_PRESET || 'superfast',
        '-crf', '23', '-b:v', q.bitrate,
      );
    }

    args.push(
      '-c:a', 'aac', '-b:a', q.audioBitrate,
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      outputPaths[q.name],
    );
  }

  return args;
}

interface EncodeAllOptions {
  videoDurationSec: number;
  onProgress: (pct: number) => void;
}

/** Spawns one multi-output ffmpeg process, returns once every output file exists and is non-empty. */
function spawnEncodeAttempt(
  inputPath: string,
  outputPaths: Record<string, string>,
  qualities: typeof QUALITIES,
  backend: EncoderBackend,
  opts: EncodeAllOptions
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = buildEncodeArgs(inputPath, outputPaths, qualities, backend);
    const proc = spawn(FFMPEG_BIN, args, { windowsHide: true });
    const startedAt = Date.now();
    let stderrTail = '';

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-2000);
      // ffmpeg prints one "time=HH:MM:SS.xx" progress line periodically,
      // reflecting the shared decode timeline all output branches ride on --
      // one combined percentage is now correct instead of N independently
      // tracked ones, since every rendition finishes together.
      const m = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (m && opts.videoDurationSec > 0) {
        const seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        opts.onProgress(Math.min(100, (seconds / opts.videoDurationSec) * 100));
      }
    });

    proc.on('error', (err: Error) => {
      reject(new Error(`ffmpeg (${backend}) spawn failed: ${err.message}`));
    });

    proc.on('close', (code, signal) => {
      const elapsed = Date.now() - startedAt;
      const allProduced = qualities.every(q => {
        const p = outputPaths[q.name];
        return fs.existsSync(p) && fs.statSync(p).size > 0;
      });
      if (code === 0 && allProduced) {
        resolve();
        return;
      }
      // A near-instant non-zero exit (or a zero exit with no real output)
      // means the hardware path never actually came up -- the caller retries
      // with software instead of failing the whole job.
      reject(new Error(
        `ffmpeg (${backend}) exited code=${code} signal=${signal} after ${Math.round(elapsed / 1000)}s ` +
        `(allOutputsProduced=${allProduced}). Stderr: ${stderrTail.slice(-500)}`
      ));
    });
  });
}

/**
 * Encodes every applicable quality rendition in ONE ffmpeg process (one
 * decode, N encode branches). Tries the resolved hardware backend first; on
 * any failure, automatically retries once with software libx264 so a
 * hardware/driver mismatch degrades to "slow but working" instead of failing
 * the job outright.
 */
async function encodeAllRenditions(
  videoId: string,
  inputPath: string,
  outputDir: string,
  qualities: typeof QUALITIES,
  videoDurationSec: number,
  onProgress: (pct: number) => void
): Promise<Record<string, string>> {
  const outputPaths: Record<string, string> = {};
  for (const q of qualities) outputPaths[q.name] = path.join(outputDir, `${q.name}.mp4`);

  const backend = await resolveEncoderBackend();
  try {
    log(videoId, `encoding ${qualities.map(q => q.name).join('+')} via ${backend} (single pass)`);
    await spawnEncodeAttempt(inputPath, outputPaths, qualities, backend, { videoDurationSec, onProgress });
    return outputPaths;
  } catch (err: any) {
    if (backend === 'software') throw err; // already the fallback -- nothing left to try
    log(videoId, `⚠️  hardware encode (${backend}) failed, falling back to software: ${err.message}`);
    await spawnEncodeAttempt(inputPath, outputPaths, qualities, 'software', { videoDurationSec, onProgress });
    return outputPaths;
  }
}

/**
 * Generate HLS segments from an already-encoded rendition
 * Uses codec copy where possible; falls back to re-encode
 */
async function generateHLS(
  inputPath: string,
  hlsDir: string,
  qualityName: string,
  onProgress?: (pct: number) => void
): Promise<string> {
  const segDir = path.join(hlsDir, qualityName);
  fs.mkdirSync(segDir, { recursive: true });
  const playlistPath = path.join(segDir, 'index.m3u8');
  const segmentPattern = path.join(segDir, 'seg_%04d.ts').replace(/\\/g, '/');

  return new Promise((resolve, reject) => {
    let stderr = '';
    ffmpeg(inputPath)
      .videoCodec('copy')
      .audioCodec('copy')
      .outputOptions([
        '-f', 'hls',
        '-hls_time', '6',
        '-hls_playlist_type', 'vod',
        '-hls_segment_type', 'mpegts',
        '-hls_segment_filename', segmentPattern,
        '-hls_flags', 'independent_segments',
        '-hls_list_size', '0',
      ])
      .output(playlistPath)
      .on('stderr', line => { stderr += line + '\n'; })
      .on('progress', p => { if (onProgress) onProgress(p.percent || 0); })
      .on('end', () => {
        // Verify segments were actually produced
        try {
          const files = fs.readdirSync(segDir);
          const hasSegments = files.some(f => f.endsWith('.ts'));
          const hasPlaylist = fs.existsSync(playlistPath) && fs.statSync(playlistPath).size > 0;
          if (!hasSegments || !hasPlaylist) {
            reject(new Error(`HLS ${qualityName}: no segments produced. Stderr: ${stderr.slice(-500)}`));
            return;
          }
          resolve(playlistPath);
        } catch (e: any) {
          reject(new Error(`HLS ${qualityName}: verification failed: ${e.message}`));
        }
      })
      .on('error', err => reject(new Error(`HLS ${qualityName}: ${err.message}. Stderr: ${stderr.slice(-500)}`)))
      .run();
  });
}

/**
 * Run `worker` over `items` with at most `limit` in flight at once. Still used
 * for stage 4 (HLS segmentation), which is cheap per-rendition stream-copy
 * work independent of the encode stage above.
 */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  const total = items.length;
  if (total === 0) return;
  let nextIndex = 0;
  let firstError: any = null;
  const poolSize = Math.max(1, Math.min(limit, total));
  const runner = async (): Promise<void> => {
    while (true) {
      if (firstError) return;
      const index = nextIndex++;
      if (index >= total) return;
      try {
        await worker(items[index], index);
      } catch (err) {
        if (!firstError) firstError = err;
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: poolSize }, () => runner()));
  if (firstError) throw firstError;
}
const HLS_SEGMENT_CONCURRENCY = Math.max(1, Number(process.env.HLS_PARALLEL_RENDITIONS) || 4);

/**
 * Generate master HLS playlist referencing all quality playlists
 */
function generateMasterPlaylist(hlsDir: string, qualities: string[]): string {
  const masterPath = path.join(hlsDir, 'master.m3u8');
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS'];
  const bitrateMap: Record<string, string> = { '360p': '800000', '480p': '1500000', '720p': '3000000', '1080p': '6000000' };
  const resolutionMap: Record<string, string> = { '360p': '640x360', '480p': '854x480', '720p': '1280x720', '1080p': '1920x1080' };

  for (const q of qualities) {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bitrateMap[q] || '2000000'},RESOLUTION=${resolutionMap[q] || '1280x720'}`);
    lines.push(`${q}/index.m3u8`);
  }

  fs.writeFileSync(masterPath, lines.join('\n'));
  return masterPath;
}

// ── Main pipeline ─────────────────────────────────────────────────────────────
export async function startEncodingPipeline(
  videoId: string,
  inputPath: string,
  ownerId: string
): Promise<void> {
  await acquireSlot();
  try {
    const video = await findVideoById(videoId);
    if (!video) throw new Error('Video not found');

    const hlsDir = path.join(HLS_BASE, videoId);
    const thumbDir = THUMB_BASE;
    fs.mkdirSync(hlsDir, { recursive: true });
    fs.mkdirSync(thumbDir, { recursive: true });

    // Progress must never go backwards for the frontend.
    let lastEmittedProgress = 0;

    const updateStage = async (stage: string, progress: number, detail?: string) => {
      const clamped = Math.max(lastEmittedProgress, Math.round(progress));
      lastEmittedProgress = clamped;
      log(videoId, `${stage} ${clamped}%`);
      // Every field update is its own atomic UPDATE now -- no shared in-memory
      // document, no mutex needed (that whole mechanism existed only because
      // several concurrent renditions used to mutate one Mongoose document).
      await updateVideo(videoId, { encodingStage: stage, encodingProgress: clamped });
      await appendEncodingLog(videoId, `[${new Date().toISOString()}] ${stage} (${clamped}%)`);
      emitEncodingProgress(io, videoId, ownerId, { stage, progress: clamped, detail });
    };

    // Lightweight, throttled tick for the *encode* stage's continuous ffmpeg
    // progress -- emits over the socket only, never hits the DB every tick.
    let lastTickAt = 0;
    let lastTickProgress = -1;
    const emitTick = (stage: string, progress: number, detail?: string, force = false) => {
      const clamped = Math.max(lastEmittedProgress, Math.round(progress));
      const now = Date.now();
      if (!force && clamped === lastTickProgress && now - lastTickAt < 1000) return;
      lastTickAt = now;
      lastTickProgress = clamped;
      lastEmittedProgress = clamped;
      emitEncodingProgress(io, videoId, ownerId, { stage, progress: clamped, detail });
    };

    // Stage 1: FFprobe - analyze source video
    await updateVideo(videoId, { status: 'processing' });
    await updateStage('FFprobe analysis', 5);
    const probeData = await probe(inputPath);
    const videoStream = probeData.streams.find((s: any) => s.codec_type === 'video');
    const audioStream = probeData.streams.find((s: any) => s.codec_type === 'audio');

    const duration = Math.round(probeData.format.duration || 0);
    const width = videoStream?.width || 0;
    const height = videoStream?.height || 0;
    const fpsRaw = videoStream?.avg_frame_rate || '0';
    const [fpsNum, fpsDen] = fpsRaw.split('/').map(Number);
    const fps = fpsDen && fpsDen !== 0 ? parseFloat((fpsNum / fpsDen).toFixed(2)) : (fpsNum || 0);
    const codec = videoStream?.codec_name || 'unknown';
    const audioCodec = audioStream?.codec_name || 'unknown';
    const bitrate = Math.round((probeData.format.bit_rate || 0) / 1000);

    await updateVideo(videoId, { duration, width, height, fps, codec, audioCodec, bitrate, status: 'encoding' });
    await updateStage('FFprobe complete', 10, `${width}x${height} ${fps.toFixed(1)}fps ${codec}`);

    // Stage 2: Generate multiple thumbnails for user selection
    await updateStage('Generating thumbnails', 12);
    try {
      const thumbPaths = await generateThumbnails(videoId, inputPath, thumbDir);
      if (thumbPaths.length > 0) {
        await updateVideo(videoId, { thumbnailPath: thumbPaths[0] });
        await appendEncodingLog(videoId, `[${new Date().toISOString()}] Generated ${thumbPaths.length} thumbnails for selection`);
      }
    } catch (e: any) {
      log(videoId, `Thumbnail warning: ${e.message}`);
      // Don't fail the pipeline for thumbnail errors
    }
    await updateStage('Thumbnails generated', 20);

    // Stage 3: single-decode, multi-output, hardware-accelerated-when-available encode
    const baseProgress = 20;
    const encProgressRange = 55; // 20% -> 75%
    const hlsProgressRange = 18; // 75% -> 93%
    const sourceHeight = height || 1080;
    const applicableQualities = QUALITIES.filter(q => parseInt(q.name) <= sourceHeight * 1.1);

    if (applicableQualities.length > 0) {
      await updateStage(`Encoding ${applicableQualities.map(q => q.name).join(', ')}`, baseProgress, 'single-pass, all renditions together');
    }

    const encodedPaths = await encodeAllRenditions(
      videoId, inputPath, hlsDir, applicableQualities, duration,
      (pct) => emitTick(
        `Encoding ${applicableQualities.map(q => q.name).join(', ')}`,
        baseProgress + (pct / 100) * encProgressRange,
        `${pct.toFixed(1)}%`,
      )
    );
    await updateStage('Encoding complete', baseProgress + encProgressRange);

    // Stage 4: HLS segmentation per rendition (cheap stream-copy, still parallelized)
    const encodedQualities = applicableQualities.map(q => q.name).filter(name => encodedPaths[name]);
    const hlsPct: Record<string, number> = {};
    for (const name of encodedQualities) hlsPct[name] = 0;
    const perQualityHls = hlsProgressRange / Math.max(1, encodedQualities.length);
    const computeHlsProgress = () => {
      const done = encodedQualities.reduce((sum, name) => sum + (hlsPct[name] / 100) * perQualityHls, 0);
      return baseProgress + encProgressRange + done;
    };

    await mapWithConcurrency(encodedQualities, HLS_SEGMENT_CONCURRENCY, async (qName) => {
      await generateHLS(encodedPaths[qName], hlsDir, qName, (pct) => {
        hlsPct[qName] = Math.max(hlsPct[qName], Math.min(100, Math.max(0, pct)));
        emitTick(`HLS segmentation`, computeHlsProgress(), `${qName} ${hlsPct[qName].toFixed(0)}%`);
      });
      hlsPct[qName] = 100;

      const stats = fs.statSync(encodedPaths[qName]);
      const q = applicableQualities.find(x => x.name === qName)!;
      await addVideoStream(videoId, {
        quality: qName as any,
        bitrate: parseInt(q.bitrate),
        path: encodedPaths[qName],
        size: stats.size,
        status: 'done',
      });
    });
    await updateStage('HLS segmentation complete', baseProgress + encProgressRange + hlsProgressRange);

    // Stage 5: Master playlist
    await updateStage('Generating master playlist', 94);
    const masterPath = generateMasterPlaylist(hlsDir, encodedQualities);
    await updateVideo(videoId, { hlsPath: masterPath });

    // Stage 6: Done
    await updateVideo(videoId, { status: 'published', encodingProgress: 100, encodingStage: 'Ready' });
    await updateStage('Ready', 100);

    const finalVideo = await getApiVideo(videoId);
    emitEncodingDone(io, videoId, ownerId, finalVideo);
    log(videoId, '✅ Pipeline complete');
  } catch (err: any) {
    log(videoId, `❌ Pipeline error: ${err.message}`);
    await markVideoFailed(videoId, err.message);
    emitEncodingError(io, videoId, ownerId, err.message);
  } finally {
    releaseSlot();
  }
}

// Export helper to generate thumbnails on demand (for thumbnail selection UI)
export async function generateThumbnailOptions(videoId: string, inputPath: string): Promise<string[]> {
  const thumbDir = THUMB_BASE;
  fs.mkdirSync(thumbDir, { recursive: true });
  const absolutePaths = await generateThumbnails(videoId, inputPath, thumbDir, [0.05, 0.15, 0.25, 0.35, 0.5, 0.65, 0.75, 0.9]);

  // Convert absolute paths to relative paths (relative to storage base)
  const storageBase = process.env.STORAGE_LOCAL_PATH
    ? path.resolve(process.env.STORAGE_LOCAL_PATH)
    : path.join(__dirname, '..', '..', 'uploads');

  return absolutePaths.map(p => path.relative(storageBase, p).replace(/\\/g, '/'));
}

export async function updateVideoThumbnail(videoId: string, thumbnailRelPath: string): Promise<void> {
  // thumbnailRelPath is relative to storage base (e.g. "thumbnails/xxx_thumb_5.jpg")
  // Convert to absolute for consistent storage
  const storageBase = process.env.STORAGE_LOCAL_PATH
    ? path.resolve(process.env.STORAGE_LOCAL_PATH)
    : path.join(__dirname, '..', '..', 'uploads');
  const absPath = path.join(storageBase, thumbnailRelPath);
  await updateVideo(videoId, { thumbnailPath: absPath });
}
