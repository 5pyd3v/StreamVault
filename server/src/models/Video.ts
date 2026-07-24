import mongoose, { Document, Schema } from 'mongoose';

export interface IVideoStream {
  quality: '360p' | '480p' | '720p' | '1080p' | '4K';
  bitrate: number;
  path: string;
  size: number;
  status: 'pending' | 'encoding' | 'done' | 'failed';
}

export interface IVideo extends Document {
  title: string;
  description: string;
  owner: mongoose.Types.ObjectId;
  status: 'uploading' | 'processing' | 'encoding' | 'published' | 'failed' | 'draft' | 'archived';

  // File info
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  duration: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  audioCodec: string;
  bitrate: number;

  // Storage paths
  originalPath: string;
  hlsPath: string;
  thumbnailPath: string;
  previewPath: string;

  // HLS streams
  streams: IVideoStream[];

  // Metadata
  tags: string[];
  folder: string;
  views: number;
  encodingLog: string[];

  // Encoding job
  encodingJobId?: string;
  encodingProgress: number;
  encodingStage: string;
  encodingError?: string;

  createdAt: Date;
  updatedAt: Date;
}

const VideoStreamSchema = new Schema<IVideoStream>({
  quality: { type: String, enum: ['360p', '480p', '720p', '1080p', '4K'] },
  bitrate: Number,
  path: String,
  size: Number,
  status: { type: String, enum: ['pending', 'encoding', 'done', 'failed'], default: 'pending' },
}, { _id: false });

const VideoSchema = new Schema<IVideo>({
  title:           { type: String, required: true, trim: true },
  description:     { type: String, default: '' },
  owner:           { type: Schema.Types.ObjectId, ref: 'User', required: true },
  status:          { type: String, enum: ['uploading','processing','encoding','published','failed','draft','archived'], default: 'uploading' },

  originalName:    { type: String, required: true },
  mimeType:        { type: String, default: '' },
  sizeBytes:       { type: Number, default: 0 },
  duration:        { type: Number, default: 0 },
  width:           { type: Number, default: 0 },
  height:          { type: Number, default: 0 },
  fps:             { type: Number, default: 0 },
  codec:           { type: String, default: '' },
  audioCodec:      { type: String, default: '' },
  bitrate:         { type: Number, default: 0 },

  originalPath:    { type: String, default: '' },
  hlsPath:         { type: String, default: '' },
  thumbnailPath:   { type: String, default: '' },
  previewPath:     { type: String, default: '' },

  streams:         [VideoStreamSchema],
  tags:            [{ type: String }],
  folder:          { type: String, default: 'root' },
  views:           { type: Number, default: 0 },
  encodingLog:     [{ type: String }],

  encodingJobId:   String,
  encodingProgress:{ type: Number, default: 0 },
  encodingStage:   { type: String, default: '' },
  encodingError:   String,
}, { timestamps: true });

VideoSchema.index({ owner: 1, status: 1 });
VideoSchema.index({ title: 'text', tags: 'text' });

export default mongoose.model<IVideo>('Video', VideoSchema);
