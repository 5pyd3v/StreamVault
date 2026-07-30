import os from 'os';

// ── Resource-aware scheduling ────────────────────────────────────────────────
//
// Enforces "live streaming always wins." This is NOT a new architecture: it
// takes over the exact FIFO-queue + counter pattern that used to live in
// encoder.ts (`activeJobs`/`jobQueue`, gated by a fixed `MAX_CONCURRENT_JOBS`)
// and makes the ceiling it queues against dynamic -- aware of whether a live
// broadcast is active, current CPU/memory load, and hardware-encoder
// contention -- instead of replacing it with something new. The live path
// itself (RTMP ingest, live ffmpeg, live HLS, the recording tee) never calls
// into any of this and is never gated by it, so a new broadcast can always
// start immediately regardless of VOD load.

const MAX_CONCURRENT_JOBS_IDLE = Math.max(1, Number(process.env.MAX_CONCURRENT_JOBS) || 4);
const MAX_CONCURRENT_JOBS_WHILE_LIVE = Math.max(1, Number(process.env.MAX_CONCURRENT_JOBS_WHILE_LIVE) || 1);
const MAX_CPU_PERCENT_FOR_VOD = Number(process.env.MAX_CPU_PERCENT_FOR_VOD) || 70;
const MAX_MEM_PERCENT_FOR_VOD = Number(process.env.MAX_MEM_PERCENT_FOR_VOD) || 80;
// Most consumer GPUs cap concurrent NVENC/QSV/AMF sessions at the driver
// level regardless of raw utilization -- there's no portable, dependency-free
// way to read true GPU utilization % without shelling out to vendor tools
// (nvidia-smi etc.), so this session-count ceiling is used as the real,
// implementable proxy for "is the hardware encoder already busy."
const MAX_CONCURRENT_HW_ENCODES = Math.max(1, Number(process.env.MAX_CONCURRENT_HW_ENCODES) || 2);

const CPU_SAMPLE_INTERVAL_MS = 2000;

// ── CPU / memory sampling ───────────────────────────────────────────────────
// os.loadavg() is POSIX-only (always [0,0,0] on Windows), so CPU% is derived
// from a rolling diff of os.cpus() tick counters instead -- cheap, synchronous,
// cross-platform, no subprocess/polling tool required.

function readCpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

let prevCpuTimes = readCpuTimes();
let currentCpuPercent = 0;

const cpuSampler = setInterval(() => {
  const cur = readCpuTimes();
  const idleDiff = cur.idle - prevCpuTimes.idle;
  const totalDiff = cur.total - prevCpuTimes.total;
  if (totalDiff > 0) {
    currentCpuPercent = Math.max(0, Math.min(100, 100 * (1 - idleDiff / totalDiff)));
  }
  prevCpuTimes = cur;
  tryAdmitNext();
}, CPU_SAMPLE_INTERVAL_MS);
cpuSampler.unref?.();

export function getCpuPercent(): number {
  return Math.round(currentCpuPercent);
}

export function getMemPercent(): number {
  const total = os.totalmem();
  const free = os.freemem();
  return Math.round(((total - free) / total) * 100);
}

function resourcesHaveHeadroom(): boolean {
  return currentCpuPercent < MAX_CPU_PERCENT_FOR_VOD && getMemPercent() < MAX_MEM_PERCENT_FOR_VOD;
}

// ── Live-session registry ───────────────────────────────────────────────────
// Fed by liveEncoder.ts around each broadcast's transcode lifecycle. Used to
// pick the VOD concurrency ceiling and exposed for the admin metrics endpoint.

const liveSessions = new Set<string>();

export function registerLiveSession(channelId: string): void {
  liveSessions.add(channelId);
}

export function unregisterLiveSession(channelId: string): void {
  liveSessions.delete(channelId);
  tryAdmitNext(); // ceiling may have just gone up -- don't wait for the next CPU tick
}

export function isLiveActive(): boolean {
  return liveSessions.size > 0;
}

export function activeLiveCount(): number {
  return liveSessions.size;
}

// ── Hardware-encode session slots ───────────────────────────────────────────
// Live sessions always reserve a slot immediately, even past the ceiling if
// necessary -- live is never denied hardware, only VOD is throttled against
// this ceiling.

let activeHwEncodes = 0;

export function reserveHardwareSlot(kind: 'live' | 'vod'): boolean {
  if (kind === 'live') {
    activeHwEncodes++;
    return true;
  }
  if (activeHwEncodes < MAX_CONCURRENT_HW_ENCODES) {
    activeHwEncodes++;
    return true;
  }
  return false;
}

export function releaseHardwareSlot(): void {
  activeHwEncodes = Math.max(0, activeHwEncodes - 1);
  tryAdmitNext();
}

export function hardwareSlotState(): { active: number; ceiling: number } {
  return { active: activeHwEncodes, ceiling: MAX_CONCURRENT_HW_ENCODES };
}

// ── VOD admission queue ──────────────────────────────────────────────────────
// Same FIFO-array + counter shape encoder.ts used to own directly; the only
// behavioral change is that the ceiling it drains against is now dynamic and
// admission also requires CPU/memory headroom.

interface QueuedVodJob {
  resolve: (result: { useHardware: boolean }) => void;
}

const vodQueue: QueuedVodJob[] = [];
let activeVodJobs = 0;

function currentVodCeiling(): number {
  return isLiveActive() ? MAX_CONCURRENT_JOBS_WHILE_LIVE : MAX_CONCURRENT_JOBS_IDLE;
}

function tryAdmitNext(): void {
  while (vodQueue.length > 0 && activeVodJobs < currentVodCeiling() && resourcesHaveHeadroom()) {
    const job = vodQueue.shift()!;
    activeVodJobs++;
    const useHardware = reserveHardwareSlot('vod');
    job.resolve({ useHardware });
  }
}

/**
 * Waits for a VOD concurrency slot under the current (live-aware) ceiling and
 * CPU/memory headroom, then reports whether a hardware-encode slot was also
 * granted (the resolved backend from hardwareEncoder.ts still decides WHICH
 * vendor is available at all; this decides whether THIS job gets to use it
 * right now, vs. queueing behind an active live broadcast or running on
 * software instead of contending for the GPU encoder).
 */
export function acquireVodSlot(): Promise<{ useHardware: boolean }> {
  return new Promise(resolve => {
    vodQueue.push({ resolve });
    tryAdmitNext();
  });
}

/**
 * `stillHoldingHardwareSlot` should be true only if the job never released its
 * hardware-slot reservation early (e.g. via a mid-job fallback to software).
 */
export function releaseVodSlot(stillHoldingHardwareSlot: boolean): void {
  activeVodJobs = Math.max(0, activeVodJobs - 1);
  if (stillHoldingHardwareSlot) {
    releaseHardwareSlot(); // also pumps the queue
  } else {
    tryAdmitNext();
  }
}

export function schedulerStatus() {
  return {
    cpuPercent: getCpuPercent(),
    memPercent: getMemPercent(),
    liveActive: isLiveActive(),
    activeLiveSessions: activeLiveCount(),
    vod: {
      active: activeVodJobs,
      queued: vodQueue.length,
      ceiling: currentVodCeiling(),
    },
    hardwareEncodeSlots: hardwareSlotState(),
  };
}
