import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import Video from '../models/Video.js';
import { io } from '../index.js';
import { emitEncodingProgress, emitEncodingDone, emitEncodingError } from '../socket/handlers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function storageDir(...parts: string[]): string {
  const base = process.env.STORAGE_LOCAL_PATH
    ? path.resolve(process.env.STORAGE_LOCAL_PATH)
    : path.join(__dirname, '..', '..', 'uploads');
  return path.join(base, ...parts);
}

const HLS_BASE = storageDir('hls');
const THUMB_BASE = storageDir('thumbnails');

if (process.env.FFMPEG_PATH) ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
if (process.env.FFPROBE_PATH) ffmpeg.setFfprobePath(process.env.FFPROBE_PATH);

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

/**
 * Encode a single quality rendition
 */
async function encodeRendition(
  inputPath: string,
  outputDir: string,
  quality: typeof QUALITIES[0],
  onProgress: (pct: number) => void
): Promise<string> {
  const outputPath = path.join(outputDir, `${quality.name}.mp4`);
  const [w, h] = quality.scale.split(':').map(Number);
  return new Promise((resolve, reject) => {
    let stderr = '';
    ffmpeg(inputPath)
      .videoCodec('libx264')
      .audioCodec('aac')
      .videoBitrate(quality.bitrate)
      .audioBitrate(quality.audioBitrate)
      // Scale, keep aspect ratio, and force even dimensions (required by libx264)
      .videoFilters(`scale=w=${w}:h=${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,scale=trunc(iw/2)*2:trunc(ih/2)*2`)
      .outputOptions(['-preset', 'veryfast', '-crf', '23', '-movflags', '+faststart', '-pix_fmt', 'yuv420p'])
      .output(outputPath)
      .on('stderr', line => { stderr += line + '\n'; })
      .on('progress', p => onProgress(p.percent || 0))
      .on('end', () => {
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
          resolve(outputPath);
        } else {
          reject(new Error(`Encoding ${quality.name} produced empty file. Stderr: ${stderr.slice(-500)}`));
        }
      })
      .on('error', (err) => reject(new Error(`Encoding ${quality.name}: ${err.message}. Stderr: ${stderr.slice(-500)}`)))
      .run();
  });
}

/**
 * Generate HLS segments from an already-encoded rendition
 * Uses codec copy where possible; falls back to re-encode
 */
