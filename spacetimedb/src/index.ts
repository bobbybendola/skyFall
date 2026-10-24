// SKYFALL SpacetimeDB module: the core of the system (see docs/ARCHITECTURE.md).
//
// Everything that coordinates the project lives here: the sighting rules,
// reporter trust, the GPU job queue with leases and failover, corridor
// history, the replay clock that emits simulated sightings, worker health,
// and the public-feed fetchers (NOAA SWPC, CelesTrak) as scheduled
// procedures. Workers and screens are thin clients around it.
//
// TS uses camelCase; SpacetimeDB's default case policy stores snake_case
// (submitSighting -> submit_sighting, objectId -> object_id).
import { schema, table, t, SenderError, ScheduleAt } from 'spacetimedb/server';
import { Identity, Timestamp, TimeDuration } from 'spacetimedb';

// ============================================================ config

const SEC = 1_000_000n; // microseconds
const SWEEP_EVERY = 2n * SEC;
const REPLAY_TICK_EVERY = 1n * SEC;
const NOAA_EVERY = 15n * 60n * SEC;
const CELESTRAK_EVERY = 2n * 3600n * SEC;
const CELESTRAK_MIN_GAP = 2n * 3600n * SEC; // CelesTrak 403s repeat downloads inside one update
const LEASE = 10n * SEC; // a claimed job not finished by then goes back to the queue
const HEARTBEAT_STALE = 10n * SEC;
const MAX_ATTEMPTS = 3;
const MIN_SUBMIT_GAP = 2n * SEC; // per reporter, LIVE/DEMO only
const HOLD_BELOW_P = 0.2; // compute's inlier probability below this -> HELD

const VERDICTS = ['PENDING', 'ACCEPTED', 'HELD', 'REJECTED'];
const SOURCES = ['TIP', 'REPLAY', 'CANDIDATE'];
const TIERS = ['gpu', 'cpu'];

// ============================================================ tables

const reentryObject = table(
  { public: true },
  {
    id: t.string().primaryKey(), // TIP-<norad> | CT-<norad> | REPLAY-<name>
    name: t.string(),
    noradId: t.u32(),
    source: t.string(), // TIP | REPLAY | CANDIDATE
    windowStart: t.timestamp().optional(), // absent for CANDIDATE
    windowEnd: t.timestamp().optional(),
    elements: t.string(), // JSON (OMM/GP fields, or the replay's model)
    status: t.string(), // PREDICTED | DECAYED | REPLAY | CANDIDATE
    updatedAt: t.timestamp(),
  }
);

const sighting = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    objectId: t.string().index('btree'),
    lat: t.f64(),
    lon: t.f64(),
    observedAt: t.timestamp(),
    bearingDeg: t.f64().optional(),
    clipRef: t.string().optional(),
    reporter: t.identity().index('btree'),
    reporterKey: t.string(), // identity hex, or sim-<n> for simulated reporters
    mode: t.string(), // LIVE | DEMO (teammate taps) | SIM (emitted by the replay)
    verdict: t.string(), // PENDING | ACCEPTED | HELD | REJECTED
    reason: t.string(),
    pInlier: t.f64().optional(), // from the last corridor job that used it
  }
);

const reporterStats = table(
  { public: true },
  {
    reporterKey: t.string().primaryKey(),
    submitted: t.u32(),
    accepted: t.u32(),
    rejected: t.u32(),
    agreed: t.u32(), // compute said consistent with the crowd
    disagreed: t.u32(),
    lastSubmitAt: t.timestamp(),
  }
);

// The queue between the crowd and the GPU. Kinds: CLASSIFY (has a clip) and
// UPDATE (re-run the corridor for an object). At most one QUEUED UPDATE per
// object: new sightings coalesce into it.
const computeJob = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    kind: t.string(),
    objectId: t.string().index('btree'),
    sightingId: t.u64().optional(),
    status: t.string(), // QUEUED | CLAIMED | DONE | FAILED
    claimedBy: t.identity().optional(),
    claimedAt: t.timestamp().optional(),
    attempts: t.u32(),
    createdAt: t.timestamp(),
    finishedAt: t.timestamp().optional(),
    error: t.string(),
  }
);

const corridor = table(
  { public: true },
  {
    objectId: t.string().primaryKey(),
    version: t.u32(),
    bands: t.string(), // JSON: [{level, polygon: [[lon, lat], ...]}]
    areaKm2_90: t.f64(),
    nSamples: t.u32(),
    nSightingsUsed: t.u32(),
    computedAt: t.timestamp(),
    computedBy: t.identity(),
  }
);

