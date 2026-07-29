// ─── Netflix-style HLS Video Player ───────────────────────────────────────────
// Extracted verbatim from App.tsx so both the VOD player (`PlayerPage`) and the
// live channel player (`LiveChannelPlayerPage`) can share one implementation
// without a circular import back into App.tsx. Internals are unchanged.
import { useState, useRef, useCallback, useEffect } from "react";
import Hls from "hls.js";
import {
  AlertCircle, Check, Loader2, Maximize2, Pause, Play,
  Settings, SkipForward, Volume2,
} from "lucide-react";

export interface HlsPlayerProps {
  src: string;
  poster?: string;
  onError?: (msg: string) => void;
  /**
   * Live streams need different transport semantics than VOD:
   *  - `currentTime`/`duration` on a live MSE stream are raw positions in an
   *    ever-growing buffer timeline, not "seconds into this viewing session"
   *    -- so we show a locally-tracked elapsed-watch-time counter instead.
   *  - Seeking must be clamped to `video.seekable` (the actual DVR window
   *    still on disk), not `[0, duration]`.
   *  - Live starts at the lowest rendition (`startLevel: 0`) for a fast join,
   *    then lets hls.js's normal bandwidth-driven ABR switch up once playback
   *    is smooth. Seamless switching depends on every live rendition being a
   *    real, frame-aligned transcode (matching forced-keyframe/segment
   *    boundaries) server-side -- see server/src/services/liveEncoder.ts.
   *    An earlier version of this component force-locked `hls.currentLevel`
   *    after the first switch to work around audio overlap; that call turns
   *    out to itself trigger a buffer flush/re-append in hls.js even when
   *    "switching" to the level already playing, which could inject exactly
   *    the doubling it was meant to prevent. Removed in favor of fixing the
   *    actual misalignment at the source.
   */
  isLive?: boolean;
}

/**
 * Shared look for every transport icon button. Netflix gives its control icons
 * a soft circular highlight on hover rather than only a colour change, and the
 * 40px square keeps every control a comfortable thumb target on a phone (the
 * old bare icons were ~20px of hit area).
 */
const ctlBtn =
  "flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-white transition-colors duration-200 hover:bg-white/15 active:bg-white/25";

