import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { AlertCircle, ArrowLeft, Loader2, Radio, RefreshCw } from "lucide-react";
import { liveApi, liveHlsUrlFor } from "../../lib/api";
import type { ApiLiveChannel } from "../../lib/api";
import { getSocket, unwatchChannel, watchChannel } from "../../lib/socket";
import type { LiveEndedEvent, LiveErrorEvent, LiveStartedEvent } from "../../lib/socket";
import HlsPlayer from "../components/HlsPlayer";

/**
 * Full-bleed live channel player (`/watch/live/:slug`).
 *
 * Thin wrapper: it resolves the channel, hands `channel.hlsUrl` to the shared
 * `HlsPlayer`, and joins the channel's socket room so a broadcast ending while
 * someone is watching flips the page to the "stream ended" state immediately
 * instead of stalling on a dead playlist.
 */
export default function LiveChannelPlayerPage() {
  // Routed by slug, but the URL is also accepted as a raw channel id (the
  // socket rooms are keyed by id) — see the fallback lookup below.
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const onBack = useCallback(() => navigate("/live"), [navigate]);

  const [channel, setChannel] = useState<ApiLiveChannel | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [endedDuringWatch, setEndedDuringWatch] = useState(false);

  // Auto-hiding chrome, mirroring HlsPlayer's own 3s showControls timer so the
  // back button and title fade together with the transport controls.
  const [showChrome, setShowChrome] = useState(true);
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

  const load = useCallback(async () => {
    if (!slug) return;
    setLoading(true);
    try {
      const c = await liveApi.get(slug);
      setChannel(c);
      setLoadError(null);
    } catch {
      // Not a slug? Fall back to matching an id out of the public lineup so
      // /watch/live/<channelId> links keep working too.
      try {
        const all = await liveApi.public();
        const byId = all.find(c => c._id === slug);
        if (!byId) throw new Error("Channel not found");
        setChannel(byId);
        setLoadError(null);
      } catch (e: any) {
        setLoadError(e?.message || "Channel not found.");
      }
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => { setEndedDuringWatch(false); void load(); }, [load]);

  // Join this channel's room and react to its live events.
  const channelId = channel?._id;
  useEffect(() => {
    if (!channelId) return;
    const socket = getSocket();
    watchChannel(channelId);

    const onStarted = (e: LiveStartedEvent) => {
      if (e.channelId !== channelId) return;
      setEndedDuringWatch(false);
      setChannel(prev => (prev ? { ...prev, status: "live", hlsUrl: liveHlsUrlFor(channelId), liveStartedAt: e.ts } : prev));
    };
    const onEnded = (e: LiveEndedEvent) => {
      if (e.channelId !== channelId) return;
      setEndedDuringWatch(true);
      setChannel(prev => (prev ? { ...prev, status: "offline", hlsUrl: "", liveStartedAt: null } : prev));
    };
    const onError = (e: LiveErrorEvent) => {
      if (e.channelId !== channelId) return;
      setChannel(prev => (prev ? { ...prev, status: "error", hlsUrl: "" } : prev));
    };

    socket.on("live:started", onStarted);
    socket.on("live:ended", onEnded);
    socket.on("live:error", onError);
    return () => {
      socket.off("live:started", onStarted);
      socket.off("live:ended", onEnded);
      socket.off("live:error", onError);
      unwatchChannel(channelId);
    };
  }, [channelId]);

  const isLive = channel?.status === "live" && !!channel.hlsUrl;

  return (
    <div
      className="fixed inset-0 z-50 bg-black"
      onMouseMove={bumpChrome}
      onTouchStart={bumpChrome}
    >
      {/* Playback surface */}
      <div className="absolute inset-0">
        {loading ? (
          <div className="flex h-full w-full items-center justify-center">
            <Loader2 size={28} className="animate-spin text-white/70" />
          </div>
        ) : loadError ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-4 px-6 text-center">
            <AlertCircle size={28} className="text-red-400" />
            <p className="text-sm text-white/60">{loadError}</p>
            <button onClick={onBack} className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-xs text-white/70 transition-colors hover:bg-white/10 hover:text-white">
              Back to Live TV
            </button>
          </div>
        ) : isLive ? (
          <HlsPlayer src={channel!.hlsUrl} isLive {...(channel!.posterUrl ? { poster: channel!.posterUrl } : {})} />
        ) : (
          <OfflineState
            name={channel?.name ?? "Channel"}
            posterUrl={channel?.posterUrl}
            ended={endedDuringWatch}
            errored={channel?.status === "error"}
            starting={channel?.status === "starting"}
            onRetry={() => void load()}
            onBack={onBack}
          />
        )}
      </div>

      {/* Top scrim: back button + channel identity, fades with the controls */}
      <div
        className={`pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-black/85 via-black/40 to-transparent px-4 pb-14 pt-4 transition-opacity duration-300 sm:px-6 ${showChrome ? "opacity-100" : "opacity-0"}`}
      >
        <div className="pointer-events-auto flex items-start gap-2 sm:gap-3">
          <button
            onClick={onBack}
            aria-label="Back to Live TV"
            className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border border-white/15 bg-black/50 text-white/80 backdrop-blur-sm transition-colors hover:bg-black/70 hover:text-white"
          >
            <ArrowLeft size={17} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-base font-bold text-white sm:text-xl" style={{ fontFamily: "'Outfit', sans-serif" }}>
                {channel?.name ?? "Live"}
              </h1>
              {isLive && (
                <span className="flex flex-shrink-0 items-center gap-1.5 rounded-md border border-[var(--sv-live-red)]/30 bg-[var(--sv-live-red)]/15 px-1.5 py-0.5">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--sv-live-red)] opacity-75" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--sv-live-red)]" />
                  </span>
                  <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-[var(--sv-live-red)]">Live</span>
                </span>
              )}
            </div>
            {channel && (
              <p className="mt-0.5 truncate font-mono text-[11px] text-white/45">
                {[channel.category, channel.description].filter(Boolean).join(" · ") || "Live channel"}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function OfflineState({
  name, posterUrl, ended, errored, starting, onRetry, onBack,
}: {
  name: string;
  posterUrl?: string | undefined;
  ended: boolean;
  errored: boolean;
  starting: boolean;
  onRetry: () => void;
  onBack: () => void;
}) {
  const headline = errored
    ? "This stream hit an error"
    : starting
      ? "Stream is starting…"
      : ended
        ? "The stream has ended"
        : `${name} is offline`;

  const detail = errored
    ? "The broadcast stopped unexpectedly. Try again in a moment."
    : starting
      ? "Waiting for the first segments to be published."
      : ended
        ? "The broadcast just wrapped up. A replay usually appears in the library once it finishes encoding."
        : "Nothing is being broadcast on this channel right now.";

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden">
      {posterUrl && (
        <img src={posterUrl} alt="" className="absolute inset-0 h-full w-full object-cover opacity-25 grayscale" />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black via-black/70 to-black/40" />
      <div className="relative max-w-md space-y-4 px-6 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-white/15 bg-white/5">
          {starting
            ? <Loader2 size={22} className="animate-spin text-white/70" />
            : errored
              ? <AlertCircle size={22} className="text-amber-400" />
              : <Radio size={22} className="text-white/50" />}
        </div>
        <h2 className="text-xl font-bold text-white" style={{ fontFamily: "'Outfit', sans-serif" }}>{headline}</h2>
        <p className="text-sm leading-relaxed text-white/45">{detail}</p>
        <div className="flex items-center justify-center gap-2 pt-1">
          <button
            onClick={onRetry}
            className="flex items-center gap-2 rounded-xl bg-[var(--sv-accent)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--sv-accent-hover)]"
          >
            <RefreshCw size={13} />Check again
          </button>
          <button
            onClick={onBack}
            className="rounded-xl border border-white/12 bg-white/5 px-4 py-2 text-sm font-semibold text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          >
            Live TV
          </button>
        </div>
      </div>
    </div>
  );
}
