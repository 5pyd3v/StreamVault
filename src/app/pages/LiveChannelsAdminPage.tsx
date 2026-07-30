import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle, Check, Copy, Eye, EyeOff, Image as ImageIcon, Key, Loader2, Plus,
  RefreshCw, Signal, Square, Trash2,
} from "lucide-react";
import { liveAdminApi, copyToClipboard } from "../../lib/api";
import type { ApiLiveChannelAdmin } from "../../lib/api";
import { getSocket } from "../../lib/socket";
import type { LiveEndedEvent, LiveErrorEvent, LiveStartedEvent } from "../../lib/socket";

// Admin/ops screens deliberately keep the existing dashboard chrome (inline
// hex + glass cards) rather than the new end-user token-based styling.
function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-2xl border border-white/[0.07] backdrop-blur-xl ${className}`}
      style={{ background: "rgba(255,255,255,0.032)", boxShadow: "0 4px 32px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.055)" }}
    >
      {children}
    </div>
  );
}

const STATUS_CLS: Record<string, string> = {
  live: "bg-emerald-500/12 text-emerald-400 border-emerald-500/25",
  starting: "bg-[var(--sv-accent-soft)] text-[var(--sv-accent-text)] border-[var(--sv-accent-border)]",
  error: "bg-red-500/12 text-red-400 border-red-500/25",
  offline: "bg-zinc-500/12 text-zinc-400 border-zinc-500/25",
};

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await copyToClipboard(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard blocked — the value is selectable in the field */ }
  };
  return (
    <div>
      <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-white/28">{label}</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate rounded-lg border border-white/[0.08] bg-black/40 px-3 py-2 font-mono text-xs text-white/75">{value}</code>
        <button
          onClick={copy}
          title={`Copy ${label}`}
          className="flex-shrink-0 rounded-lg border border-white/10 bg-white/5 p-2 text-white/45 transition-colors hover:bg-white/10 hover:text-white"
        >
          {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
        </button>
      </div>
    </div>
  );
}

/**
 * Admin-only channel management (`/admin/live`): create channels, hand out the
 * OBS ingest credentials, rotate keys and kill runaway broadcasts.
 */
export default function LiveChannelsAdminPage() {
  const [channels, setChannels] = useState<ApiLiveChannelAdmin[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Create form
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [recordEnabled, setRecordEnabled] = useState(true);
  const [posterFile, setPosterFile] = useState<File | null>(null);
  const [creating, setCreating] = useState(false);

  // Revealed credentials, keyed by channel id. Never persisted.
  const [creds, setCreds] = useState<Record<string, { streamKey: string; rtmpUrl: string }>>({});
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const flash = (text: string, ok: boolean) => {
    setMsg({ text, ok });
    setTimeout(() => setMsg(null), 3500);
  };

  const refresh = useCallback(async () => {
    try {
      setChannels(await liveAdminApi.list());
    } catch (e: any) {
      flash(e?.message || "Could not load channels.", false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Keep the status column honest without polling.
  useEffect(() => {
    const socket = getSocket();
    const patchStatus = (id: string, status: ApiLiveChannelAdmin["status"]) =>
      setChannels(prev => prev.map(c => (c._id === id ? { ...c, status } : c)));
    const onStarted = (e: LiveStartedEvent) => patchStatus(e.channelId, "live");
    const onEnded = (e: LiveEndedEvent) => patchStatus(e.channelId, "offline");
    const onError = (e: LiveErrorEvent) => patchStatus(e.channelId, "error");
    socket.on("live:started", onStarted);
    socket.on("live:ended", onEnded);
    socket.on("live:error", onError);
    return () => {
      socket.off("live:started", onStarted);
      socket.off("live:ended", onEnded);
      socket.off("live:error", onError);
    };
  }, []);

  const handleCreate = async () => {
    if (!name.trim()) { flash("Channel name is required.", false); return; }
    setCreating(true);
    try {
      const created = await liveAdminApi.create({
        name: name.trim(),
        description: description.trim(),
        category: category.trim(),
        recordEnabled,
      });
      // This is the only response that hands back the raw key — surface it now.
      setCreds(prev => ({ ...prev, [created._id]: { streamKey: created.streamKey, rtmpUrl: created.rtmpUrl } }));

      // The poster is a separate multipart call — the channel has to exist first.
      let posterFailed = "";
      if (posterFile) {
        try {
          await liveAdminApi.uploadPoster(created._id, posterFile);
        } catch (e: any) {
          posterFailed = e?.message || "the poster upload failed";
        }
      }

      setName(""); setDescription(""); setCategory(""); setPosterFile(null);
      await refresh();
      if (posterFailed) {
        flash(`Channel "${created.name}" created, but ${posterFailed}. Upload the poster from the list below.`, false);
      } else {
        flash(`Channel "${created.name}" created — copy the stream key below.`, true);
      }
    } catch (e: any) {
      flash(e?.message || "Could not create the channel.", false);
    } finally {
      setCreating(false);
    }
  };

  const withBusy = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    try { await fn(); } finally { setBusy(null); }
  };

  const handleReveal = (id: string) => withBusy(id, async () => {
    if (creds[id]) { setCreds(prev => { const n = { ...prev }; delete n[id]; return n; }); return; }
    try {
      const c = await liveAdminApi.reveal(id);
      setCreds(prev => ({ ...prev, [id]: c }));
    } catch (e: any) {
      flash(e?.message || "Could not reveal the stream key.", false);
    }
  });

  const handleRegenerate = (id: string) => withBusy(id, async () => {
    try {
      const c = await liveAdminApi.regenerateKey(id);
      setCreds(prev => ({ ...prev, [id]: { streamKey: c.streamKey, rtmpUrl: c.rtmpUrl } }));
      await refresh();
      flash("Stream key rotated. Update OBS with the new key.", true);
    } catch (e: any) {
      flash(e?.message || "Could not rotate the key.", false);
    }
  });

  const handleStop = (id: string) => withBusy(id, async () => {
    try {
      const r = await liveAdminApi.stop(id);
      await refresh();
      flash(r.stopped ? "Stream stopped." : "No active stream on that channel.", true);
    } catch (e: any) {
      flash(e?.message || "Could not stop the stream.", false);
    }
  });

  const handleToggleEnabled = (c: ApiLiveChannelAdmin) => withBusy(c._id, async () => {
    try {
      await liveAdminApi.update(c._id, { isEnabled: !c.isEnabled });
      await refresh();
      flash(c.isEnabled ? "Channel disabled." : "Channel enabled.", true);
    } catch (e: any) {
      flash(e?.message || "Could not update the channel.", false);
    }
  });

  const handlePosterUpload = (id: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // so the same file can be picked again after a failure
    if (!file) return;
    return withBusy(id, async () => {
      try {
        await liveAdminApi.uploadPoster(id, file);
        await refresh();
        flash("Poster updated.", true);
      } catch (err: any) {
        flash(err?.message || "Could not upload the poster.", false);
      }
    });
  };

  const handleDelete = (id: string) => {
    if (confirmDelete !== id) { setConfirmDelete(id); setTimeout(() => setConfirmDelete(null), 5000); return; }
    setConfirmDelete(null);
    return withBusy(id, async () => {
      try {
        await liveAdminApi.remove(id);
        setCreds(prev => { const n = { ...prev }; delete n[id]; return n; });
        await refresh();
        flash("Channel deleted.", true);
      } catch (e: any) {
        flash(e?.message || "Could not delete the channel.", false);
      }
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white" style={{ fontFamily: "'Outfit', sans-serif" }}>Live Channels</h1>
        <p className="mt-0.5 text-sm text-white/35">RTMP ingest for OBS · One stream key per channel</p>
      </div>

      {msg && (
        <div className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-sm ${msg.ok ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400" : "border-red-500/20 bg-red-500/10 text-red-400"}`}>
          {msg.ok ? <Check size={15} /> : <AlertCircle size={15} />}{msg.text}
        </div>
      )}

      {/* Create */}
      <Card className="p-5">
        <h3 className="mb-4 text-sm font-semibold text-white/75">New Channel</h3>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div>
            <label className="mb-1.5 block font-mono text-xs text-white/35">Name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Studio A"
              onKeyDown={e => e.key === "Enter" && handleCreate()}
              className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white placeholder-white/20 transition-colors focus:border-[var(--sv-accent-border)] focus:outline-none" />
          </div>
          <div>
            <label className="mb-1.5 block font-mono text-xs text-white/35">Category <span className="text-white/20">(optional)</span></label>
            <input value={category} onChange={e => setCategory(e.target.value)} placeholder="Sports"
              className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white placeholder-white/20 transition-colors focus:border-[var(--sv-accent-border)] focus:outline-none" />
          </div>
          <div>
            <label className="mb-1.5 block font-mono text-xs text-white/35">Description <span className="text-white/20">(optional)</span></label>
            <input value={description} onChange={e => setDescription(e.target.value)} placeholder="Main studio feed"
              className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white placeholder-white/20 transition-colors focus:border-[var(--sv-accent-border)] focus:outline-none" />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <button onClick={handleCreate} disabled={creating}
            className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold text-white transition-all hover:opacity-90 disabled:opacity-50"
            style={{ background: "var(--sv-accent)" }}>
            {creating ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}Create Channel
          </button>
          <label className="flex cursor-pointer select-none items-center gap-2 text-xs text-white/45">
            <input type="checkbox" checked={recordEnabled} onChange={e => setRecordEnabled(e.target.checked)} className="accent-[var(--sv-accent)]" />
            Auto-record broadcasts into the VOD library
          </label>
          <label className="flex cursor-pointer select-none items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/55 transition-colors hover:bg-white/10 hover:text-white">
            <ImageIcon size={12} />
            {posterFile ? posterFile.name : "Poster image (optional)"}
            <input type="file" accept="image/*" className="hidden"
              onChange={e => setPosterFile(e.target.files?.[0] ?? null)} />
          </label>
        </div>
        <p className="mt-2 font-mono text-[10px] text-white/25">
          No poster? One is captured automatically from the first seconds of the broadcast.
        </p>
      </Card>

      {/* List */}
      {loading ? (
        <Card className="p-12 text-center">
          <Loader2 size={26} className="mx-auto animate-spin text-[var(--sv-accent)]" />
        </Card>
      ) : channels.length === 0 ? (
        <Card className="p-12 text-center">
          <Signal size={26} className="mx-auto mb-3 text-white/25" />
          <p className="text-white/50">No channels yet</p>
          <p className="mt-1 font-mono text-xs text-white/30">Create one above, then paste the RTMP URL + key into OBS.</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {channels.map(c => {
            const revealed = creds[c._id];
            const isBusy = busy === c._id;
            // Auto-captured posters land on this exact filename (see
            // autoPosterPathFor in the server's liveEncoder) — worth telling the
            // admin apart from one they uploaded themselves.
            const autoPoster = !!c.posterUrl && c.posterUrl.endsWith(`/posters/${c._id}.jpg`);
            return (
              <Card key={c._id} className="p-5">
                <div className="flex flex-wrap items-start gap-4">
                  <div className="flex-shrink-0">
                    {c.posterUrl ? (
                      <img src={c.posterUrl} alt={`${c.name} poster`}
                        className="h-14 w-24 rounded-lg border border-white/[0.08] bg-black/40 object-cover" />
                    ) : (
                      <div className="flex h-14 w-24 items-center justify-center rounded-lg border border-dashed border-white/10 bg-black/25">
                        <ImageIcon size={15} className="text-white/20" />
                      </div>
                    )}
                    <p className="mt-1 text-center font-mono text-[9px] uppercase tracking-wider text-white/25">
                      {c.posterUrl ? (autoPoster ? "auto-captured" : "uploaded") : "no poster"}
                    </p>
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-white">{c.name}</span>
                      <span className={`rounded-md border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-widest ${STATUS_CLS[c.status] ?? STATUS_CLS.offline}`}>
                        {c.status}
                      </span>
                      {!c.isEnabled && (
                        <span className="rounded-md border border-amber-500/25 bg-amber-500/12 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-amber-400">
                          disabled
                        </span>
                      )}
                    </div>
                    <p className="font-mono text-xs text-white/30">
                      /{c.slug}{c.category ? ` · ${c.category}` : ""}{c.recordEnabled ? " · auto-record" : ""}
                    </p>
                    {c.lastError && <p className="mt-1 font-mono text-xs text-red-400/70">{c.lastError}</p>}
                  </div>

                  <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5">
                    <button onClick={() => handleReveal(c._id)} disabled={isBusy}
                      className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/55 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40">
                      {revealed ? <EyeOff size={12} /> : <Eye size={12} />}{revealed ? "Hide key" : "Reveal key"}
                    </button>
                    <label title={c.posterUrl ? "Replace the poster image" : "Upload a poster image"}
                      className={`flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/55 transition-colors hover:bg-white/10 hover:text-white ${isBusy ? "pointer-events-none opacity-40" : "cursor-pointer"}`}>
                      <ImageIcon size={12} />{c.posterUrl ? "Replace poster" : "Poster"}
                      <input type="file" accept="image/*" className="hidden" disabled={isBusy}
                        onChange={e => void handlePosterUpload(c._id, e)} />
                    </label>
                    <button onClick={() => handleRegenerate(c._id)} disabled={isBusy} title="Rotate the stream key"
                      className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/55 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40">
                      <Key size={12} />Rotate
                    </button>
                    <button onClick={() => handleStop(c._id)} disabled={isBusy} title="Force-stop the current broadcast"
                      className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/55 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40">
                      <Square size={12} />Stop
                    </button>
                    <button onClick={() => handleToggleEnabled(c)} disabled={isBusy}
                      className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/55 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40">
                      <RefreshCw size={12} />{c.isEnabled ? "Disable" : "Enable"}
                    </button>
                    <button onClick={() => handleDelete(c._id)} disabled={isBusy}
                      className="flex items-center gap-1.5 rounded-lg border border-red-500/15 bg-red-500/5 px-3 py-1.5 text-xs text-red-400/70 transition-colors hover:bg-red-500/12 hover:text-red-400 disabled:opacity-40">
                      <Trash2 size={12} />{confirmDelete === c._id ? "Confirm?" : "Delete"}
                    </button>
                    {isBusy && <Loader2 size={13} className="animate-spin text-white/35" />}
                  </div>
                </div>

                {revealed && (
                  <div className="mt-4 grid grid-cols-1 gap-3 rounded-xl border border-[var(--sv-accent-border)] bg-[var(--sv-accent-faint)] p-4 md:grid-cols-2">
                    <CopyField label="OBS Server (RTMP URL)" value={revealed.rtmpUrl.replace(/\/[^/]+$/, "")} />
                    <CopyField label="OBS Stream Key" value={revealed.streamKey} />
                    <div className="md:col-span-2">
                      <CopyField label="Full ingest URL" value={revealed.rtmpUrl} />
                      <p className="mt-2 font-mono text-[10px] text-white/25">
                        In OBS: Settings → Stream → Service "Custom", paste the server + key above.
                      </p>
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
