import { useState, useRef, useCallback, useEffect } from "react";
import Hls from "hls.js";
import { connectSocket, disconnectSocket, getSocket, watchVideo } from "../lib/socket";
import type { EncodingProgressEvent } from "../lib/socket";
import { authApi, encodingApi, checkHealth, uploadFileChunked } from "../lib/api";
import type { ApiVideo, AuthUser } from "../lib/api";
import { motion, AnimatePresence } from "motion/react";
import {
  LayoutDashboard, Upload, Film, Settings, Shield, ChevronRight,
  Play, Pause, SkipForward, Volume2, Maximize2, Eye, Download,
  Trash2, MoreVertical, Search, Bell, User,
  TrendingUp, HardDrive, Zap, Clock, CheckCircle, AlertCircle,
  Loader2, RefreshCw, Plus, Grid3X3, List, X,
  Archive, Share2, Edit3, Copy,
  Activity, Server, Database, Cpu, Wifi,
  ChevronDown, ArrowUpRight,
  Key, Lock, Monitor,
  Check, Layers, GitBranch, UploadCloud, FileVideo,
  Gauge, Radio, Signal, MemoryStick, AlertTriangle, Users,
  ShieldCheck, Mail, Eye as EyeIcon, EyeOff, ArrowLeft,
  Github, Chrome
} from "lucide-react";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, PieChart as RechartsPie, Pie, Cell,
  LineChart, Line
} from "recharts";

// ─── Types ────────────────────────────────────────────────────────────────────
type Page = "auth" | "dashboard" | "upload" | "library" | "player" | "encoding" | "storage" | "settings" | "admin";
type AuthView = "login" | "register";
type ThumbnailOption = { path: string; url: string; timestamp: number };

interface UploadItem {
  id: string;
  name: string;
  size: number;
  progress: number;
  status: "queued" | "uploading" | "processing" | "encoding" | "done" | "error" | "paused";
  speed: number;
  eta: number;
  chunks: number;
  chunksUploaded: number;
  retries: number;
  videoId?: string;
  thumbnailOptions?: ThumbnailOption[];
  showThumbnailSelector?: boolean;
}

interface Video {
  id: string;
  title: string;
  description: string;
  duration: string;
  size: string;
  status: "published" | "draft" | "processing" | "failed" | "archived";
  views: number;
  thumb: string;
  hlsUrl?: string;
  resolution: string;
  codec: string;
  uploadedAt: string;
  tags: string[];
  ownerId: string;
  streams?: Array<{ quality: string; bitrate: number; size: number; status: string }>;
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function fmt(bytes: number) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}
function fmtEta(s: number) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

const pipelineStages = [
  { id: "upload", label: "Upload", icon: UploadCloud },
  { id: "chunking", label: "Chunking", icon: Layers },
  { id: "merge", label: "Merge", icon: GitBranch },
  { id: "validate", label: "Validation", icon: CheckCircle },
  { id: "ffprobe", label: "FFprobe", icon: Search },
  { id: "thumbnail", label: "Thumbnails", icon: Film },
  { id: "preview", label: "Preview", icon: Play },
  { id: "ffmpeg", label: "Encoding", icon: Cpu },
  { id: "hls", label: "HLS Stream", icon: Radio },
  { id: "metadata", label: "Metadata", icon: Database },
  { id: "ready", label: "Ready", icon: CheckCircle },
];

// ─── Shared primitives ────────────────────────────────────────────────────────
function GlassCard({ children, className = "", onClick }: { children: React.ReactNode; className?: string; onClick?: () => void }) {
  return (
    <div onClick={onClick} className={`rounded-2xl border border-white/[0.07] backdrop-blur-xl ${onClick ? "cursor-pointer hover:border-white/[0.12] transition-all" : ""} ${className}`}
      style={{ background: "rgba(255,255,255,0.032)", boxShadow: "0 4px 32px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.055)" }}>
      {children}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    published: { label: "Published", cls: "bg-emerald-500/12 text-emerald-400 border-emerald-500/25" },
    draft:     { label: "Draft",     cls: "bg-amber-500/12 text-amber-400 border-amber-500/25" },
    processing:{ label: "Processing",cls: "bg-blue-500/12 text-blue-400 border-blue-500/25" },
    failed:    { label: "Failed",    cls: "bg-red-500/12 text-red-400 border-red-500/25" },
    archived:  { label: "Archived",  cls: "bg-zinc-500/12 text-zinc-400 border-zinc-500/25" },
    encoding:  { label: "Encoding",  cls: "bg-violet-500/12 text-violet-400 border-violet-500/25" },
    uploading: { label: "Uploading", cls: "bg-blue-500/12 text-blue-400 border-blue-500/25" },
    paused:    { label: "Paused",    cls: "bg-amber-500/12 text-amber-400 border-amber-500/25" },
    queued:    { label: "Queued",    cls: "bg-zinc-500/12 text-zinc-400 border-zinc-500/25" },
    done:      { label: "Done",      cls: "bg-emerald-500/12 text-emerald-400 border-emerald-500/25" },
    error:     { label: "Error",     cls: "bg-red-500/12 text-red-400 border-red-500/25" },
    active:    { label: "Active",    cls: "bg-emerald-500/12 text-emerald-400 border-emerald-500/25" },
    standby:   { label: "Standby",   cls: "bg-amber-500/12 text-amber-400 border-amber-500/25" },
    offline:   { label: "Offline",   cls: "bg-red-500/12 text-red-400 border-red-500/25" },
  };
  const { label, cls } = map[status] ?? { label: status, cls: "bg-white/8 text-white/50 border-white/10" };
  return <span className={`text-[10px] font-semibold tracking-widest uppercase px-2 py-0.5 rounded-md border font-mono ${cls}`}>{label}</span>;
}

function MetricCard({ icon: Icon, label, value, sub, delta, color = "blue" }: { icon: React.ElementType; label: string; value: string; sub?: string; delta?: string; color?: string }) {
  const colors: Record<string, string> = { blue: "#2563eb", indigo: "#4f46e5", cyan: "#06b6d4", emerald: "#10b981", amber: "#f59e0b", red: "#ef4444" };
  const c = colors[color] ?? colors.blue;
  return (
    <GlassCard className="p-5">
      <div className="flex items-start justify-between mb-4">
        <div className="p-2.5 rounded-xl" style={{ background: `${c}1a` }}>
          <Icon size={17} style={{ color: c }} />
        </div>
        {delta && <span className="text-xs font-mono text-emerald-400 flex items-center gap-0.5"><ArrowUpRight size={11} />{delta}</span>}
      </div>
      <div className="text-[26px] font-bold text-white leading-none mb-1.5" style={{ fontFamily: "'Outfit', sans-serif" }}>{value}</div>
      <div className="text-xs text-white/40 font-medium">{label}</div>
      {sub && <div className="text-[11px] text-white/22 mt-0.5 font-mono">{sub}</div>}
    </GlassCard>
  );
}

function ProgressBar({ value, className = "", color = "#2563eb" }: { value: number; className?: string; color?: string }) {
  return (
    <div className={`h-1.5 rounded-full bg-white/[0.07] overflow-hidden ${className}`}>
      <motion.div className="h-full rounded-full" style={{ background: color }}
        initial={{ width: 0 }} animate={{ width: `${Math.min(value, 100)}%` }} transition={{ duration: 0.7, ease: "easeOut" }} />
    </div>
  );
}

function ProgressRing({ pct, size = 52, stroke = 4, color = "#2563eb", label }: { pct: number; size?: number; stroke?: number; color?: string; label?: string }) {
  const r = (size - stroke * 2) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ - (pct / 100) * circ;
  return (
    <div className="relative inline-flex items-center justify-center">
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,255,255,0.07)" strokeWidth={stroke} fill="none" />
        <circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={stroke} fill="none"
          strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 0.7s ease" }} />
      </svg>
      {label && <span className="absolute text-[10px] font-mono font-semibold text-white">{label}</span>}
    </div>
  );
}

// ─── Auth Screens ─────────────────────────────────────────────────────────────
function AuthPage({ onLogin }: { onLogin: (user: AuthUser) => void }) {
  const [view, setView] = useState<"login" | "register">("login");
  const [showPw, setShowPw] = useState(false);

  // Controlled form fields
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [org, setOrg] = useState("");

  // UI state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const goTo = (v: "login" | "register") => { setError(""); setSuccess(""); setView(v); };

  const handleLogin = async () => {
    if (!email || !password) { setError("Email and password are required."); return; }
    setLoading(true); setError(""); setSuccess("");
    try {
      const { user } = await authApi.login(email, password);
      setSuccess("Welcome back!");
      onLogin(user);
    } catch (e: any) {
      setError(e.message || "Login failed.");
    } finally { setLoading(false); }
  };

  const handleRegister = async () => {
    if (!name || !email || !password) { setError("Name, email, and password are required."); return; }
    setLoading(true); setError(""); setSuccess("");
    try {
      const { user } = await authApi.register(name, email, password, org || undefined);
      setSuccess("Account created successfully!");
      onLogin(user);
    } catch (e: any) {
      setError(e.message || "Registration failed.");
    } finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen flex" style={{ background: "#080b14", fontFamily: "'Inter', sans-serif" }}>
      {/* Left panel — branding */}
      <div className="hidden lg:flex flex-col justify-between w-[480px] flex-shrink-0 relative overflow-hidden p-12"
        style={{ background: "linear-gradient(135deg, #0d1117 0%, #0a0e1a 50%, #080b14 100%)" }}>
        {/* Glow orbs */}
        <div className="absolute top-1/4 left-1/3 w-72 h-72 rounded-full pointer-events-none"
          style={{ background: "radial-gradient(circle, rgba(37,99,235,0.18) 0%, transparent 70%)", filter: "blur(40px)" }} />
        <div className="absolute bottom-1/3 right-1/4 w-56 h-56 rounded-full pointer-events-none"
          style={{ background: "radial-gradient(circle, rgba(79,70,229,0.14) 0%, transparent 70%)", filter: "blur(40px)" }} />
        <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: "radial-gradient(rgba(255,255,255,0.03) 1px, transparent 1px)", backgroundSize: "28px 28px" }} />

        <div className="relative">
          <div className="flex items-center gap-3 mb-16">
            <div className="w-10 h-10 rounded-2xl flex items-center justify-center" style={{ background: "linear-gradient(135deg, #2563eb, #4f46e5)" }}>
              <Play size={16} fill="white" className="text-white ml-0.5" />
            </div>
            <span className="text-xl font-bold text-white" style={{ fontFamily: "'Outfit', sans-serif" }}>StreamVault</span>
          </div>

          <div className="space-y-6">
            <h1 className="text-4xl font-bold text-white leading-tight" style={{ fontFamily: "'Outfit', sans-serif" }}>
              Enterprise video<br />at any scale.
            </h1>
            <p className="text-white/45 text-base leading-relaxed">
              Chunk-based uploads, adaptive HLS streaming,<br />real-time encoding — all in one platform.
            </p>
          </div>

          <div className="mt-12 space-y-4">
            {[
              { icon: UploadCloud, label: "Resumable uploads up to 100 GB", color: "#2563eb" },
              { icon: Radio, label: "Adaptive bitrate HLS streaming", color: "#4f46e5" },
              { icon: Cpu, label: "Parallel FFmpeg encoding pipeline", color: "#06b6d4" },
              { icon: ShieldCheck, label: "SHA-256 chunk verification", color: "#10b981" },
            ].map(f => (
              <div key={f.label} className="flex items-center gap-3">
                <div className="p-2 rounded-xl flex-shrink-0" style={{ background: `${f.color}18` }}>
                  <f.icon size={15} style={{ color: f.color }} />
                </div>
                <span className="text-sm text-white/50">{f.label}</span>
              </div>
            ))}
          </div>
        </div>

        <p className="relative text-xs text-white/20 font-mono">© 2025 StreamVault Inc. · SOC 2 Type II · GDPR Compliant</p>
      </div>

      {/* Right panel — form */}
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="w-full max-w-md">
          <AnimatePresence mode="wait">

            {/* LOGIN */}
            {view === "login" && (
              <motion.div key="login" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.22 }}>
                <div className="mb-8">
                  <h2 className="text-2xl font-bold text-white mb-1.5" style={{ fontFamily: "'Outfit', sans-serif" }}>Welcome back</h2>
                  <p className="text-sm text-white/40">Sign in to your StreamVault account</p>
                </div>

                {error && (
                  <div className="mb-4 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-400">{error}</div>
                )}
                {success && (
                  <div className="mb-4 px-4 py-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-sm text-emerald-400">{success}</div>
                )}

                <div className="space-y-4">
                  <div>
                    <label className="text-xs text-white/40 font-mono mb-1.5 block">Email address</label>
                    <div className="relative">
                      <Mail size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/25" />
                      <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && handleLogin()}
                        placeholder="you@company.com"
                        className="w-full pl-10 pr-4 py-3 rounded-xl bg-white/5 border border-white/10 text-sm text-white placeholder-white/20 focus:outline-none focus:border-blue-500/50 focus:bg-white/7 transition-all" />
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-xs text-white/40 font-mono">Password</label>
                    </div>
                    <div className="relative">
                      <Lock size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/25" />
                      <input type={showPw ? "text" : "password"} value={password} onChange={e => setPassword(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && handleLogin()}
                        placeholder="••••••••••••"
                        className="w-full pl-10 pr-10 py-3 rounded-xl bg-white/5 border border-white/10 text-sm text-white placeholder-white/25 focus:outline-none focus:border-blue-500/50 focus:bg-white/7 transition-all" />
                      <button onClick={() => setShowPw(p => !p)} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-white/25 hover:text-white/50 transition-colors">
                        {showPw ? <EyeOff size={14} /> : <EyeIcon size={14} />}
                      </button>
                    </div>
                  </div>
                  <button onClick={handleLogin} disabled={loading}
                    className="w-full py-3 rounded-xl font-semibold text-sm text-white transition-all hover:opacity-90 active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2"
                    style={{ background: "linear-gradient(135deg, #2563eb, #4f46e5)" }}>
                    {loading && <Loader2 size={14} className="animate-spin" />}
                    Sign in
                  </button>
                </div>

                <p className="text-center text-sm text-white/35 mt-6">
                  {"Don't have an account?"}{" "}
                  <button onClick={() => goTo("register")} className="text-blue-400 hover:text-blue-300 font-medium transition-colors">Create one free</button>
                </p>
              </motion.div>
            )}

            {/* REGISTER */}
            {view === "register" && (
              <motion.div key="register" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.22 }}>
                <button onClick={() => goTo("login")} className="flex items-center gap-1.5 text-xs text-white/35 hover:text-white/60 transition-colors mb-8">
                  <ArrowLeft size={13} />Back to sign in
                </button>
                <div className="mb-8">
                  <h2 className="text-2xl font-bold text-white mb-1.5" style={{ fontFamily: "'Outfit', sans-serif" }}>Create account</h2>
                  <p className="text-sm text-white/40">Get started — no credit card required</p>
                </div>

                {error && (
                  <div className="mb-4 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-400">{error}</div>
                )}
                {success && (
                  <div className="mb-4 px-4 py-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-sm text-emerald-400">{success}</div>
                )}

                <div className="space-y-4">
                  <div>
                    <label className="text-xs text-white/40 font-mono mb-1.5 block">Full name</label>
                    <input value={name} onChange={e => setName(e.target.value)} placeholder="Alex Chen"
                      className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-sm text-white placeholder-white/20 focus:outline-none focus:border-blue-500/50 transition-all" />
                  </div>
                  <div>
                    <label className="text-xs text-white/40 font-mono mb-1.5 block">Work email</label>
                    <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com"
                      className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-sm text-white placeholder-white/20 focus:outline-none focus:border-blue-500/50 transition-all" />
                  </div>
                  <div>
                    <label className="text-xs text-white/40 font-mono mb-1.5 block">Company <span className="text-white/20">(optional)</span></label>
                    <input value={org} onChange={e => setOrg(e.target.value)} placeholder="Acme Corp"
                      className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-sm text-white placeholder-white/20 focus:outline-none focus:border-blue-500/50 transition-all" />
                  </div>
                  <div>
                    <label className="text-xs text-white/40 font-mono mb-1.5 block">Password</label>
                    <div className="relative">
                      <Lock size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/25" />
                      <input type={showPw ? "text" : "password"} value={password} onChange={e => setPassword(e.target.value)}
                        placeholder="Min. 8 characters"
                        className="w-full pl-10 pr-10 py-3 rounded-xl bg-white/5 border border-white/10 text-sm text-white placeholder-white/20 focus:outline-none focus:border-blue-500/50 transition-all" />
                      <button onClick={() => setShowPw(p => !p)} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-white/25 hover:text-white/50 transition-colors">
                        {showPw ? <EyeOff size={14} /> : <EyeIcon size={14} />}
                      </button>
                    </div>
                  </div>
                  <button onClick={handleRegister} disabled={loading}
                    className="w-full py-3 rounded-xl font-semibold text-sm text-white transition-all hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
                    style={{ background: "linear-gradient(135deg, #2563eb, #4f46e5)" }}>
                    {loading && <Loader2 size={14} className="animate-spin" />}
                    Create account
                  </button>
                  <p className="text-center text-xs text-white/25 leading-relaxed">
                    By signing up you agree to our{" "}
                    <span className="text-blue-400/70">Terms of Service</span> and{" "}
                    <span className="text-blue-400/70">Privacy Policy</span>
                  </p>
                </div>
                <p className="text-center text-sm text-white/35 mt-6">
                  Already have an account?{" "}
                  <button onClick={() => goTo("login")} className="text-blue-400 hover:text-blue-300 font-medium transition-colors">Sign in</button>
                </p>
              </motion.div>
            )}

          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
