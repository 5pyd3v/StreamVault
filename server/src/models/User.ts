import mongoose, { Document, Schema } from 'mongoose';
import bcrypt from 'bcryptjs';

export interface IUser extends Document {
  name: string;
  email: string;
  password: string;
  role: 'admin' | 'editor' | 'viewer';
  organization: string;
  twoFactorEnabled: boolean;
  twoFactorSecret?: string;
  rememberTokens: string[];
  active: boolean;
  lastLogin?: Date;
  createdAt: Date;
  comparePassword(candidate: string): Promise<boolean>;
}

const UserSchema = new Schema<IUser>({
  name:             { type: String, required: true, trim: true },
  email:            { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:         { type: String, required: true, minlength: 8 },
  role:             { type: String, enum: ['admin', 'editor', 'viewer'], default: 'viewer' },
  organization:     { type: String, default: '' },
  twoFactorEnabled: { type: Boolean, default: false },
  twoFactorSecret:  { type: String },
  rememberTokens:   [{ type: String }],
  active:           { type: Boolean, default: true },
  lastLogin:        { type: Date },
}, { timestamps: true });

UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

UserSchema.methods.comparePassword = async function (candidate: string): Promise<boolean> {
  return bcrypt.compare(candidate, this.password);
};

UserSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.twoFactorSecret;
  delete obj.rememberTokens;
  return obj;
};

export default mongoose.model<IUser>('User', UserSchema);