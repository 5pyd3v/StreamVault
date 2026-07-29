import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { AlertCircle, Loader2, Radio } from "lucide-react";
import { videosApi } from "../../lib/api";
import type { ApiLiveChannel, ApiVideo, AuthUser } from "../../lib/api";
import HeroBanner from "../components/HeroBanner";
import MediaRow from "../components/MediaRow";
import PosterCard from "../components/PosterCard";
import useLiveChannels from "../hooks/useLiveChannels";

const MAX_TAG_ROWS = 6;
const MIN_ITEMS_PER_TAG_ROW = 2;

function fmtDuration(seconds: number): string {
  if (!seconds || !isFinite(seconds)) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function thumbOf(v: ApiVideo): string {
  return v.thumbnailUrl || (v.thumbnailPath ? `/uploads/${v.thumbnailPath}` : "");
}

// Quality/resolution is an operational detail — regular viewers only ever see
// a view count under a title, matching what a real IPTV subscriber cares about.
function videoSubtitle(v: ApiVideo, showQuality: boolean): string {
  const bits = [
    showQuality && v.height ? `${v.height}p` : "",
    v.views ? `${v.views.toLocaleString()} views` : "",
  ].filter(Boolean);
  return bits.join(" · ");
}

/**
 * Netflix-style landing page: a hero for whatever is most worth watching right
 * now (a live channel if one is broadcasting, otherwise the newest video),
 * followed by horizontally scrolling rows.
 *
 * The rows only ever show `published` videos — encoding/failed uploads belong
 * in the Library's filtered views, not in the browse experience.
 */
export default function HomePage({ user }: { user: AuthUser | null } = { user: null }) {
  const isAdmin = user?.role === "admin";
  const [videos, setVideos] = useState<ApiVideo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { channels } = useLiveChannels();

  useEffect(() => {
    let stopped = false;
    videosApi.list({})
      .then(data => {
        if (stopped) return;
        setVideos(data.videos ?? []);
        setError(null);
      })
      .catch((e: any) => { if (!stopped) setError(e?.message || "Could not load the library."); })
      .finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; };
  }, []);

  // `videosApi.list` has no sort parameter, so order newest-first client-side.
  const published = useMemo(
    () => videos
      .filter(v => v.status === "published")
      .slice()
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [videos],
  );

  const liveChannels = useMemo(() => channels.filter(c => c.status === "live"), [channels]);

  // One row per most-populated tag, capped so the page doesn't turn into a wall.
  const tagRows = useMemo(() => {
    const byTag = new Map<string, ApiVideo[]>();
    for (const v of published) {
      for (const raw of v.tags ?? []) {
        const tag = String(raw).trim();
        if (!tag) continue;
        const bucket = byTag.get(tag);
        if (bucket) bucket.push(v);
        else byTag.set(tag, [v]);
      }
    }
    return [...byTag.entries()]
      .filter(([, items]) => items.length >= MIN_ITEMS_PER_TAG_ROW)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, MAX_TAG_ROWS);
  }, [published]);

  const heroChannel: ApiLiveChannel | undefined = liveChannels[0];
  const heroVideo: ApiVideo | undefined = published[0];

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 size={26} className="animate-spin text-[var(--sv-accent)]" />
      </div>
    );
  }

  const nothingToShow = !heroChannel && published.length === 0;

  return (
    <div className="space-y-8 pb-4">
      {heroChannel ? (
        <HeroBanner
          title={heroChannel.name}
          {...(heroChannel.description ? { description: heroChannel.description } : {})}
          {...(heroChannel.posterUrl ? { backdropUrl: heroChannel.posterUrl } : {})}
          meta={[heroChannel.category || "Live channel"]}
          live
          primary={{ label: "Watch Live", to: `/watch/live/${heroChannel.slug}` }}
          secondary={{ label: "All Channels", to: "/live" }}
        />
      ) : heroVideo ? (
        <HeroBanner
          title={heroVideo.title}
          {...(heroVideo.description ? { description: heroVideo.description } : {})}
          {...(thumbOf(heroVideo) ? { backdropUrl: thumbOf(heroVideo) } : {})}
          meta={[
            ...(isAdmin ? [heroVideo.height ? `${heroVideo.height}p` : "HLS"] : []),
            fmtDuration(heroVideo.duration) || "—",
            `${(heroVideo.views ?? 0).toLocaleString()} views`,
          ].filter(Boolean)}
          primary={{ label: "Play", to: `/watch/${heroVideo._id}` }}
          secondary={{ label: "Browse Library", to: "/library" }}
        />
      ) : null}

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          <AlertCircle size={15} />{error}
        </div>
      )}

      {nothingToShow && !error && (
        <div className="rounded-2xl border border-[var(--sv-border)] bg-[var(--sv-surface)] px-6 py-16 text-center">
          <Radio size={26} className="mx-auto mb-3 text-[var(--sv-text-dim)]" />
          <p className="text-sm text-[var(--sv-text-muted)]">Nothing to watch yet.</p>
          {/* No upload CTA here: ingest is admin-only, and this page is the first
              thing a regular viewer sees. Admins reach it from Admin → Upload Center. */}
          <p className="mt-1 font-mono text-xs text-[var(--sv-text-dim)]">
            New titles and live channels will show up here as they are published.
          </p>
        </div>
      )}

      {liveChannels.length > 0 && (
        <MediaRow
          title="Live Now"
          items={liveChannels}
          getKey={c => c._id}
          action={
            <Link to="/live" className="font-mono text-[11px] text-[var(--sv-text-muted)] transition-colors hover:text-[var(--sv-text)]">
              See all →
            </Link>
          }
          renderItem={c => (
            <PosterCard
              to={`/watch/live/${c.slug}`}
              title={c.name}
              {...(c.posterUrl ? { imageUrl: c.posterUrl } : {})}
              {...(c.category ? { subtitle: c.category } : {})}
              live
            />
          )}
        />
      )}

      {published.length > 0 && (
        <MediaRow
          title="Recently Added"
          items={published.slice(0, 20)}
          getKey={v => v._id}
          action={
            <Link to="/library" className="font-mono text-[11px] text-[var(--sv-text-muted)] transition-colors hover:text-[var(--sv-text)]">
              See all →
            </Link>
          }
          renderItem={v => (
            <PosterCard
              to={`/watch/${v._id}`}
              title={v.title}
              {...(thumbOf(v) ? { imageUrl: thumbOf(v) } : {})}
              {...(videoSubtitle(v, isAdmin) ? { subtitle: videoSubtitle(v, isAdmin) } : {})}
              {...(fmtDuration(v.duration) ? { badge: fmtDuration(v.duration) } : {})}
            />
          )}
        />
      )}

      {tagRows.map(([tag, items]) => (
        <MediaRow
          key={tag}
          title={tag}
          items={items}
          getKey={v => v._id}
          renderItem={v => (
            <PosterCard
              to={`/watch/${v._id}`}
              title={v.title}
              {...(thumbOf(v) ? { imageUrl: thumbOf(v) } : {})}
              {...(videoSubtitle(v, isAdmin) ? { subtitle: videoSubtitle(v, isAdmin) } : {})}
              {...(fmtDuration(v.duration) ? { badge: fmtDuration(v.duration) } : {})}
            />
          )}
        />
      ))}
    </div>
  );
}
