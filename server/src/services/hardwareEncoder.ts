import { spawn, ChildProcess } from 'child_process';

// ── Shared hardware-encoder detection + spawn utilities ────────────────────────
//
// Used by BOTH the VOD pipeline (encoder.ts) and the live pipeline
// (liveEncoder.ts) so the two don't each hand-roll their own copy of "which
// GPU encoder is available" / "how do I build codec args for it" / "how do I
// detect a silently-hung ffmpeg process." Priority order, exactly as
// requested: NVIDIA (h264_nvenc) -> Intel Quick Sync (h264_qsv) -> AMD
// (h264_amf) -> Apple Silicon (h264_videotoolbox) -> software (libx264).

export type EncoderBackend = 'nvenc' | 'qsv' | 'amf' | 'videotoolbox' | 'software';

const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';

const HW_ENCODER_NAMES: Record<Exclude<EncoderBackend, 'software'>, string> = {
  nvenc: 'h264_nvenc',
  qsv: 'h264_qsv',
  amf: 'h264_amf',
  videotoolbox: 'h264_videotoolbox',
};

let cachedEncoderCaps: Set<string> | null = null;

/** Probes the ffmpeg *binary* (not the runtime GPU) once, cached for the process lifetime. */
export async function probeAvailableEncoders(): Promise<Set<string>> {
  if (cachedEncoderCaps) return cachedEncoderCaps;
  return new Promise(resolve => {
    let out = '';
    const proc = spawn(FFMPEG_BIN, ['-hide_banner', '-encoders'], { windowsHide: true });
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    proc.on('close', () => {
      const caps = new Set<string>();
      for (const enc of Object.values(HW_ENCODER_NAMES)) if (out.includes(enc)) caps.add(enc);
      cachedEncoderCaps = caps;
      resolve(caps);
    });
    proc.on('error', () => { cachedEncoderCaps = new Set(); resolve(cachedEncoderCaps); });
  });
}

/**
 * Resolves which backend to use: an explicit `ENCODER_HWACCEL` override (used
 * by both VOD and live), or an auto-probe following the priority order above.
 */
export async function resolveEncoderBackend(): Promise<EncoderBackend> {
  const configured = (process.env.ENCODER_HWACCEL || 'auto').toLowerCase();
  if (configured === 'software' || configured === 'none') return 'software';
  if (configured === 'nvenc' || configured === 'qsv' || configured === 'amf' || configured === 'videotoolbox') {
    return configured;
  }
  const caps = await probeAvailableEncoders();
  if (caps.has(HW_ENCODER_NAMES.nvenc)) return 'nvenc';
  if (caps.has(HW_ENCODER_NAMES.qsv)) return 'qsv';
  if (caps.has(HW_ENCODER_NAMES.amf)) return 'amf';
  if (caps.has(HW_ENCODER_NAMES.videotoolbox)) return 'videotoolbox';
  return 'software';
}

export interface RateControl {
  bitrate: string;
  maxrate?: string;
  bufsize?: string;
}

/**
 * Per-backend `-c:v`/preset/rate-control args for one video stream.
 *
 * `streamIndex` selects the ffmpeg flag form: omitted for a single-output-per-
 * process pipeline (VOD's `-c:v h264_nvenc ...`), or a number for a single
 * multi-variant process addressing stream `v:N` (live's `-c:v:0 libx264 ...`
 * alongside `-var_stream_map`).
 *
 * Deliberately never emits `-hwaccel cuda`/`-hwaccel_output_format cuda` (GPU
 * *decode*) here or anywhere else in this module -- that caused a real,
 * silent production hang (a CUDA-context init stall that never errors and
 * never uses CPU). Hardware *encode* only; decode stays on the CPU.
 */
export function videoCodecArgsFor(backend: EncoderBackend, rate: RateControl, streamIndex?: number): string[] {
  const v = streamIndex === undefined ? 'v' : `v:${streamIndex}`;
  const kbps = parseInt(rate.bitrate, 10) || 0;
  const maxrate = rate.maxrate || `${Math.round(kbps * 1.1)}k`;
  const bufsize = rate.bufsize || `${Math.round(kbps * 2)}k`;

  switch (backend) {
    case 'nvenc':
      return [
        `-c:${v}`, 'h264_nvenc',
        `-preset:${v}`, process.env.ENCODER_NVENC_PRESET || 'p4',
        `-rc:${v}`, 'vbr', `-b:${v}`, rate.bitrate, `-maxrate:${v}`, maxrate, `-bufsize:${v}`, bufsize,
      ];
    case 'qsv':
      return [`-c:${v}`, 'h264_qsv', `-preset:${v}`, 'veryfast', `-b:${v}`, rate.bitrate, `-maxrate:${v}`, maxrate];
    case 'amf':
      return [`-c:${v}`, 'h264_amf', `-quality:${v}`, 'speed', `-b:${v}`, rate.bitrate, `-maxrate:${v}`, maxrate];
    case 'videotoolbox':
      return [`-c:${v}`, 'h264_videotoolbox', `-b:${v}`, rate.bitrate, `-maxrate:${v}`, maxrate];
    default:
      return [
        `-c:${v}`, 'libx264',
        `-preset:${v}`, process.env.ENCODER_SOFTWARE_PRESET || 'superfast',
        `-crf:${v}`, '23', `-b:${v}`, rate.bitrate, `-maxrate:${v}`, maxrate, `-bufsize:${v}`, bufsize,
      ];
  }
}