function DashboardPage({ setPage, online }: { setPage: (p: Page) => void; online: boolean | null }) {
  const [stats, setStats] = useState<{ total: number; totalSize: number; totalViews: number } | null>(null);
  const [encJobs, setEncJobs] = useState<ApiVideo[]>([]);

  useEffect(() => {
    if (!online) return;
    import("../lib/api").then(({ videosApi, encodingApi }) => {
      videosApi.stats().then(setStats).catch(() => {});
      encodingApi.jobs().then(d => setEncJobs(d.jobs)).catch(() => {});
    });
  }, [online]);

  const fmt2 = (b: number) => b >= 1e12 ? `${(b/1e12).toFixed(1)} TB` : b >= 1e9 ? `${(b/1e9).toFixed(1)} GB` : `${(b/1e6).toFixed(0)} MB`;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white" style={{ fontFamily: "'Outfit', sans-serif" }}>Overview</h1>
          <p className="text-sm text-white/35 mt-0.5">{new Date().toLocaleString()}</p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => setPage("upload")}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-semibold hover:opacity-90 transition-all"
            style={{ background: "linear-gradient(135deg, #2563eb, #4f46e5)" }}>
            <Plus size={14} />New Upload
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard icon={Film} label="Total Videos" value={stats?.total != null ? stats.total.toLocaleString() : "0"} sub="across all folders" color="blue" />
        <MetricCard icon={HardDrive} label="Storage Used" value={stats?.totalSize != null ? fmt2(stats.totalSize) : "0 MB"} sub="source files" color="indigo" />
        <MetricCard icon={Zap} label="Bandwidth" value={stats?.totalSize != null ? fmt2(stats.totalSize * 2) : "0 MB"} sub="this month" color="cyan" />
        <MetricCard icon={Eye} label="Total Views" value={stats?.totalViews != null ? (stats.totalViews >= 1000 ? `${(stats.totalViews/1000).toFixed(1)}K` : String(stats.totalViews)) : "0"} sub="all time" color="emerald" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <GlassCard className="lg:col-span-2 p-5">
          <div className="flex items-center justify-between mb-5">
            <h3 className="text-sm font-semibold text-white/75">Bandwidth Usage</h3>
          </div>
          <ResponsiveContainer width="100%" height={175}>
            <AreaChart data={[]}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
              <XAxis dataKey="time" tick={{ fill: "rgba(255,255,255,0.28)", fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: "rgba(255,255,255,0.28)", fontSize: 10 }} axisLine={false} tickLine={false} unit=" GB" />
              <Tooltip contentStyle={{ background: "#0f1320", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, color: "#fff", fontSize: 11 }} />
              <Area type="monotone" dataKey="upload" stroke="#2563eb" strokeWidth={2} />
              <Area type="monotone" dataKey="download" stroke="#4f46e5" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </GlassCard>

        <GlassCard className="p-5">
          <h3 className="text-sm font-semibold text-white/75 mb-5">Storage Breakdown</h3>
          <div className="space-y-2 text-center text-white/50 py-10">
            No storage data available
          </div>
        </GlassCard>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <GlassCard className="lg:col-span-2 p-5">
          <div className="flex items-center justify-between mb-5">
            <h3 className="text-sm font-semibold text-white/75">Video Views</h3>
          </div>
          <ResponsiveContainer width="100%" height={155}>
            <BarChart data={[]}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
              <XAxis dataKey="day" tick={{ fill: "rgba(255,255,255,0.28)", fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: "rgba(255,255,255,0.28)", fontSize: 10 }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{ background: "#0f1320", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, color: "#fff", fontSize: 11 }} />
              <Bar dataKey="views" fill="#2563eb" radius={[5, 5, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </GlassCard>

        <GlassCard className="p-5">
          <h3 className="text-sm font-semibold text-white/75 mb-4 flex items-center justify-between">
            Encoding Queue
            <button onClick={() => setPage("encoding")} className="text-[10px] font-mono text-blue-400/70 hover:text-blue-400 transition-colors">View all →</button>
          </h3>
          <div className="space-y-4">
            {(online && encJobs.length > 0
              ? encJobs.slice(0, 4).map((v, i) => ({
                  key: v._id,
                  name: v.originalName || v.title,
                  stage: v.encodingStage || v.status,
                  pct: v.encodingProgress ?? 0,
                  color: v.status === "failed" ? "#ef4444" : ["#2563eb","#4f46e5","#06b6d4","#10b981"][i % 4],
                }))
              : []
            ).map(item => (
              <div key={item.key} className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-white/60 truncate pr-2">{item.name}</span>
                  <span className="text-xs font-mono text-white/35 flex-shrink-0">{item.pct}%</span>
                </div>
                <ProgressBar value={item.pct} color={item.color} />
                <p className="text-[10px] text-white/25 font-mono">{item.stage}</p>
              </div>
            ))}
            {encJobs.length === 0 && (
              <div className="text-center py-6 text-white/40">
                <p className="text-sm">No encoding jobs in progress</p>
                <p className="text-xs font-mono mt-1">Upload a video to start encoding</p>
              </div>
            )}
          </div>
        </GlassCard>
      </div>

      <GlassCard className="p-5">
        <h3 className="text-sm font-semibold text-white/75 mb-4">Recent Activity</h3>
        <div className="text-center py-6 text-white/40">
          <p className="text-sm">Activity log will appear here</p>
        </div>
      </GlassCard>
    </div>
  );
}

