import { useState } from "react";
import { Link } from "react-router";
import { motion } from "motion/react";
import { Info, Play } from "lucide-react";

export interface HeroBannerProps {
  title: string;
  description?: string;
  /** Large backdrop image (a video thumbnail or a channel poster). */
  backdropUrl?: string;
  /** Small mono chips above the title — resolution, category, view count, … */
  meta?: string[];
  /** Renders the pulsing LIVE pill and switches the CTA copy to "Watch Live". */
  live?: boolean;
  primary: { label: string; to: string };
  secondary?: { label: string; to: string };
}

/**
 * Full-width cinematic hero used at the top of HomePage: backdrop image,
 * left-to-bottom gradient scrims for text legibility, and the play / more-info
 * CTAs. Shrinks to a fixed 16:10 banner below `md`.
 */
export default function HeroBanner({
  title, description, backdropUrl, meta = [], live = false, primary, secondary,
}: HeroBannerProps) {
  const [broken, setBroken] = useState(false);
  const hasImage = !!backdropUrl && !broken;

  return (
    <motion.section
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      /* `min-h` guards the phone case: a 16/10 box at ~390px wide is only ~215px
         tall, which the title + meta + description + CTAs would overflow. */
      className="relative aspect-[16/10] min-h-[340px] w-full overflow-hidden rounded-2xl border border-[var(--sv-border)] bg-[var(--sv-surface)] sm:aspect-[16/7] sm:min-h-[300px] md:aspect-auto md:h-[58vh] md:min-h-[400px]"
    >
      {hasImage ? (
        <img
          src={backdropUrl}
          alt=""
          onError={() => setBroken(true)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <div
          className="absolute inset-0"
          style={{ background: "linear-gradient(135deg, var(--sv-surface-2) 0%, var(--sv-bg) 60%, #2a0609 100%)" }}
        />
      )}

      {/* Scrims: bottom for the copy, left for the CTA column */}
      <div className="absolute inset-0 bg-gradient-to-t from-[var(--sv-bg)] via-[var(--sv-bg)]/45 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-r from-[var(--sv-bg)]/85 via-[var(--sv-bg)]/25 to-transparent" />

      <div className="relative flex h-full flex-col justify-end gap-2.5 p-4 sm:gap-3 sm:p-7 md:max-w-2xl md:gap-4 md:p-10">
        {live && (
          <span className="flex w-fit items-center gap-1.5 rounded-md border border-[var(--sv-live-red)]/30 bg-[var(--sv-live-red)]/12 px-2 py-0.5">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--sv-live-red)] opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--sv-live-red)]" />
            </span>
            <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-[var(--sv-live-red)]">Live now</span>
          </span>
        )}

        <h1
          className="line-clamp-2 break-words text-xl font-bold leading-tight text-[var(--sv-text)] sm:text-3xl md:line-clamp-3 md:text-5xl"
          style={{ fontFamily: "'Outfit', sans-serif" }}
        >
          {title}
        </h1>

        {meta.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[11px] text-[var(--sv-text-muted)]">
            {meta.map((m, i) => (
              <span key={m} className="flex items-center gap-2.5">
                {i > 0 && <span className="text-[var(--sv-text-dim)]">·</span>}
                {m}
              </span>
            ))}
          </div>
        )}

        {description && (
          <p className="line-clamp-2 max-w-xl text-[13px] leading-relaxed text-[var(--sv-text-muted)] sm:text-sm md:line-clamp-3 md:text-base">
            {description}
          </p>
        )}

        {/* CTAs stay ≥44px tall so they remain a comfortable thumb target */}
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Link
            to={primary.to}
            className="flex min-h-[44px] items-center gap-2 rounded-xl bg-[var(--sv-accent)] px-4 text-sm font-semibold text-white transition-colors hover:bg-[var(--sv-accent-hover)] active:scale-[0.98] sm:px-5"
          >
            <Play size={15} fill="white" className="flex-shrink-0" />
            <span className="truncate">{primary.label}</span>
          </Link>
          {secondary && (
            <Link
              to={secondary.to}
              className="flex min-h-[44px] items-center gap-2 rounded-xl border border-[var(--sv-border-strong)] bg-white/10 px-4 text-sm font-semibold text-[var(--sv-text)] backdrop-blur-sm transition-colors hover:bg-white/15 sm:px-5"
            >
              <Info size={15} className="flex-shrink-0" />
              <span className="truncate">{secondary.label}</span>
            </Link>
          )}
        </div>
      </div>
    </motion.section>
  );
}