const corridorHistory = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    objectId: t.string().index('btree'),
    version: t.u32(),
    bands: t.string(),
    areaKm2_90: t.f64(),
    nSightingsUsed: t.u32(),
    computedAt: t.timestamp(),
    jobMs: t.u32(),
    tier: t.string(),
  }
);

const computeStatus = table(
  { public: true },
  {
    worker: t.identity().primaryKey(),
    tier: t.string(), // gpu | cpu
    gpuName: t.string(),
    healthy: t.bool(),
    variantsRunTotal: t.u64(), // maintained by the module from finished jobs
    lastJobMs: t.u32(),
    sightingsClassified: t.u32(),
    updatedAt: t.timestamp(), // heartbeat
  }
);

const feedStatus = table(
  { public: true },
  {
    feed: t.string().primaryKey(),
    lastAttemptAt: t.timestamp().optional(),
    lastOkAt: t.timestamp().optional(),
    lastError: t.string(),
    rowsIngested: t.u32(),
  }
);

const spaceWeather = table(
  { public: true },
  {
    key: t.string().primaryKey(), // 'current'
    kp: t.f64().optional(),
    kpTime: t.string(),
    f107: t.f64().optional(),
    f107Time: t.string(),
    updatedAt: t.timestamp(),
  }
);

// Single row, id = 0. Clock = tOffset + (now - startedAt) while running.
const replayState = table(
  { public: true },
  {
    id: t.u32().primaryKey(),
    running: t.bool(),
    tOffset: t.f64(),
    eventId: t.string(),
    startedAt: t.timestamp(),
    speed: t.f64(), // replay seconds per wall second
  }
);

// Private: the scripted simulated sightings, including which ones are
// deliberate outliers (ground truth for scoring; never shown to clients).
const replaySighting = table(
  { public: false },
  {
    id: t.u64().primaryKey().autoInc(),
    eventId: t.string().index('btree'),
    tOffsetS: t.f64(),
    lat: t.f64(),
    lon: t.f64(),
    bearingDeg: t.f64().optional(),
    simReporter: t.string(),
    isOutlier: t.bool(),
    emitted: t.bool(),
  }
);

const workerRegistry = table(
  { public: false },
  {
    identity: t.identity().primaryKey(),
    role: t.string(),
  }
);

// Schedule tables (private). One scheduled function per table.
const sweepTick = table(
  { public: false },
  { scheduledId: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt() }
);
const replayTick = table(
  { public: false },
  { scheduledId: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt() }
);
const noaaTick = table(
  { public: false },
  { scheduledId: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt() }
);
const celestrakTick = table(
  { public: false },
  { scheduledId: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt() }
);

const spacetimedb = schema({
  reentryObject,
  sighting,
  reporterStats,
  computeJob,
  corridor,
  corridorHistory,
  computeStatus,
  feedStatus,
  spaceWeather,
  replayState,
  replaySighting,
  workerRegistry,
  sweepTick,
  replayTick,
  noaaTick,
  celestrakTick,
});
export default spacetimedb;

// ============================================================ helpers
// Loosely typed so they accept any reducer/transaction context.
type AnyCtx = { db: any; sender: Identity; timestamp: Timestamp; databaseIdentity: Identity };

const micros = (ts: Timestamp): bigint => ts.microsSinceUnixEpoch;
const olderThan = (ctx: AnyCtx, ts: Timestamp | undefined, age: bigint): boolean =>
  ts === undefined || micros(ctx.timestamp) - micros(ts) > age;

function roleOf(ctx: AnyCtx): string | null {
  const row = ctx.db.workerRegistry.identity.find(ctx.sender);
  return row ? row.role : null;
}

function requireRole(ctx: AnyCtx, ...allowed: string[]): void {
  const role = roleOf(ctx);
  if (role === null || !allowed.includes(role)) {
    throw new SenderError(`caller is not authorized (needs ${allowed.join(' or ')})`);
  }
}

function requireScheduler(ctx: AnyCtx): void {
  if (!ctx.sender.isEqual(ctx.databaseIdentity)) throw new SenderError('scheduler only');
}

function bumpStats(ctx: AnyCtx, reporterKey: string, patch: Partial<Record<string, number>>): void {
  const prev = ctx.db.reporterStats.reporterKey.find(reporterKey);
  const base = prev ?? {
    reporterKey,
    submitted: 0,
    accepted: 0,
    rejected: 0,
    agreed: 0,
    disagreed: 0,
    lastSubmitAt: ctx.timestamp,
  };
  const next = { ...base };
  for (const [k, v] of Object.entries(patch)) (next as any)[k] = (base as any)[k] + (v ?? 0);
  if (patch.submitted) next.lastSubmitAt = ctx.timestamp;
  if (prev) ctx.db.reporterStats.reporterKey.update(next);
  else ctx.db.reporterStats.insert(next);
}

