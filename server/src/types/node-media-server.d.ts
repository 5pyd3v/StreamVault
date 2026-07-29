/**
 * Minimal ambient types for node-media-server v2.7.4 (the package ships no declarations).
 * Only the surface actually used by src/services/liveMediaServer.ts is declared.
 */
declare module 'node-media-server' {
  interface NmsRtmpConfig {
    port?: number;
    chunk_size?: number;
    gop_cache?: boolean;
    ping?: number;
    ping_timeout?: number;
  }

  interface NmsConfig {
    logType?: number;
    rtmp?: NmsRtmpConfig;
    /** Deliberately unused: HLS is served by the existing Express static /uploads route. */
    http?: Record<string, unknown>;
    /** Deliberately unused: transcoding is handled by our own ffmpeg spawn. */
    trans?: Record<string, unknown>;
    [key: string]: unknown;
  }

  interface NmsSession {
    id: string;
    reject(): void;
    stop(): void;
    [key: string]: any;
  }

  type NmsEvent =
    | 'preConnect'
    | 'postConnect'
    | 'doneConnect'
    | 'prePublish'
    | 'postPublish'
    | 'donePublish'
    | 'prePlay'
    | 'postPlay'
    | 'donePlay';

  type NmsListener = (id: string, streamPath: string, args: Record<string, string>) => void;

  class NodeMediaServer {
    constructor(config: NmsConfig);
    run(): void;
    stop(): void;
    on(event: NmsEvent, listener: NmsListener): void;
    getSession(id: string): NmsSession | undefined;
  }

  export = NodeMediaServer;
}