async function generateHLS(
  inputPath: string,
  hlsDir: string,
  qualityName: string
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
    const video = await Video.findById(videoId);
    if (!video) throw new Error('Video not found');

    const hlsDir = path.join(HLS_BASE, videoId);
    const thumbDir = THUMB_BASE;
    fs.mkdirSync(hlsDir, { recursive: true });
    fs.mkdirSync(thumbDir, { recursive: true });

    const updateStage = async (stage: string, progress: number, detail?: string) => {
      log(videoId, `${stage} ${progress}%`);
      video.encodingStage = stage;
      video.encodingProgress = progress;
      video.encodingLog.push(`[${new Date().toISOString()}] ${stage} (${progress}%)`);
      await video.save();
      emitEncodingProgress(io, videoId, ownerId, { stage, progress, detail });
    };

    // Stage 1: FFprobe - analyze source video
    video.status = 'processing';
    await video.save();
    await updateStage('FFprobe analysis', 5);
    const probeData = await probe(inputPath);
    const videoStream = probeData.streams.find((s: any) => s.codec_type === 'video');
    const audioStream = probeData.streams.find((s: any) => s.codec_type === 'audio');

    video.duration = Math.round(probeData.format.duration || 0);
    video.width = videoStream?.width || 0;
    video.height = videoStream?.height || 0;
    const fpsRaw = videoStream?.avg_frame_rate || '0';
    const [fpsNum, fpsDen] = fpsRaw.split('/').map(Number);
    video.fps = fpsDen && fpsDen !== 0 ? parseFloat((fpsNum / fpsDen).toFixed(2)) : (fpsNum || 0);
    video.codec = videoStream?.codec_name || 'unknown';
    video.audioCodec = audioStream?.codec_name || 'unknown';
    video.bitrate = Math.round((probeData.format.bit_rate || 0) / 1000);
    video.status = 'encoding';
    await video.save();
    await updateStage('FFprobe complete', 10, `${video.width}x${video.height} ${video.fps.toFixed(1)}fps ${video.codec}`);

    // Stage 2: Generate multiple thumbnails for user selection
    await updateStage('Generating thumbnails', 12);
    try {
      const thumbPaths = await generateThumbnails(videoId, inputPath, thumbDir);
      if (thumbPaths.length > 0) {
        // Store absolute path for thumbnailPath - toUrl will convert it
        video.thumbnailPath = thumbPaths[0]; // Default to first thumbnail
        video.encodingLog.push(`[${new Date().toISOString()}] Generated ${thumbPaths.length} thumbnails for selection`);
        await video.save();
      }
    } catch (e: any) {
      log(videoId, `Thumbnail warning: ${e.message}`);
      // Don't fail the pipeline for thumbnail errors
    }
    await updateStage('Thumbnails generated', 20);

    // Stage 3: Encode each quality (only up to source resolution)
    const encodedPaths: Record<string, string> = {};
    const baseProgress = 20;
    const encProgressRange = 55;
    const sourceHeight = video.height || 1080;
    const applicableQualities = QUALITIES.filter(q => parseInt(q.name) <= sourceHeight * 1.1);
    const perQuality = encProgressRange / applicableQualities.length;

    for (let qi = 0; qi < applicableQualities.length; qi++) {
      const q = applicableQualities[qi];
      await updateStage(`Encoding ${q.name}`, Math.round(baseProgress + qi * perQuality));
      const outPath = await encodeRendition(inputPath, hlsDir, q, (pct) => {
        const stageProgress = Math.round(baseProgress + qi * perQuality + (pct / 100) * perQuality);
        emitEncodingProgress(io, videoId, ownerId, {
          stage: `Encoding ${q.name}`,
          progress: stageProgress,
          detail: `${pct.toFixed(1)}%`,
        });
      });
      encodedPaths[q.name] = outPath;

      // Save stream info to video document
      const stats = fs.statSync(outPath);
      video.streams.push({
        quality: q.name as any,
        bitrate: parseInt(q.bitrate),
        path: outPath,
        size: stats.size,
        status: 'done',
      });
      await video.save();
    }
    await updateStage('Encoding complete', 75);

    // Stage 4: HLS segmentation for each quality
    const encodedQualities = Object.keys(encodedPaths);
    for (let qi = 0; qi < encodedQualities.length; qi++) {
      const qName = encodedQualities[qi];
      await updateStage(`HLS segmentation ${qName}`, Math.round(75 + (qi / encodedQualities.length) * 18));
      await generateHLS(encodedPaths[qName], hlsDir, qName);
    }

    // Stage 5: Master playlist
    await updateStage('Generating master playlist', 94);
    const masterPath = generateMasterPlaylist(hlsDir, encodedQualities);
    // Store path relative to storage base for proper URL generation
    const storageBase = process.env.STORAGE_LOCAL_PATH
      ? path.resolve(process.env.STORAGE_LOCAL_PATH)
      : path.join(__dirname, '..', '..', 'uploads');
    video.hlsPath = masterPath;
    await video.save();

    // Stage 6: Done
    video.status = 'published';
    video.encodingProgress = 100;
    video.encodingStage = 'Ready';
    await video.save();
    await updateStage('Ready', 100);

    emitEncodingDone(io, videoId, ownerId, video.toJSON());
    log(videoId, '✅ Pipeline complete');
  } catch (err: any) {
    log(videoId, `❌ Pipeline error: ${err.message}`);
    await Video.findByIdAndUpdate(videoId, {
      status: 'failed',
      encodingError: err.message,
      encodingStage: 'Failed',
    });
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
  await Video.findByIdAndUpdate(videoId, { thumbnailPath: absPath });
}