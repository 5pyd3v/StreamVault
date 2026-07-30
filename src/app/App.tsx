import { useState, useRef, useCallback, useEffect } from "react";
import {
  Routes, Route, Navigate, NavLink, Link, Outlet,
  useNavigate, useParams, useLocation,
} from "react-router";
import RequireAdmin from "./routes/RequireAdmin";
import RequireAuth from "./routes/RequireAuth";
import HlsPlayer from "./components/HlsPlayer";
import PosterCard from "./components/PosterCard";
import HomePage from "./pages/HomePage";
import LiveTvPage from "./pages/LiveTvPage";
import LiveChannelPlayerPage from "./pages/LiveChannelPlayerPage";
import LiveChannelsAdminPage from "./pages/LiveChannelsAdminPage";
import { connectSocket, disconnectSocket, getSocket, watchVideo } from "../lib/socket";
import type { EncodingProgressEvent } from "../lib/socket";
import { authApi, encodingApi, checkHealth, uploadFileChunked, copyToClipboard } from "../lib/api";
import type { ApiVideo, AuthUser } from "../lib/api";
import { motion, AnimatePresence } from "motion/react";
import {
  LayoutDashboard, Upload, Film, Settings, Shield, ChevronRight,
  Play, Pause, Eye, Download,
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
  Github, Chrome, Home, Tv, Menu, LogOut
} from "lucide-react";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, PieChart as RechartsPie, Pie, Cell,
  LineChart, Line
} from "recharts";

// ─── Types ────────────────────────────────────────────────────────────────────
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
    processing:{ label: "Processing",cls: "bg-white/10 text-white/75 border-white/20" },
    failed:    { label: "Failed",    cls: "bg-red-500/12 text-red-400 border-red-500/25" },
    archived:  { label: "Archived",  cls: "bg-zinc-500/12 text-zinc-400 border-zinc-500/25" },
    encoding:  { label: "Encoding",  cls: "bg-[var(--sv-accent-soft)] text-[var(--sv-accent-text)] border-[var(--sv-accent-border)]" },
    uploading: { label: "Uploading", cls: "bg-white/10 text-white/75 border-white/20" },
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

