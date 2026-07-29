import mongoose, { Document, Schema } from 'mongoose';
import crypto from 'crypto';

export interface ILiveChannel extends Document {
  name: string;
  slug: string;
  description: string;
  category: string;
  posterPath: string;
  owner: mongoose.Types.ObjectId;
  streamKey: string;
  rtmpApp: string;
  isEnabled: boolean;

  // Live state
  status: 'offline' | 'starting' | 'live' | 'error';
  currentSessionId: string | null;
  liveStartedAt: Date | null;
  lastError: string;
  liveHlsPath: string;

  // Options
  recordEnabled: boolean;
  viewerCount: number;

  createdAt: Date;
  updatedAt: Date;
}

const LiveChannelSchema = new Schema<ILiveChannel>({
  name:             { type: String, required: true, trim: true },
  slug:             { type: String, required: true, unique: true, trim: true, lowercase: true },
  description:      { type: String, default: '' },
  category:         { type: String, default: '' },
  posterPath:       { type: String, default: '' },
  owner:            { type: Schema.Types.ObjectId, ref: 'User', required: true },
  streamKey:        { type: String, required: true, unique: true, select: false },
  rtmpApp:          { type: String, default: 'live' },
  isEnabled:        { type: Boolean, default: true },

  status:           { type: String, enum: ['offline', 'starting', 'live', 'error'], default: 'offline' },
  currentSessionId: { type: String, default: null },
  liveStartedAt:    { type: Date, default: null },
  lastError:        { type: String, default: '' },
  liveHlsPath:      { type: String, default: '' },

  recordEnabled:    { type: Boolean, default: true },
  viewerCount:      { type: Number, default: 0 },
}, { timestamps: true });

LiveChannelSchema.index({ isEnabled: 1, status: 1 });

const LiveChannel = mongoose.model<ILiveChannel>('LiveChannel', LiveChannelSchema);

/** Generate a fresh OBS stream key. */
export function generateStreamKey(): string {
  return crypto.randomBytes(24).toString('hex');
}

/** Turn an arbitrary channel name into a url-safe slug fragment. */
export function slugify(input: string): string {
  const slug = String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '');
  return slug || 'channel';
}

/** Slugify a name, appending a short random suffix when the slug is already taken. */
export async function generateUniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  let candidate = base;
  for (let attempt = 0; attempt < 10; attempt++) {
    const existing = await LiveChannel.exists({ slug: candidate });
    if (!existing) return candidate;
    candidate = `${base}-${crypto.randomBytes(2).toString('hex')}`;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export default LiveChannel;
