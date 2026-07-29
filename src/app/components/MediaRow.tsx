import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import useEmblaCarousel from "embla-carousel-react";
import { ChevronLeft, ChevronRight } from "lucide-react";

export interface MediaRowProps<T> {
  title: string;
  items: T[];
  getKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => ReactNode;
  /** Optional right-aligned control next to the heading (e.g. a "See all" link). */
  action?: ReactNode;
}

/**
 * Horizontally scrolling row of tiles.
 *
 * Touch/trackpad drag comes free from embla; the arrow buttons are desktop-only
 * (`hidden md:flex`) since touch devices scroll natively.
 */
export default function MediaRow<T>({ title, items, getKey, renderItem, action }: MediaRowProps<T>) {
  const [emblaRef, emblaApi] = useEmblaCarousel({
    align: "start",
    dragFree: true,
    containScroll: "trimSnaps",
    loop: false,
  });
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(false);

  const sync = useCallback(() => {
    if (!emblaApi) return;
    setCanPrev(emblaApi.canScrollPrev());
    setCanNext(emblaApi.canScrollNext());
  }, [emblaApi]);

  useEffect(() => {
    if (!emblaApi) return;
    sync();
    emblaApi.on("select", sync).on("reInit", sync);
    return () => {
      emblaApi.off("select", sync).off("reInit", sync);
    };
  }, [emblaApi, sync]);

  if (items.length === 0) return null;

  const arrowBase =
    "hidden md:flex h-8 w-8 items-center justify-center rounded-full border border-[var(--sv-border)] bg-[var(--sv-surface)]/80 text-[var(--sv-text-muted)] transition-colors hover:text-[var(--sv-text)] hover:border-[var(--sv-border-strong)] disabled:opacity-25 disabled:hover:text-[var(--sv-text-muted)]";

  return (
    <section className="space-y-3">
      <div className="flex min-w-0 items-center gap-3">
        <h2 className="truncate text-base font-semibold text-[var(--sv-text)] sm:text-lg" style={{ fontFamily: "'Outfit', sans-serif" }}>
          {title}
        </h2>
        <div className="ml-auto flex flex-shrink-0 items-center gap-2">
          {action}
          <button type="button" aria-label={`Scroll ${title} left`} className={arrowBase} disabled={!canPrev} onClick={() => emblaApi?.scrollPrev()}>
            <ChevronLeft size={16} />
          </button>
          <button type="button" aria-label={`Scroll ${title} right`} className={arrowBase} disabled={!canNext} onClick={() => emblaApi?.scrollNext()}>
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      <div className="overflow-hidden" ref={emblaRef}>
        {/* Negative margin + per-slide padding is embla's recommended gap technique */}
        <div className="flex -ml-3 touch-pan-y">
          {items.map((item, i) => (
            <div
              key={getKey(item, i)}
              className="min-w-0 shrink-0 grow-0 basis-[62%] pl-3 sm:basis-[40%] md:basis-[30%] lg:basis-[22%] xl:basis-[17%]"
            >
              {renderItem(item, i)}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