export interface StallWatchdogOptions {
  /** Prefix for log lines, e.g. "encoder (nvenc)" or "live:42". */
  label: string;
  /** Kill + reject if ffmpeg produces zero stderr output for this long. */
  stallTimeoutMs: number;
  checkIntervalMs?: number;
  onStderrData?: (text: string) => void;
}

export interface StallWatchdogResult {
  proc: ChildProcess;
  /**
   * Resolves with exit info on any normal close (success or failure alike --
   * callers apply their own success heuristic on top, since "success" means
   * different things for a one-shot VOD encode vs. a long-running live
   * process). Rejects ONLY for a detected stall or a spawn failure.
   */
  waitForExit: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderrTail: string; elapsedMs: number }>;
}

/**
 * Spawns ffmpeg and races it against a stall watchdog: if ffmpeg produces
 * zero output (not even startup banner/stream-info lines) for `stallTimeoutMs`,
 * it's treated as hung and killed rather than waited on forever. Any real
 * ffmpeg process (hardware or software) prints substantial stderr within the
 * first second or two, so this is a generous margin, not a tight race.
 *
 * This is the exact mechanism that caught and fixed the production hang
 * caused by `-hwaccel cuda` (see videoCodecArgsFor's comment) -- reused here
 * so the live pipeline gets the same protection once it also gets a hardware
 * path.
 */
export function spawnWithStallWatchdog(
  bin: string,
  args: string[],
  opts: StallWatchdogOptions
): StallWatchdogResult {
  const proc = spawn(bin, args, { windowsHide: true });
  const startedAt = Date.now();
  let lastActivityAt = Date.now();
  let stderrTail = '';
  let settled = false;

  const waitForExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderrTail: string; elapsedMs: number }>(
    (resolve, reject) => {
      const checkIntervalMs = opts.checkIntervalMs || 5000;

      const stallWatchdog = setInterval(() => {
        const silentFor = Date.now() - lastActivityAt;
        if (silentFor > opts.stallTimeoutMs) {
          clearInterval(stallWatchdog);
          console.warn(`[${opts.label}] produced no output for ${Math.round(silentFor / 1000)}s -- treating as hung, killing`);
          try { proc.kill(process.platform === 'win32' ? undefined : 'SIGKILL'); } catch { /* already gone */ }
          settle(reject, new Error(`${opts.label} stalled: no output for ${Math.round(silentFor / 1000)}s (likely a hardware/driver init hang)`));
        }
      }, checkIntervalMs);
      stallWatchdog.unref?.();

      // `resolve`/`reject` can each only usefully fire once -- the watchdog
      // killing the process still triggers a 'close' event afterward, which
      // must not try to settle the promise a second time.
      const settle = (fn: (v: any) => void, value: any) => {
        if (settled) return;
        settled = true;
        clearInterval(stallWatchdog);
        fn(value);
      };

      proc.stderr?.on('data', (chunk: Buffer) => {
        lastActivityAt = Date.now();
        const text = chunk.toString();
        stderrTail = (stderrTail + text).slice(-2000);
        opts.onStderrData?.(text);
      });

      // `-progress pipe:1` (added to every command this module builds args for)
      // writes a machine-readable progress block to stdout via ffmpeg's own
      // avio writer, which flushes immediately -- unlike the human-readable
      // stats line on stderr, which can go quiet for well over a minute at a
      // time on some platforms/builds even while ffmpeg is actively encoding
      // fine (observed in production: a healthy software-encoded live stream
      // got killed as "stalled" after ~35s of stderr silence). Any data here
      // is a reliable liveness signal regardless of whether stderr happens to
      // have anything to say.
      proc.stdout?.on('data', () => {
        lastActivityAt = Date.now();
      });

      proc.on('error', (err: Error) => {
        settle(reject, new Error(`${opts.label} spawn failed: ${err.message}`));
      });

      proc.on('close', (code, signal) => {
        settle(resolve, { code, signal, stderrTail, elapsedMs: Date.now() - startedAt });
      });
    }
  );

  return { proc, waitForExit };
}