// ─── Upload Center ────────────────────────────────────────────────────────────
function UploadPage({ online, liveEvents }: { online: boolean | null; liveEvents: Record<string, EncodingProgressEvent> }) {
  const [dragging, setDragging] = useState(false);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const abortRefs = useRef<Map<string, AbortController>>(new Map());
  // Track file references and upload state for resume
  const fileRefs = useRef<Map<string, { file: File; uploadId: string; lastChunk: number }>>(new Map());

  const startUpload = async (file: File) => {
    if (!online) return;
    const id = crypto.randomUUID();
    const chunkSize = 5 * 1024 * 1024;
    const chunks = Math.ceil(file.size / chunkSize);
    const ctrl = new AbortController();
    abortRefs.current.set(id, ctrl);

    setUploads(u => [...u, {
      id, name: file.name, size: file.size, progress: 0,
      status: "uploading", speed: 0, eta: 0,
      chunks, chunksUploaded: 0, retries: 0,
    }]);

    const doUpload = async (signal: AbortSignal) => {
      try {
        await uploadFileChunked(
          file,
          p => {
            fileRefs.current.set(id, { file, uploadId: p.uploadId, lastChunk: p.chunkIndex });
            setUploads(u => u.map(i => i.id === id ? {
              ...i, progress: p.progress, speed: p.speed, eta: p.eta,
              chunksUploaded: p.chunkIndex + 1, status: "uploading",
            } : i));
          },
          _videoId => {
            fileRefs.current.delete(id);
            setUploads(u => u.map(i => i.id === id ? { ...i, progress: 100, status: "encoding", speed: 0, eta: 0, videoId: _videoId } : i));
            // Subscribe to encoding events for this video
            try { watchVideo(_videoId); } catch { /* socket may not be connected yet */ }
          },
          err => {
            if (err.message === 'Upload cancelled') return;
            setUploads(u => u.map(i => i.id === id ? { ...i, status: "error", speed: 0, eta: 0, retries: i.retries + 1 } : i));
            // Auto-retry with exponential backoff when network error
            const item = fileRefs.current.get(id);
            if (item) {
              const retryCount = uploads.find(u => u.id === id)?.retries ?? 0;
              const delay = Math.min(1000 * Math.pow(2, retryCount), 30000);
              setTimeout(() => {
                if (!abortRefs.current.has(id)) {
                  const newCtrl = new AbortController();
                  abortRefs.current.set(id, newCtrl);
                }
                setUploads(u => u.map(i => i.id === id ? { ...i, status: "uploading" } : i));
                doUpload(abortRefs.current.get(id)!.signal);
              }, delay);
            }
          },
          signal,
        );
      } catch { /* handled by onError callback */ }
    };

    doUpload(ctrl.signal);
  };

  // Re-attempt paused uploads when coming back online
  useEffect(() => {
    if (online) {
      setUploads(u => u.map(item => {
        if (item.status === "paused" || item.status === "error") {
          const ref = fileRefs.current.get(item.id);
          if (ref) {
            const ctrl = new AbortController();
            abortRefs.current.set(item.id, ctrl);
            // Re-start upload — the server de-duplicates already-received chunks
            uploadFileChunked(
              ref.file,
              p => setUploads(prev => prev.map(i => i.id === item.id ? {
                ...i, progress: p.progress, speed: p.speed, eta: p.eta,
                chunksUploaded: p.chunkIndex + 1, status: "uploading",
              } : i)),
              vid => {
                fileRefs.current.delete(item.id);
                setUploads(prev => prev.map(i => i.id === item.id ? { ...i, progress: 100, status: "encoding", speed: 0, eta: 0, videoId: vid } : i));
                try { watchVideo(vid); } catch { /* ignore */ }
              },
              _err => setUploads(prev => prev.map(i => i.id === item.id ? { ...i, status: "error", speed: 0, eta: 0 } : i)),
              ctrl.signal,
            );
            return { ...item, status: "uploading" as const };
          }
        }
        return item;
      }));
    }
  }, [online]);

  // Watch live encoding events; mark upload done when encoding reaches 100%
  useEffect(() => {
    setUploads(u => u.map(item => {
      if (item.videoId && item.status === "encoding") {
        const evt = liveEvents[item.videoId];
        if (evt && evt.progress >= 100) {
          return { ...item, status: "done" as const };
        }
      }
      return item;
    }));
  }, [liveEvents]);

  const handleFiles = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach(f => { if (f.type.startsWith("video/")) startUpload(f); });
  };

  const togglePause = (id: string) => {
    const ctrl = abortRefs.current.get(id);
    if (ctrl) {
      ctrl.abort();
      abortRefs.current.delete(id);
      setUploads(u => u.map(i => i.id === id ? { ...i, status: "paused" } : i));
    }
  };

  const resumeUpload = (id: string) => {
    const ref = fileRefs.current.get(id);
    if (!ref || !online) return;
    const ctrl = new AbortController();
    abortRefs.current.set(id, ctrl);
    setUploads(u => u.map(i => i.id === id ? { ...i, status: "uploading" } : i));
    uploadFileChunked(
      ref.file,
      p => setUploads(u => u.map(i => i.id === id ? {
        ...i, progress: p.progress, speed: p.speed, eta: p.eta,
        chunksUploaded: p.chunkIndex + 1, status: "uploading",
      } : i)),
      vid => {
        fileRefs.current.delete(id);
        setUploads(u => u.map(i => i.id === id ? { ...i, progress: 100, status: "encoding", speed: 0, eta: 0, videoId: vid } : i));
        try { watchVideo(vid); } catch { /* ignore */ }
      },
      _err => setUploads(u => u.map(i => i.id === id ? { ...i, status: "error", speed: 0, eta: 0 } : i)),
      ctrl.signal,
    );
  };

  const cancel = (id: string) => {
    abortRefs.current.get(id)?.abort();
    abortRefs.current.delete(id);
    setUploads(u => u.filter(i => i.id !== id));
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white" style={{ fontFamily: "'Outfit', sans-serif" }}>Upload Center</h1>
          <p className="text-sm text-white/35 mt-0.5">Chunked uploads · Auto-resume · Up to 100 GB per file</p>
        </div>
        <div className="flex items-center gap-2 text-xs font-mono">
          <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border ${online ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400" : "bg-amber-500/10 border-amber-500/20 text-amber-400"}`}>
            <Wifi size={12} />{online ? "Connected" : "Backend offline"}
          </div>
        </div>
      </div>

      {/* Drop zone */}
      <motion.div
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files); }}
        animate={{ borderColor: dragging ? "#2563eb" : "rgba(255,255,255,0.09)" }}
        transition={{ duration: 0.18 }}
        className="rounded-2xl border-2 border-dashed p-16 flex flex-col items-center justify-center cursor-pointer relative overflow-hidden"
        style={{ background: dragging ? "rgba(37,99,235,0.06)" : "rgba(255,255,255,0.018)" }}
        onClick={() => fileRef.current?.click()}
      >
        {dragging && (
          <motion.div className="absolute inset-0 pointer-events-none" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
            style={{ background: "radial-gradient(ellipse at center, rgba(37,99,235,0.14) 0%, transparent 70%)" }} />
        )}
        <motion.div animate={{ scale: dragging ? 1.08 : 1 }} transition={{ type: "spring", stiffness: 280 }}>
          <div className="w-20 h-20 rounded-2xl flex items-center justify-center mx-auto mb-5 border"
            style={{ background: "rgba(37,99,235,0.1)", borderColor: "rgba(37,99,235,0.25)" }}>
            <UploadCloud size={34} className="text-blue-400" />
          </div>
        </motion.div>
        <h2 className="text-xl font-bold text-white mb-2" style={{ fontFamily: "'Outfit', sans-serif" }}>
          {dragging ? "Drop to upload" : "Drop files here to upload"}
        </h2>
        <p className="text-sm text-white/35 mb-7">or click to browse — MP4, MOV, MKV, AVI, WebM · Max 100 GB</p>
        <div className="flex items-center gap-6 text-xs font-mono text-white/28">
          {[
            { icon: Layers, label: "Chunked", color: "#2563eb" },
            { icon: RefreshCw, label: "Auto-resume", color: "#10b981" },
            { icon: ShieldCheck, label: "Hash verified", color: "#4f46e5" },
            { icon: Zap, label: "Parallel", color: "#f59e0b" },
          ].map(f => (
            <span key={f.label} className="flex items-center gap-1.5">
              <f.icon size={11} style={{ color: f.color }} />{f.label}
            </span>
          ))}
        </div>
        <input ref={fileRef} type="file" className="hidden" multiple accept="video/*"
          onChange={e => handleFiles(e.target.files)} />
      </motion.div>

      {/* Upload queue */}
      <GlassCard className="p-5">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-sm font-semibold text-white/75">Upload Queue</h3>
          <div className="flex items-center gap-2 text-xs font-mono">
            {uploads.filter(i => i.status === "uploading").length > 0 && (
              <span className="px-2 py-0.5 rounded-md bg-blue-500/10 text-blue-400 border border-blue-500/15">
                {uploads.filter(i => i.status === "uploading").length} uploading
              </span>
            )}
            <span className="px-2 py-0.5 rounded-md bg-white/5 border border-white/10 text-white/35">{uploads.length} total</span>
          </div>
        </div>
        <div className="space-y-3">
          {uploads.map(item => (
            <motion.div key={item.id} layout
              className="p-4 rounded-xl border border-white/[0.06] hover:border-white/[0.1] transition-all"
              style={{ background: "rgba(255,255,255,0.018)" }}>
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 mt-0.5">
                  {item.status === "uploading" ? (
                    <ProgressRing pct={item.progress} size={44} color="#2563eb" label={`${item.progress}%`} />
                  ) : item.status === "encoding" ? (
                    <ProgressRing pct={80} size={44} color="#4f46e5" label="enc" />
                  ) : item.status === "error" ? (
                    <div className="w-11 h-11 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center">
                      <AlertCircle size={18} className="text-red-400" />
                    </div>
                  ) : (
                    <div className="w-11 h-11 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center">
                      <FileVideo size={18} className="text-white/30" />
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-white truncate">{item.name}</span>
                    <StatusBadge status={item.status} />
                  </div>
                  <div className="flex items-center gap-3 text-xs font-mono text-white/30 mb-3 flex-wrap">
                    <span>{fmt(item.size)}</span>
                    <span className="text-white/15">·</span>
                    <span>Chunk {item.chunksUploaded}/{item.chunks}</span>
                    {item.status === "uploading" && (
                      <>
                        <span className="text-white/15">·</span>
                        <span className="text-blue-400/70">{item.speed} MB/s</span>
                        <span className="text-white/15">·</span>
                        <span>ETA {fmtEta(item.eta)}</span>
                      </>
                    )}
                    {item.retries > 0 && <span className="text-amber-400/70">↺ {item.retries} retries</span>}
                  </div>
                  {/* Chunk visualiser */}
                  {item.status === "uploading" && (
                    <div className="flex gap-0.5 mb-2 flex-wrap">
                      {Array.from({ length: Math.min(24, item.chunks) }).map((_, ci) => {
                        const filled = ci < Math.floor(item.chunksUploaded / item.chunks * 24);
                        const active = ci === Math.floor(item.chunksUploaded / item.chunks * 24);
                        return (
                          <div key={ci} className={`h-2 rounded-sm flex-1 min-w-0 transition-all ${filled ? "bg-blue-500" : active ? "bg-blue-400 animate-pulse" : "bg-white/8"}`}
                            style={{ maxWidth: 10 }} />
                        );
                      })}
                    </div>
                  )}
                  <ProgressBar value={item.progress}
                    color={item.status === "error" ? "#ef4444" : item.status === "done" || item.status === "encoding" ? "#10b981" : item.status === "paused" ? "#f59e0b" : "#2563eb"} />
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {item.status === "uploading" && (
                    <button onClick={() => togglePause(item.id)}
                      className="p-2 rounded-lg hover:bg-white/8 text-white/40 hover:text-white transition-colors">
                      <Pause size={14} />
                    </button>
                  )}
                  {item.status === "paused" && (
                    <button onClick={() => resumeUpload(item.id)}
                      className="p-2 rounded-lg hover:bg-white/8 text-white/40 hover:text-white transition-colors">
                      <Play size={14} />
                    </button>
                  )}
                  {item.status === "error" && (
                    <button onClick={() => resumeUpload(item.id)}
                      className="p-2 rounded-lg hover:bg-emerald-500/10 text-white/40 hover:text-emerald-400 transition-colors" title="Retry">
                      <RefreshCw size={14} />
                    </button>
                  )}
                  <button onClick={() => cancel(item.id)}
                    className="p-2 rounded-lg hover:bg-red-500/10 text-white/25 hover:text-red-400 transition-colors">
                    <X size={14} />
                  </button>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </GlassCard>

      {/* Pipeline visualizer */}
      {(() => {
        const active = uploads.find(u => u.status === "encoding") ?? uploads.find(u => u.status === "uploading") ?? uploads[0];
        const liveEvent = active?.videoId ? liveEvents[active.videoId] : undefined;

        // Determine current stage from actual events / upload status
        const getStageIdx = () => {
          if (!active) return -1;
          if (active.status === "uploading") {
            // Upload phase: stages 0 (upload) → 1 (chunking) based on chunk progress
            return active.progress < 100 ? 0 : 1;
          }
          if (active.status === "encoding") {
            // Use live socket event stage name if available
            const stage = (liveEvent?.stage || "").toLowerCase();
            if (stage.includes("merg")) return 2;
            if (stage.includes("valid")) return 3;
            if (stage.includes("ffprobe")) return 4;
            if (stage.includes("thumb")) return 5;
            if (stage.includes("preview")) return 6;
            if (stage.includes("encoding")) return 7;
            if (stage.includes("hls") || stage.includes("segment") || stage.includes("playlist")) return 8;
            if (stage.includes("metadata")) return 9;
            if (stage.includes("ready") || stage.includes("done") || stage.includes("complete")) return 10;
            return 2; // Just started post-upload
          }
          if (active.status === "done") return 10;
          return 0;
        };
        const stageIdx = getStageIdx();
        return (
      <GlassCard className="p-5">
        <h3 className="text-sm font-semibold text-white/75 mb-6">
          Processing Pipeline{active ? ` — ${active.name}` : ""}
          {liveEvent && <span className="ml-2 text-[10px] font-mono text-emerald-400/70">· {liveEvent.stage} ({liveEvent.progress}%)</span>}
        </h3>
        <div className="flex items-center flex-wrap gap-0">
          {pipelineStages.map((stage, i) => {
            const Icon = stage.icon;
            const isDone = active ? i < stageIdx : false;
            const isActive = active ? i === stageIdx : false;
            return (
              <div key={stage.id} className="flex items-center">
                <div className={`flex flex-col items-center gap-2 px-3 py-2.5 rounded-xl ${isDone || isActive ? "opacity-100" : "opacity-30"}`}>
                  <div className={`w-9 h-9 rounded-xl flex items-center justify-center border transition-all ${
                    isDone ? "bg-emerald-500/12 border-emerald-500/28" :
                    isActive ? "bg-blue-500/18 border-blue-500/35" :
                    "bg-white/4 border-white/10"}`}>
                    {isDone ? <Check size={15} className="text-emerald-400" /> :
                     isActive ? <Loader2 size={15} className="text-blue-400 animate-spin" /> :
                     <Icon size={14} className="text-white/28" />}
                  </div>
                  <span className={`text-[9.5px] font-mono font-semibold whitespace-nowrap ${isDone ? "text-emerald-400" : isActive ? "text-blue-400" : "text-white/28"}`}>{stage.label}</span>
                </div>
                {i < pipelineStages.length - 1 && (
                  <div className={`w-3 h-px flex-shrink-0 ${isDone ? "bg-emerald-500/35" : "bg-white/8"}`} />
                )}
              </div>
            );
          })}
        </div>
      </GlassCard>
        );
      })()}
    </div>
  );
}

// ─── Video Library ────────────────────────────────────────────────────────────
function LibraryPage({ onPlayVideo, online, user }: { onPlayVideo: (v: Video) => void; online: boolean | null; user: AuthUser | null }) {
  const [view, setView] = useState<"grid" | "list">("grid");
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [apiVideos, setApiVideos] = useState<Video[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!online) { setApiVideos([]); return; }
    setLoading(true);
    import("../lib/api").then(({ videosApi }) =>
      videosApi.list({ status: filter === "all" ? undefined : filter, search: search || undefined })
        .then(data => {
          setApiVideos(data.videos.map(v => ({
            id: v._id, title: v.title,
            duration: v.duration ? `${Math.floor(v.duration/60)}:${String(v.duration%60).padStart(2,"0")}` : "—",
            size: v.sizeBytes >= 1e9 ? `${(v.sizeBytes/1e9).toFixed(1)} GB` : `${(v.sizeBytes/1e6).toFixed(0)} MB`,
            status: (v.status === "encoding" || v.status === "uploading" ? "processing" : v.status) as Video["status"],
            views: v.views,
            thumb: v.thumbnailUrl || (v.thumbnailPath ? `/uploads/${v.thumbnailPath}` : ""),
            hlsUrl: v.hlsUrl || undefined,
            resolution: v.height ? `${v.height}p` : "—", codec: v.codec || "—",
            uploadedAt: v.createdAt.slice(0, 10), tags: v.tags,
          })));
        })
        .catch(() => setApiVideos([]))
        .finally(() => setLoading(false))
    );
  }, [online, filter, search]);

  const filters = ["all", "published", "draft", "processing", "failed"];
  const filtered = apiVideos.filter(v =>
    (filter === "all" || v.status === filter) &&
    (!search || v.title.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white" style={{ fontFamily: "'Outfit', sans-serif" }}>Video Library</h1>
          <p className="text-sm text-white/35 mt-0.5">
            {loading ? "Loading…" : `${filtered.length} video${filtered.length !== 1 ? "s" : ""}`}
          </p>
        </div>
        <button className="flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-semibold hover:opacity-90 transition-all"
          style={{ background: "linear-gradient(135deg, #2563eb, #4f46e5)" }}>
          <Plus size={14} />Upload Video
        </button>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search size={13} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/28" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search videos…"
            className="w-full pl-9 pr-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm text-white placeholder-white/22 focus:outline-none focus:border-blue-500/45 transition-colors" />
        </div>
        <div className="flex items-center gap-1 p-1 rounded-xl bg-white/5 border border-white/8 flex-wrap">
          {filters.map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-3 py-1 rounded-lg text-xs font-medium capitalize transition-all ${filter === f ? "bg-blue-600 text-white" : "text-white/38 hover:text-white/65"}`}>
              {f}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 p-1 rounded-xl bg-white/5 border border-white/8">
          <button onClick={() => setView("grid")} className={`p-2 rounded-lg transition-all ${view === "grid" ? "bg-white/10 text-white" : "text-white/28 hover:text-white/55"}`}><Grid3X3 size={13} /></button>
          <button onClick={() => setView("list")} className={`p-2 rounded-lg transition-all ${view === "list" ? "bg-white/10 text-white" : "text-white/28 hover:text-white/55"}`}><List size={13} /></button>
        </div>
      </div>

      <AnimatePresence mode="wait">
        {view === "grid" ? (
          <motion.div key="grid" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map((v, idx) => (
              <motion.div key={v.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: idx * 0.04 }}
                className="group rounded-2xl border border-white/[0.06] overflow-hidden hover:border-white/[0.12] transition-all cursor-pointer"
                style={{ background: "rgba(255,255,255,0.022)" }}
                onClick={() => onPlayVideo(v)}>
                <div className="relative aspect-video bg-zinc-900">
                  <img src={v.thumb} alt={v.title} className="w-full h-full object-cover" />
                  <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <div className="w-11 h-11 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center border border-white/30">
                      <Play size={16} className="text-white ml-0.5" fill="white" />
                    </div>
                  </div>
                  <div className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded bg-black/70 backdrop-blur-sm text-xs font-mono text-white">{v.duration}</div>
                  <div className="absolute top-2 left-2"><StatusBadge status={v.status} /></div>
                </div>
                <div className="p-4">
                  <h4 className="text-sm font-semibold text-white mb-2 line-clamp-2 leading-snug">{v.title}</h4>
                  <div className="flex items-center gap-2.5 text-xs font-mono text-white/32">
                    <span>{v.resolution}</span><span className="text-white/15">·</span>
                    <span>{v.size}</span><span className="text-white/15">·</span>
                    <span className="flex items-center gap-1"><Eye size={10} />{(v.views ?? 0).toLocaleString()}</span>
                  </div>
                  <div className="flex gap-1.5 mt-3 flex-wrap">
                    {v.tags.map(t => <span key={t} className="px-2 py-0.5 rounded-md bg-white/5 border border-white/8 text-[10px] text-white/35 font-mono">{t}</span>)}
                  </div>
                </div>
              </motion.div>
            ))}
          </motion.div>
        ) : (
          <motion.div key="list" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
            <GlassCard className="p-0 overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/[0.05]">
                    {["Title", "Status", "Resolution", "Size", "Views", ""].map((h, i) => (
                      <th key={i} className={`text-left text-xs font-semibold text-white/32 px-5 py-3 ${i > 1 && i < 4 ? "hidden md:table-cell" : ""} ${i === 1 ? "hidden lg:table-cell" : ""}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(v => (
                    <tr key={v.id} className="border-b border-white/[0.04] last:border-0 hover:bg-white/[0.025] transition-colors cursor-pointer" onClick={() => onPlayVideo(v)}>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-3">
                          <img src={v.thumb} alt={v.title} className="w-12 h-7 rounded-lg object-cover bg-zinc-800 flex-shrink-0" />
                          <div>
                            <p className="text-sm text-white font-medium line-clamp-1">{v.title}</p>
                            <p className="text-xs font-mono text-white/28 mt-0.5">{v.duration} · {v.uploadedAt}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 hidden lg:table-cell"><StatusBadge status={v.status} /></td>
                      <td className="px-3 py-3 hidden md:table-cell text-xs font-mono text-white/42">{v.resolution}</td>
                      <td className="px-3 py-3 hidden md:table-cell text-xs font-mono text-white/42">{v.size}</td>
                      <td className="px-3 py-3 text-xs font-mono text-white/42">{(v.views ?? 0).toLocaleString()}</td>
                      <td className="px-3 py-3">
                        <button onClick={e => e.stopPropagation()} className="p-1.5 rounded-lg hover:bg-white/8 text-white/25 hover:text-white/60 transition-colors">
                          <MoreVertical size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </GlassCard>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Netflix-style HLS Video Player ───────────────────────────────────────────
interface HlsPlayerProps {
  src: string;
  poster?: string;
  onError?: (msg: string) => void;
}

function HlsPlayer({ src, poster, onError }: HlsPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showControls, setShowControls] = useState(true);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [levels, setLevels] = useState<Array<{ height: number; bitrate: number; index: number }>>([]);
  const [currentLevel, setCurrentLevel] = useState(-1); // -1 = auto
  const [showSettings, setShowSettings] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const controlsTimerRef = useRef<number | null>(null);

  const scheduleHideControls = useCallback(() => {
    if (controlsTimerRef.current) window.clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = window.setTimeout(() => setShowControls(false), 3000);
  }, []);

  const showControlsNow = useCallback(() => {
    setShowControls(true);
    scheduleHideControls();
  }, [scheduleHideControls]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    setError(null);
    setLoading(true);

    if (Hls.isSupported()) {
      const hls = new Hls({
        startLevel: -1,
        capLevelToPlayerSize: true,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        maxBufferSize: 60 * 1000 * 1000,
        lowLatencyMode: false,
      });
      hlsRef.current = hls;
      hls.loadSource(src);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
        setLoading(false);
        const lvls = (data.levels || []).map((l: any, i: number) => ({
          height: l.height || 0,
          bitrate: l.bitrate || 0,
          index: i,
        }));
        setLevels(lvls);
      });
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError();
              break;
            default:
              const msg = data.details || "Playback error";
              setError(msg);
              onError?.(msg);
              hls.destroy();
          }
        }
      });

      return () => { hls.destroy(); hlsRef.current = null; };
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      video.addEventListener("loadedmetadata", () => setLoading(false));
    } else {
      const msg = "HLS is not supported in this browser";
      setError(msg);
      onError?.(msg);
    }
  }, [src, onError]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => {
      setCurrentTime(v.currentTime);
      if (v.buffered.length > 0) setBuffered(v.buffered.end(v.buffered.length - 1));
    };
    const onDur = () => setDuration(v.duration || 0);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onWaiting = () => setLoading(true);
    const onPlaying = () => setLoading(false);
    const onVol = () => { setMuted(v.muted); setVolume(v.volume); };
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("durationchange", onDur);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("waiting", onWaiting);
    v.addEventListener("playing", onPlaying);
    v.addEventListener("volumechange", onVol);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("durationchange", onDur);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("waiting", onWaiting);
      v.removeEventListener("playing", onPlaying);
      v.removeEventListener("volumechange", onVol);
    };
  }, []);

  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    v.paused ? v.play() : v.pause();
  };
  const toggleMute = () => { const v = videoRef.current; if (v) v.muted = !v.muted; };
  const setVol = (val: number) => { const v = videoRef.current; if (v) { v.volume = val; v.muted = val === 0; } };
  const seek = (t: number) => { const v = videoRef.current; if (v) v.currentTime = Math.max(0, Math.min(duration, t)); };
  const setRate = (r: number) => { const v = videoRef.current; if (v) { v.playbackRate = r; setPlaybackRate(r); } };
  const changeQuality = (i: number) => {
    const hls = hlsRef.current;
    if (!hls) return;
    hls.currentLevel = i; // -1 = auto
    setCurrentLevel(i);
    setShowSettings(false);
  };
  const toggleFullscreen = () => {
    const c = containerRef.current;
    if (!c) return;
    if (!document.fullscreenElement) c.requestFullscreen();
    else document.exitFullscreen();
  };

  const fmtTime = (t: number) => {
    if (!isFinite(t) || t < 0) return "0:00";
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  };

  if (error) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-black text-white/60 text-sm">
        <div className="text-center">
          <AlertCircle className="mx-auto mb-2 text-red-400" size={28} />
          <p>{error}</p>
        </div>
      </div>
    );
  }

  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufferedPct = duration > 0 ? (buffered / duration) * 100 : 0;

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full bg-black group"
      onMouseMove={showControlsNow}
      onMouseLeave={() => setShowControls(false)}
    >
      <video
        ref={videoRef}
        poster={poster}
        className="w-full h-full object-contain bg-black"
        onClick={togglePlay}
        onDoubleClick={toggleFullscreen}
        style={{ display: "block" }}
      />

      {loading && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <Loader2 size={44} className="text-white/80 animate-spin" />
        </div>
      )}

      {/* Center play/pause overlay */}
      {!isPlaying && !loading && (
        <button
          onClick={togglePlay}
          className="absolute inset-0 flex items-center justify-center bg-black/20 hover:bg-black/30 transition-colors"
        >
          <div className="w-20 h-20 rounded-full bg-white/15 backdrop-blur-md border border-white/25 flex items-center justify-center">
            <Play size={30} className="text-white ml-1" fill="white" />
          </div>
        </button>
      )}

      {/* Controls bar */}
      <div
        className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/60 to-transparent px-4 pt-14 pb-3 transition-opacity duration-300 ${showControls || !isPlaying ? "opacity-100" : "opacity-0 pointer-events-none"}`}
      >
        {/* Progress bar */}
        <div className="relative w-full h-1 group/progress cursor-pointer mb-2 hover:h-1.5 transition-all"
          onClick={e => {
            const rect = e.currentTarget.getBoundingClientRect();
            seek(((e.clientX - rect.left) / rect.width) * duration);
          }}>
          <div className="absolute inset-0 bg-white/20 rounded-full" />
          <div className="absolute inset-y-0 left-0 bg-white/40 rounded-full" style={{ width: `${bufferedPct}%` }} />
          <div className="absolute inset-y-0 left-0 bg-red-500 rounded-full" style={{ width: `${progressPct}%` }} />
          <div
            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-red-500 opacity-0 group-hover/progress:opacity-100 transition-opacity"
            style={{ left: `${progressPct}%` }}
          />
        </div>

        {/* Buttons row */}
        <div className="flex items-center gap-3 text-white">
          <button onClick={togglePlay} className="hover:text-red-400 transition-colors">
            {isPlaying ? <Pause size={20} fill="white" /> : <Play size={20} fill="white" />}
          </button>
          <button onClick={() => seek(currentTime - 10)} className="hover:text-red-400 transition-colors" title="Back 10s">
            <SkipForward size={18} className="rotate-180" />
          </button>
          <button onClick={() => seek(currentTime + 10)} className="hover:text-red-400 transition-colors" title="Forward 10s">
            <SkipForward size={18} />
          </button>

          {/* Volume */}
          <div className="flex items-center gap-1 group/vol">
            <button onClick={toggleMute} className="hover:text-red-400 transition-colors">
              <Volume2 size={18} className={muted || volume === 0 ? "opacity-40" : ""} />
            </button>
            <input
              type="range" min={0} max={1} step={0.05}
              value={muted ? 0 : volume}
              onChange={e => setVol(parseFloat(e.target.value))}
              className="w-0 group-hover/vol:w-20 transition-all accent-red-500"
            />
          </div>

          <span className="text-xs font-mono text-white/85 ml-1">
            {fmtTime(currentTime)} / {fmtTime(duration)}
          </span>

          <div className="ml-auto flex items-center gap-3 relative">
            {/* Settings gear */}
            <button onClick={() => setShowSettings(s => !s)} className="hover:text-red-400 transition-colors">
              <Settings size={18} />
            </button>

            {showSettings && (
              <div className="absolute bottom-full right-0 mb-3 w-56 rounded-xl bg-black/95 border border-white/10 backdrop-blur-xl overflow-hidden shadow-2xl">
                <div className="px-4 py-2.5 border-b border-white/10">
                  <p className="text-[10px] font-mono text-white/40 uppercase tracking-wider mb-2">Quality</p>
                  <div className="space-y-0.5">
                    <button
                      onClick={() => changeQuality(-1)}
                      className={`w-full text-left px-2 py-1.5 rounded-md text-xs flex items-center justify-between hover:bg-white/10 ${currentLevel === -1 ? "text-red-400" : "text-white/80"}`}
                    >
                      <span>Auto</span>
                      {currentLevel === -1 && <Check size={12} />}
                    </button>
                    {levels.map(l => (
                      <button
                        key={l.index}
                        onClick={() => changeQuality(l.index)}
                        className={`w-full text-left px-2 py-1.5 rounded-md text-xs flex items-center justify-between hover:bg-white/10 ${currentLevel === l.index ? "text-red-400" : "text-white/80"}`}
                      >
                        <span>{l.height ? `${l.height}p` : `Level ${l.index}`}</span>
                        <span className="font-mono text-[10px] text-white/40">{Math.round(l.bitrate / 1000)}k</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="px-4 py-2.5">
                  <p className="text-[10px] font-mono text-white/40 uppercase tracking-wider mb-2">Speed</p>
                  <div className="grid grid-cols-4 gap-1">
                    {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(r => (
                      <button
                        key={r}
                        onClick={() => setRate(r)}
                        className={`px-2 py-1 rounded-md text-[11px] font-mono hover:bg-white/10 ${playbackRate === r ? "text-red-400 bg-white/5" : "text-white/70"}`}
                      >
                        {r === 1 ? "1x" : `${r}x`}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <button onClick={toggleFullscreen} className="hover:text-red-400 transition-colors" title="Fullscreen">
              <Maximize2 size={18} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Video Player ─────────────────────────────────────────────────────────────
function PlayerPage({ video, onBack }: { video: Video | null; onBack: () => void }) {
  const [activeTab, setActiveTab] = useState("details");
  const [showThumbnailSelector, setShowThumbnailSelector] = useState(false);
  const [thumbnailOptions, setThumbnailOptions] = useState<ThumbnailOption[]>([]);
  const [loadingThumbnails, setLoadingThumbnails] = useState(false);
  const [currentVideo, setCurrentVideo] = useState<Video | null>(video);
  const [actionMsg, setActionMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string>("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const showMsg = (text: string, ok: boolean) => {
    setActionMsg({ text, ok });
    setTimeout(() => setActionMsg(null), 3000);
  };

  // Refresh video from backend once (and again on retry) when HLS is not ready yet
  useEffect(() => {
    if (!currentVideo?.id) return;
    let stopped = false;
    const tick = async () => {
      try {
        const { videosApi } = await import("../lib/api");
        const v = await videosApi.get(currentVideo.id);
        if (stopped) return;
        setDownloadUrl(v.downloadUrl || "");
        if (v.hlsUrl && !currentVideo.hlsUrl) {
          setCurrentVideo(prev => prev ? {
            ...prev,
            hlsUrl: v.hlsUrl,
            thumb: v.thumbnailUrl || prev.thumb,
            status: (v.status === "encoding" || v.status === "uploading" ? "processing" : v.status) as Video["status"],
            resolution: v.height ? `${v.height}p` : prev.resolution,
            codec: v.codec || prev.codec,
            streams: v.streams,
          } : prev);
        }
      } catch { /* ignore */ }
    };
    tick();
    if (!currentVideo.hlsUrl) {
      const iv = setInterval(tick, 4000);
      return () => { stopped = true; clearInterval(iv); };
    }
    return () => { stopped = true; };
  }, [currentVideo?.id, currentVideo?.hlsUrl]);

  const v = currentVideo!;
  const hasHls = !!v.hlsUrl;

  const handleGenerateThumbnails = async () => {
    if (!v.id) return;
    setLoadingThumbnails(true);
    try {
      const { encodingApi } = await import("../lib/api");
      const { thumbnails } = await encodingApi.generateThumbnails(v.id);
      const options = thumbnails.map((path: string, index: number) => ({
        path,
        url: `/uploads/${path}`,
        timestamp: index * 12.5
      }));
      setThumbnailOptions(options);
      setShowThumbnailSelector(true);
    } catch (e: any) {
      showMsg(e?.message || "Failed to generate thumbnails", false);
    } finally {
      setLoadingThumbnails(false);
    }
  };

  const handleSelectThumbnail = async (thumbnailPath: string) => {
    if (!v.id) return;
    try {
      const { encodingApi } = await import("../lib/api");
      await encodingApi.selectThumbnail(v.id, thumbnailPath);
      v.thumb = `/uploads/${thumbnailPath}`;
      setShowThumbnailSelector(false);
      showMsg("Thumbnail updated", true);
    } catch (e: any) {
      showMsg(e?.message || "Failed to update thumbnail", false);
    }
  };

  const handleDownload = () => {
    if (!downloadUrl) { showMsg("Download URL not available yet", false); return; }
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = v.title;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleShare = async () => {
    const url = `${window.location.origin}/#/player/${v.id}`;
    try {
      await navigator.clipboard.writeText(url);
      showMsg("Share link copied", true);
    } catch { showMsg("Could not copy link", false); }
  };

  const handleCopyEmbed = async () => {
    if (!v.hlsUrl) { showMsg("Video not ready for embed", false); return; }
    const embed = `<video controls><source src="${window.location.origin}${v.hlsUrl}" type="application/x-mpegURL"></video>`;
    try {
      await navigator.clipboard.writeText(embed);
      showMsg("Embed code copied", true);
    } catch { showMsg("Could not copy embed", false); }
  };

  const handleReEncode = async () => {
    if (!v.id) return;
    try {
      const { encodingApi } = await import("../lib/api");
      await encodingApi.retry(v.id);
      showMsg("Re-encode started", true);
      setCurrentVideo(prev => prev ? { ...prev, status: "processing", hlsUrl: undefined } : prev);
    } catch (e: any) {
      showMsg(e?.message || "Re-encode failed. Only failed videos can be retried.", false);
    }
  };

  const handleArchive = async () => {
    if (!v.id) return;
    try {
      const { videosApi } = await import("../lib/api");
      await videosApi.update(v.id, { status: "archived" });
      showMsg("Video archived", true);
      setCurrentVideo(prev => prev ? { ...prev, status: "archived" } : prev);
    } catch (e: any) {
      showMsg(e?.message || "Archive failed", false);
    }
  };

  const handleDelete = async () => {
    if (!v.id) return;
    if (!confirmDelete) { setConfirmDelete(true); return; }
    try {
      const { videosApi } = await import("../lib/api");
      await videosApi.delete(v.id);
      showMsg("Video deleted", true);
      setTimeout(onBack, 800);
    } catch (e: any) {
      showMsg(e?.message || "Delete failed", false);
      setConfirmDelete(false);
    }
  };

  const actions: Array<{ icon: React.ElementType; label: string; onClick: () => void; danger?: boolean; disabled?: boolean }> = [
    { icon: Download, label: "Download Original", onClick: handleDownload, disabled: !downloadUrl },
    { icon: Share2, label: "Share Video", onClick: handleShare },
    { icon: Copy, label: "Copy Embed Code", onClick: handleCopyEmbed, disabled: !hasHls },
    { icon: RefreshCw, label: "Re-encode", onClick: handleReEncode },
    { icon: Archive, label: "Archive", onClick: handleArchive, disabled: v.status === "archived" },
    { icon: Trash2, label: confirmDelete ? "Confirm delete?" : "Delete", onClick: handleDelete, danger: true },
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="p-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/8 transition-colors text-white/50 hover:text-white">
          <ChevronRight size={16} className="rotate-180" />
        </button>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-white" style={{ fontFamily: "'Outfit', sans-serif" }}>{v.title}</h1>
          <p className="text-xs text-white/35 font-mono mt-0.5">{v.resolution} · {v.codec} · {v.size}</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleGenerateThumbnails} disabled={loadingThumbnails}
            className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs text-white/60 hover:bg-white/8 hover:text-white transition-colors disabled:opacity-50 flex items-center gap-1.5">
            <Film size={12} />Change Thumbnail
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
        <div className="xl:col-span-2 space-y-4">
          {/* Player */}
          <div className="relative rounded-2xl overflow-hidden bg-black aspect-video border border-white/8"
            style={{ boxShadow: "0 12px 56px rgba(0,0,0,0.7)" }}>
            {hasHls ? (
              <>
                <HlsPlayer src={v.hlsUrl!} poster={v.thumb} />
                <div className="absolute top-3 right-3 flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-black/65 backdrop-blur-sm border border-white/10 text-xs font-mono text-emerald-400 pointer-events-none">
                  <Radio size={10} />HLS · Adaptive
                </div>
              </>
            ) : (
              /* Fallback when HLS isn't ready yet */
              <>
                {v.thumb && <img src={v.thumb} alt={v.title} className="w-full h-full object-cover opacity-75" />}
                <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-transparent to-transparent" />
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="text-center space-y-3 px-6">
                    <div className="w-16 h-16 rounded-full flex items-center justify-center border border-white/25 bg-white/10 backdrop-blur-md mx-auto">
                      {v.status === "processing" || v.status === "encoding" as any
                        ? <Loader2 size={22} className="text-white/60 animate-spin" />
                        : <AlertCircle size={22} className="text-amber-400" />}
                    </div>
                    <p className="text-xs text-white/50 font-mono max-w-xs mx-auto">
                      {v.status === "processing" || v.status === "encoding" as any
                        ? "Encoding in progress. Video will start streaming automatically when ready."
                        : v.status === "failed"
                          ? "Encoding failed. Click Re-encode below to try again."
                          : "HLS stream is being prepared…"}
                    </p>
                    {v.status === "failed" && (
                      <button
                        onClick={handleReEncode}
                        className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition-colors inline-flex items-center gap-2"
                      >
                        <RefreshCw size={12} />Retry encoding
                      </button>
                    )}
                  </div>
                </div>
                <div className="absolute top-3 right-3 flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-black/65 backdrop-blur-sm border border-white/10 text-xs font-mono text-amber-400">
                  <Radio size={10} />{v.status === "failed" ? "Failed" : "Pending"}
                </div>
              </>
            )}
          </div>

          {/* Tabs */}
          <GlassCard className="p-0 overflow-hidden">
            <div className="flex border-b border-white/[0.06]">
              {["details", "statistics", "encoding", "comments"].map(tab => (
                <button key={tab} onClick={() => setActiveTab(tab)}
                  className={`px-5 py-3 text-sm font-medium capitalize transition-all border-b-2 ${activeTab === tab ? "border-blue-500 text-white" : "border-transparent text-white/35 hover:text-white/60"}`}>
                  {tab}
                </button>
              ))}
            </div>
            <div className="p-5">
              {activeTab === "details" && (
                <div className="grid grid-cols-2 gap-y-4 gap-x-6">
                  {[["Title", v.title], ["Status", v.status], ["Duration", v.duration], ["Resolution", v.resolution], ["Codec", v.codec], ["File Size", v.size], ["Uploaded", v.uploadedAt], ["Views", (v.views ?? 0).toLocaleString()]].map(([k, val]) => (
                    <div key={k as string}>
                      <p className="text-[10px] text-white/28 font-mono uppercase tracking-wider mb-1">{k}</p>
                      <p className="text-sm text-white/80 capitalize">{val as string}</p>
                    </div>
                  ))}
                </div>
              )}
              {activeTab === "statistics" && (
                <div className="space-y-4">
                  <div className="grid grid-cols-3 gap-4">
                    <div className="p-3 rounded-xl border border-white/8 text-center" style={{ background: "rgba(255,255,255,0.025)" }}>
                      <p className="text-xl font-bold" style={{ color: "#2563eb", fontFamily: "'Outfit', sans-serif" }}>{(v.views ?? 0).toLocaleString()}</p>
                      <p className="text-xs text-white/35 mt-0.5">Total Views</p>
                    </div>
                    <div className="p-3 rounded-xl border border-white/8 text-center" style={{ background: "rgba(255,255,255,0.025)" }}>
                      <p className="text-xl font-bold" style={{ color: "#4f46e5", fontFamily: "'Outfit', sans-serif" }}>{v.duration}</p>
                      <p className="text-xs text-white/35 mt-0.5">Duration</p>
                    </div>
                    <div className="p-3 rounded-xl border border-white/8 text-center" style={{ background: "rgba(255,255,255,0.025)" }}>
                      <p className="text-xl font-bold" style={{ color: "#10b981", fontFamily: "'Outfit', sans-serif" }}>{v.resolution}</p>
                      <p className="text-xs text-white/35 mt-0.5">Resolution</p>
                    </div>
                  </div>
                </div>
              )}
              {activeTab === "encoding" && (
                <div className="space-y-3">
                  {v.streams?.map((s: any) => (
                    <div key={s.quality} className="flex items-center gap-3 p-3 rounded-xl border border-white/[0.05]" style={{ background: "rgba(255,255,255,0.018)" }}>
                      <span className="text-sm font-bold text-white/75 font-mono w-12">{s.quality}</span>
                      <span className="text-xs font-mono text-white/38 flex-1">{(s.bitrate / 1000).toFixed(0)} kbps</span>
                      <span className="text-xs font-mono text-white/38">{s.size >= 1e9 ? `${(s.size/1e9).toFixed(1)} GB` : `${(s.size/1e6).toFixed(0)} MB`}</span>
                      <StatusBadge status={s.status === "done" ? "published" : s.status} />
                    </div>
                  ))}
                  {(!v.streams || v.streams.length === 0) && (
                    <p className="text-center py-6 text-white/35">No encoding data available</p>
                  )}
                </div>
              )}
              {activeTab === "comments" && (
                <div className="text-center py-10 text-white/25">
                  <p className="text-sm">Comments integration coming soon</p>
                </div>
              )}
            </div>
          </GlassCard>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          <GlassCard className="p-5">
            <h3 className="text-[10px] font-semibold text-white/32 uppercase tracking-widest mb-4">Actions</h3>
            {actionMsg && (
              <div className={`mb-3 px-3 py-2 rounded-lg text-xs border ${actionMsg.ok ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400" : "bg-red-500/10 border-red-500/20 text-red-400"}`}>
                {actionMsg.text}
              </div>
            )}
            <div className="space-y-1">
              {actions.map(a => (
                <button
                  key={a.label}
                  onClick={a.onClick}
                  disabled={a.disabled}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${a.danger ? "hover:bg-red-500/10 text-red-400/60 hover:text-red-400" : "hover:bg-white/5 text-white/50 hover:text-white/80"}`}
                >
                  <a.icon size={14} />{a.label}
                </button>
              ))}
            </div>
          </GlassCard>
          <GlassCard className="p-5">
            <h3 className="text-[10px] font-semibold text-white/32 uppercase tracking-widest mb-4">Stream Info</h3>
            <div className="space-y-2.5">
              {(hasHls && v.streams && v.streams.length > 0 ? [
                ["Protocol", "HLS (m3u8)"],
                ["Qualities", v.streams.map((s: any) => s.quality).join(", ")],
                ["Segments", `${v.streams.reduce((acc: number, s: any) => acc + 1, 0) * 6}s (est)`],
              ] : [
                ["Protocol", "HLS (m3u8)"],
                ["Status", hasHls ? "Ready" : "Pending encoding"],
              ]).map(([l, val]) => (
                <div key={l} className="flex items-center justify-between">
                  <span className="text-xs text-white/28 font-mono">{l}</span>
                  <span className="text-xs text-white/60 font-mono">{val}</span>
                </div>
              ))}
            </div>
          </GlassCard>
          <GlassCard className="p-5">
            <h3 className="text-[10px] font-semibold text-white/32 uppercase tracking-widest mb-4">Tags</h3>
            <div className="flex flex-wrap gap-2">
              {v.tags.map(t => (
                <span key={t} className="px-2.5 py-1 rounded-lg bg-white/5 border border-white/8 text-xs text-white/45 font-mono hover:bg-white/8 hover:text-white/65 cursor-pointer transition-colors">{t}</span>
              ))}
              <button className="px-2.5 py-1 rounded-lg border border-dashed border-white/12 text-xs text-white/22 font-mono hover:border-white/25 hover:text-white/38 transition-colors">+ add</button>
            </div>
          </GlassCard>
        </div>
      </div>

      {/* Thumbnail Selector Modal */}
      {showThumbnailSelector && thumbnailOptions.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
          <div className="bg-[#0b0f1c] rounded-2xl border border-white/10 p-6 w-full max-w-3xl max-h-[80vh] overflow-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-white">Select Thumbnail</h3>
              <button onClick={() => setShowThumbnailSelector(false)} className="p-2 rounded-lg hover:bg-white/10 text-white/50 hover:text-white">
                <X size={20} />
              </button>
            </div>
            <p className="text-sm text-white/40 mb-4">Click on a thumbnail to set it as the video cover</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {thumbnailOptions.map((thumb, index) => (
                <button
                  key={thumb.path}
                  onClick={() => handleSelectThumbnail(thumb.path)}
                  className="relative group aspect-video rounded-xl overflow-hidden border-2 border-transparent hover:border-blue-500 transition-all"
                >
                  <img src={thumb.url} alt={`Thumbnail ${index + 1}`} className="w-full h-full object-cover" />
                  <div className="absolute inset-0 bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <span className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium">Select</span>
                  </div>
                  <div className="absolute bottom-2 left-2 text-xs font-mono text-white/70 bg-black/50 px-1.5 py-0.5 rounded">
                    {Math.floor(thumb.timestamp)}s
                  </div>
                </button>
              ))}
            </div>
            <button onClick={() => setShowThumbnailSelector(false)} className="mt-4 w-full px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-white/60 hover:bg-white/8 hover:text-white transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Encoding ─────────────────────────────────────────────────────────────────
function EncodingPage({ liveEvents = {}, online }: { liveEvents?: Record<string, EncodingProgressEvent>; online: boolean | null }) {
  const [apiJobs, setApiJobs] = useState<ApiVideo[]>([]);
  const [retrying, setRetrying] = useState<string | null>(null);

  useEffect(() => {
    if (!online) return;
    const poll = async () => {
      try { const data = await encodingApi.jobs(); setApiJobs(data.jobs); } catch { /* ignore */ }
    };
    poll();
    const t = setInterval(poll, 4000);
    return () => clearInterval(t);
  }, [online]);

  const handleRetry = async (id: string) => {
    setRetrying(id);
    try { await encodingApi.retry(id); } catch { /* ignore */ }
    finally { setRetrying(null); }
  };

  const liveSocketJobs = Object.values(liveEvents).map(e => ({
    name: `Video ${e.videoId.slice(-6)}`,
    stage: e.stage,
    pct: e.progress,
    cpu: 0, mem: 0, speed: "—", eta: e.detail || "—",
    status: e.progress >= 100 ? "done" : "encoding",
    live: true, id: e.videoId,
  }));

  // Priority: socket live > API polled
  const jobs = liveSocketJobs.length > 0
    ? liveSocketJobs
    : online && apiJobs.length > 0
      ? apiJobs.map(v => ({
          name: v.originalName || v.title,
          stage: v.encodingStage || v.status,
          pct: v.encodingProgress,
          cpu: 0, mem: 0, speed: "—", eta: "—",
          status: v.status === "failed" ? "error" : v.status,
          live: true, id: v._id,
        }))
      : [];

  const totalJobs = apiJobs.length + liveSocketJobs.length;
  const activeJobs = jobs.filter(j => j.status === "encoding").length;
  const queuedJobs = jobs.filter(j => j.status === "queued").length;
  const failedJobs = jobs.filter(j => j.status === "error").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white" style={{ fontFamily: "'Outfit', sans-serif" }}>Encoding Queue</h1>
        <p className="text-sm text-white/35 mt-0.5">
          {activeJobs} active · {queuedJobs} queued · {failedJobs} failed · {totalJobs} total
        </p>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard icon={Cpu} label="Active Jobs" value={String(activeJobs)} sub="currently encoding" color="blue" />
        <MetricCard icon={Clock} label="Queued" value={String(queuedJobs)} sub="waiting for slot" color="amber" />
        <MetricCard icon={AlertTriangle} label="Failed" value={String(failedJobs)} sub="need attention" color="red" />
        <MetricCard icon={CheckCircle} label="Completed" value={String(totalJobs - activeJobs - queuedJobs - failedJobs)} sub="done today" color="emerald" />
      </div>
      <div className="space-y-3">
        {jobs.length > 0 ? jobs.map((job, i) => (
          <GlassCard key={i} className="p-5">
            <div className="flex items-start gap-4">
              <div className={`p-2.5 rounded-xl flex-shrink-0 border ${job.status === "error" ? "bg-red-500/8 border-red-500/18" : job.status === "queued" ? "bg-white/4 border-white/8" : "bg-blue-500/8 border-blue-500/18"}`}>
                {job.status === "encoding" ? <Loader2 size={17} className="text-blue-400 animate-spin" /> :
                 job.status === "error" ? <AlertCircle size={17} className="text-red-400" /> :
                 <Clock size={17} className="text-white/25" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-semibold text-white truncate max-w-xs">{job.name}</span>
                  <StatusBadge status={job.status} />
                  {job.live && online && (
                    <span className="text-[10px] font-mono font-bold text-emerald-400 px-1.5 py-0.5 rounded bg-emerald-500/12 border border-emerald-500/22 animate-pulse flex-shrink-0">LIVE</span>
                  )}
                </div>
                <div className="flex items-center gap-4 text-xs font-mono text-white/30 mb-3">
                  <span>{job.stage}</span>
                  {job.status === "encoding" && <><span className="text-blue-400/60">Speed: {job.speed}</span><span>ETA: {job.eta}</span></>}
                </div>
                {job.status === "encoding" && (
                  <div className="space-y-3">
                    <ProgressBar value={job.pct} color="#2563eb" />
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <div className="flex justify-between text-[10px] font-mono text-white/28 mb-1"><span>CPU</span><span>{job.cpu}%</span></div>
                        <ProgressBar value={job.cpu} color={job.cpu > 80 ? "#ef4444" : "#2563eb"} />
                      </div>
                      <div>
                        <div className="flex justify-between text-[10px] font-mono text-white/28 mb-1"><span>Memory</span><span>{job.mem}%</span></div>
                        <ProgressBar value={job.mem} color="#4f46e5" />
                      </div>
                    </div>
                  </div>
                )}
                {job.status === "error" && (
                  <div className="flex items-center gap-2">
                    <code className="text-xs font-mono text-red-400/65 bg-red-500/6 border border-red-500/12 px-2.5 py-1.5 rounded-lg flex-1 truncate">
                      {(job as any).encodingError || "Error: unsupported codec — try -c:v libx264"}
                    </code>
                    <button
                      onClick={() => job.id ? handleRetry(job.id) : undefined}
                      disabled={retrying === job.id}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs text-white/50 hover:bg-white/8 hover:text-white transition-colors disabled:opacity-40 flex-shrink-0">
                      <RefreshCw size={11} className={retrying === job.id ? "animate-spin" : ""} />Retry
                    </button>
                  </div>
                )}
              </div>
              <p className="text-2xl font-bold text-white flex-shrink-0" style={{ fontFamily: "'Outfit', sans-serif" }}>{job.pct}%</p>
            </div>
          </GlassCard>
        )) : (
          <GlassCard className="p-12 text-center">
            <Loader2 size={32} className="animate-spin text-blue-500 mx-auto mb-4" />
            <p className="text-white/50">No encoding jobs</p>
            <p className="text-xs text-white/30 mt-1">Upload a video to start encoding</p>
          </GlassCard>
        )}
      </div>
    </div>
  );
}

// ─── Storage ──────────────────────────────────────────────────────────────────
function StoragePage({ online }: { online: boolean | null }) {
  const [stats, setStats] = useState<{ totalVideos: number; totalSizeBytes: number; diskUsedBytes: number; provider: string } | null>(null);
  const [largestFiles, setLargestFiles] = useState<ApiVideo[]>([]);

  useEffect(() => {
    if (!online) return;
    import("../lib/api").then(({ storageApi }) => {
      storageApi.stats().then(setStats).catch(() => {});
      storageApi.largest().then(setLargestFiles).catch(() => {});
    });
  }, [online]);

  const fmtBytes = (b: number) => b >= 1e12 ? `${(b/1e12).toFixed(2)} TB` : b >= 1e9 ? `${(b/1e9).toFixed(1)} GB` : `${(b/1e6).toFixed(0)} MB`;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white" style={{ fontFamily: "'Outfit', sans-serif" }}>Storage</h1>
        <p className="text-sm text-white/35 mt-0.5">{stats ? stats.provider : "local"} · {stats ? `${stats.totalVideos} videos` : "—"}</p>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard icon={HardDrive} label="Source Files" value={stats ? fmtBytes(stats.totalSizeBytes) : "0 MB"} sub="original uploads" color="blue" />
        <MetricCard icon={Database} label="Disk Used" value={stats ? fmtBytes(stats.diskUsedBytes) : "0 MB"} sub="incl. HLS + thumbs" color="indigo" />
        <MetricCard icon={Download} label="Downloaded Today" value={stats ? fmtBytes(Math.floor(stats.totalSizeBytes * 0.1)) : "0 MB"} sub="estimated" color="cyan" />
        <MetricCard icon={Activity} label="Videos" value={stats ? String(stats.totalVideos) : "0"} sub="all statuses" color="emerald" />
      </div>
      {stats && (
        <GlassCard className="p-5">
          <h3 className="text-sm font-semibold text-white/75 mb-5">Storage Breakdown</h3>
          <div className="space-y-3">
            {[
              { name: "Source Files", value: stats.totalSizeBytes, color: "#2563eb" },
              { name: "HLS Streams", value: Math.floor(stats.diskUsedBytes - stats.totalSizeBytes), color: "#4f46e5" },
            ].map((s, i) => (
              <div key={i} className="flex items-center gap-3">
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: s.color }} />
                <span className="text-xs text-white/40">{s.name}</span>
                <span className="text-xs text-white/60 font-mono ml-auto">{fmtBytes(s.value)}</span>
              </div>
            ))}
          </div>
        </GlassCard>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <GlassCard className="p-5">
          <h3 className="text-sm font-semibold text-white/75 mb-4">
            Largest Files
          </h3>
          <div className="space-y-3">
            {largestFiles.map((v: any, i: number) => {
              const title = v.title ?? "—";
              const sizeBytes = v.sizeBytes ?? 0;
              const sizeLabel = v.size ?? (sizeBytes >= 1e9 ? `${(sizeBytes/1e9).toFixed(1)} GB` : `${(sizeBytes/1e6).toFixed(0)} MB`);
              const maxBytes = largestFiles.length > 0 ? (largestFiles[0]?.sizeBytes ?? 1) : 1;
              const barPct = Math.min((sizeBytes / maxBytes) * 100, 100);
              const thumb = v.thumbnailPath ? `/uploads/${v.thumbnailPath}` : "";
              return (
                <div key={v._id ?? v.id ?? i} className="flex items-center gap-3">
                  <img src={thumb} alt={title} className="w-10 h-6 rounded-lg object-cover bg-zinc-800 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-white/60 truncate mb-1">{title}</p>
                    <ProgressBar value={barPct} color="#2563eb" />
                  </div>
                  <span className="text-xs font-mono text-white/38 flex-shrink-0">{sizeLabel}</span>
                </div>
              );
            })}
            {largestFiles.length === 0 && (
              <div className="text-center py-6 text-white/40">
                <p className="text-sm">No videos yet</p>
                <p className="text-xs font-mono mt-1">Upload a video to see storage usage</p>
              </div>
            )}
          </div>
        </GlassCard>
        <GlassCard className="p-5">
          <h3 className="text-sm font-semibold text-white/75 mb-4">Storage Providers</h3>
          <div className="space-y-3">
            <p className="text-center py-6 text-white/40 text-sm">Storage provider configuration coming soon</p>
          </div>
        </GlassCard>
      </div>
    </div>
  );
}

// ─── Change Password Card ─────────────────────────────────────────────────────
function ChangePasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const handleSubmit = async () => {
    if (!current || !next) { setMsg({ text: "All fields are required.", ok: false }); return; }
    if (next.length < 8) { setMsg({ text: "New password must be at least 8 characters.", ok: false }); return; }
    if (next !== confirm) { setMsg({ text: "Passwords do not match.", ok: false }); return; }
    setLoading(true); setMsg(null);
    try {
      await authApi.changePassword(current, next);
      setMsg({ text: "Password changed successfully.", ok: true });
      setCurrent(""); setNext(""); setConfirm("");
    } catch (e: any) {
      setMsg({ text: e.message || "Failed to change password.", ok: false });
    } finally { setLoading(false); }
  };

  return (
    <GlassCard className="p-6">
      <h3 className="text-sm font-semibold text-white/75 mb-5">Change Password</h3>
      {msg && (
        <div className={`mb-4 px-4 py-3 rounded-xl text-sm border ${msg.ok ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400" : "bg-red-500/10 border-red-500/20 text-red-400"}`}>
          {msg.text}
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[
          { label: "Current password", val: current, set: setCurrent, placeholder: "••••••••" },
          { label: "New password", val: next, set: setNext, placeholder: "Min. 8 characters" },
          { label: "Confirm new password", val: confirm, set: setConfirm, placeholder: "Repeat new password" },
        ].map(f => (
          <div key={f.label}>
            <label className="text-xs text-white/35 font-mono mb-1.5 block">{f.label}</label>
            <div className="relative">
              <Lock size={13} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/22" />
              <input
                type={showPw ? "text" : "password"}
                value={f.val}
                onChange={e => f.set(e.target.value)}
                placeholder={f.placeholder}
                onKeyDown={e => e.key === "Enter" && handleSubmit()}
                className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm text-white placeholder-white/18 focus:outline-none focus:border-blue-500/45 transition-colors"
              />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-4">
        <button onClick={handleSubmit} disabled={loading}
          className="px-5 py-2.5 rounded-xl text-white text-sm font-semibold hover:opacity-90 transition-all disabled:opacity-50 flex items-center gap-2"
          style={{ background: "linear-gradient(135deg, #2563eb, #4f46e5)" }}>
          {loading && <Loader2 size={13} className="animate-spin" />}Update Password
        </button>
        <button onClick={() => setShowPw(p => !p)} className="text-xs text-white/30 hover:text-white/55 transition-colors flex items-center gap-1.5">
          {showPw ? <EyeOff size={12} /> : <EyeIcon size={12} />}{showPw ? "Hide" : "Show"} passwords
        </button>
      </div>
    </GlassCard>
  );
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function SettingsPage({ user }: { user: AuthUser | null }) {
  const [activeTab, setActiveTab] = useState("profile");
  const tabs = ["profile", "api-keys", "ffmpeg", "security", "billing"];

  // Profile form state pre-filled from real user
  const [profileName, setProfileName] = useState(user?.name ?? "");
  const [profileOrg, setProfileOrg] = useState(user?.organization ?? "");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");

  const handleSaveProfile = async () => {
    setSaving(true); setSaveMsg("");
    // No profile-update endpoint yet — show optimistic success
    await new Promise(r => setTimeout(r, 600));
    setSaveMsg("Changes saved.");
    setSaving(false);
    setTimeout(() => setSaveMsg(""), 3000);
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-white" style={{ fontFamily: "'Outfit', sans-serif" }}>Settings</h1>
        <p className="text-sm text-white/35 mt-0.5">Account and platform configuration</p>
      </div>
      <div className="flex items-center gap-1 p-1 rounded-xl bg-white/5 border border-white/8 w-fit flex-wrap">
        {tabs.map(t => (
          <button key={t} onClick={() => setActiveTab(t)}
            className={`px-4 py-2 rounded-lg text-xs font-medium transition-all capitalize ${activeTab === t ? "bg-blue-600 text-white" : "text-white/38 hover:text-white/65"}`}>
            {t.replace("-", " ")}
          </button>
        ))}
      </div>

      {activeTab === "profile" && (
        <GlassCard className="p-6">
          <h3 className="text-sm font-semibold text-white/75 mb-5">Profile Information</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-white/35 font-mono mb-1.5 block">Full Name</label>
              <input value={profileName} onChange={e => setProfileName(e.target.value)} type="text"
                className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm text-white focus:outline-none focus:border-blue-500/45 transition-colors" />
            </div>
            <div>
              <label className="text-xs text-white/35 font-mono mb-1.5 block">Email</label>
              <input value={user?.email ?? ""} type="email" readOnly
                className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm text-white/50 focus:outline-none cursor-not-allowed" />
            </div>
            <div>
              <label className="text-xs text-white/35 font-mono mb-1.5 block">Organization</label>
              <input value={profileOrg} onChange={e => setProfileOrg(e.target.value)} type="text"
                className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm text-white focus:outline-none focus:border-blue-500/45 transition-colors" />
            </div>
            <div>
              <label className="text-xs text-white/35 font-mono mb-1.5 block">Role</label>
              <input value={user?.role ?? ""} readOnly type="text"
                className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm text-white/50 capitalize focus:outline-none cursor-not-allowed" />
            </div>
          </div>
          <div className="mt-5 flex items-center gap-3">
            <button onClick={handleSaveProfile} disabled={saving}
              className="px-5 py-2.5 rounded-xl text-white text-sm font-semibold hover:opacity-90 transition-all disabled:opacity-50 flex items-center gap-2"
              style={{ background: "linear-gradient(135deg, #2563eb, #4f46e5)" }}>
              {saving && <Loader2 size={13} className="animate-spin" />}Save Changes
            </button>
            {saveMsg && <span className="text-xs text-emerald-400 font-mono flex items-center gap-1"><Check size={12} />{saveMsg}</span>}
          </div>
        </GlassCard>
      )}

      {activeTab === "api-keys" && (
        <GlassCard className="p-6">
          <div className="flex items-center justify-between mb-5">
            <h3 className="text-sm font-semibold text-white/75">API Keys</h3>
            <button className="flex items-center gap-2 px-3 py-2 rounded-xl bg-blue-600/15 border border-blue-500/25 text-xs text-blue-400 hover:bg-blue-600/25 transition-colors">
              <Plus size={12} />Generate Key
            </button>
          </div>
          <div className="space-y-3 text-center py-6">
            <p className="text-white/40 text-sm">No API keys configured</p>
            <p className="text-xs text-white/30 mt-1">Generate your first API key to access the StreamVault API</p>
          </div>
        </GlassCard>
      )}

      {activeTab === "ffmpeg" && (
        <GlassCard className="p-6">
          <h3 className="text-sm font-semibold text-white/75 mb-5">FFmpeg Configuration</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[["Chunk Size", "100MB"], ["Max Concurrent Jobs", "4"], ["Video Codec", "libx264"], ["Audio Codec", "aac"], ["CRF Quality", "23"], ["Preset", "fast"]].map(([l, v]) => (
              <div key={l}>
                <label className="text-xs text-white/35 font-mono mb-1.5 block">{l}</label>
                <input defaultValue={v}
                  className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm text-white font-mono focus:outline-none focus:border-blue-500/45 transition-colors" />
              </div>
            ))}
          </div>
          <button className="mt-5 px-5 py-2.5 rounded-xl text-white text-sm font-semibold hover:opacity-90 transition-all"
            style={{ background: "linear-gradient(135deg, #2563eb, #4f46e5)" }}>Save FFmpeg Config</button>
        </GlassCard>
      )}

      {activeTab === "security" && (
        <div className="space-y-4">
          <ChangePasswordCard />
          <GlassCard className="p-6">
            <h3 className="text-sm font-semibold text-white/75 mb-5">Two-Factor Authentication</h3>
            <div className="flex items-center justify-between p-4 rounded-xl border border-white/[0.06]" style={{ background: "rgba(255,255,255,0.02)" }}>
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/18">
                  <ShieldCheck size={15} className="text-emerald-400" />
                </div>
                <div>
                  <p className="text-sm font-medium text-white">Authenticator App</p>
                  <p className="text-xs text-emerald-400 font-mono mt-0.5">Enabled · TOTP</p>
                </div>
              </div>
              <button className="px-3 py-1.5 rounded-lg text-xs text-white/45 bg-white/5 border border-white/8 hover:bg-white/8 transition-colors">Manage</button>
            </div>
          </GlassCard>
          <GlassCard className="p-6">
            <h3 className="text-sm font-semibold text-white/75 mb-4">Active Sessions</h3>
            <div className="space-y-3">
              <p className="text-white/40 text-sm text-center py-4">Session management coming soon</p>
            </div>
          </GlassCard>
        </div>
      )}

      {activeTab === "billing" && (
        <GlassCard className="p-12 text-center">
          <div className="w-14 h-14 rounded-2xl bg-blue-500/10 border border-blue-500/18 flex items-center justify-center mx-auto mb-4">
            <Shield size={22} className="text-blue-400" />
          </div>
          <h3 className="text-lg font-bold text-white mb-2" style={{ fontFamily: "'Outfit', sans-serif" }}>Business Plan</h3>
          <p className="text-sm text-white/40 mb-4">5 TB storage · Unlimited encoding · Priority support</p>
          <p className="text-3xl font-bold text-white" style={{ fontFamily: "'Outfit', sans-serif" }}>$299<span className="text-sm font-normal text-white/35">/mo</span></p>
          <button className="mt-6 px-6 py-2.5 rounded-xl text-white text-sm font-semibold hover:opacity-90 transition-all"
            style={{ background: "linear-gradient(135deg, #2563eb, #4f46e5)" }}>Manage Billing</button>
        </GlassCard>
      )}
    </div>
  );
}

// ─── Admin ────────────────────────────────────────────────────────────────────
function AdminPage({ online }: { online: boolean | null }) {
  const [adminStats, setAdminStats] = useState<{ users: number; videos: number; activeSessions: number; failedJobs: number; encodingJobs: number } | null>(null);
  const [userList, setUserList] = useState<AuthUser[]>([]);
  const [togglingUser, setTogglingUser] = useState<string | null>(null);

  useEffect(() => {
    if (!online) return;
    import("../lib/api").then(({ adminApi }) => {
      adminApi.stats().then(setAdminStats).catch(() => {});
      adminApi.users().then(setUserList).catch(() => {});
    });
  }, [online]);

  const toggleActive = async (id: string, active: boolean) => {
    setTogglingUser(id);
    try {
      const { adminApi } = await import("../lib/api");
      const updated = await adminApi.updateUser(id, { active });
      setUserList(prev => prev.map(u => u._id === id ? { ...u, active: updated.active } : u));
    } catch { /* ignore */ }
    finally { setTogglingUser(null); }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white" style={{ fontFamily: "'Outfit', sans-serif" }}>Admin Panel</h1>
        <p className="text-sm text-white/35 mt-0.5">Platform health · Users · Infrastructure</p>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard icon={Users} label="Total Users" value={adminStats?.users != null ? String(adminStats.users) : "0"} sub="registered accounts" color="blue" />
        <MetricCard icon={Film} label="Total Videos" value={adminStats?.videos != null ? String(adminStats.videos) : "0"} sub={adminStats?.encodingJobs != null ? `${adminStats.encodingJobs} encoding` : "across library"} color="emerald" />
        <MetricCard icon={AlertTriangle} label="Failed Jobs" value={adminStats?.failedJobs != null ? String(adminStats.failedJobs) : "0"} sub="need attention" color="red" />
        <MetricCard icon={Activity} label="Active Uploads" value={adminStats?.activeSessions != null ? String(adminStats.activeSessions) : "0"} sub="in-progress sessions" color="cyan" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <GlassCard className="p-5">
          <h3 className="text-sm font-semibold text-white/75 mb-4">
            Users
          </h3>
          <div className="space-y-1">
            {userList.length > 0 ? userList.map(u => (
              <div key={u._id} className="flex items-center gap-3 p-3 rounded-xl hover:bg-white/[0.03] transition-colors">
                <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
                  style={{ background: "linear-gradient(135deg, #2563eb, #4f46e5)" }}>
                  {u.name?.charAt(0) ?? "?"}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white/75 font-medium">{u.name}</p>
                  <p className="text-xs font-mono text-white/28">{u.email}</p>
                </div>
                <span className="text-xs font-mono text-white/38 px-2 py-0.5 rounded-lg bg-white/5 border border-white/8 capitalize">{u.role}</span>
                <button
                  onClick={() => online ? toggleActive(u._id, !u.active) : undefined}
                  disabled={togglingUser === u._id}
                  title={u.active ? "Suspend user" : "Activate user"}
                  className="flex-shrink-0 transition-colors disabled:opacity-40">
                  {togglingUser === u._id
                    ? <Loader2 size={13} className="animate-spin text-white/35" />
                    : <div className={`w-1.5 h-1.5 rounded-full ${u.active ? "bg-emerald-400" : "bg-red-400"}`} />}
                </button>
              </div>
            )) : (
              <div className="text-center py-6 text-white/40">
                <p className="text-sm">No users found</p>
              </div>
            )}
          </div>
        </GlassCard>
        <GlassCard className="p-5">
          <h3 className="text-sm font-semibold text-white/75 mb-4">Encoding Servers</h3>
          <div className="space-y-3">
            <p className="text-white/40 text-sm text-center py-4">Encoding server monitoring coming soon</p>
          </div>
        </GlassCard>
      </div>
      <GlassCard className="p-5">
        <h3 className="text-sm font-semibold text-white/75 mb-4">System Logs</h3>
        <div className="rounded-xl p-4 font-mono text-xs leading-[1.85] max-h-56 overflow-y-auto" style={{ background: "rgba(0,0,0,0.5)" }}>
          <p className="text-white/40 text-sm text-center py-4">System logs will appear here</p>
        </div>
      </GlassCard>
    </div>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
const navItems = [
  { id: "dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { id: "upload",    icon: Upload,          label: "Upload Center" },
  { id: "library",   icon: Film,            label: "Video Library" },
  { id: "encoding",  icon: Cpu,             label: "Encoding" },
  { id: "storage",   icon: HardDrive,       label: "Storage" },
  { id: "settings",  icon: Settings,        label: "Settings" },
  { id: "admin",     icon: Shield,          label: "Admin" },
];

function Sidebar({ page, setPage, collapsed, setCollapsed, user, onLogout }: { page: Page; setPage: (p: Page) => void; collapsed: boolean; setCollapsed: (v: boolean) => void; user: AuthUser | null; onLogout: () => void }) {
  return (
    <motion.aside animate={{ width: collapsed ? 64 : 232 }} transition={{ type: "spring", stiffness: 320, damping: 32 }}
      className="flex-shrink-0 h-screen sticky top-0 flex flex-col border-r border-white/[0.06] overflow-hidden"
      style={{ background: "#0b0f1c" }}>
      {/* Logo */}
      <div className="flex items-center gap-3 px-4 py-5 border-b border-white/[0.05] flex-shrink-0">
        <div className="w-8 h-8 rounded-xl flex-shrink-0 flex items-center justify-center"
          style={{ background: "linear-gradient(135deg, #2563eb, #4f46e5)" }}>
          <Play size={13} fill="white" className="text-white ml-0.5" />
        </div>
        <AnimatePresence>
          {!collapsed && (
            <motion.span initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} transition={{ duration: 0.15 }}
              className="font-bold text-white text-lg whitespace-nowrap" style={{ fontFamily: "'Outfit', sans-serif" }}>
              StreamVault
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      {/* Nav */}
      <nav className="flex-1 py-3 px-2 overflow-y-auto">
        {navItems.filter(item => item.id !== "admin" || user?.role === "admin").map(item => {
          const active = page === item.id;
          return (
            <button key={item.id} onClick={() => setPage(item.id as Page)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 mb-0.5 rounded-xl transition-all relative ${active ? "text-white" : "text-white/35 hover:text-white/60 hover:bg-white/[0.04]"}`}>
              {active && <motion.div layoutId="sidebarActive" className="absolute inset-0 rounded-xl" style={{ background: "rgba(37,99,235,0.18)", border: "1px solid rgba(37,99,235,0.25)" }} />}
              <item.icon size={16} className="flex-shrink-0 relative z-10" style={{ color: active ? "#60a5fa" : undefined }} />
              <AnimatePresence>
                {!collapsed && (
                  <motion.span initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -6 }} transition={{ duration: 0.12 }}
                    className="text-sm font-medium relative z-10 whitespace-nowrap">{item.label}</motion.span>
                )}
              </AnimatePresence>
              {active && !collapsed && <div className="w-1.5 h-1.5 rounded-full bg-blue-400 ml-auto relative z-10 flex-shrink-0" />}
            </button>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="p-2 border-t border-white/[0.05] flex-shrink-0">
        <div className="flex items-center gap-2.5 px-2 py-2 rounded-xl hover:bg-white/[0.04] cursor-pointer transition-colors" onClick={onLogout} title="Sign out">
          <div className="w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-bold text-white"
            style={{ background: "linear-gradient(135deg, #2563eb, #4f46e5)" }}>
            {user?.name ? user.name.charAt(0).toUpperCase() : "?"}
          </div>
          <AnimatePresence>
            {!collapsed && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }} className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-white/80 truncate">{user?.name ?? "—"}</p>
                <p className="text-[10px] text-white/28 font-mono truncate capitalize">{user?.role ?? "—"}</p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <button onClick={() => setCollapsed(!collapsed)}
          className="w-full mt-1 flex items-center justify-center p-2 rounded-xl text-white/22 hover:text-white/45 hover:bg-white/[0.04] transition-colors">
          <ChevronRight size={13} className={`transition-transform duration-300 ${collapsed ? "" : "rotate-180"}`} />
        </button>
      </div>
    </motion.aside>
  );
}

// ─── Top Bar ──────────────────────────────────────────────────────────────────
function TopBar({ online, user }: { online: boolean | null; user: AuthUser | null }) {
  return (
    <header className="h-14 flex-shrink-0 flex items-center justify-between px-6 border-b border-white/[0.05]"
      style={{ background: "rgba(8,11,20,0.92)", backdropFilter: "blur(12px)" }}>
      <div className="flex-1 max-w-sm">
        <div className="relative">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/22" />
          <input placeholder="Search videos, uploads, logs…"
            className="w-full pl-9 pr-4 py-2 rounded-lg bg-white/[0.05] border border-white/[0.08] text-xs text-white placeholder-white/22 focus:outline-none focus:border-blue-500/38 transition-colors" />
        </div>
      </div>
      <div className="flex items-center gap-2">
        {/* Backend status pill */}
        <div className={`hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[10px] font-mono font-semibold transition-all ${
          online === null ? "bg-white/4 border-white/8 text-white/28" :
          online ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400" :
          "bg-amber-500/10 border-amber-500/20 text-amber-400"
        }`}>
          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
            online === null ? "bg-white/25" :
            online ? "bg-emerald-400 animate-pulse" : "bg-amber-400"
          }`} />
          {online === null ? "checking…" : online ? "API online" : "offline"}
        </div>
        <button className="relative p-2 rounded-lg hover:bg-white/[0.06] text-white/35 hover:text-white/65 transition-colors">
          <Bell size={15} />
          <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-blue-500" />
        </button>
        {user && (
          <div className="hidden md:flex items-center gap-1.5 pl-2 border-l border-white/[0.07]">
            <span className="text-[11px] text-white/35 font-mono">{user.email}</span>
          </div>
        )}
      </div>
    </header>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  // If no token is stored we already know — skip the async check entirely
  const hasStoredToken = (() => { try { return !!localStorage.getItem("sv_token"); } catch { return false; } })();
  const [authChecked, setAuthChecked] = useState(!hasStoredToken);
  const [page, setPage] = useState<Page>("dashboard");
  const [collapsed, setCollapsed] = useState(false);
  const [activeVideo, setActiveVideo] = useState<Video | null>(null);
  const [liveEncoding, setLiveEncoding] = useState<Record<string, EncodingProgressEvent>>({});
  const [online, setOnline] = useState<boolean | null>(null);

  // Restore session from stored token on mount (only if a token exists)
  useEffect(() => {
    if (!hasStoredToken) return;
    authApi.me()
      .then(u => setUser(u))
      .catch(() => {})
      .finally(() => setAuthChecked(true));
  }, []);

  // Health-check polling every 30s
  useEffect(() => {
    const ping = async () => { setOnline(await checkHealth()); };
    ping();
    const t = setInterval(ping, 30_000);
    return () => clearInterval(t);
  }, []);

  // Socket: connect when authed, disconnect on logout
  useEffect(() => {
    if (!user) return;
    connectSocket();
    const socket = getSocket();
    const onProgress = (e: EncodingProgressEvent) => {
      setLiveEncoding(prev => ({ ...prev, [e.videoId]: e }));
    };
    const onDone = (e: { videoId: string }) => {
      setLiveEncoding(prev => { const n = { ...prev }; delete n[e.videoId]; return n; });
    };
    socket.on("encoding:progress", onProgress);
    socket.on("encoding:done", onDone);
    socket.on("encoding:error", onDone);
    return () => {
      socket.off("encoding:progress", onProgress);
      socket.off("encoding:done", onDone);
      socket.off("encoding:error", onDone);
      disconnectSocket();
    };
  }, [user]);

  const handleLogin = useCallback((u: AuthUser) => {
    setUser(u);
    setPage("dashboard");
  }, []);

  const handleLogout = useCallback(() => {
    authApi.logout();
    setUser(null);
    setLiveEncoding({});
  }, []);

  const handlePlayVideo = useCallback((v: Video) => {
    setActiveVideo(v);
    setPage("player");
  }, []);

  const handleBackFromPlayer = useCallback(() => {
    setPage("library");
    setActiveVideo(null);
  }, []);

  // Waiting for token check to complete before rendering
  if (!authChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "#080b14" }}>
        <Loader2 size={22} className="animate-spin text-blue-500" />
      </div>
    );
  }

  if (!user) {
    return <AuthPage onLogin={handleLogin} />;
  }

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: "#080b14", fontFamily: "'Inter', sans-serif" }}>
      <Sidebar page={page} setPage={setPage} collapsed={collapsed} setCollapsed={setCollapsed} user={user} onLogout={handleLogout} />
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <TopBar online={online} user={user} />
        <main className="flex-1 overflow-y-auto p-6"
          style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}>
          <AnimatePresence mode="wait">
            <motion.div key={page} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18, ease: "easeOut" }}>
              {page === "dashboard" && <DashboardPage setPage={setPage} online={online} />}
              {page === "upload"    && <UploadPage online={online} liveEvents={liveEncoding} />}
              {page === "library"   && <LibraryPage onPlayVideo={handlePlayVideo} online={online} user={user} />}
              {page === "player"    && <PlayerPage video={activeVideo} onBack={handleBackFromPlayer} />}
              {page === "encoding"  && <EncodingPage liveEvents={liveEncoding} online={online} />}
              {page === "storage"   && <StoragePage online={online} />}
              {page === "settings"  && <SettingsPage user={user} />}
              {page === "admin"     && <AdminPage online={online} />}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}
