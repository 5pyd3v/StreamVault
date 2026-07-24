import mongoose, { Document, Schema } from 'mongoose';

export interface IChunk {
  index: number;
  size: number;
  hash: string;
  receivedAt: Date;
}

export interface IUploadSession extends Document {
  uploadId: string;
  owner: mongoose.Types.ObjectId;
  filename: string;
  mimeType: string;
  totalSize: number;
  totalChunks: number;
  chunkSize: number;
  receivedChunks: IChunk[];
  status: 'active' | 'merging' | 'done' | 'error';
  tempDir: string;
  videoId?: mongoose.Types.ObjectId;
  errorMessage?: string;
  expiresAt: Date;
  createdAt: Date;
}

const ChunkSchema = new Schema<IChunk>({
  index:      { type: Number, required: true },
  size:       { type: Number, required: true },
  hash:       { type: String, required: true },
  receivedAt: { type: Date, default: Date.now },
}, { _id: false });

const UploadSessionSchema = new Schema<IUploadSession>({
  uploadId:       { type: String, required: true, unique: true, index: true },
  owner:          { type: Schema.Types.ObjectId, ref: 'User', required: true },
  filename:       { type: String, required: true },
  mimeType:       { type: String, default: 'video/mp4' },
  totalSize:      { type: Number, required: true },
  totalChunks:    { type: Number, required: true },
  chunkSize:      { type: Number, default: 5 * 1024 * 1024 },
  receivedChunks: [ChunkSchema],
  status:         { type: String, enum: ['active','merging','done','error'], default: 'active' },
  tempDir:        { type: String, required: true },
  videoId:        { type: Schema.Types.ObjectId, ref: 'Video' },
  errorMessage:   String,
  expiresAt:      { type: Date, default: () => new Date(Date.now() + 48 * 60 * 60 * 1000) },
}, { timestamps: true });

// TTL index to auto-clean stale sessions
UploadSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model<IUploadSession>('UploadSession', UploadSessionSchema);
