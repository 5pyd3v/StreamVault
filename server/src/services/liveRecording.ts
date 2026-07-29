import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import LiveChannel from '../models/LiveChannel.js';
import Video from '../models/Video.js';
import { startEncodingPipeline } from './encoder.js';
import { storageDir, recordingPathFor } from './liveEncoder.js';

function log(channelId: string, message: string): void {
  console.log(`[live-recording:${channelId}] ${message}`);
}

function safeUnlink(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch { /* best-effort cleanup */ }
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
    const channel = await LiveChannel.findById(channelId);
    if (!channel) {
      log(channelId, 'Channel no longer exists — discarding recording');
      safeUnlink(recordingPath);
      return;
    }

    if (!channel.recordEnabled) {
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
    const video = await Video.create({
      title:         `${channel.name} — Live Replay ${new Date().toLocaleString()}`,
      description:   channel.description || '',
      owner:         channel.owner,
      originalName,
      mimeType:      'video/mp4',
      sizeBytes:     fs.statSync(finalPath).size,
      originalPath:  finalPath,
      status:        'processing',
      sourceType:    'live-recording',
      sourceChannel: channel._id,
      tags:          [channel.category].filter(Boolean),
      folder:        'live-replays',
    });

    log(channelId, `📼 Live replay → Video ${video._id} (${recStat.size} bytes), starting encode`);

    // Non-blocking: same call signature the upload merge route uses
    startEncodingPipeline(video._id.toString(), finalPath, channel.owner.toString());
  } catch (err: any) {
    console.error(`[live-recording:${channelId}] VOD handoff failed: ${err.message}`);
  }
}