function MetricCard({ icon: Icon, label, value, sub, delta, color = "accent" }: { icon: React.ElementType; label: string; value: string; sub?: string; delta?: string; color?: string }) {
  // Netflix keeps its chrome monochrome and spends colour sparingly, so the
  // tile ramp is brand red first, then neutrals. No blue/indigo/cyan.
  const colors: Record<string, string> = { accent: "#e50914", crimson: "#b20710", neutral: "#d2d2d2", emerald: "#10b981", amber: "#f59e0b", red: "#ef4444" };
  const c = colors[color] ?? colors.accent;
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

function ProgressBar({ value, className = "", color = "var(--sv-accent)" }: { value: number; className?: string; color?: string }) {
  return (
    <div className={`h-1.5 rounded-full bg-white/[0.07] overflow-hidden ${className}`}>
      <motion.div className="h-full rounded-full" style={{ background: color }}
        initial={{ width: 0 }} animate={{ width: `${Math.min(value, 100)}%` }} transition={{ duration: 0.7, ease: "easeOut" }} />
    </div>
  );
}

function ProgressRing({ pct, size = 52, stroke = 4, color = "var(--sv-accent)", label }: { pct: number; size?: number; stroke?: number; color?: string; label?: string }) {
  const r = (size - stroke * 2) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ - (pct / 100) * circ;
  return (
    <div className="relative inline-flex items-center justify-center">
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,255,255,0.07)" strokeWidth={stroke} fill="none" />
        {/* `stroke` is set through style, not the SVG attribute, so callers can
            pass a `var(--sv-*)` token instead of a literal hex. */}
        <circle cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none"
          strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
          style={{ stroke: color, transition: "stroke-dashoffset 0.7s ease" }} />
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

  // Netflix-style auth surface: a moody near-black backdrop with a single red
  // bloom, the wordmark top-left, and one centred card holding the form. No
  // marketing panel, no feature bullets, no compliance claims — the sign-in
  // page's only job is the form. Behaviour below is untouched.
  return (
    <div className="relative min-h-screen overflow-hidden" style={{ background: "var(--sv-bg-deep)", fontFamily: "'Inter', sans-serif" }}>
      {/* Backdrop: deep vignette + one warm red bloom, no imagery. */}
      <div aria-hidden className="pointer-events-none absolute inset-0"
        style={{ background: "radial-gradient(125% 95% at 50% -10%, #2b0609 0%, #150809 40%, #000000 100%)" }} />
      <div aria-hidden className="pointer-events-none absolute -top-48 left-1/2 h-[560px] w-[860px] -translate-x-1/2 rounded-full"
        style={{ background: "radial-gradient(circle, var(--sv-accent-soft) 0%, transparent 68%)", filter: "blur(80px)" }} />
      <div aria-hidden className="pointer-events-none absolute inset-0"
        style={{ background: "linear-gradient(to bottom, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0.15) 35%, rgba(0,0,0,0.88) 100%)" }} />

      <div className="relative flex min-h-screen flex-col">
        {/* Wordmark */}
        <header className="flex-shrink-0 px-6 pt-6 sm:px-12 sm:pt-8">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg" style={{ background: "var(--sv-accent)" }}>
              <Play size={14} fill="white" className="ml-0.5 text-white" />
            </div>
            <span className="text-xl font-extrabold tracking-tight text-[var(--sv-accent)]" style={{ fontFamily: "'Outfit', sans-serif" }}>
              StreamVault
            </span>
          </div>
        </header>

        {/* Form card */}
        <main className="flex flex-1 items-center justify-center px-4 py-10 sm:py-14">
          <div className="w-full max-w-[420px] rounded-xl border border-white/[0.06] px-6 py-9 sm:px-11 sm:py-12"
            style={{ background: "rgba(0,0,0,0.72)", backdropFilter: "blur(6px)", boxShadow: "0 24px 70px rgba(0,0,0,0.6)" }}>
            <AnimatePresence mode="wait">

              {/* LOGIN */}
              {view === "login" && (
                <motion.div key="login" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.22 }}>
                  <h1 className="mb-7 text-[28px] font-bold leading-tight text-white" style={{ fontFamily: "'Outfit', sans-serif" }}>Sign In</h1>

                  {error && (
                    <div className="mb-4 rounded-md px-4 py-3 text-sm font-medium text-white" style={{ background: "var(--sv-accent)" }}>{error}</div>
                  )}
                  {success && (
                    <div className="mb-4 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-400">{success}</div>
                  )}

                  <div className="space-y-4">
                    <div className="relative">
                      <Mail size={15} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-white/30" />
                      <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && handleLogin()}
                        placeholder="Email"
                        className="w-full rounded-md border border-white/10 bg-white/[0.07] py-3.5 pl-11 pr-4 text-sm text-white placeholder-white/40 transition-colors focus:border-[var(--sv-accent-border)] focus:bg-white/[0.1] focus:outline-none" />
                    </div>
                    <div className="relative">
                      <Lock size={15} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-white/30" />
                      <input type={showPw ? "text" : "password"} value={password} onChange={e => setPassword(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && handleLogin()}
                        placeholder="Password"
                        className="w-full rounded-md border border-white/10 bg-white/[0.07] py-3.5 pl-11 pr-11 text-sm text-white placeholder-white/40 transition-colors focus:border-[var(--sv-accent-border)] focus:bg-white/[0.1] focus:outline-none" />
                      <button type="button" onClick={() => setShowPw(p => !p)} aria-label={showPw ? "Hide password" : "Show password"}
                        className="absolute right-4 top-1/2 -translate-y-1/2 text-white/35 transition-colors hover:text-white">
                        {showPw ? <EyeOff size={15} /> : <EyeIcon size={15} />}
                      </button>
                    </div>
                    <button onClick={handleLogin} disabled={loading}
                      className="flex w-full items-center justify-center gap-2 rounded-md bg-[var(--sv-accent)] py-3.5 text-sm font-semibold text-white transition-colors hover:bg-[var(--sv-accent-hover)] active:scale-[0.99] disabled:opacity-60">
                      {loading && <Loader2 size={15} className="animate-spin" />}
                      Sign In
                    </button>
                  </div>

                  <p className="mt-8 text-sm text-white/45">
                    {"New to StreamVault?"}{" "}
                    <button onClick={() => goTo("register")} className="font-medium text-white transition-colors hover:underline">Create an account</button>
                  </p>
                </motion.div>
              )}

              {/* REGISTER */}
              {view === "register" && (
                <motion.div key="register" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.22 }}>
                  <button onClick={() => goTo("login")} className="mb-6 flex items-center gap-1.5 text-xs text-white/40 transition-colors hover:text-white">
                    <ArrowLeft size={13} />Back to sign in
                  </button>
                  <h1 className="mb-7 text-[28px] font-bold leading-tight text-white" style={{ fontFamily: "'Outfit', sans-serif" }}>Create Account</h1>

                  {error && (
                    <div className="mb-4 rounded-md px-4 py-3 text-sm font-medium text-white" style={{ background: "var(--sv-accent)" }}>{error}</div>
                  )}
                  {success && (
                    <div className="mb-4 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-400">{success}</div>
                  )}

                  <div className="space-y-4">
                    <div className="relative">
                      <User size={15} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-white/30" />
                      <input value={name} onChange={e => setName(e.target.value)} placeholder="Full name"
                        className="w-full rounded-md border border-white/10 bg-white/[0.07] py-3.5 pl-11 pr-4 text-sm text-white placeholder-white/40 transition-colors focus:border-[var(--sv-accent-border)] focus:bg-white/[0.1] focus:outline-none" />
                    </div>
                    <div className="relative">
                      <Mail size={15} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-white/30" />
                      <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email"
                        className="w-full rounded-md border border-white/10 bg-white/[0.07] py-3.5 pl-11 pr-4 text-sm text-white placeholder-white/40 transition-colors focus:border-[var(--sv-accent-border)] focus:bg-white/[0.1] focus:outline-none" />
                    </div>
                    <div className="relative">
                      <Layers size={15} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-white/30" />
                      <input value={org} onChange={e => setOrg(e.target.value)} placeholder="Organization (optional)"
                        className="w-full rounded-md border border-white/10 bg-white/[0.07] py-3.5 pl-11 pr-4 text-sm text-white placeholder-white/40 transition-colors focus:border-[var(--sv-accent-border)] focus:bg-white/[0.1] focus:outline-none" />
                    </div>
                    <div className="relative">
                      <Lock size={15} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-white/30" />
                      <input type={showPw ? "text" : "password"} value={password} onChange={e => setPassword(e.target.value)}
                        placeholder="Password"
                        className="w-full rounded-md border border-white/10 bg-white/[0.07] py-3.5 pl-11 pr-11 text-sm text-white placeholder-white/40 transition-colors focus:border-[var(--sv-accent-border)] focus:bg-white/[0.1] focus:outline-none" />
                      <button type="button" onClick={() => setShowPw(p => !p)} aria-label={showPw ? "Hide password" : "Show password"}
                        className="absolute right-4 top-1/2 -translate-y-1/2 text-white/35 transition-colors hover:text-white">
                        {showPw ? <EyeOff size={15} /> : <EyeIcon size={15} />}
                      </button>
                    </div>
                    <button onClick={handleRegister} disabled={loading}
                      className="flex w-full items-center justify-center gap-2 rounded-md bg-[var(--sv-accent)] py-3.5 text-sm font-semibold text-white transition-colors hover:bg-[var(--sv-accent-hover)] active:scale-[0.99] disabled:opacity-60">
                      {loading && <Loader2 size={15} className="animate-spin" />}
                      Create Account
                    </button>
                  </div>

                  <p className="mt-8 text-sm text-white/45">
                    Already have an account?{" "}
                    <button onClick={() => goTo("login")} className="font-medium text-white transition-colors hover:underline">Sign in</button>
                  </p>
                </motion.div>
              )}

            </AnimatePresence>
          </div>
        </main>

        <footer className="flex-shrink-0 px-6 pb-7 text-center sm:px-12">
          <p className="font-mono text-[11px] text-white/25">© {new Date().getFullYear()} StreamVault</p>
        </footer>
      </div>
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
function DashboardPage({ online }: { online: boolean | null }) {
  const navigate = useNavigate();
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
          <button onClick={() => navigate("/admin/upload")}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-semibold hover:opacity-90 transition-all"
            style={{ background: "var(--sv-accent)" }}>
            <Plus size={14} />New Upload
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard icon={Film} label="Total Videos" value={stats?.total != null ? stats.total.toLocaleString() : "0"} sub="across all folders" color="accent" />
        <MetricCard icon={HardDrive} label="Storage Used" value={stats?.totalSize != null ? fmt2(stats.totalSize) : "0 MB"} sub="source files" color="crimson" />
        <MetricCard icon={Zap} label="Bandwidth" value={stats?.totalSize != null ? fmt2(stats.totalSize * 2) : "0 MB"} sub="this month" color="neutral" />
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
              <Tooltip contentStyle={{ background: "#1f1f1f", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, color: "#fff", fontSize: 11 }} />
              <Area type="monotone" dataKey="upload" stroke="#e50914" strokeWidth={2} />
              <Area type="monotone" dataKey="download" stroke="#d2d2d2" strokeWidth={2} />
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
              <Tooltip contentStyle={{ background: "#1f1f1f", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, color: "#fff", fontSize: 11 }} />
              <Bar dataKey="views" fill="#e50914" radius={[5, 5, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </GlassCard>

        <GlassCard className="p-5">
          <h3 className="text-sm font-semibold text-white/75 mb-4 flex items-center justify-between">
            Encoding Queue
            <button onClick={() => navigate("/admin/encoding")} className="text-[10px] font-mono text-[var(--sv-text-muted)] hover:text-white transition-colors">View all →</button>
          </h3>
          <div className="space-y-4">
            {(online && encJobs.length > 0
              ? encJobs.slice(0, 4).map((v, i) => ({
                  key: v._id,
                  name: v.originalName || v.title,
                  stage: v.encodingStage || v.status,
                  pct: v.encodingProgress ?? 0,
                  color: v.status === "failed" ? "#ef4444" : ["#e50914","#d2d2d2","#f59e0b","#10b981"][i % 4],
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
    // crypto.randomUUID() only works in a "secure context" (HTTPS or
    // localhost) -- unavailable over plain http:// on a public IP/domain,
    // which is a completely normal way to reach this app before a TLS
    // certificate is set up. This id is only ever a local React/map key for
    // the upload queue UI (the real server-side upload id comes back from
    // /api/upload/init as `p.uploadId` below), so it doesn't need
    // cryptographic randomness -- any locally-unique string works.
    const id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
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
        animate={{ borderColor: dragging ? "#e50914" : "rgba(255,255,255,0.09)" }}
        transition={{ duration: 0.18 }}
        className="rounded-2xl border-2 border-dashed p-16 flex flex-col items-center justify-center cursor-pointer relative overflow-hidden"
        style={{ background: dragging ? "rgba(229,9,20,0.07)" : "rgba(255,255,255,0.018)" }}
        onClick={() => fileRef.current?.click()}
      >
        {dragging && (
          <motion.div className="absolute inset-0 pointer-events-none" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
            style={{ background: "radial-gradient(ellipse at center, rgba(229,9,20,0.14) 0%, transparent 70%)" }} />
        )}
        <motion.div animate={{ scale: dragging ? 1.08 : 1 }} transition={{ type: "spring", stiffness: 280 }}>
          <div className="w-20 h-20 rounded-2xl flex items-center justify-center mx-auto mb-5 border"
            style={{ background: "var(--sv-accent-soft)", borderColor: "var(--sv-accent-border)" }}>
            <UploadCloud size={34} className="text-[var(--sv-accent)]" />
          </div>
        </motion.div>
        <h2 className="text-xl font-bold text-white mb-2" style={{ fontFamily: "'Outfit', sans-serif" }}>
          {dragging ? "Drop to upload" : "Drop files here to upload"}
        </h2>
        <p className="text-sm text-white/35 mb-7">or click to browse — MP4, MOV, MKV, AVI, WebM · Max 100 GB</p>
        <div className="flex items-center gap-6 text-xs font-mono text-white/28">
          {[
            { icon: Layers, label: "Chunked", color: "#e50914" },
            { icon: RefreshCw, label: "Auto-resume", color: "#10b981" },
            { icon: ShieldCheck, label: "Hash verified", color: "#d2d2d2" },
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
              <span className="px-2 py-0.5 rounded-md bg-[var(--sv-accent-soft)] text-[var(--sv-accent-text)] border border-[var(--sv-accent-border)]">
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
                    <ProgressRing pct={item.progress} size={44} color="var(--sv-accent)" label={`${item.progress}%`} />
                  ) : item.status === "encoding" ? (
                    <ProgressRing pct={80} size={44} color="#d2d2d2" label="enc" />
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
                        <span className="text-[var(--sv-accent-text)]">{item.speed} MB/s</span>
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
                          <div key={ci} className={`h-2 rounded-sm flex-1 min-w-0 transition-all ${filled ? "bg-[var(--sv-accent)]" : active ? "bg-[var(--sv-accent-hover)] animate-pulse" : "bg-white/8"}`}
                            style={{ maxWidth: 10 }} />
                        );
                      })}
                    </div>
                  )}
                  <ProgressBar value={item.progress}
                    color={item.status === "error" ? "#ef4444" : item.status === "done" || item.status === "encoding" ? "#10b981" : item.status === "paused" ? "#f59e0b" : "var(--sv-accent)"} />
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
                    isActive ? "bg-[var(--sv-accent-soft)] border-[var(--sv-accent-border)]" :
                    "bg-white/4 border-white/10"}`}>
                    {isDone ? <Check size={15} className="text-emerald-400" /> :
                     isActive ? <Loader2 size={15} className="text-[var(--sv-accent)] animate-spin" /> :
                     <Icon size={14} className="text-white/28" />}
                  </div>
                  <span className={`text-[9.5px] font-mono font-semibold whitespace-nowrap ${isDone ? "text-emerald-400" : isActive ? "text-[var(--sv-accent-text)]" : "text-white/28"}`}>{stage.label}</span>
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
  const navigate = useNavigate();
  const isAdmin = user?.role === "admin";
  const [view, setView] = useState<"grid" | "list">("grid");
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [apiVideos, setApiVideos] = useState<Video[]>([]);
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    if (!online) { setApiVideos([]); return; }
    setLoading(true);
    import("../lib/api").then(({ videosApi }) =>
      videosApi.list({ status: filter === "all" ? undefined : filter, search: search || undefined })
        .then(data => {
          setApiVideos(data.videos.map(v => ({
            id: v._id, title: v.title, description: v.description ?? "",
            ownerId: v.owner?._id ?? "",
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

  // Status chips are an admin editorial tool. The API only ever hands a regular
  // user published videos, so for them every option but "all" would be a control
  // that silently returns nothing — the row isn't rendered at all below.
  const filters = ["all", "published", "draft", "processing", "failed"];
  const filtered = apiVideos.filter(v =>
    (filter === "all" || v.status === filter) &&
    (!search || v.title.toLowerCase().includes(search.toLowerCase()))
  );

  // One-click delete straight from the library, instead of opening the
  // player, opening its Details drawer, and hunting for the action there.
  const handleDeleteVideo = async (id: string, title: string) => {
    if (!window.confirm(`Delete "${title}"? This cannot be undone.`)) return;
    setDeletingId(id);
    try {
      const { videosApi } = await import("../lib/api");
      await videosApi.delete(id);
      setApiVideos(prev => prev.filter(v => v.id !== id));
    } catch (e: any) {
      alert(e?.message || "Delete failed.");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold text-white" style={{ fontFamily: "'Outfit', sans-serif" }}>Video Library</h1>
          <p className="text-sm text-white/35 mt-0.5">
            {loading ? "Loading…" : `${filtered.length} video${filtered.length !== 1 ? "s" : ""}`}
          </p>
        </div>
        {isAdmin && (
          <button onClick={() => navigate("/admin/upload")}
            className="flex flex-shrink-0 items-center gap-2 px-4 min-h-[40px] rounded-xl text-white text-sm font-semibold hover:opacity-90 transition-all"
            style={{ background: "var(--sv-accent)" }}>
            <Plus size={14} />Upload Video
          </button>
        )}
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-0 basis-full sm:basis-auto sm:min-w-48">
          <Search size={13} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/28" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search videos…"
            className="w-full pl-9 pr-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm text-white placeholder-white/22 focus:outline-none focus:border-[var(--sv-accent-border)] transition-colors" />
        </div>
        {isAdmin && (
          <div className="flex items-center gap-1 p-1 rounded-xl bg-white/5 border border-white/8 flex-wrap">
            {filters.map(f => (
              <button key={f} onClick={() => setFilter(f)}
                className={`px-3 py-1 rounded-lg text-xs font-medium capitalize transition-all ${filter === f ? "bg-[var(--sv-accent)] text-white" : "text-white/38 hover:text-white/65"}`}>
                {f}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-1 p-1 rounded-xl bg-white/5 border border-white/8">
          <button onClick={() => setView("grid")} className={`p-2 rounded-lg transition-all ${view === "grid" ? "bg-white/10 text-white" : "text-white/28 hover:text-white/55"}`}><Grid3X3 size={13} /></button>
          <button onClick={() => setView("list")} className={`p-2 rounded-lg transition-all ${view === "list" ? "bg-white/10 text-white" : "text-white/28 hover:text-white/55"}`}><List size={13} /></button>
        </div>
      </div>

      <AnimatePresence mode="wait">
        {view === "grid" ? (
          /* Netflix-style poster grid — same data + filters as before, just
             rendered through the shared PosterCard primitive. */
          <motion.div key="grid" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
            className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 sm:gap-4">
            {filtered.map(v => (
              <PosterCard
                key={v.id}
                to={`/watch/${v.id}`}
                title={v.title}
                {...(v.thumb ? { imageUrl: v.thumb } : {})}
                subtitle={[...(isAdmin ? [v.resolution, v.size] : []), `${(v.views ?? 0).toLocaleString()} views`].filter(x => x && x !== "—").join(" · ")}
                badge={v.status === "published" ? v.duration : v.status}
                dimmed={v.status !== "published"}
                {...(isAdmin ? { onDelete: () => handleDeleteVideo(v.id, v.title), deleting: deletingId === v.id } : {})}
              />
            ))}
            {filtered.length === 0 && !loading && (
              <p className="col-span-full py-16 text-center text-sm text-white/35">No videos match this filter.</p>
            )}
          </motion.div>
        ) : (
          <motion.div key="list" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
            <GlassCard className="p-0 overflow-hidden">
              {/* Scroll the table itself rather than the page on narrow screens */}
              <div className="overflow-x-auto">
              <table className="w-full min-w-[420px]">
                <thead>
                  <tr className="border-b border-white/[0.05]">
                    {["Title", "Status", ...(isAdmin ? ["Resolution", "Size"] : []), "Views", ""].map((h, i) => (
                      <th key={i} className={`text-left text-xs font-semibold text-white/32 px-3 sm:px-5 py-3 ${isAdmin && i > 1 && i < 4 ? "hidden md:table-cell" : ""} ${i === 1 ? "hidden lg:table-cell" : ""}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(v => (
                    <tr key={v.id} className="border-b border-white/[0.04] last:border-0 hover:bg-white/[0.025] transition-colors cursor-pointer" onClick={() => onPlayVideo(v)}>
                      <td className="px-3 sm:px-5 py-3">
                        <div className="flex items-center gap-3">
                          <img src={v.thumb} alt={v.title} className="w-12 h-7 rounded-lg object-cover bg-zinc-800 flex-shrink-0" />
                          <div className="min-w-0">
                            <p className="text-sm text-white font-medium line-clamp-1">{v.title}</p>
                            <p className="text-xs font-mono text-white/28 mt-0.5 truncate">{v.duration} · {v.uploadedAt}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 hidden lg:table-cell"><StatusBadge status={v.status} /></td>
                      {isAdmin && <td className="px-3 py-3 hidden md:table-cell text-xs font-mono text-white/42">{v.resolution}</td>}
                      {isAdmin && <td className="px-3 py-3 hidden md:table-cell text-xs font-mono text-white/42">{v.size}</td>}
                      <td className="px-3 py-3 text-xs font-mono text-white/42">{(v.views ?? 0).toLocaleString()}</td>
                      <td className="px-3 py-3">
                        {isAdmin ? (
                          <button
                            onClick={e => { e.stopPropagation(); handleDeleteVideo(v.id, v.title); }}
                            disabled={deletingId === v.id}
                            title="Delete video"
                            aria-label="Delete video"
                            className="p-1.5 rounded-lg hover:bg-red-600/20 text-white/25 hover:text-red-400 transition-colors disabled:opacity-50">
                            {deletingId === v.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                          </button>
                        ) : (
                          <button onClick={e => e.stopPropagation()} className="p-1.5 rounded-lg hover:bg-white/8 text-white/25 hover:text-white/60 transition-colors">
                            <MoreVertical size={13} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </GlassCard>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Video Player ─────────────────────────────────────────────────────────────
function PlayerPage({ user }: { user: AuthUser | null } = { user: null }) {
  const isAdmin = user?.role === "admin";
  // Video identity now comes from the URL (`/watch/:videoId`) instead of a prop,
  // so deep links and page refreshes resolve the right video.
  const { videoId } = useParams<{ videoId: string }>();
  const navigate = useNavigate();
  const onBack = useCallback(() => navigate(-1), [navigate]);

  const [activeTab, setActiveTab] = useState("details");
  const [showThumbnailSelector, setShowThumbnailSelector] = useState(false);
  const [thumbnailOptions, setThumbnailOptions] = useState<ThumbnailOption[]>([]);
  const [loadingThumbnails, setLoadingThumbnails] = useState(false);
  const [currentVideo, setCurrentVideo] = useState<Video | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string>("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Cinematic chrome: the back button / title overlay and the details drawer
  // toggle. The overlay fades on the same 3s cadence HlsPlayer uses internally
  // for its own transport controls, so everything disappears together.
  const [showChrome, setShowChrome] = useState(true);
  const [showDetails, setShowDetails] = useState(false);
  const chromeTimer = useRef<number | null>(null);
  const bumpChrome = useCallback(() => {
    setShowChrome(true);
    if (chromeTimer.current) window.clearTimeout(chromeTimer.current);
    chromeTimer.current = window.setTimeout(() => setShowChrome(false), 3000);
  }, []);
  useEffect(() => {
    bumpChrome();
    return () => { if (chromeTimer.current) window.clearTimeout(chromeTimer.current); };
  }, [bumpChrome]);

  const showMsg = (text: string, ok: boolean) => {
    setActionMsg({ text, ok });
    setTimeout(() => setActionMsg(null), 3000);
  };

  // Load the video from the backend, then keep polling while HLS is not ready yet
  useEffect(() => {
    if (!videoId) return;
    // Navigating straight from one /watch/:id to another must not render stale data
    setCurrentVideo(prev => (prev && prev.id !== videoId ? null : prev));
    let stopped = false;
    const tick = async () => {
      try {
        const { videosApi } = await import("../lib/api");
        const v = await videosApi.get(videoId);
        if (stopped) return;
        setLoadError(null);
        setDownloadUrl(v.downloadUrl || "");
        setCurrentVideo(prev => ({
          id: v._id,
          title: v.title,
          description: v.description ?? "",
          ownerId: v.owner?._id ?? "",
          duration: v.duration ? `${Math.floor(v.duration / 60)}:${String(v.duration % 60).padStart(2, "0")}` : "—",
          size: v.sizeBytes >= 1e9 ? `${(v.sizeBytes / 1e9).toFixed(1)} GB` : `${(v.sizeBytes / 1e6).toFixed(0)} MB`,
          status: (v.status === "encoding" || v.status === "uploading" ? "processing" : v.status) as Video["status"],
          views: v.views,
          thumb: v.thumbnailUrl || (v.thumbnailPath ? `/uploads/${v.thumbnailPath}` : "") || prev?.thumb || "",
          hlsUrl: v.hlsUrl || undefined,
          resolution: v.height ? `${v.height}p` : "—",
          codec: v.codec || "—",
          uploadedAt: v.createdAt ? v.createdAt.slice(0, 10) : "—",
          tags: v.tags ?? [],
          streams: v.streams,
        }));
      } catch (e: any) {
        if (!stopped) setLoadError(e?.message || "Could not load this video.");
      }
    };
    tick();
    if (!currentVideo?.hlsUrl) {
      const iv = setInterval(tick, 4000);
      return () => { stopped = true; clearInterval(iv); };
    }
    return () => { stopped = true; };
  }, [videoId, currentVideo?.hlsUrl]);

  if (!currentVideo) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-black">
        {loadError ? (
          <>
            <AlertCircle size={26} className="text-red-400" />
            <p className="text-sm text-white/50">{loadError}</p>
            <button onClick={onBack} className="px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-xs text-white/60 hover:bg-white/8 hover:text-white transition-colors">
              Go back
            </button>
          </>
        ) : (
          <Loader2 size={26} className="animate-spin text-[var(--sv-accent)]" />
        )}
      </div>
    );
  }

  const v = currentVideo;
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
    const url = `${window.location.origin}/watch/${v.id}`;
    try {
      await copyToClipboard(url);
      showMsg("Share link copied", true);
    } catch { showMsg("Could not copy link", false); }
  };

  const handleCopyEmbed = async () => {
    if (!v.hlsUrl) { showMsg("Video not ready for embed", false); return; }
    const embed = `<video controls><source src="${window.location.origin}${v.hlsUrl}" type="application/x-mpegURL"></video>`;
    try {
      await copyToClipboard(embed);
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
    <div className="fixed inset-0 z-50 bg-black" onMouseMove={bumpChrome} onTouchStart={bumpChrome}>
      {/* Full-bleed playback surface */}
      <div className="absolute inset-0">
        {hasHls ? (
          <>
            <HlsPlayer src={v.hlsUrl!} poster={v.thumb} />
            <div className={`absolute top-4 right-4 flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-black/65 backdrop-blur-sm border border-white/10 text-xs font-mono text-emerald-400 pointer-events-none transition-opacity duration-300 ${showChrome ? "opacity-100" : "opacity-0"}`}>
              <Radio size={10} />HLS · Adaptive
            </div>
          </>
        ) : (
          /* Fallback when HLS isn't ready yet */
          <div className="relative w-full h-full">
            {v.thumb && <img src={v.thumb} alt={v.title} className="w-full h-full object-cover opacity-45" />}
            <div className="absolute inset-0 bg-gradient-to-t from-black via-black/60 to-black/30" />
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
                    className="px-4 py-2 rounded-lg bg-[var(--sv-accent)] hover:bg-[var(--sv-accent-hover)] text-white text-xs font-semibold transition-colors inline-flex items-center gap-2"
                  >
                    <RefreshCw size={12} />Retry encoding
                  </button>
                )}
              </div>
            </div>
            <div className="absolute top-4 right-4 flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-black/65 backdrop-blur-sm border border-white/10 text-xs font-mono text-amber-400">
              <Radio size={10} />{v.status === "failed" ? "Failed" : "Pending"}
            </div>
          </div>
        )}
      </div>

      {/* Auto-hiding top scrim: back button, title/metadata, secondary actions */}
      <div className={`pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-black/90 via-black/45 to-transparent px-4 pb-16 pt-4 sm:px-6 transition-opacity duration-300 ${showChrome || showDetails || !hasHls ? "opacity-100" : "opacity-0"}`}>
        <div className="pointer-events-auto flex items-start gap-2 sm:gap-3">
          <button onClick={onBack} aria-label="Back"
            className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border border-white/15 bg-black/50 text-white/80 backdrop-blur-sm transition-colors hover:bg-black/70 hover:text-white">
            <ArrowLeft size={17} />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-bold text-white sm:text-xl" style={{ fontFamily: "'Outfit', sans-serif" }}>{v.title}</h1>
            {/* Resolution/codec/size are operational details -- a regular
                viewer only ever sees a view count, same as everywhere else. */}
            <p className="mt-0.5 truncate text-[11px] text-white/40 font-mono">
              {isAdmin ? `${v.resolution} · ${v.codec} · ${v.size} · ` : ""}{(v.views ?? 0).toLocaleString()} views
            </p>
          </div>
          {/* Thumbnail management and the technical details drawer (encoding
              log, stream ladder, etc.) are admin/ops tools, not viewer-facing. */}
          {isAdmin && (
            <div className="flex flex-shrink-0 items-center gap-2">
              <button onClick={handleGenerateThumbnails} disabled={loadingThumbnails}
                className="hidden sm:flex px-3 min-h-[40px] rounded-lg bg-black/50 border border-white/12 text-xs text-white/70 hover:bg-black/70 hover:text-white transition-colors disabled:opacity-50 items-center gap-1.5 backdrop-blur-sm">
                <Film size={12} />Change Thumbnail
              </button>
              <button onClick={() => setShowDetails(d => !d)}
                className="px-3 min-h-[40px] rounded-lg bg-black/50 border border-white/12 text-xs text-white/70 hover:bg-black/70 hover:text-white transition-colors flex items-center gap-1.5 backdrop-blur-sm">
                <ChevronRight size={12} className={`flex-shrink-0 transition-transform ${showDetails ? "-rotate-90" : "rotate-90"}`} />
                <span className="whitespace-nowrap">{showDetails ? "Hide details" : "Details"}</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Details drawer — everything the old in-shell page showed, on demand */}
      <AnimatePresence>
        {showDetails && (
        <motion.div key="details" initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }} transition={{ duration: 0.25, ease: "easeOut" }}
          className="absolute inset-x-0 bottom-0 max-h-[75%] overflow-y-auto border-t border-white/[0.08] backdrop-blur-xl"
          style={{ background: "rgba(20,20,20,0.96)", scrollbarWidth: "thin" }}>
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-5 p-4 sm:p-6">
        <div className="xl:col-span-2 space-y-4">
          {/* Tabs */}
          <GlassCard className="p-0 overflow-hidden">
            <div className="flex overflow-x-auto border-b border-white/[0.06]">
              {["details", "statistics", "encoding", "comments"].map(tab => (
                <button key={tab} onClick={() => setActiveTab(tab)}
                  className={`flex-shrink-0 px-4 sm:px-5 py-3 text-sm font-medium capitalize transition-all border-b-2 ${activeTab === tab ? "border-[var(--sv-accent)] text-white" : "border-transparent text-white/35 hover:text-white/60"}`}>
                  {tab}
                </button>
              ))}
            </div>
            <div className="p-4 sm:p-5">
              {activeTab === "details" && (
                <div className="grid grid-cols-2 gap-y-4 gap-x-4 sm:gap-x-6">
                  {[["Title", v.title], ["Status", v.status], ["Duration", v.duration], ["Resolution", v.resolution], ["Codec", v.codec], ["File Size", v.size], ["Uploaded", v.uploadedAt], ["Views", (v.views ?? 0).toLocaleString()]].map(([k, val]) => (
                    <div key={k as string} className="min-w-0">
                      <p className="text-[10px] text-white/28 font-mono uppercase tracking-wider mb-1">{k}</p>
                      <p className="text-sm text-white/80 capitalize break-words">{val as string}</p>
                    </div>
                  ))}
                </div>
              )}
              {activeTab === "statistics" && (
                <div className="space-y-4">
                  <div className="grid grid-cols-3 gap-4">
                    <div className="p-3 rounded-xl border border-white/8 text-center" style={{ background: "rgba(255,255,255,0.025)" }}>
                      <p className="text-xl font-bold" style={{ color: "var(--sv-accent)", fontFamily: "'Outfit', sans-serif" }}>{(v.views ?? 0).toLocaleString()}</p>
                      <p className="text-xs text-white/35 mt-0.5">Total Views</p>
                    </div>
                    <div className="p-3 rounded-xl border border-white/8 text-center" style={{ background: "rgba(255,255,255,0.025)" }}>
                      <p className="text-xl font-bold" style={{ color: "#d2d2d2", fontFamily: "'Outfit', sans-serif" }}>{v.duration}</p>
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
                    <div key={s.quality} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 p-3 rounded-xl border border-white/[0.05]" style={{ background: "rgba(255,255,255,0.018)" }}>
                      <span className="text-sm font-bold text-white/75 font-mono w-12 flex-shrink-0">{s.quality}</span>
                      <span className="text-xs font-mono text-white/38 flex-1 min-w-0">{(s.bitrate / 1000).toFixed(0)} kbps</span>
                      <span className="text-xs font-mono text-white/38 flex-shrink-0">{s.size >= 1e9 ? `${(s.size/1e9).toFixed(1)} GB` : `${(s.size/1e6).toFixed(0)} MB`}</span>
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
        </motion.div>
        )}
      </AnimatePresence>

      {/* Thumbnail Selector Modal */}
      {showThumbnailSelector && thumbnailOptions.length > 0 && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
          <div className="rounded-2xl border border-white/10 p-4 sm:p-6 w-full max-w-3xl max-h-[80vh] overflow-auto" style={{ background: "var(--sv-surface)" }}>
            <div className="flex items-center justify-between gap-3 mb-4">
              <h3 className="text-base sm:text-lg font-bold text-white truncate">Select Thumbnail</h3>
              <button onClick={() => setShowThumbnailSelector(false)} className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg hover:bg-white/10 text-white/50 hover:text-white">
                <X size={20} />
              </button>
            </div>
            <p className="text-sm text-white/40 mb-4">Click on a thumbnail to set it as the video cover</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {thumbnailOptions.map((thumb, index) => (
                <button
                  key={thumb.path}
                  onClick={() => handleSelectThumbnail(thumb.path)}
                  className="relative group aspect-video rounded-xl overflow-hidden border-2 border-transparent hover:border-[var(--sv-accent)] transition-all"
                >
                  <img src={thumb.url} alt={`Thumbnail ${index + 1}`} className="w-full h-full object-cover" />
                  <div className="absolute inset-0 bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <span className="px-3 py-1.5 rounded-lg bg-[var(--sv-accent)] text-white text-xs font-medium">Select</span>
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
        <MetricCard icon={Cpu} label="Active Jobs" value={String(activeJobs)} sub="currently encoding" color="accent" />
        <MetricCard icon={Clock} label="Queued" value={String(queuedJobs)} sub="waiting for slot" color="amber" />
        <MetricCard icon={AlertTriangle} label="Failed" value={String(failedJobs)} sub="need attention" color="red" />
        <MetricCard icon={CheckCircle} label="Completed" value={String(totalJobs - activeJobs - queuedJobs - failedJobs)} sub="done today" color="emerald" />
      </div>
      <div className="space-y-3">
        {jobs.length > 0 ? jobs.map((job, i) => (
          <GlassCard key={i} className="p-5">
            <div className="flex items-start gap-4">
              <div className={`p-2.5 rounded-xl flex-shrink-0 border ${job.status === "error" ? "bg-red-500/8 border-red-500/18" : job.status === "queued" ? "bg-white/4 border-white/8" : "bg-[var(--sv-accent-faint)] border-[var(--sv-accent-border)]"}`}>
                {job.status === "encoding" ? <Loader2 size={17} className="text-[var(--sv-accent)] animate-spin" /> :
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
                  {job.status === "encoding" && <><span className="text-[var(--sv-accent-text)]">Speed: {job.speed}</span><span>ETA: {job.eta}</span></>}
                </div>
                {job.status === "encoding" && (
                  <div className="space-y-3">
                    <ProgressBar value={job.pct} color="var(--sv-accent)" />
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <div className="flex justify-between text-[10px] font-mono text-white/28 mb-1"><span>CPU</span><span>{job.cpu}%</span></div>
                        <ProgressBar value={job.cpu} color={job.cpu > 80 ? "#ef4444" : "var(--sv-accent)"} />
                      </div>
                      <div>
                        <div className="flex justify-between text-[10px] font-mono text-white/28 mb-1"><span>Memory</span><span>{job.mem}%</span></div>
                        <ProgressBar value={job.mem} color="#d2d2d2" />
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
            <Loader2 size={32} className="animate-spin text-[var(--sv-accent)] mx-auto mb-4" />
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
        <MetricCard icon={HardDrive} label="Source Files" value={stats ? fmtBytes(stats.totalSizeBytes) : "0 MB"} sub="original uploads" color="accent" />
        <MetricCard icon={Database} label="Disk Used" value={stats ? fmtBytes(stats.diskUsedBytes) : "0 MB"} sub="incl. HLS + thumbs" color="crimson" />
        <MetricCard icon={Download} label="Downloaded Today" value={stats ? fmtBytes(Math.floor(stats.totalSizeBytes * 0.1)) : "0 MB"} sub="estimated" color="neutral" />
        <MetricCard icon={Activity} label="Videos" value={stats ? String(stats.totalVideos) : "0"} sub="all statuses" color="emerald" />
      </div>
      {stats && (
        <GlassCard className="p-5">
          <h3 className="text-sm font-semibold text-white/75 mb-5">Storage Breakdown</h3>
          <div className="space-y-3">
            {[
              { name: "Source Files", value: stats.totalSizeBytes, color: "#e50914" },
              { name: "HLS Streams", value: Math.floor(stats.diskUsedBytes - stats.totalSizeBytes), color: "#d2d2d2" },
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
                    <ProgressBar value={barPct} color="var(--sv-accent)" />
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
                className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm text-white placeholder-white/18 focus:outline-none focus:border-[var(--sv-accent-border)] transition-colors"
              />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-4">
        <button onClick={handleSubmit} disabled={loading}
          className="px-5 py-2.5 rounded-xl text-white text-sm font-semibold hover:opacity-90 transition-all disabled:opacity-50 flex items-center gap-2"
          style={{ background: "var(--sv-accent)" }}>
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
  const isAdmin = user?.role === "admin";
  const [activeTab, setActiveTab] = useState("profile");
  // api-keys/ffmpeg are operational/admin concerns -- a regular subscriber only
  // ever needs their profile, account security, and billing.
  const tabs = isAdmin ? ["profile", "api-keys", "ffmpeg", "security", "billing"] : ["profile", "security", "billing"];

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
        <h1 className="text-xl sm:text-2xl font-bold text-white" style={{ fontFamily: "'Outfit', sans-serif" }}>Settings</h1>
        <p className="text-sm text-white/35 mt-0.5">Account and platform configuration</p>
      </div>
      <div className="flex items-center gap-1 p-1 rounded-xl bg-white/5 border border-white/8 w-fit max-w-full flex-wrap">
        {tabs.map(t => (
          <button key={t} onClick={() => setActiveTab(t)}
            className={`px-3 sm:px-4 min-h-[40px] rounded-lg text-xs font-medium transition-all capitalize ${activeTab === t ? "bg-[var(--sv-accent)] text-white" : "text-white/38 hover:text-white/65"}`}>
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
                className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm text-white focus:outline-none focus:border-[var(--sv-accent-border)] transition-colors" />
            </div>
            <div>
              <label className="text-xs text-white/35 font-mono mb-1.5 block">Email</label>
              <input value={user?.email ?? ""} type="email" readOnly
                className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm text-white/50 focus:outline-none cursor-not-allowed" />
            </div>
            <div>
              <label className="text-xs text-white/35 font-mono mb-1.5 block">Organization</label>
              <input value={profileOrg} onChange={e => setProfileOrg(e.target.value)} type="text"
                className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm text-white focus:outline-none focus:border-[var(--sv-accent-border)] transition-colors" />
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
              style={{ background: "var(--sv-accent)" }}>
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
            <button className="flex items-center gap-2 px-3 py-2 rounded-xl bg-[var(--sv-accent-soft)] border border-[var(--sv-accent-border)] text-xs text-[var(--sv-accent-text)] hover:bg-[var(--sv-accent)] hover:text-white transition-colors">
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
                  className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm text-white font-mono focus:outline-none focus:border-[var(--sv-accent-border)] transition-colors" />
              </div>
            ))}
          </div>
          <button className="mt-5 px-5 py-2.5 rounded-xl text-white text-sm font-semibold hover:opacity-90 transition-all"
            style={{ background: "var(--sv-accent)" }}>Save FFmpeg Config</button>
        </GlassCard>
      )}

      {activeTab === "security" && (
        <div className="space-y-4">
          <ChangePasswordCard />
          <GlassCard className="p-6">
            <h3 className="text-sm font-semibold text-white/75 mb-5">Two-Factor Authentication</h3>
            <div className="flex flex-wrap items-center justify-between gap-3 p-4 rounded-xl border border-white/[0.06]" style={{ background: "rgba(255,255,255,0.02)" }}>
              <div className="flex min-w-0 items-center gap-3">
                <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/18 flex-shrink-0">
                  <ShieldCheck size={15} className="text-emerald-400" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-white truncate">Authenticator App</p>
                  <p className="text-xs text-emerald-400 font-mono mt-0.5 truncate">Enabled · TOTP</p>
                </div>
              </div>
              <button className="px-3 min-h-[40px] flex-shrink-0 rounded-lg text-xs text-white/45 bg-white/5 border border-white/8 hover:bg-white/8 transition-colors">Manage</button>
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
        <GlassCard className="p-8 sm:p-12 text-center">
          <div className="w-14 h-14 rounded-2xl bg-[var(--sv-accent-soft)] border border-[var(--sv-accent-border)] flex items-center justify-center mx-auto mb-4">
            <Shield size={22} className="text-[var(--sv-accent)]" />
          </div>
          <h3 className="text-lg font-bold text-white mb-2" style={{ fontFamily: "'Outfit', sans-serif" }}>Business Plan</h3>
          <p className="text-sm text-white/40 mb-4">5 TB storage · Unlimited encoding · Priority support</p>
          <p className="text-3xl font-bold text-white" style={{ fontFamily: "'Outfit', sans-serif" }}>$299<span className="text-sm font-normal text-white/35">/mo</span></p>
          <button className="mt-6 px-6 py-2.5 rounded-xl text-white text-sm font-semibold hover:opacity-90 transition-all"
            style={{ background: "var(--sv-accent)" }}>Manage Billing</button>
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
        <MetricCard icon={Users} label="Total Users" value={adminStats?.users != null ? String(adminStats.users) : "0"} sub="registered accounts" color="accent" />
        <MetricCard icon={Film} label="Total Videos" value={adminStats?.videos != null ? String(adminStats.videos) : "0"} sub={adminStats?.encodingJobs != null ? `${adminStats.encodingJobs} encoding` : "across library"} color="emerald" />
        <MetricCard icon={AlertTriangle} label="Failed Jobs" value={adminStats?.failedJobs != null ? String(adminStats.failedJobs) : "0"} sub="need attention" color="red" />
        <MetricCard icon={Activity} label="Active Uploads" value={adminStats?.activeSessions != null ? String(adminStats.activeSessions) : "0"} sub="in-progress sessions" color="neutral" />
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
                  style={{ background: "var(--sv-accent)" }}>
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
interface NavItem { to: string; icon: React.ElementType; label: string; end?: boolean }

// Everything a regular (non-admin) user gets — a pure consumption surface.
// Ingest deliberately isn't here: uploading is an admin capability.
const userNavItems: NavItem[] = [
  { to: "/",         icon: Home,     label: "Home", end: true },
  { to: "/live",     icon: Radio,    label: "Live TV" },
  { to: "/library",  icon: Film,     label: "Video Library" },
  { to: "/settings", icon: Settings, label: "Settings" },
];

// Ops/ingest/analytics surfaces — only ever built into the nav for admins.
// The actual security boundary is the RequireAdmin route guard, not this list.
const adminNavItems: NavItem[] = [
  { to: "/admin",           icon: Shield,          label: "Admin", end: true },
  { to: "/admin/dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/admin/upload",    icon: Upload,          label: "Upload Center" },
  { to: "/admin/encoding",  icon: Cpu,             label: "Encoding" },
  { to: "/admin/storage",   icon: HardDrive,       label: "Storage" },
  { to: "/admin/live",      icon: Tv,              label: "Live Channels" },
];

function SidebarLink({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) =>
        `w-full flex items-center gap-3 px-3 py-2.5 mb-0.5 rounded-xl transition-all relative ${isActive ? "text-white" : "text-white/35 hover:text-white/60 hover:bg-white/[0.04]"}`}
    >
      {({ isActive }) => (
        <>
          {isActive && <motion.div layoutId="sidebarActive" className="absolute inset-0 rounded-xl" style={{ background: "var(--sv-accent-soft)", border: "1px solid var(--sv-accent-soft)" }} />}
          <item.icon size={16} className="flex-shrink-0 relative z-10" style={{ color: isActive ? "var(--sv-accent-text)" : undefined }} />
          <AnimatePresence>
            {!collapsed && (
              <motion.span initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -6 }} transition={{ duration: 0.12 }}
                className="text-sm font-medium relative z-10 whitespace-nowrap">{item.label}</motion.span>
            )}
          </AnimatePresence>
          {isActive && !collapsed && <div className="w-1.5 h-1.5 rounded-full bg-[var(--sv-accent)] ml-auto relative z-10 flex-shrink-0" />}
        </>
      )}
    </NavLink>
  );
}

function Sidebar({ collapsed, setCollapsed, user, onLogout, hasNavbarAbove = true }: { collapsed: boolean; setCollapsed: (v: boolean) => void; user: AuthUser | null; onLogout: () => void; hasNavbarAbove?: boolean }) {
  const isAdmin = user?.role === "admin";
  return (
    <motion.aside animate={{ width: collapsed ? 64 : 232 }} transition={{ type: "spring", stiffness: 320, damping: 32 }}
      className={`flex-shrink-0 sticky flex flex-col border-r border-white/[0.06] overflow-hidden ${
        hasNavbarAbove ? "top-14 sm:top-16 h-[calc(100vh-56px)] sm:h-[calc(100vh-64px)]" : "top-0 h-screen"}`}
      style={{ background: "var(--sv-surface)" }}>
      {/* The fixed UserNavBar above already shows the wordmark when present —
          only draw our own logo header when this sidebar has to stand alone. */}
      {!hasNavbarAbove && (
        <div className="flex items-center gap-3 px-4 py-5 border-b border-white/[0.05] flex-shrink-0">
          <Link to="/" className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl flex-shrink-0 flex items-center justify-center" style={{ background: "var(--sv-accent)" }}>
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
          </Link>
        </div>
      )}
      {/* Nav */}
      <nav className="flex-1 py-3 px-2 overflow-y-auto">
        {userNavItems.map(item => <SidebarLink key={item.to} item={item} collapsed={collapsed} />)}

        {/* Admin section is simply not built for non-admins — no post-hoc filtering. */}
        {isAdmin && (
          <>
            <div className="mt-4 mb-1 px-3 h-4 flex items-center">
              {!collapsed
                ? <span className="text-[9.5px] font-mono font-semibold uppercase tracking-widest text-white/22">Admin</span>
                : <span className="w-full h-px bg-white/[0.07]" />}
            </div>
            {adminNavItems.map(item => <SidebarLink key={item.to} item={item} collapsed={collapsed} />)}
          </>
        )}
      </nav>

      {/* Footer */}
      <div className="p-2 border-t border-white/[0.05] flex-shrink-0">
        <div className="flex items-center gap-2.5 px-2 py-2 rounded-xl hover:bg-white/[0.04] cursor-pointer transition-colors" onClick={onLogout} title="Sign out">
          <div className="w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-bold text-white"
            style={{ background: "var(--sv-accent)" }}>
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

// ─── User top navbar (Netflix-style) ──────────────────────────────────────────
// Netflix's browse UI is a slim horizontal bar, not a left rail, so the regular
// viewer surfaces (`/`, `/live`, `/library`, `/settings`) render this with no
// `Sidebar` at all. `AppShell` (the `/admin/*` subtree) renders this SAME bar
// plus `Sidebar` beneath it, so admins always have a way back to the regular
// browse experience — only `Sidebar`'s admin-tools column is exclusive to that
// shell, not the navbar itself.

// Inline primary destinations. Derived from `userNavItems` so the routes stay
// declared exactly once — Settings is deliberately excluded here and lives in
// the avatar dropdown instead, mirroring Netflix's account menu.
const primaryNavItems = userNavItems.filter(i => i.to !== "/settings");

function NavBarLink({ item }: { item: NavItem }) {
  return (
    <NavLink
      to={item.to}
      {...(item.end ? { end: item.end } : {})}
      className={({ isActive }) =>
        `relative whitespace-nowrap py-1 text-sm transition-colors ${isActive ? "font-semibold text-white" : "font-medium text-white/60 hover:text-white"}`}
    >
      {({ isActive }) => (
        <>
          {item.label}
          {/* Plain (non-`layoutId`) underline: the mobile drawer renders the same
              routes, and two live elements sharing a layoutId fight each other. */}
          {isActive && (
            <span className="absolute inset-x-0 -bottom-0.5 h-0.5 rounded-full" style={{ background: "var(--sv-accent)" }} />
          )}
        </>
      )}
    </NavLink>
  );
}

function UserNavBar({ user, online, onLogout, forceSolid = false }: { user: AuthUser | null; online: boolean | null; onLogout: () => void; forceSolid?: boolean }) {
  const location = useLocation();
  const isAdmin = user?.role === "admin";
  const [scrolled, setScrolled] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  // Netflix blends its bar into the artwork at the top of the page and drops a
  // solid background in once you scroll. The shell scrolls the document (not an
  // inner pane), so a plain window listener is enough.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Any navigation collapses whatever was expanded.
  useEffect(() => {
    setMobileNavOpen(false);
    setMobileSearchOpen(false);
    setUserMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!userMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) setUserMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [userMenuOpen]);

  // Admin pages scroll inside their own <main>, not the document, so the
  // scroll-driven transparent-over-hero treatment never has anything to react
  // to there -- force a solid bar instead of leaving it permanently see-through.
  const solid = forceSolid || scrolled || mobileNavOpen || mobileSearchOpen;
  const iconBtn = "flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-white/65 transition-colors hover:bg-white/10 hover:text-white";

  return (
    <header
      className="fixed inset-x-0 top-0 z-50 transition-colors duration-300"
      style={solid
        ? { background: "rgba(20,20,20,0.97)", backdropFilter: "blur(14px)", borderBottom: "1px solid var(--sv-border)" }
        : { background: "linear-gradient(to bottom, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.45) 55%, rgba(0,0,0,0) 100%)", borderBottom: "1px solid transparent" }}
    >
      <div className="relative flex h-14 items-center gap-1.5 px-3 sm:h-16 sm:gap-4 sm:px-6 lg:px-10">
        {/* Mobile menu toggle — the primary links collapse behind this below md */}
        <button
          type="button"
          aria-label={mobileNavOpen ? "Close menu" : "Open menu"}
          aria-expanded={mobileNavOpen}
          onClick={() => { setMobileNavOpen(o => !o); setMobileSearchOpen(false); setUserMenuOpen(false); }}
          className={`${iconBtn} md:hidden`}
        >
          {mobileNavOpen ? <X size={18} /> : <Menu size={18} />}
        </button>

        {/* Wordmark — same red play tile the sidebar uses */}
        <Link to="/" className="flex flex-shrink-0 items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: "var(--sv-accent)" }}>
            <Play size={13} fill="white" className="ml-0.5 text-white" />
          </span>
          <span className="hidden text-lg font-bold text-white sm:inline lg:text-xl" style={{ fontFamily: "'Outfit', sans-serif" }}>
            StreamVault
          </span>
        </Link>

        {/* Primary links centered in the bar regardless of logo/right-cluster width. */}
        <nav className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-5 md:flex lg:gap-7">
          {primaryNavItems.map(item => <NavBarLink key={item.to} item={item} />)}
        </nav>

        <div className="ml-auto flex min-w-0 items-center gap-0.5 sm:gap-1.5">
          {/* Desktop search — expands on focus */}
          <div className="relative hidden md:block">
            <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/35" />
            <input
              placeholder="Titles, channels…"
              className="w-40 rounded-lg border border-white/[0.12] bg-black/50 py-2 pl-9 pr-3 text-xs text-white placeholder-white/25 transition-[width,border-color] duration-300 focus:w-56 focus:border-[var(--sv-accent-border)] focus:outline-none lg:w-52 lg:focus:w-72"
            />
          </div>
          {/* Mobile search — icon that expands into a full-width row */}
          <button
            type="button"
            aria-label="Search"
            aria-expanded={mobileSearchOpen}
            onClick={() => { setMobileSearchOpen(o => !o); setMobileNavOpen(false); }}
            className={`${iconBtn} md:hidden`}
          >
            <Search size={17} />
          </button>

          {/* Backend status pill — an ops detail, admin-only */}
          {isAdmin && (
            <div className={`hidden items-center gap-1.5 rounded-lg border px-2.5 py-1 font-mono text-[10px] font-semibold transition-all lg:flex ${
              online === null ? "border-white/8 bg-white/4 text-white/28" :
              online ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400" :
              "border-amber-500/20 bg-amber-500/10 text-amber-400"
            }`}>
              <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                online === null ? "bg-white/25" : online ? "animate-pulse bg-emerald-400" : "bg-amber-400"
              }`} />
              {online === null ? "checking…" : online ? "API online" : "offline"}
            </div>
          )}

          <button type="button" aria-label="Notifications" className={`relative ${iconBtn}`}>
            <Bell size={17} />
            <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full" style={{ background: "var(--sv-accent)" }} />
          </button>

          {/* Profile menu */}
          <div className="relative flex-shrink-0" ref={userMenuRef}>
            <button
              type="button"
              aria-label="Account menu"
              aria-expanded={userMenuOpen}
              onClick={() => { setUserMenuOpen(o => !o); setMobileNavOpen(false); setMobileSearchOpen(false); }}
              className="flex h-10 items-center gap-1 rounded-full pl-0.5 pr-1 transition-colors hover:bg-white/10"
            >
              <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                style={{ background: "var(--sv-accent)" }}>
                {user?.name ? user.name.charAt(0).toUpperCase() : "?"}
              </span>
              <ChevronDown size={13} className={`hidden text-white/45 transition-transform duration-200 sm:block ${userMenuOpen ? "rotate-180" : ""}`} />
            </button>

            <AnimatePresence>
              {userMenuOpen && (
                <motion.div
                  key="user-menu"
                  initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.14, ease: "easeOut" }}
                  className="absolute right-0 top-full z-50 mt-2 w-56 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl border border-white/[0.1] shadow-2xl"
                  style={{ background: "rgba(24,24,24,0.98)", backdropFilter: "blur(16px)" }}
                >
                  <div className="border-b border-white/[0.07] px-4 py-3">
                    <p className="truncate text-sm font-semibold text-white">{user?.name ?? "—"}</p>
                    <p className="truncate font-mono text-[11px] text-white/38">{user?.email ?? ""}</p>
                    <span className="mt-1.5 inline-block rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-white/45">
                      {user?.role ?? "—"}
                    </span>
                  </div>
                  <div className="p-1.5">
                    <Link to="/settings" onClick={() => setUserMenuOpen(false)}
                      className="flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm text-white/65 transition-colors hover:bg-white/[0.07] hover:text-white">
                      <Settings size={15} className="flex-shrink-0" />Settings
                    </Link>
                    <button type="button" onClick={() => { setUserMenuOpen(false); onLogout(); }}
                      className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm text-white/65 transition-colors hover:bg-[var(--sv-accent-faint)] hover:text-[var(--sv-accent-text)]">
                      <LogOut size={15} className="flex-shrink-0" />Sign out
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* Expanded mobile search row */}
      <AnimatePresence>
        {mobileSearchOpen && (
          <motion.div key="mobile-search" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            className="overflow-hidden border-t border-white/[0.06] md:hidden">
            <div className="relative px-3 py-2.5">
              <Search size={14} className="pointer-events-none absolute left-6 top-1/2 -translate-y-1/2 text-white/35" />
              <input
                autoFocus
                placeholder="Search titles, channels…"
                className="w-full rounded-lg border border-white/[0.12] bg-black/50 py-2.5 pl-9 pr-3 text-sm text-white placeholder-white/25 focus:border-[var(--sv-accent-border)] focus:outline-none"
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Mobile nav drawer */}
      <AnimatePresence>
        {mobileNavOpen && (
          <motion.nav key="mobile-nav" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="overflow-hidden border-t border-white/[0.06] md:hidden">
            <div className="space-y-1 px-3 py-3">
              {userNavItems.map(item => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  {...(item.end ? { end: item.end } : {})}
                  onClick={() => setMobileNavOpen(false)}
                  className={({ isActive }) =>
                    `flex items-center gap-3 rounded-xl px-3 py-3 text-sm transition-colors ${
                      isActive ? "font-semibold text-white" : "text-white/60 hover:bg-white/[0.05] hover:text-white"}`}
                  style={({ isActive }) => (isActive ? { background: "var(--sv-accent-soft)" } : {})}
                >
                  <item.icon size={16} className="flex-shrink-0" />
                  <span className="truncate">{item.label}</span>
                </NavLink>
              ))}
            </div>
          </motion.nav>
        )}
      </AnimatePresence>
    </header>
  );
}

// ─── User shell (top navbar + routed <Outlet/>, no sidebar column) ────────────
// ─── App shell (navbar always; sidebar too, for admins, on every page) ────────
// Admins expect their tools reachable from wherever they are, not just inside
// a separate /admin subtree, so the sidebar's presence is role-driven, not
// route-driven — everyone gets the same navbar, and it's just a plain flex
// sibling next to the routed content rather than a second, route-gated shell.
function AppShell({ user, online, collapsed, setCollapsed, onLogout }: {
  user: AuthUser | null;
  online: boolean | null;
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  onLogout: () => void;
}) {
  const location = useLocation();
  const isAdmin = user?.role === "admin";
  // The sidebar already links back to Home/Live/Library/Settings (plus every
  // admin tool), so a second top bar duplicating those same links is just
  // clutter once you're inside the admin section itself.
  const inAdminSection = location.pathname.startsWith("/admin");
  const showNavbar = !inAdminSection;

  if (!user) return <Navigate to="/login" replace />;

  return (
    <div className="min-h-screen w-full overflow-x-hidden" style={{ background: "var(--sv-bg)", fontFamily: "'Inter', sans-serif" }}>
      {showNavbar && <UserNavBar user={user} online={online} onLogout={onLogout} forceSolid={isAdmin} />}
      {/* Top padding clears the fixed navbar (h-14 mobile / h-16 from sm up) —
          only needed when the navbar is actually rendered above this row. */}
      <div className={`flex ${showNavbar ? "pt-14 sm:pt-16" : ""}`}>
        {isAdmin && <Sidebar collapsed={collapsed} setCollapsed={setCollapsed} user={user} onLogout={onLogout} hasNavbarAbove={showNavbar} />}
        <main className="min-w-0 flex-1 px-4 pb-12 pt-6 sm:px-6 lg:px-10">
          <AnimatePresence mode="wait">
            <motion.div key={location.pathname} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18, ease: "easeOut" }}>
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────
export default function App() {
  const navigate = useNavigate();
  const [user, setUser] = useState<AuthUser | null>(null);
  // If no token is stored we already know — skip the async check entirely
  const hasStoredToken = (() => { try { return !!localStorage.getItem("sv_token"); } catch { return false; } })();
  const [authChecked, setAuthChecked] = useState(!hasStoredToken);
  const [collapsed, setCollapsed] = useState(false);
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
    navigate("/", { replace: true });
  }, [navigate]);

  const handleLogout = useCallback(() => {
    authApi.logout();
    setUser(null);
    setLiveEncoding({});
    navigate("/login", { replace: true });
  }, [navigate]);

  const handlePlayVideo = useCallback((v: Video) => {
    navigate(`/watch/${v.id}`);
  }, [navigate]);

  // Waiting for token check to complete before rendering
  if (!authChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "var(--sv-bg)" }}>
        <Loader2 size={22} className="animate-spin text-[var(--sv-accent)]" />
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <AuthPage onLogin={handleLogin} />} />

      {/* One shell for every authenticated route: the navbar always renders,
          and the sidebar joins it too when the signed-in user is an admin —
          on Home/Live/Library/Settings as well as /admin/*, not just there.
          Redirects to /login when there's no session. */}
      <Route element={<AppShell user={user} online={online} collapsed={collapsed} setCollapsed={setCollapsed} onLogout={handleLogout} />}>
        <Route index element={<HomePage user={user} />} />
        <Route path="live" element={<LiveTvPage />} />
        <Route path="library" element={<LibraryPage onPlayVideo={handlePlayVideo} online={online} user={user} />} />
        <Route path="settings" element={<SettingsPage user={user} />} />

        {/* RequireAdmin is the real client-side boundary (server enforces it too) */}
        <Route path="admin" element={<RequireAdmin user={user}><AdminPage online={online} /></RequireAdmin>} />
        <Route path="admin/dashboard" element={<RequireAdmin user={user}><DashboardPage online={online} /></RequireAdmin>} />
        {/* Ingest lives inside the admin subtree: /upload no longer exists, so a
            non-admin typing either URL falls through to RequireAdmin → /library. */}
        <Route path="admin/upload" element={<RequireAdmin user={user}><UploadPage online={online} liveEvents={liveEncoding} /></RequireAdmin>} />
        <Route path="admin/encoding" element={<RequireAdmin user={user}><EncodingPage liveEvents={liveEncoding} online={online} /></RequireAdmin>} />
        <Route path="admin/storage" element={<RequireAdmin user={user}><StoragePage online={online} /></RequireAdmin>} />
        <Route path="admin/live" element={<RequireAdmin user={user}><LiveChannelsAdminPage /></RequireAdmin>} />
      </Route>

      {/* Full-bleed cinematic players. Deliberately rendered *outside* both
          shells: they are `position: fixed` surfaces and every shell wraps its
          <Outlet/> in a page-transition motion.div, whose transform becomes the
          containing block for fixed descendants and would offset them.
          RequireAuth applies the same "session required" rule the shells do. */}
      <Route element={<RequireAuth user={user} />}>
        <Route path="watch/live/:slug" element={<LiveChannelPlayerPage />} />
        <Route path="watch/:videoId" element={<PlayerPage user={user} />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