// Coalescing: one QUEUED UPDATE per object is enough, because the worker
// reads all current sightings when it runs the job.
function enqueueUpdate(ctx: AnyCtx, objectId: string): void {
  for (const j of ctx.db.computeJob.objectId.filter(objectId)) {
    if (j.kind === 'UPDATE' && j.status === 'QUEUED') return;
  }
  ctx.db.computeJob.insert({
    id: 0n,
    kind: 'UPDATE',
    objectId,
    sightingId: undefined,
    status: 'QUEUED',
    claimedBy: undefined,
    claimedAt: undefined,
    attempts: 0,
    createdAt: ctx.timestamp,
    finishedAt: undefined,
    error: '',
  });
}

function claimedJob(ctx: AnyCtx, jobId: bigint, kind: string) {
  const job = ctx.db.computeJob.id.find(jobId);
  if (!job) throw new SenderError('no such job');
  if (job.kind !== kind) throw new SenderError(`job is ${job.kind}, not ${kind}`);
  if (job.status !== 'CLAIMED' || !job.claimedBy || !job.claimedBy.isEqual(ctx.sender)) {
    throw new SenderError('job is not claimed by you (lease may have expired)');
  }
  return job;
}

function finishJob(ctx: AnyCtx, job: any): void {
  ctx.db.computeJob.id.update({ ...job, status: 'DONE', finishedAt: ctx.timestamp, error: '' });
}

function insertSighting(
  ctx: AnyCtx,
  a: {
    objectId: string;
    lat: number;
    lon: number;
    observedAt: Timestamp;
    bearingDeg?: number;
    clipRef?: string;
    mode: string;
    reporterKey: string;
  }
): void {
  const row = ctx.db.sighting.insert({
    id: 0n,
    objectId: a.objectId,
    lat: a.lat,
    lon: a.lon,
    observedAt: a.observedAt,
    bearingDeg: a.bearingDeg,
    clipRef: a.clipRef,
    reporter: ctx.sender,
    reporterKey: a.reporterKey,
    mode: a.mode,
    verdict: 'PENDING',
    reason: '',
    pInlier: undefined,
  });
  bumpStats(ctx, a.reporterKey, { submitted: 1 });
  if (a.clipRef) {
    ctx.db.computeJob.insert({
      id: 0n,
      kind: 'CLASSIFY',
      objectId: a.objectId,
      sightingId: row.id,
      status: 'QUEUED',
      claimedBy: undefined,
      claimedAt: undefined,
      attempts: 0,
      createdAt: ctx.timestamp,
      finishedAt: undefined,
      error: '',
    });
  } else {
    // No clip to check: accept on position, let the corridor job weigh it.
    ctx.db.sighting.id.update({ ...row, verdict: 'ACCEPTED', reason: 'position-only report' });
    bumpStats(ctx, a.reporterKey, { accepted: 1 });
    enqueueUpdate(ctx, a.objectId);
  }
}

function validateObjectRow(a: { source: string; status: string }): void {
  if (!SOURCES.includes(a.source)) throw new SenderError('bad source');
  if (!['PREDICTED', 'DECAYED', 'REPLAY', 'CANDIDATE'].includes(a.status)) {
    throw new SenderError('bad status');
  }
}

function upsertObject(ctx: AnyCtx, row: any): boolean {
  const existed = !!ctx.db.reentryObject.id.find(row.id);
  if (existed) ctx.db.reentryObject.id.update(row);
  else ctx.db.reentryObject.insert(row);
  return !existed;
}

function recordFeed(ctx: AnyCtx, feed: string, ok: boolean, error: string, rows: number): void {
  const prev = ctx.db.feedStatus.feed.find(feed);
  const row = {
    feed,
    lastAttemptAt: ctx.timestamp,
    lastOkAt: ok ? ctx.timestamp : prev?.lastOkAt,
    lastError: ok ? '' : error.slice(0, 300),
    rowsIngested: (prev?.rowsIngested ?? 0) + rows,
  };
  if (prev) ctx.db.feedStatus.feed.update(row);
  else ctx.db.feedStatus.insert(row);
}

// ============================================================ lifecycle

export const init = spacetimedb.init(ctx => {
  ctx.db.sweepTick.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(SWEEP_EVERY) });
  ctx.db.replayTick.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(REPLAY_TICK_EVERY) });
  ctx.db.noaaTick.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(NOAA_EVERY) });
  ctx.db.celestrakTick.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(CELESTRAK_EVERY) });
});

// ============================================================ roles

