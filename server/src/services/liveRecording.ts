import path from 'path';
import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import { v4 as uuidv4 } from 'uuid';
import { findChannelById } from '../db/liveChannels.js';
import { createVideo } from '../db/videos.js';
import { startEncodingPipeline } from './encoder.js';
import { storageDir, recordingPathFor } from './liveEncoder.js';

if (process.env.FFPROBE_PATH) ffmpeg.setFfprobePath(process.env.FFPROBE_PATH);

function log(channelId: string, message: string): void {
  console.log(`[live-recording:${channelId}] ${message}`);
}

function safeUnlink(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch { /* best-effort cleanup */ }
}

/**
 * A non-zero file size only proves ffmpeg wrote *something* -- a killed or
 * cut-short fragmented-MP4 recording can still pass that check and then fail
 * deep inside the VOD pipeline instead. This actually opens the file with
 * ffprobe and confirms it has a decodable video stream and a plausible
 * (non-zero) duration before it's ever handed off.
 */
async function isRecordingValid(filePath: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const data = await new Promise<any>((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, result) => (err ? reject(err) : resolve(result)));
    });
    const videoStream = data.streams?.find((s: any) => s.codec_type === 'video');
    if (!videoStream) return { ok: false, reason: 'no video stream found' };
    const duration = Number(data.format?.duration) || 0;
    if (duration <= 0) return { ok: false, reason: `implausible duration (${duration}s)` };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: `ffprobe failed: ${e.message}` };
  }
}

/**
 * Called once the live transcode process has fully exited (i.e. ffmpeg has
 * flushed and closed the recording file). Promotes the broadcast recording into
 * the normal VOD library and hands it to the UNMODIFIED encoding pipeline, so
 * it produces the exact same encoding:progress/done/error events the existing
 * UI already handles.
 */
export async function handleRecordingFinished(channelId: string, sessionId: string): Promise<void> {
  const recordingPath = recordingPathFor(channelId, sessionId);

  try {
    const channel = await findChannelById(channelId);
    if (!channel) {
      log(channelId, 'Channel no longer exists — discarding recording');
      safeUnlink(recordingPath);
      return;
    }

    if (!channel.record_enabled) {
      log(channelId, 'recordEnabled=false — discarding recording');
      safeUnlink(recordingPath);
      return;
    }

    if (!fs.existsSync(recordingPath)) {
      log(channelId, 'No recording file produced — nothing to publish');
      return;
    }

    const recStat = fs.statSync(recordingPath);
    if (recStat.size === 0) {
      log(channelId, 'Recording file is empty — discarding');
      safeUnlink(recordingPath);
      return;
    }

    const validity = await isRecordingValid(recordingPath);
    if (!validity.ok) {
      log(channelId, `Recording failed integrity check (${validity.reason}) — discarding`);
      safeUnlink(recordingPath);
      return;
    }

    // Move into the same directory chunked uploads land in (uploads/videos)
    const videosDir = storageDir('videos');
    fs.mkdirSync(videosDir, { recursive: true });
    const finalPath = path.join(videosDir, `${uuidv4()}.mp4`);
    try {
      fs.renameSync(recordingPath, finalPath);
    } catch {
      // Fallback for cross-device moves
      fs.copyFileSync(recordingPath, finalPath);
      safeUnlink(recordingPath);
    }

    const originalName = `${channel.slug}-${sessionId}.mp4`;
    const video = await createVideo({
      title:           `${channel.name} — Live Replay ${new Date().toLocaleString()}`,
      description:     channel.description || '',
      ownerId:         channel.owner_id,
      originalName,
      mimeType:        'video/mp4',
      sizeBytes:       fs.statSync(finalPath).size,
      originalPath:    finalPath,
      status:          'processing',
      sourceType:      'live-recording',
      sourceChannelId: channel.id,
      tags:            [channel.category].filter(Boolean),
      folder:          'live-replays',
    });

    log(channelId, `📼 Live replay → Video ${video.id} (${recStat.size} bytes), starting encode`);

    // Non-blocking: same call signature the upload merge route uses
    startEncodingPipeline(String(video.id), finalPath, String(channel.owner_id));
  } catch (err: any) {
    console.error(`[live-recording:${channelId}] VOD handoff failed: ${err.message}`);
  }
}
