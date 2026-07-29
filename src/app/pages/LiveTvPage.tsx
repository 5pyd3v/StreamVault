import { useMemo } from "react";
import { AlertCircle, Loader2, RefreshCw, Tv } from "lucide-react";
import type { ApiLiveChannel } from "../../lib/api";
import PosterCard from "../components/PosterCard";
import useLiveChannels from "../hooks/useLiveChannels";

const STATUS_RANK: Record<ApiLiveChannel["status"], number> = {
  live: 0,
  starting: 1,
  error: 2,
  offline: 3,
};

function statusLabel(c: ApiLiveChannel): string {
  switch (c.status) {
    case "live": return c.category || "On air now";
    case "starting": return "Starting…";
    case "error": return "Stream error";
    default: return c.category ? `${c.category} · Offline` : "Offline";
  }
}

/**
 * The channel lineup. Live channels sort to the front with a pulsing badge;
 * everything else is greyscaled underneath. State comes from the socket
 * broadcasts via `useLiveChannels`, so no polling.
 */
export default function LiveTvPage() {
  const { channels, loading, error, refresh } = useLiveChannels();

  const sorted = useMemo(
    () => channels.slice().sort((a, b) => {
      const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      return rank !== 0 ? rank : a.name.localeCompare(b.name);
    }),
    [channels],
  );

  const liveCount = channels.filter(c => c.status === "live").length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-[var(--sv-text)] sm:text-2xl" style={{ fontFamily: "'Outfit', sans-serif" }}>
            Live TV
          </h1>
          <p className="mt-0.5 text-sm text-[var(--sv-text-muted)]">
            {loading
              ? "Loading channels…"
              : `${channels.length} channel${channels.length === 1 ? "" : "s"} · ${liveCount} live`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="flex items-center gap-2 rounded-xl border border-[var(--sv-border)] px-3 py-2 text-xs text-[var(--sv-text-muted)] transition-colors hover:border-[var(--sv-border-strong)] hover:text-[var(--sv-text)]"
        >
          <RefreshCw size={13} />Refresh
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          <AlertCircle size={15} />{error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 size={24} className="animate-spin text-[var(--sv-accent)]" />
        </div>
      ) : sorted.length === 0 ? (
        <div className="rounded-2xl border border-[var(--sv-border)] bg-[var(--sv-surface)] px-6 py-16 text-center">
          <Tv size={26} className="mx-auto mb-3 text-[var(--sv-text-dim)]" />
          <p className="text-sm text-[var(--sv-text-muted)]">No channels have been set up yet.</p>
          <p className="mt-1 font-mono text-xs text-[var(--sv-text-dim)]">
            An admin can create one under Admin → Live Channels.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {sorted.map(c => (
            <PosterCard
              key={c._id}
              to={`/watch/live/${c.slug}`}
              title={c.name}
              {...(c.posterUrl ? { imageUrl: c.posterUrl } : {})}
              subtitle={statusLabel(c)}
              live={c.status === "live"}
              dimmed={c.status !== "live"}
            />
          ))}
        </div>
      )}
    </div>
  );
}
