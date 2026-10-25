// Glance indicators for the demo. Both read the live subscription:
// compute_status (heartbeat) and compute_job (who claimed the work).
// Timings match spacetimedb/src/index.ts: HEARTBEAT_STALE is 10s, sweep is 2s,
// and a bulk job (FORECAST / DEBRIS) stays with a silent worker for 60s.
import { useSpacetimeDB, useTable } from 'spacetimedb/react';
import { tables } from './module_bindings/index.ts';
import { useNow } from './live.ts';
import { debrisSourceTag, type DebrisResult } from './globe/debrisTypes.ts';

const HEARTBEAT_STALE_MS = 10_000;

function useWorkers() {
  return useTable(tables.computeStatus);
}
function useJobs() {
  return useTable(tables.computeJob);
}
function useRuns() {
  return useTable(tables.computeRun);
}

type Worker = ReturnType<typeof useWorkers>[0][number];
type Job = ReturnType<typeof useJobs>[0][number];

function ageMs(updatedAt: { toDate(): Date }, now: number): number {
  return now - updatedAt.toDate().getTime();
}

function isStale(w: Worker, now: number): boolean {
  return !w.healthy || ageMs(w.updatedAt, now) > HEARTBEAT_STALE_MS;
}

function deviceName(gpuName: string): string {
  const n = gpuName.trim();
  if (!n || n === 'unknown' || n.toLowerCase().startsWith('cpu')) return 'GX10';
  return n;
}

function jobTime(j: Job): number {
  for (const ts of [j.finishedAt, j.claimedAt, j.createdAt]) {
    if (!ts) continue;
    const t = ts.toDate().getTime();
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

function holder(j: Job, workers: readonly Worker[]): Worker | undefined {
  const hex = j.claimedBy?.toHexString();
  if (!hex) return undefined;
  return workers.find(w => w.worker.toHexString() === hex);
}

function who(w: Worker | undefined, hex: string): string {
  if (!w) return hex ? hex.slice(0, 8) : 'unknown worker';
  if (w.tier === 'cpu') return 'CPU';
  return `GPU ${deviceName(w.gpuName)}`;
}

export function ComputeStatusBanner({ placement }: { placement: 'globe' | 'panel' }) {
  const conn = useSpacetimeDB();
  const now = useNow(1000);
  const [workers] = useWorkers();
  const [jobs] = useJobs();
  const [runs] = useRuns();

  if (!conn.isActive) {
    return (
      <div className={`compute-banner connecting place-${placement}`} role="status">
        <div className="compute-banner-title">compute connecting…</div>
      </div>
    );
  }

  const gpus = workers.filter(w => w.tier === 'gpu' && !isStale(w, now));
  const cpus = workers.filter(w => w.tier === 'cpu' && !isStale(w, now));
  const gpu = [...gpus].sort((a, b) => b.updatedAt.toDate().getTime() - a.updatedAt.toDate().getTime())[0];
  let mode = 'degraded';
  let title = 'DEGRADED: no compute worker';
  if (gpu) {
    mode = 'gpu';
    title = `GPU: ${deviceName(gpu.gpuName)} online`;
  } else if (cpus.length > 0) {
    title = 'DEGRADED: CPU fallback active';
  } else if (workers.some(w => w.tier === 'gpu')) {
    title = 'DEGRADED: GPU offline';
  }

  const claimed = jobs.filter(j => j.status === 'CLAIMED' && j.claimedBy);
  const liveClaims = claimed
    .filter(j => {
      const w = holder(j, workers);
      return !!w && !isStale(w, now);
    })
    .sort((a, b) => jobTime(b) - jobTime(a));
  const staleClaims = claimed.filter(j => !liveClaims.includes(j)).sort((a, b) => jobTime(b) - jobTime(a));
  const done = jobs.filter(j => j.status === 'DONE' && j.claimedBy).sort((a, b) => jobTime(b) - jobTime(a));
  const focus = liveClaims[0] ?? staleClaims[0] ?? done[0];
  const lastRun = [...runs].sort((a, b) => Number(b.id - a.id))[0];
  let sub = 'no job claimed yet';
  if (focus) {
    const w = holder(focus, workers);
    const name = who(w, focus.claimedBy?.toHexString() ?? '');
    const verb = focus.status === 'CLAIMED' ? 'claimed' : 'last';
    const bulkHeld =
      focus.status === 'CLAIMED' && !!w && isStale(w, now) && (focus.kind === 'FORECAST' || focus.kind === 'DEBRIS');
    sub = bulkHeld ? `${verb} ${focus.kind} · ${name} · requeues after 60s` : `${verb} ${focus.kind} · ${name}`;
  } else if (lastRun) {
    // Job rows are not always still in the table. The run records tier and device.
    const tier = lastRun.tier === 'cpu' ? 'CPU' : 'GPU';
    const match = workers.find(w => w.tier === lastRun.tier);
    const name = match ? who(match, '') : lastRun.device;
    sub = `last ${lastRun.kind} · ${name.startsWith(tier) ? name : `${tier} ${name}`}`;
  }

  return (
    <div className={`compute-banner ${mode} place-${placement}`} role="status">
      <div className="compute-banner-title">{title}</div>
      <div className="compute-banner-sub">{sub}</div>
    </div>
  );
}

/** HUD pill for the debris currently on screen. */
export function DebrisSourcePill({ debris }: { debris: DebrisResult | null }) {
  const [rows] = useTable(tables.debrisForecast);
  if (debris) {
    const tag = debrisSourceTag(debris);
    const title = tag.live
      ? `Modeled estimate computed on ${debris.tier === 'cpu' ? 'CPU' : 'GPU'}${debris.device ? ` (${debris.device})` : ''}`
      : 'Placeholder geometry. Not a GX10 or CPU result.';
    return (
      <span className={tag.live ? 'live-pill' : 'mock'} title={title}>
        {tag.text}
      </span>
    );
  }
  if (rows.length > 0) {
    return (
      <span className="live-pill" title="Live debris results are loaded. Select an object to show one.">
        DEBRIS LIVE · {rows.length}
      </span>
    );
  }
  return (
    <span className="mock" title="No debris_forecast row yet. Selecting an object shows placeholder debris.">
      DEBRIS MOCK
    </span>
  );
}
