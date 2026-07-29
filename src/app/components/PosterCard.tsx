import { useState } from "react";
import { Link } from "react-router";
import { Film, Loader2, Play, Trash2 } from "lucide-react";

export interface PosterCardProps {
  /** Route this tile links to (`/watch/:id` for VOD, `/watch/live/:slug` for channels). */
  to: string;
  title: string;
  imageUrl?: string;
  /** Secondary line under the title — resolution · size, category, "Offline", … */
  subtitle?: string;
  /** Bottom-right pill. Duration for VOD; ignored when `live` is set. */
  badge?: string;
  /** Renders the pulsing red LIVE badge instead of `badge`. */
  live?: boolean;
  /** Greyscale + dimmed treatment (offline channels). */
  dimmed?: boolean;
  /** Fired in addition to navigation — handy for analytics / parent state. */
  onClick?: () => void;
  /**
   * Admin-only quick delete: when provided, a trash icon overlay appears
   * (hover-revealed on desktop, always visible on touch) that deletes the
   * item without navigating into it first. Omit entirely for read-only
   * browse contexts (Home rows, Live TV grid) — it's opt-in per usage.
   */
  onDelete?: () => void;
  /** Shows a spinner over the delete button while the request is in flight. */
  deleting?: boolean;
}

/**
 * A single poster tile. Used by the Netflix-style rows on HomePage, the
 * LiveTvPage channel grid and the LibraryPage results grid, so the browse
 * experience is one consistent object everywhere.
 */
export default function PosterCard({
  to, title, imageUrl, subtitle, badge, live = false, dimmed = false, onClick, onDelete, deleting = false,
}: PosterCardProps) {
  const [broken, setBroken] = useState(false);
  const hasImage = !!imageUrl && !broken;

  return (
    <Link
      to={to}
      onClick={onClick}
      title={title}
      className={`group block focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sv-accent)] rounded-xl ${dimmed ? "opacity-55 hover:opacity-90" : ""} transition-opacity`}
    >
      <div
        className={`relative aspect-video w-full overflow-hidden rounded-xl border border-[var(--sv-border)] bg-[var(--sv-surface)] transition-transform duration-200 ease-out group-hover:scale-[1.045] group-hover:border-[var(--sv-border-strong)] group-hover:z-10 ${dimmed ? "grayscale group-hover:grayscale-0" : ""}`}
      >
        {hasImage ? (
          <img
            src={imageUrl}
            alt={title}
            loading="lazy"
            onError={() => setBroken(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          <div
            className="flex h-full w-full items-center justify-center"
            style={{ background: "linear-gradient(135deg, var(--sv-surface-2), var(--sv-surface))" }}
          >
            <Film size={22} className="text-white/30" />
          </div>
        )}

        {/* Hover scrim + play affordance */}
        <div className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          <span className="flex h-11 w-11 items-center justify-center rounded-full border border-white/30 bg-white/20 backdrop-blur-sm">
            <Play size={15} className="ml-0.5 text-white" fill="white" />
          </span>
        </div>

        {/* Admin quick-delete — stops the click from also triggering the Link */}
        {onDelete && (
          <button
            type="button"
            title="Delete video"
            aria-label="Delete video"
            disabled={deleting}
            onClick={e => { e.preventDefault(); e.stopPropagation(); onDelete(); }}
            className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-full border border-white/20 bg-black/70 text-white/70 opacity-100 backdrop-blur-sm transition-colors hover:border-red-500/50 hover:bg-red-600/80 hover:text-white disabled:opacity-70 sm:opacity-0 sm:group-hover:opacity-100"
          >
            {deleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
          </button>
        )}

        {/* Live badge — a pulsing dot plus a solid halo ping */}
        {live ? (
          <span className="absolute left-2 top-2 flex items-center gap-1.5 rounded-md bg-black/70 px-1.5 py-0.5 backdrop-blur-sm">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--sv-live-red)] opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--sv-live-red)]" />
            </span>
            <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-[var(--sv-live-red)]">Live</span>
          </span>
        ) : badge ? (
          <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-white backdrop-blur-sm">
            {badge}
          </span>
        ) : null}
      </div>

      <p className="mt-2 line-clamp-2 text-sm font-medium leading-snug text-[var(--sv-text)]">{title}</p>
      {subtitle && (
        <p className="mt-0.5 truncate font-mono text-[11px] text-[var(--sv-text-dim)]">{subtitle}</p>
      )}
    </Link>
  );
}
