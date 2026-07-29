import bcrypt from 'bcryptjs';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { pool } from './pool.js';

export type UserRole = 'admin' | 'editor' | 'viewer';

interface UserRow extends RowDataPacket {
  id: number;
  name: string;
  email: string;
  password: string;
  role: UserRole;
  organization: string;
  two_factor_enabled: number;
  two_factor_secret: string | null;
  remember_tokens: string | null; // JSON column comes back as a string via mysql2
  active: number;
  last_login: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface PublicUser {
  _id: string;
  name: string;
  email: string;
  role: UserRole;
  organization: string;
  twoFactorEnabled: boolean;
  active: boolean;
  lastLogin: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Row -> the exact JSON shape the old Mongoose `toJSON` produced (password/2FA-secret/remember-tokens stripped). */
export function toPublicUser(row: UserRow): PublicUser {
  return {
    _id: String(row.id),
    name: row.name,
    email: row.email,
    role: row.role,
    organization: row.organization,
    twoFactorEnabled: !!row.two_factor_enabled,
    active: !!row.active,
    lastLogin: row.last_login,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function countUsers(): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM users');
  return Number(rows[0]!.n);
}

export async function findUserById(id: string | number): Promise<UserRow | null> {
  const [rows] = await pool.query<UserRow[]>('SELECT * FROM users WHERE id = ? LIMIT 1', [id]);
  return rows[0] ?? null;
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const [rows] = await pool.query<UserRow[]>('SELECT * FROM users WHERE email = ? LIMIT 1', [email.toLowerCase().trim()]);
  return rows[0] ?? null;
}

export async function comparePassword(candidate: string, hash: string): Promise<boolean> {
  return bcrypt.compare(candidate, hash);
}

export interface CreateUserInput {
  name: string;
  email: string;
  password: string; // plaintext -- hashed here
  organization?: string;
  role?: UserRole;
}

/** First-user-becomes-admin is decided by the caller (matches the old `count===0` check in auth.ts). */
export async function createUser(input: CreateUserInput): Promise<UserRow> {
  const hash = await bcrypt.hash(input.password, 12);
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO users (name, email, password, role, organization) VALUES (?, ?, ?, ?, ?)`,
    [input.name.trim(), input.email.toLowerCase().trim(), hash, input.role ?? 'viewer', input.organization ?? '']
  );
  const created = await findUserById(result.insertId);
  if (!created) throw new Error('Failed to load user after insert');
  return created;
}

export async function updateLastLogin(id: number): Promise<void> {
  await pool.query('UPDATE users SET last_login = NOW() WHERE id = ?', [id]);
}

export async function updatePassword(id: number, newPassword: string): Promise<void> {
  const hash = await bcrypt.hash(newPassword, 12);
  await pool.query('UPDATE users SET password = ? WHERE id = ?', [hash, id]);
}

export interface ListUsersOptions {
  onlineIds?: Set<string>; // unused by the query, kept for route-layer shaping if needed
}

export async function listUsers(): Promise<UserRow[]> {
  const [rows] = await pool.query<UserRow[]>('SELECT * FROM users ORDER BY created_at DESC');
  return rows;
}

export async function updateUserRoleActive(id: string | number, patch: { role?: UserRole; active?: boolean }): Promise<UserRow | null> {
  const sets: string[] = [];
  const params: any[] = [];
  if (patch.role !== undefined) { sets.push('role = ?'); params.push(patch.role); }
  if (patch.active !== undefined) { sets.push('active = ?'); params.push(patch.active ? 1 : 0); }
  if (sets.length === 0) return findUserById(id);
  params.push(id);
  await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
  return findUserById(id);
}

export async function deleteUser(id: string | number): Promise<void> {
  await pool.query('DELETE FROM users WHERE id = ?', [id]);
}
