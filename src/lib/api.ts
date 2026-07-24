// ── Typed API client for StreamVault backend ──────────────────────────────────

const BASE = '/api';

// ── Auth storage ──────────────────────────────────────────────────────────────
export const getToken = () => localStorage.getItem('sv_token');
export const setToken = (t: string) => localStorage.setItem('sv_token', t);
export const setRefresh = (t: string) => localStorage.setItem('sv_refresh', t);
export const clearTokens = () => { localStorage.removeItem('sv_token'); localStorage.removeItem('sv_refresh'); };

// ── Base fetch ────────────────────────────────────────────────────────────────
async function req<T>(
  method: string,
  url: string,
  body?: unknown,
  isFormData = false,
): Promise<T> {
  const token = getToken();
  const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};
  if (!isFormData && body) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${BASE}${url}`, {
    method,
    headers,
    body: body ? (isFormData ? (body as FormData) : JSON.stringify(body)) : undefined,
  });

  if (res.status === 401) { clearTokens(); window.location.reload(); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}

const get = <T>(url: string) => req<T>('GET', url);
const post = <T>(url: string, body?: unknown) => req<T>('POST', url, body);
const patch = <T>(url: string, body?: unknown) => req<T>('PATCH', url, body);
const del = <T>(url: string) => req<T>('DELETE', url);

// ── Types ─────────────────────────────────────────────────────────────────────
export interface AuthUser {
  _id: string;
  name: string;
  email: string;
  role: 'admin' | 'editor' | 'viewer';
  organization: string;
  active: boolean;
  createdAt: string;
}

export interface ApiVideo {
  _id: string;
  title: string;
  description: string;
  owner: { _id: string; name: string; email: string };
  status: 'uploading' | 'processing' | 'encoding' | 'published' | 'failed' | 'draft' | 'archived';
  originalName: string;
  sizeBytes: number;
  duration: number;
  width: number;
  height: number;
  codec: string;
  audioCodec: string;
  thumbnailPath: string;
  thumbnailUrl: string;
  hlsPath: string;
  hlsUrl: string;
  streams: Array<{ quality: string; bitrate: number; path: string; size: number; status: string; hlsUrl?: string; downloadUrl?: string }>;
  tags: string[];
  folder: string;
  views: number;
  encodingProgress: number;
  encodingStage: string;
  encodingError?: string;
  encodingLog: string[];
  createdAt: string;
  downloadUrl?: string;
}

export interface UploadInitResponse {
  uploadId: string;
  totalChunks: number;
  chunkSize: number;
}

export interface ChunkResponse {
  chunkIndex: number;
  received: number;
  total: number;
  progress: number;
  complete: boolean;
}

// ── Auth API ──────────────────────────────────────────────────────────────────
export const authApi = {
  login: async (email: string, password: string) => {
    const data = await post<{ token: string; refreshToken: string; user: AuthUser }>('/auth/login', { email, password });
    setToken(data.token);
    setRefresh(data.refreshToken);
    return data;
  },

  register: async (name: string, email: string, password: string, organization?: string) => {
    const data = await post<{ token: string; refreshToken: string; user: AuthUser }>('/auth/register', { name, email, password, organization });
    setToken(data.token);
    setRefresh(data.refreshToken);
    return data;
  },

  me: () => get<AuthUser>('/auth/me'),

  changePassword: (currentPassword: string, newPassword: string) =>
    post<{ message: string }>('/auth/change-password', { currentPassword, newPassword }),

  logout: () => { clearTokens(); },
};

// ── Videos API ────────────────────────────────────────────────────────────────
export const videosApi = {
  list: (params?: { status?: string; search?: string; page?: number }) => {
    const qs = new URLSearchParams();
    if (params?.status && params.status !== 'all') qs.set('status', params.status);
    if (params?.search) qs.set('search', params.search);
    if (params?.page) qs.set('page', String(params.page));
    return get<{ videos: ApiVideo[]; total: number }>(`/videos${qs.toString() ? '?' + qs : ''}`);
  },

  get: (id: string) => get<ApiVideo>(`/videos/${id}`),
  update: (id: string, body: Partial<Pick<ApiVideo, 'title' | 'description' | 'tags' | 'folder' | 'status'>>) =>
    patch<ApiVideo>(`/videos/${id}`, body),
  delete: (id: string) => del<{ message: string }>(`/videos/${id}`),
  stats: () => get<{ total: number; totalSize: number; totalViews: number }>('/videos/meta/stats'),
};

// ── Upload API + chunker ──────────────────────────────────────────────────────
const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB

export interface UploadProgress {
  uploadId: string;
  filename: string;
  chunkIndex: number;
  chunksTotal: number;
  progress: number;
  speed: number; // MB/s
  eta: number; // seconds
}

export type UploadProgressCallback = (p: UploadProgress) => void;
export type UploadDoneCallback = (videoId: string) => void;
export type UploadErrorCallback = (err: Error) => void;

export async function uploadFileChunked(
  file: File,
  onProgress: UploadProgressCallback,
  onDone: UploadDoneCallback,
  onError: UploadErrorCallback,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const token = getToken();

    // Init session (server returns existing session if already created for same file)
    const { uploadId, resumeFrom } = await post<UploadInitResponse & { resumeFrom?: number }>('/upload/init', {
      filename: file.name,
      totalSize: file.size,
      mimeType: file.type || 'video/mp4',
    });

    const startChunk = resumeFrom ?? 0;
    const startTime = Date.now();
    let retryCount = 0;
    const MAX_RETRIES = 10;

    for (let i = startChunk; i < totalChunks; i++) {
      if (signal?.aborted) throw new Error('Upload cancelled');

      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const chunk = file.slice(start, end);

      // Compute SHA-256 hash
      const buffer = await chunk.arrayBuffer();
      const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
      const hash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

      const formData = new FormData();
      formData.append('chunk', new Blob([buffer], { type: 'application/octet-stream' }), 'chunk');
      formData.append('uploadId', uploadId);
      formData.append('chunkIndex', String(i));
      formData.append('totalChunks', String(totalChunks));
      formData.append('hash', hash);

      const headers: HeadersInit = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;

      // Retry loop for individual chunks (handles transient network failures)
      let chunkSuccess = false;
      while (!chunkSuccess) {
        try {
          const res = await fetch(`${BASE}/upload/chunk`, { method: 'POST', headers, body: formData, signal });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `Chunk ${i} upload failed`);
          }
          chunkSuccess = true;
          retryCount = 0; // Reset on success
        } catch (err: any) {
          if (signal?.aborted || err.name === 'AbortError') throw new Error('Upload cancelled');
          retryCount++;
          if (retryCount > MAX_RETRIES) throw err;
          // Exponential backoff: wait before retrying
          const delay = Math.min(1000 * Math.pow(2, retryCount - 1), 30000);
          await new Promise(r => setTimeout(r, delay));
          // Re-check abort during wait
          if (signal?.aborted) throw new Error('Upload cancelled');
        }
      }

      const elapsed = (Date.now() - startTime) / 1000;
      const chunksUploaded = i - startChunk + 1;
      const bytesUploaded = chunksUploaded * CHUNK_SIZE;
      const speed = elapsed > 0 ? bytesUploaded / elapsed / (1024 * 1024) : 0;
      const remaining = file.size - (i + 1) * CHUNK_SIZE;
      const eta = speed > 0 ? Math.max(0, remaining / (speed * 1024 * 1024)) : 0;

      onProgress({ uploadId, filename: file.name, chunkIndex: i, chunksTotal: totalChunks, progress: Math.round(((i + 1) / totalChunks) * 100), speed: parseFloat(speed.toFixed(1)), eta: Math.round(eta) });
    }

    // Merge
    const { videoId } = await post<{ videoId: string; message: string }>('/upload/merge', { uploadId });
    onDone(videoId);
  } catch (err: any) {
    if (err.name !== 'AbortError' && err.message !== 'Upload cancelled') onError(err);
  }
}

// ── Encoding API ──────────────────────────────────────────────────────────────
export const encodingApi = {
  jobs: () => get<{ jobs: ApiVideo[] }>('/encoding/jobs'),
  job: (id: string) => get<ApiVideo>(`/encoding/jobs/${id}`),
  retry: (id: string) => post<{ message: string }>(`/encoding/jobs/${id}/retry`),
  generateThumbnails: (id: string) => post<{ thumbnails: string[] }>(`/encoding/thumbnails/${id}/generate`),
  selectThumbnail: (id: string, thumbnailPath: string) => post<{ message: string; thumbnailPath: string }>(`/encoding/thumbnails/${id}/select`, { thumbnailPath }),
};

// ── Storage API ───────────────────────────────────────────────────────────────
export const storageApi = {
  stats: () => get<{ totalVideos: number; totalSizeBytes: number; diskUsedBytes: number; provider: string }>('/storage/stats'),
  largest: () => get<ApiVideo[]>('/storage/largest'),
};

// ── Admin API ─────────────────────────────────────────────────────────────────
export const adminApi = {
  users: () => get<AuthUser[]>('/admin/users'),
  updateUser: (id: string, body: { role?: string; active?: boolean }) => patch<AuthUser>(`/admin/users/${id}`, body),
  deleteUser: (id: string) => del<{ message: string }>(`/admin/users/${id}`),
  stats: () => get<{ users: number; videos: number; activeSessions: number; failedJobs: number; encodingJobs: number }>('/admin/stats'),
};

// ── Health check ──────────────────────────────────────────────────────────────
export const checkHealth = () =>
  fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) })
    .then(r => r.ok)
    .catch(() => false);