// The poller and operator roles are claimed by the first identity that asks
// (register them before the demo opens). Workers cannot self-register: the
// operator approves each worker identity, so only approved machines can
// publish verdicts and corridors.
export const registerWorker = spacetimedb.reducer({ role: t.string() }, (ctx, { role }) => {
  if (role !== 'poller' && role !== 'operator') {
    throw new SenderError('only poller/operator self-register; workers use approve_worker');
  }
  const mine = ctx.db.workerRegistry.identity.find(ctx.sender);
  if (mine && mine.role === role) return;
  if (mine) throw new SenderError(`this identity already has role ${mine.role}`);
  const taken = [...ctx.db.workerRegistry.iter()].some(r => r.role === role);
  if (taken) throw new SenderError(`role ${role} already claimed`);
  ctx.db.workerRegistry.insert({ identity: ctx.sender, role });
});

export const approveWorker = spacetimedb.reducer({ identityHex: t.string() }, (ctx, { identityHex }) => {
  requireRole(ctx, 'operator');
  let id: Identity;
  try {
    id = Identity.fromString(identityHex);
  } catch {
    throw new SenderError('bad identity hex');
  }
  const row = ctx.db.workerRegistry.identity.find(id);
  if (row) ctx.db.workerRegistry.identity.update({ identity: id, role: 'worker' });
  else ctx.db.workerRegistry.insert({ identity: id, role: 'worker' });
});

export const revokeWorker = spacetimedb.reducer({ identityHex: t.string() }, (ctx, { identityHex }) => {
  requireRole(ctx, 'operator');
  const id = Identity.fromString(identityHex);
  const row = ctx.db.workerRegistry.identity.find(id);
  if (row && row.role === 'worker') ctx.db.workerRegistry.identity.delete(id);
});

// ============================================================ objects + feeds

export const ingestObject = spacetimedb.reducer(
  {
    id: t.string(),
    name: t.string(),
    noradId: t.u32(),
    source: t.string(),
    windowStart: t.timestamp().optional(),
    windowEnd: t.timestamp().optional(),
    elements: t.string(),
    status: t.string(),
  },
  (ctx, a) => {
    requireRole(ctx, 'poller', 'operator');
    validateObjectRow(a);
    const isNew = upsertObject(ctx, { ...a, updatedAt: ctx.timestamp });
    // A new tracked object (not a mere candidate) gets a baseline corridor.
    if (isNew && a.source !== 'CANDIDATE') enqueueUpdate(ctx, a.id);
  }
);

export const reportFeedStatus = spacetimedb.reducer(
  { feed: t.string(), ok: t.bool(), error: t.string(), rowsIngested: t.u32() },
  (ctx, { feed, ok, error, rowsIngested }) => {
    requireRole(ctx, 'poller', 'operator');
    recordFeed(ctx, feed, ok, error, rowsIngested);
  }
);

function pollNoaa(ctx: any): void {
  const get = (url: string) => ctx.http.fetch(url, { timeout: TimeDuration.fromMillis(8000) });
  let kp: number | undefined, kpTime = '', f107: number | undefined, f107Time = '';
  let err = '';
  try {
    const r = get('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json');
    if (!r.ok) throw new Error(`kp HTTP ${r.status}`);
    const rows = r.json() as Array<{ time_tag: string; Kp: number }>;
    const last = rows[rows.length - 1];
    const v = Number(last?.Kp);
    if (!Number.isFinite(v) || typeof last?.time_tag !== 'string') throw new Error('kp: unexpected format');
    kp = v;
    kpTime = last.time_tag;
  } catch (e) {
    err += String(e) + '; ';
  }
  try {
    const r = get('https://services.swpc.noaa.gov/products/summary/10cm-flux.json');
    if (!r.ok) throw new Error(`f107 HTTP ${r.status}`);
    // Served as a one-element array (seen Oct 24); accept a bare object too.
    const body = r.json() as any;
    const d = (Array.isArray(body) ? body[body.length - 1] : body) as { flux?: number | string; time_tag?: string };
    const v = Number(d?.flux);
    if (!Number.isFinite(v) || typeof d?.time_tag !== 'string') throw new Error('f107: unexpected format');
    f107 = v;
    f107Time = d.time_tag;
  } catch (e) {
    err += String(e);
  }
  ctx.withTx((tx: AnyCtx) => {
    const prev = tx.db.spaceWeather.key.find('current');
    const row = {
      key: 'current',
      kp: kp ?? prev?.kp,
      kpTime: kp !== undefined ? kpTime : prev?.kpTime ?? '',
      f107: f107 ?? prev?.f107,
      f107Time: f107 !== undefined ? f107Time : prev?.f107Time ?? '',
      updatedAt: tx.timestamp,
    };
    if (prev) tx.db.spaceWeather.key.update(row);
    else tx.db.spaceWeather.insert(row);
    recordFeed(tx, 'noaa_swpc', err === '', err, (kp !== undefined ? 1 : 0) + (f107 !== undefined ? 1 : 0));
  });
}

