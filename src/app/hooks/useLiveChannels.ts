import { useCallback, useEffect, useRef, useState } from "react";
import { liveApi, liveHlsUrlFor } from "../../lib/api";
import type { ApiLiveChannel } from "../../lib/api";
import { getSocket } from "../../lib/socket";
import type { LiveEndedEvent, LiveErrorEvent, LiveStartedEvent } from "../../lib/socket";

/**
 * Public channel lineup, kept current from the `live:started` / `live:ended` /
 * `live:error` socket broadcasts instead of polling.
 *
 * The socket payload's `channel` is the raw Mongo document (no `hlsUrl`, and
 * `posterPath` rather than `posterUrl`), so we only trust `channelId` from it
 * and derive the playlist URL locally. A `live:started` for a channel we have
 * never seen (created after this page loaded) triggers one refetch.
 */
export function useLiveChannels() {
  const [channels, setChannels] = useState<ApiLiveChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const channelsRef = useRef<ApiLiveChannel[]>([]);

  useEffect(() => { channelsRef.current = channels; }, [channels]);

  const refresh = useCallback(async () => {
    try {
      const list = await liveApi.public();
      setChannels(list);
      setError(null);
    } catch (e: any) {
      setError(e?.message || "Could not load live channels.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const socket = getSocket();

    const onStarted = (e: LiveStartedEvent) => {
      if (!channelsRef.current.some(c => c._id === e.channelId)) { void refresh(); return; }
      setChannels(prev => prev.map(c => c._id === e.channelId
        ? { ...c, status: "live", hlsUrl: liveHlsUrlFor(e.channelId), liveStartedAt: e.ts }
        : c));
    };
    const onEnded = (e: LiveEndedEvent) => {
      setChannels(prev => prev.map(c => c._id === e.channelId
        ? { ...c, status: "offline", hlsUrl: "", liveStartedAt: null }
        : c));
    };
    // A broadcast failure is an operational state, not a viewing state: the
    // lineup shows the channel as plain offline, matching what
    // `GET /live/channels/public` reports for an errored channel.
    const onError = (e: LiveErrorEvent) => {
      setChannels(prev => prev.map(c => c._id === e.channelId
        ? { ...c, status: "offline", hlsUrl: "", liveStartedAt: null }
        : c));
    };

    socket.on("live:started", onStarted);
    socket.on("live:ended", onEnded);
    socket.on("live:error", onError);
    return () => {
      socket.off("live:started", onStarted);
      socket.off("live:ended", onEnded);
      socket.off("live:error", onError);
    };
  }, [refresh]);

  return { channels, loading, error, refresh };
}

export default useLiveChannels;