export default function HlsPlayer({ src, poster, onError, isLive = false }: HlsPlayerProps) {
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

  // ── Live-only playback state ──────────────────────────────────────────────
  // Elapsed watch time: a plain stopwatch that only ticks while actually
  // playing, completely decoupled from the raw (and ever-growing) MSE
  // timeline, so it reads as "how many seconds I've watched" rather than a
  // number that silently jumps ahead on its own.
  const [liveElapsed, setLiveElapsed] = useState(0);
  const elapsedAccumRef = useRef(0);
  const lastTickRef = useRef<number | null>(null);
  const didInitialLiveSeekRef = useRef(false);
  const [seekableRange, setSeekableRange] = useState<{ start: number; end: number } | null>(null);
  const [atLiveEdge, setAtLiveEdge] = useState(true);

  const scheduleHideControls = useCallback(() => {
    if (controlsTimerRef.current) window.clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = window.setTimeout(() => setShowControls(false), 3000);
  }, []);

  const showControlsNow = useCallback(() => {
    setShowControls(true);
    scheduleHideControls();
  }, [scheduleHideControls]);

  useEffect(() => {
    // Fresh stream/session: reset all live-only accumulators so a rewatch or
    // a rejoin-after-offline doesn't inherit stale elapsed time or a stale
    // "already did the initial live-edge seek" flag from the previous broadcast.
    elapsedAccumRef.current = 0;
    lastTickRef.current = null;
    didInitialLiveSeekRef.current = false;
    setLiveElapsed(0);
    setSeekableRange(null);
    setAtLiveEdge(true);

    const video = videoRef.current;
    if (!video || !src) return;
    setError(null);
    setLoading(true);

    if (Hls.isSupported()) {
      const hls = new Hls({
        // Live joins at the lowest rendition for a fast start, then hls.js's
        // normal bandwidth-driven ABR switches up once playback is smooth.
        // VOD keeps auto (-1) since there's no "start fast" concern.
        startLevel: isLive ? 0 : -1,
        capLevelToPlayerSize: !isLive,
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
      if (isLive) {
        // Join at the live edge, not wherever the buffer happens to start.
        hls.on(Hls.Events.LEVEL_LOADED, (_e, data: any) => {
          if (didInitialLiveSeekRef.current) return;
          const details = data?.details;
          if (!details?.live) return;
          didInitialLiveSeekRef.current = true;
          const edge = hls.liveSyncPosition;
          if (typeof edge === "number" && isFinite(edge)) {
            video.currentTime = edge;
          }
        });
      }
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
  }, [src, onError, isLive]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    const readSeekable = () => {
      if (v.seekable.length === 0) return null;
      return { start: v.seekable.start(0), end: v.seekable.end(v.seekable.length - 1) };
    };

    const onTime = () => {
      setCurrentTime(v.currentTime);
      if (v.buffered.length > 0) setBuffered(v.buffered.end(v.buffered.length - 1));

      if (isLive) {
        // Wall-clock stopwatch, not the raw MSE position -- only accrues
        // while genuinely playing, so pausing/buffering doesn't count.
        const now = performance.now();
        if (!v.paused && !v.seeking) {
          if (lastTickRef.current != null) {
            const delta = Math.min(1.5, Math.max(0, (now - lastTickRef.current) / 1000));
            elapsedAccumRef.current += delta;
            setLiveElapsed(elapsedAccumRef.current);
          }
          lastTickRef.current = now;
        } else {
          lastTickRef.current = null;
        }

        const range = readSeekable();
        setSeekableRange(range);
        if (range) {
          setAtLiveEdge(range.end - v.currentTime < Math.max(4, (range.end - range.start) * 0.05));
        }
      }
    };
    const onDur = () => setDuration(v.duration || 0);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => { setIsPlaying(false); lastTickRef.current = null; };
    const onWaiting = () => { setLoading(true); lastTickRef.current = null; };
    const onPlaying = () => { setLoading(false); lastTickRef.current = performance.now(); };
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
  }, [isLive]);

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
  const seek = (t: number) => {
    const v = videoRef.current;
    if (!v) return;
    if (isLive) {
      // Clamp to the actual DVR window still on disk -- targeting anything
      // outside it is exactly what used to make the player snap back to the
      // live edge (the segment no longer exists to be fetched).
      if (!seekableRange) return;
      v.currentTime = Math.max(seekableRange.start, Math.min(seekableRange.end - 0.5, t));
    } else {
      v.currentTime = Math.max(0, Math.min(duration, t));
    }
  };
  const goLive = () => { if (seekableRange) seek(seekableRange.end); };
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

  // For live, progress reflects position within the DVR window (seekable
  // range), not position within an ever-growing "duration" -- that value is
  // meaningless for a live buffer and was the source of the drifting-time bug.
  const liveWindow = isLive && seekableRange ? seekableRange.end - seekableRange.start : 0;
  const progressPct = isLive
    ? (liveWindow > 0 && seekableRange ? ((currentTime - seekableRange.start) / liveWindow) * 100 : 0)
    : (duration > 0 ? (currentTime / duration) * 100 : 0);
  const bufferedPct = isLive
    ? (liveWindow > 0 && seekableRange ? ((buffered - seekableRange.start) / liveWindow) * 100 : 0)
    : (duration > 0 ? (buffered / duration) * 100 : 0);

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

      {/* Center play/pause overlay — Netflix's large, soft translucent disc */}
      {!isPlaying && !loading && (
        <button
          onClick={togglePlay}
          className="absolute inset-0 flex items-center justify-center bg-black/25 transition-colors hover:bg-black/35"
        >
          <span className="flex h-[76px] w-[76px] items-center justify-center rounded-full border border-white/25 bg-white/20 backdrop-blur-md transition-transform duration-200 hover:scale-105 sm:h-24 sm:w-24"
            style={{ boxShadow: "0 8px 40px rgba(0,0,0,0.55)" }}>
            <Play size={32} className="ml-1 text-white sm:hidden" fill="white" />
            <Play size={38} className="ml-1 hidden text-white sm:block" fill="white" />
          </span>
        </button>
      )}

      {/* Controls bar */}
      <div
        className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/55 to-transparent px-3 pb-3 pt-20 transition-opacity duration-300 sm:px-6 sm:pb-5 sm:pt-24 md:px-10 ${showControls || !isPlaying ? "opacity-100" : "opacity-0 pointer-events-none"}`}
      >
        {/* Scrub bar. The generous vertical padding is the touch target; the
            visible track inside it stays a thin Netflix-style red line. */}
        <div className="group/progress -my-2 mb-1 w-full cursor-pointer py-2 sm:mb-2"
          onClick={e => {
            const rect = e.currentTarget.getBoundingClientRect();
            const frac = (e.clientX - rect.left) / rect.width;
            if (isLive && seekableRange) seek(seekableRange.start + frac * liveWindow);
            else seek(frac * duration);
          }}>
          <div className="relative h-[3px] w-full rounded-full transition-[height] duration-200 ease-out group-hover/progress:h-[5px]">
            <div className="absolute inset-0 rounded-full bg-white/25" />
            <div className="absolute inset-y-0 left-0 rounded-full bg-white/45" style={{ width: `${bufferedPct}%` }} />
            <div className="absolute inset-y-0 left-0 rounded-full bg-[var(--sv-accent)]" style={{ width: `${progressPct}%` }} />
            <div
              className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 scale-0 rounded-full bg-[var(--sv-accent)] opacity-0 transition-all duration-200 ease-out group-hover/progress:scale-100 group-hover/progress:opacity-100 sm:h-4 sm:w-4"
              style={{ left: `${progressPct}%`, boxShadow: "0 0 0 5px var(--sv-accent-soft), 0 2px 8px rgba(0,0,0,0.6)" }}
            />
          </div>
        </div>

        {/* Buttons row */}
        <div className="flex min-w-0 items-center gap-0.5 text-white sm:gap-1.5">
          <button onClick={togglePlay} className={ctlBtn} title={isPlaying ? "Pause" : "Play"}>
            {isPlaying ? <Pause size={22} fill="white" /> : <Play size={22} fill="white" />}
          </button>
          <button onClick={() => seek(currentTime - 10)} className={ctlBtn} title="Back 10s">
            <SkipForward size={20} className="rotate-180" />
          </button>
          <button onClick={() => seek(currentTime + 10)} className={ctlBtn} title="Forward 10s">
            <SkipForward size={20} />
          </button>

          {/* Volume — the slider is desktop-only; phones have hardware volume */}
          <div className="group/vol flex items-center">
            <button onClick={toggleMute} className={ctlBtn} title={muted || volume === 0 ? "Unmute" : "Mute"}>
              <Volume2 size={20} className={muted || volume === 0 ? "opacity-40" : ""} />
            </button>
            <input
              type="range" min={0} max={1} step={0.05}
              value={muted ? 0 : volume}
              onChange={e => setVol(parseFloat(e.target.value))}
              className="hidden w-0 accent-[var(--sv-accent)] transition-all duration-200 group-hover/vol:w-20 sm:block"
            />
          </div>

          {isLive ? (
            <span className="ml-1 flex min-w-0 items-center gap-2">
              <span className="hidden flex-shrink-0 items-center gap-1.5 rounded-md border border-[var(--sv-live-red)]/30 bg-[var(--sv-live-red)]/15 px-1.5 py-0.5 sm:flex">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--sv-live-red)] opacity-75" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--sv-live-red)]" />
                </span>
                <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-[var(--sv-live-red)]">Live</span>
              </span>
              <span className="whitespace-nowrap font-mono text-[11px] text-white/85 sm:text-xs">{fmtTime(liveElapsed)}</span>
              {!atLiveEdge && (
                <button
                  onClick={goLive}
                  className="flex-shrink-0 whitespace-nowrap rounded-md border border-white/20 px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-wide text-white/60 transition-colors hover:border-white/40 hover:text-white"
                >
                  Go live
                </button>
              )}
            </span>
          ) : (
            <span className="ml-1 min-w-0 truncate font-mono text-[11px] text-white/85 sm:ml-2 sm:text-xs">
              {fmtTime(currentTime)} / {fmtTime(duration)}
            </span>
          )}

          <div className="relative ml-auto flex flex-shrink-0 items-center gap-0.5 sm:gap-1.5">
            {/* Settings gear */}
            <button onClick={() => setShowSettings(s => !s)} className={ctlBtn} title="Settings">
              <Settings size={20} />
            </button>

            {showSettings && (
              <div className="absolute bottom-full right-0 mb-3 max-h-[60vh] w-60 max-w-[calc(100vw-1.5rem)] overflow-y-auto overflow-x-hidden rounded-2xl border border-white/[0.12] shadow-2xl backdrop-blur-xl"
                style={{ background: "rgba(20,20,20,0.96)" }}>
                <div className="border-b border-white/10 px-4 py-3">
                  <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-white/40">Quality</p>
                  <div className="space-y-0.5">
                    <button
                      onClick={() => changeQuality(-1)}
                      className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs transition-colors hover:bg-white/10 ${currentLevel === -1 ? "bg-white/[0.06] font-semibold text-[var(--sv-accent-text)]" : "text-white/80"}`}
                    >
                      <span>Auto</span>
                      {currentLevel === -1 && <Check size={13} />}
                    </button>
                    {levels.map(l => (
                      <button
                        key={l.index}
                        onClick={() => changeQuality(l.index)}
                        className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors hover:bg-white/10 ${currentLevel === l.index ? "bg-white/[0.06] font-semibold text-[var(--sv-accent-text)]" : "text-white/80"}`}
                      >
                        <span className="truncate">{l.height ? `${l.height}p` : `Level ${l.index}`}</span>
                        <span className="flex-shrink-0 font-mono text-[10px] text-white/40">{Math.round(l.bitrate / 1000)}k</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="px-4 py-3">
                  <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-white/40">Speed</p>
                  <div className="grid grid-cols-4 gap-1">
                    {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(r => (
                      <button
                        key={r}
                        onClick={() => setRate(r)}
                        className={`rounded-lg px-2 py-1.5 font-mono text-[11px] transition-colors hover:bg-white/10 ${playbackRate === r ? "bg-white/[0.06] font-semibold text-[var(--sv-accent-text)]" : "text-white/70"}`}
                      >
                        {r === 1 ? "1x" : `${r}x`}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <button onClick={toggleFullscreen} className={ctlBtn} title="Fullscreen">
              <Maximize2 size={20} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