function pollCelestrak(ctx: any): void {
  // Politeness is enforced here, not by the caller: at most one download per
  // CelesTrak update cycle, and no retry after an error until the next cycle.
  const skip = ctx.withTx((tx: AnyCtx) => {
    const prev = tx.db.feedStatus.feed.find('celestrak_decaying');
    return prev ? !olderThan(tx, prev.lastAttemptAt, CELESTRAK_MIN_GAP) : false;
  });
  if (skip) return;
  let rows: any[] = [];
  let err = '';
  try {
    const r = ctx.http.fetch('https://celestrak.org/NORAD/elements/gp.php?SPECIAL=DECAYING&FORMAT=json', {
      timeout: TimeDuration.fromMillis(10000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    rows = r.json();
  } catch (e) {
    err = String(e);
  }
  ctx.withTx((tx: AnyCtx) => {
    for (const g of rows) {
      const norad = Number(g.NORAD_CAT_ID);
      if (!Number.isFinite(norad)) continue;
      const id = `CT-${norad}`;
      // Do not downgrade an object we already track from TIP or REPLAY.
      const tracked = tx.db.reentryObject.id.find(`TIP-${norad}`);
      if (tracked) continue;
      upsertObject(tx, {
        id,
        name: String(g.OBJECT_NAME ?? id),
        noradId: norad,
        source: 'CANDIDATE',
        windowStart: undefined,
        windowEnd: undefined,
        elements: JSON.stringify(g),
        status: 'CANDIDATE',
        updatedAt: tx.timestamp,
      });
    }
    recordFeed(tx, 'celestrak_decaying', err === '', err, rows.length);
  });
}

export const noaaPoll = spacetimedb.procedure(
  { onSchedule: noaaTick },
  { tick: noaaTick.rowType },
  t.unit(),
  (ctx, _args) => {
    if (!ctx.sender.isEqual(ctx.databaseIdentity)) return {};
    pollNoaa(ctx);
    return {};
  }
);

export const celestrakPoll = spacetimedb.procedure(
  { onSchedule: celestrakTick },
  { tick: celestrakTick.rowType },
  t.unit(),
  (ctx, _args) => {
    if (!ctx.sender.isEqual(ctx.databaseIdentity)) return {};
    pollCelestrak(ctx);
    return {};
  }
);

// Operator button: fetch public feeds now (CelesTrak still respects its gap).
export const pollFeedsNow = spacetimedb.procedure(t.unit(), ctx => {
  const isOperator = ctx.withTx(tx => {
    const row = tx.db.workerRegistry.identity.find(tx.sender);
    return row?.role === 'operator';
  });
  if (!isOperator) throw new SenderError('operator only');
  pollNoaa(ctx);
  pollCelestrak(ctx);
  return {};
});

// ============================================================ sightings

export const submitSighting = spacetimedb.reducer(
  {
    objectId: t.string(),
    lat: t.f64(),
    lon: t.f64(),
    observedAt: t.timestamp(),
    bearingDeg: t.f64().optional(),
    clipRef: t.string().optional(),
    mode: t.string(),
  },
  (ctx, a) => {
    const obj = ctx.db.reentryObject.id.find(a.objectId);
    if (!obj) throw new SenderError('unknown object');
    if (obj.source === 'CANDIDATE') throw new SenderError('object is not being tracked');
    if (!(a.lat >= -90 && a.lat <= 90 && a.lon >= -180 && a.lon <= 180)) {
      throw new SenderError('lat/lon out of range');
    }
    if (a.mode !== 'DEMO' && a.mode !== 'LIVE') throw new SenderError('mode must be DEMO or LIVE');
    if (a.mode === 'DEMO' && obj.source !== 'REPLAY') throw new SenderError('DEMO sightings only on a replay');
    if (a.bearingDeg !== undefined && !(a.bearingDeg >= 0 && a.bearingDeg < 360)) {
      throw new SenderError('bearing must be in [0, 360)');
    }
    const reporterKey = ctx.sender.toHexString();
    const stats = ctx.db.reporterStats.reporterKey.find(reporterKey);
    if (stats && !olderThan(ctx, stats.lastSubmitAt, MIN_SUBMIT_GAP)) {
      throw new SenderError('slow down: one report every 2 seconds');
    }
    insertSighting(ctx, { ...a, reporterKey });
  }
);

// ============================================================ job queue

// The caller takes the oldest queued job. CPU-tier workers only get work
// when no healthy GPU worker is online (failover is a database rule).
export const claimJob = spacetimedb.reducer({}, ctx => {
  requireRole(ctx, 'worker');
  const me = ctx.db.computeStatus.worker.find(ctx.sender);
  if (!me) throw new SenderError('send report_compute_status first');
  if (!me.healthy) return; // compute down or heartbeat stale: leave work for others
  if (me.tier === 'cpu') {
    const gpuUp = [...ctx.db.computeStatus.iter()].some(w => w.tier === 'gpu' && w.healthy);
    if (gpuUp) return;
  }
  for (const j of ctx.db.computeJob.iter()) {
    if (j.claimedBy && j.claimedBy.isEqual(ctx.sender) && j.status === 'CLAIMED') return; // one at a time
  }
  let next: any = null;
  for (const j of ctx.db.computeJob.iter()) {
    if (j.status !== 'QUEUED') continue;
    // CLASSIFY first (it gates the sighting), then oldest.
    if (!next || (j.kind === 'CLASSIFY' && next.kind !== 'CLASSIFY') || (j.kind === next.kind && j.id < next.id)) {
      next = j;
    }
  }
  if (!next) return;
  ctx.db.computeJob.id.update({
    ...next,
    status: 'CLAIMED',
    claimedBy: ctx.sender,
    claimedAt: ctx.timestamp,
    attempts: next.attempts + 1,
  });
});

export const setVerdict = spacetimedb.reducer(
  { jobId: t.u64(), verdict: t.string(), reason: t.string() },
  (ctx, { jobId, verdict, reason }) => {
    requireRole(ctx, 'worker');
    if (!VERDICTS.includes(verdict) || verdict === 'PENDING') throw new SenderError('bad verdict');
    const job = claimedJob(ctx, jobId, 'CLASSIFY');
    finishJob(ctx, job);
    const me = ctx.db.computeStatus.worker.find(ctx.sender);
    if (me) ctx.db.computeStatus.worker.update({ ...me, sightingsClassified: me.sightingsClassified + 1 });
    const s = job.sightingId === undefined ? null : ctx.db.sighting.id.find(job.sightingId);
    if (!s) return; // removed by reset_demo
    ctx.db.sighting.id.update({ ...s, verdict, reason });
    bumpStats(ctx, s.reporterKey, verdict === 'REJECTED' ? { rejected: 1 } : { accepted: 1 });
    if (verdict !== 'REJECTED') enqueueUpdate(ctx, s.objectId);
  }
);

// scores: JSON [{id, p_inlier}] for the sightings the job used (may be "[]").
export const publishCorridor = spacetimedb.reducer(
  {
    jobId: t.u64(),
    bands: t.string(),
    areaKm2_90: t.f64(),
    nSamples: t.u32(),
    nSightingsUsed: t.u32(),
    jobMs: t.u32(),
    scores: t.string(),
  },
  (ctx, a) => {
    requireRole(ctx, 'worker');
    const job = claimedJob(ctx, a.jobId, 'UPDATE');
    finishJob(ctx, job);
    const me = ctx.db.computeStatus.worker.find(ctx.sender);
    const tier = me?.tier ?? 'unknown';
    if (me) {
      ctx.db.computeStatus.worker.update({
        ...me,
        variantsRunTotal: me.variantsRunTotal + BigInt(a.nSamples),
        lastJobMs: a.jobMs,
      });
    }
    const prev = ctx.db.corridor.objectId.find(job.objectId);
    const version = prev ? prev.version + 1 : 1;
    const row = {
      objectId: job.objectId,
      version,
      bands: a.bands,
      areaKm2_90: a.areaKm2_90,
      nSamples: a.nSamples,
      nSightingsUsed: a.nSightingsUsed,
      computedAt: ctx.timestamp,
      computedBy: ctx.sender,
    };
    if (prev) ctx.db.corridor.objectId.update(row);
    else ctx.db.corridor.insert(row);
    ctx.db.corridorHistory.insert({
      id: 0n,
      objectId: job.objectId,
      version,
      bands: a.bands,
      areaKm2_90: a.areaKm2_90,
      nSightingsUsed: a.nSightingsUsed,
      computedAt: ctx.timestamp,
      jobMs: a.jobMs,
      tier,
    });

    // Per-sighting consistency from the simulation feeds trust and HELD.
    let scores: Array<{ id: number | string; p_inlier: number }> = [];
    try {
      scores = JSON.parse(a.scores);
    } catch {
      throw new SenderError('scores must be JSON');
    }
    for (const sc of scores) {
      const s = ctx.db.sighting.id.find(BigInt(sc.id));
      if (!s) continue;
      const p = Number(sc.p_inlier);
      const firstScore = s.pInlier === undefined;
      let { verdict, reason } = s;
      if (verdict === 'ACCEPTED' && p < HOLD_BELOW_P) {
        verdict = 'HELD';
        reason = `inconsistent with other reports (p=${p.toFixed(2)})`;
      } else if (verdict === 'HELD' && p >= 0.5 && reason.startsWith('inconsistent')) {
        verdict = 'ACCEPTED';
        reason = `consistent with other reports (p=${p.toFixed(2)})`;
      }
      ctx.db.sighting.id.update({ ...s, pInlier: p, verdict, reason });
      if (firstScore) bumpStats(ctx, s.reporterKey, p >= 0.5 ? { agreed: 1 } : { disagreed: 1 });
    }
  }
);

export const failJob = spacetimedb.reducer({ jobId: t.u64(), error: t.string() }, (ctx, { jobId, error }) => {
  requireRole(ctx, 'worker');
  const job = ctx.db.computeJob.id.find(jobId);
  if (!job || job.status !== 'CLAIMED' || !job.claimedBy?.isEqual(ctx.sender)) return;
  const giveUp = job.attempts >= MAX_ATTEMPTS;
  ctx.db.computeJob.id.update({
    ...job,
    status: giveUp ? 'FAILED' : 'QUEUED',
    claimedBy: undefined,
    claimedAt: undefined,
    finishedAt: giveUp ? ctx.timestamp : undefined,
    error: error.slice(0, 300),
  });
});

// Heartbeat. healthy=false is also set by the sweeper when this goes stale.
export const reportComputeStatus = spacetimedb.reducer(
  { tier: t.string(), gpuName: t.string(), healthy: t.bool() },
  (ctx, a) => {
    requireRole(ctx, 'worker');
    if (!TIERS.includes(a.tier)) throw new SenderError('tier must be gpu or cpu');
    const prev = ctx.db.computeStatus.worker.find(ctx.sender);
    const row = {
      worker: ctx.sender,
      tier: a.tier,
      gpuName: a.gpuName,
      healthy: a.healthy,
      variantsRunTotal: prev?.variantsRunTotal ?? 0n,
      lastJobMs: prev?.lastJobMs ?? 0,
      sightingsClassified: prev?.sightingsClassified ?? 0,
      updatedAt: ctx.timestamp,
    };
    if (prev) ctx.db.computeStatus.worker.update(row);
    else ctx.db.computeStatus.insert(row);
  }
);

// Every 2 s: expire job leases and mark silent workers unhealthy.
export const sweep = spacetimedb.reducer({ onSchedule: sweepTick }, { tick: sweepTick.rowType }, ctx => {
  requireScheduler(ctx);
  for (const j of [...ctx.db.computeJob.iter()]) {
    if (j.status !== 'CLAIMED' || !olderThan(ctx, j.claimedAt, LEASE)) continue;
    const giveUp = j.attempts >= MAX_ATTEMPTS;
    ctx.db.computeJob.id.update({
      ...j,
      status: giveUp ? 'FAILED' : 'QUEUED',
      claimedBy: undefined,
      claimedAt: undefined,
      finishedAt: giveUp ? ctx.timestamp : undefined,
      error: 'lease expired',
    });
  }
  for (const w of [...ctx.db.computeStatus.iter()]) {
    if (w.healthy && olderThan(ctx, w.updatedAt, HEARTBEAT_STALE)) {
      ctx.db.computeStatus.worker.update({ ...w, healthy: false });
    }
  }
});

// ============================================================ replay (simulated)

// rows: JSON [{t_offset_s, lat, lon, bearing_deg?, sim_reporter, is_outlier}]
// from tools/sighting-gen. Replaces any script already loaded for the event.
export const loadReplayScript = spacetimedb.reducer(
  { eventId: t.string(), rows: t.string() },
  (ctx, { eventId, rows }) => {
    requireRole(ctx, 'operator');
    const obj = ctx.db.reentryObject.id.find(eventId);
    if (!obj || obj.source !== 'REPLAY') throw new SenderError('not a replay object');
    for (const r of [...ctx.db.replaySighting.eventId.filter(eventId)]) ctx.db.replaySighting.id.delete(r.id);
    let parsed: any[];
    try {
      parsed = JSON.parse(rows);
    } catch {
      throw new SenderError('rows must be JSON');
    }
    for (const r of parsed) {
      ctx.db.replaySighting.insert({
        id: 0n,
        eventId,
        tOffsetS: Number(r.t_offset_s),
        lat: Number(r.lat),
        lon: Number(r.lon),
        bearingDeg: r.bearing_deg === undefined || r.bearing_deg === null ? undefined : Number(r.bearing_deg),
        simReporter: String(r.sim_reporter ?? 'sim-0'),
        isOutlier: !!r.is_outlier,
        emitted: false,
      });
    }
  }
);

export const startReplay = spacetimedb.reducer(
  { eventId: t.string(), tOffset: t.f64(), speed: t.f64() },
  (ctx, { eventId, tOffset, speed }) => {
    requireRole(ctx, 'operator');
    const obj = ctx.db.reentryObject.id.find(eventId);
    if (!obj || obj.source !== 'REPLAY') throw new SenderError('not a replay object');
    if (!(speed > 0 && speed <= 600)) throw new SenderError('speed must be in (0, 600]');
    const row = { id: 0, running: true, tOffset, eventId, startedAt: ctx.timestamp, speed };
    if (ctx.db.replayState.id.find(0)) ctx.db.replayState.id.update(row);
    else ctx.db.replayState.insert(row);
  }
);

export const pauseReplay = spacetimedb.reducer({}, ctx => {
  requireRole(ctx, 'operator');
  const rs = ctx.db.replayState.id.find(0);
  if (!rs || !rs.running) return;
  const elapsed = Number(micros(ctx.timestamp) - micros(rs.startedAt)) / 1e6;
  ctx.db.replayState.id.update({ ...rs, running: false, tOffset: rs.tOffset + elapsed * rs.speed });
});

// Every second while running: emit scripted sightings whose time has come.
export const replayStep = spacetimedb.reducer({ onSchedule: replayTick }, { tick: replayTick.rowType }, ctx => {
  requireScheduler(ctx);
  const rs = ctx.db.replayState.id.find(0);
  if (!rs || !rs.running) return;
  const obj = ctx.db.reentryObject.id.find(rs.eventId);
  if (!obj || !obj.windowStart) return;
  const clock = rs.tOffset + (Number(micros(ctx.timestamp) - micros(rs.startedAt)) / 1e6) * rs.speed;
  for (const r of [...ctx.db.replaySighting.eventId.filter(rs.eventId)]) {
    if (r.emitted || r.tOffsetS > clock) continue;
    ctx.db.replaySighting.id.update({ ...r, emitted: true });
    insertSighting(ctx, {
      objectId: rs.eventId,
      lat: r.lat,
      lon: r.lon,
      observedAt: new Timestamp(micros(obj.windowStart) + BigInt(Math.round(r.tOffsetS * 1e6))),
      bearingDeg: r.bearingDeg,
      clipRef: undefined,
      mode: 'SIM',
      reporterKey: r.simReporter,
    });
  }
});

// Clears DEMO and SIM sightings, their jobs, history and stats for one replay
// object, rewinds the script, and queues a fresh baseline corridor.
export const resetDemo = spacetimedb.reducer({ objectId: t.string() }, (ctx, { objectId }) => {
  requireRole(ctx, 'operator');
  const obj = ctx.db.reentryObject.id.find(objectId);
  if (!obj || obj.source !== 'REPLAY') throw new SenderError('reset only applies to a replay object');
  const keys = new Set<string>();
  for (const s of [...ctx.db.sighting.objectId.filter(objectId)]) {
    if (s.mode === 'DEMO' || s.mode === 'SIM') {
      keys.add(s.reporterKey);
      ctx.db.sighting.id.delete(s.id);
    }
  }
  for (const k of keys) ctx.db.reporterStats.reporterKey.delete(k);
  for (const j of [...ctx.db.computeJob.objectId.filter(objectId)]) ctx.db.computeJob.id.delete(j.id);
  for (const h of [...ctx.db.corridorHistory.objectId.filter(objectId)]) ctx.db.corridorHistory.id.delete(h.id);
  ctx.db.corridor.objectId.delete(objectId);
  for (const r of [...ctx.db.replaySighting.eventId.filter(objectId)]) {
    if (r.emitted) ctx.db.replaySighting.id.update({ ...r, emitted: false });
  }
  const rs = ctx.db.replayState.id.find(0);
  if (rs) ctx.db.replayState.id.update({ ...rs, running: false, tOffset: 0 });
  enqueueUpdate(ctx, objectId);
});

// ============================================================ views

// Each phone sees only its own reports and their verdicts.
export const mySightings = spacetimedb.view(
  { name: 'my_sightings', public: true },
  t.array(sighting.rowType),
  ctx => [...ctx.db.sighting.reporter.filter(ctx.sender)]
);
