// SKYFALL SpacetimeDB module: the core of the system (see docs/ARCHITECTURE.md).
//
// Everything that coordinates the project lives here: the sighting rules,
// reporter trust, the GPU job queue with leases and failover, corridor
// history, the replay clock that emits simulated sightings, worker health,
// and the public-feed fetchers (NOAA SWPC, CelesTrak GP and SATCAT decay
// dates, Space-Track only when database env credentials exist) as scheduled
// procedures. Forecasts are scored against official decay times in
// forecast_score. Workers and screens are thin clients around it.
//
// TS uses camelCase; SpacetimeDB's default case policy stores snake_case
// (submitSighting -> submit_sighting, objectId -> object_id).
import { schema, table, t, SenderError, ScheduleAt } from 'spacetimedb/server';
import { Identity, Timestamp, TimeDuration } from 'spacetimedb';

// The module host provides console. This package's tsconfig has no DOM lib.
declare const console: { log: (message: string) => void };

// ============================================================ config

const SEC = 1_000_000n; // microseconds
const SWEEP_EVERY = 2n * SEC;
const REPLAY_TICK_EVERY = 1n * SEC;
const NOAA_EVERY = 15n * 60n * SEC;
const CELESTRAK_EVERY = 2n * 3600n * SEC;
const CELESTRAK_MIN_GAP = 2n * 3600n * SEC; // CelesTrak 403s repeat downloads inside one update
const OUTCOME_EVERY = 6n * 3600n * SEC; // SATCAT decay dates + optional Space-Track
const SATCAT_MIN_GAP = 2n * 3600n * SEC;
const SATCAT_BATCH = 4; // SATCAT CATNR is one object per request; stay well under a retry loop
const SATCAT_PROBE_EVERY = 24n * 3600n * SEC;
const SPACETRACK_DECAY_GAP = 24n * 3600n * SEC; // class/decay is 1/day; one combined query, never per object
const SPACETRACK_TIP_GAP = 60n * 60n * SEC; // class/tip is 1/hour
const HOUR_US = 3_600_000_000; // microseconds in an hour
const OUTCOME_SOURCES = ['CELESTRAK_SATCAT', 'SPACETRACK_DECAY', 'SPACETRACK_TIP', 'OPERATOR'];
// Higher wins. A feed must not overwrite a better official time, or an operator correction.
const OUTCOME_RANK: Record<string, number> = {
  SPACETRACK_TIP: 1,
  CELESTRAK_SATCAT: 2,
  SPACETRACK_DECAY: 3,
  OPERATOR: 4,
};
const LEASE = 60n * SEC; // fast lane (CLASSIFY/UPDATE). Failover is faster: sweep requeues jobs of workers whose heartbeat stopped
const LEASE_BULK = 15n * 60n * SEC; // bulk lane (FORECAST, DEBRIS); a dead worker's job is requeued sooner by sweep
const FORECAST_EVERY = 20n * 60n * SEC; // refresh all forecasts as time passes
const DEBRIS_WITHIN = 72n * 3600n * SEC; // run debris for objects forecast to re-enter this soon
const DEBRIS_MIN_P = 0.2; // ...with at least this chance inside the forecast horizon
const HEARTBEAT_STALE = 10n * SEC;
// A bulk job (FORECAST ~11 min at full size) is only taken back after this long a
// heartbeat gap: a short Wi-Fi blip must not throw away minutes of GPU work.
// A worker that reports healthy=false still loses its job at once.
const HEARTBEAT_STALE_BULK = 60n * SEC;
const WORKER_FORGET = 600n * SEC; // silent this long: remove from compute_status
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
    // Set only on a single-object replay FORECAST. publish_forecast stores this
    // as the forecast's computed_at, and the worker passes it to /forecast as as_of.
    asOf: t.timestamp().optional(),
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

// Re-entry forecast per object from the GPU Monte Carlo (one row per object).
const forecast = table(
  { public: true },
  {
    objectId: t.string().primaryKey(),
    version: t.u32(),
    status: t.string(), // ok | likely_reentered | error
    tQ05: t.timestamp().optional(),
    tQ25: t.timestamp().optional(),
    tQ50: t.timestamp().optional(),
    tQ75: t.timestamp().optional(),
    tQ95: t.timestamp().optional(),
    decayedFrac: t.f64(), // share of particles that re-entered inside the horizon
    horizonDays: t.f64(),
    nSamples: t.u32(),
    ess: t.f64(),
    calibrated: t.bool(), // drag fitted to the observed decay rate
    bcM2Kg: t.f64(),
    areaKm2_90: t.f64(),
    tier: t.string(), // gpu | cpu (degraded)
    device: t.string(),
    computedAt: t.timestamp(),
    note: t.string(),
  }
);

// Archive of every distinct element set we fetched (CelesTrak / Space-Track).
// Lets us replay a real re-entry later from the data we had at the time.
const elementsHistory = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    objectId: t.string().index('btree'),
    epoch: t.string(),
    elements: t.string(),
    fetchedAt: t.timestamp(),
  }
);

// Every forecast we published, small: how the prediction moved over time.
const forecastHistory = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    objectId: t.string().index('btree'),
    version: t.u32(),
    tQ05: t.timestamp().optional(),
    tQ50: t.timestamp().optional(),
    tQ95: t.timestamp().optional(),
    decayedFrac: t.f64(),
    nSamples: t.u32(),
    tier: t.string(),
    computedAt: t.timestamp(),
  }
);

// What each tracked object is (from catalogs, or guessed from its name), and
// which archetype (documented component list) the debris model uses for it.
const satelliteProfile = table(
  { public: true },
  {
    noradId: t.u32().primaryKey(),
    name: t.string(),
    objectType: t.string(), // PAY | R/B | DEB | UNK
    owner: t.string(),
    launchDate: t.string(),
    massKg: t.f64().optional(),
    dims: t.string(), // JSON: {length_m?, diameter_m?, span_m?}
    shape: t.string(),
    rcsSize: t.string().optional(), // SMALL | MEDIUM | LARGE
    archetypeId: t.string(),
    matchReason: t.string(),
    sources: t.string(), // JSON list of {source, field}
    confidence: t.string(), // low | medium | high
    updatedAt: t.timestamp(),
  }
);

// Documented component lists per satellite class (data/archetypes/*.json).
const archetype = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    name: t.string(),
    appliesTo: t.string(), // JSON: {object_type?, name_regex?, mass_kg?, priority?}
    components: t.string(), // JSON, see docs/DEBRIS_MODEL.md §2
    sources: t.string(), // JSON list
    confidence: t.string(),
    updatedAt: t.timestamp(),
  }
);

// Debris prediction per object (latest version). Components and tracks are
// child tables keyed by object_id ("subtables" in docs/VIS_NOTES.md).
const debrisForecast = table(
  { public: true },
  {
    objectId: t.string().primaryKey(),
    version: t.u32(),
    archetypeId: t.string(),
    forecastVersion: t.u32(),
    nParticles: t.u32(),
    pAnySurvives: t.f64(),
    survivingMassKgMean: t.f64(),
    survivingMassKgP95: t.f64(),
    casualtyAreaM2Mean: t.f64(),
    footprint: t.string(), // JSON bands [{level, polygon}]
    areaKm2_90: t.f64(),
    breakup: t.string(), // JSON {t_unix_s, lat, lon, alt_km}
    tier: t.string(),
    device: t.string(),
    computedAt: t.timestamp(),
    note: t.string(),
  }
);

const debrisComponent = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    objectId: t.string().index('btree'),
    version: t.u32(),
    name: t.string(),
    material: t.string(),
    shape: t.string(),
    count: t.u32(),
    massKgStart: t.f64(),
    pSurvive: t.f64(),
    massKgMean: t.f64(),
    impactSpeedMsMean: t.f64().optional(),
    impactEnergyJMean: t.f64().optional(),
    demiseAltKmMean: t.f64().optional(),
    impactLat: t.f64().optional(),
    impactLon: t.f64().optional(),
    footprint: t.string(), // JSON bands
  }
);

const debrisTrack = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    objectId: t.string().index('btree'),
    version: t.u32(),
    component: t.string(),
    survived: t.bool(),
    points: t.string(), // JSON [[t_unix_s, lat, lon, alt_km], ...]
  }
);

const debrisHistory = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    objectId: t.string().index('btree'),
    version: t.u32(),
    pAnySurvives: t.f64(),
    survivingMassKgMean: t.f64(),
    areaKm2_90: t.f64(),
    tier: t.string(),
    computedAt: t.timestamp(),
  }
);

// One row per finished compute run: what the hardware actually did.
const computeRun = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    kind: t.string(),
    tier: t.string(),
    device: t.string(),
    objects: t.u32(),
    particles: t.u64(),
    particleSteps: t.u64(), // RK4 steps x particles
    ms: t.u32(),
    finishedAt: t.timestamp(),
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

// Official decay for one NORAD id, plus any reported find points.
// finds is JSON [{lat, lon, note}]. replay=true is a historical case.
const reentryOutcome = table(
  { public: true },
  {
    noradId: t.u32().primaryKey(),
    objectId: t.string(),
    name: t.string(),
    decayAt: t.timestamp(),
    source: t.string(), // CELESTRAK_SATCAT | SPACETRACK_DECAY | SPACETRACK_TIP | OPERATOR
    finds: t.string(),
    note: t.string(),
    replay: t.bool(),
    updatedAt: t.timestamp(),
  }
);

// One row each time an outcome is written or a matching forecast is published.
// The latest row per norad_id is the current score. See docs/ARCHITECTURE.md
// for calibrated, hours_error and lead_time_hours.
const forecastScore = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    noradId: t.u32().index('btree'),
    objectId: t.string(),
    forecastHistoryId: t.u64().optional(),
    status: t.string(), // scored | no_forecast
    hoursError: t.f64().optional(),
    insideWindow: t.bool().optional(),
    findHits: t.string(), // JSON [{lat, lon, note, inside}] ; inside is null when there is no 90% corridor
    leadTimeHours: t.f64().optional(),
    calibrated: t.bool(),
    replay: t.bool(),
    source: t.string(),
    forecastComputedAt: t.timestamp().optional(),
    scoredAt: t.timestamp(),
  }
);

// Which archived NORAD ids we already asked CelesTrak SATCAT about.
const outcomeProbe = table(
  { public: false },
  {
    noradId: t.u32().primaryKey(),
    checkedAt: t.timestamp(),
    decayFound: t.bool(),
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
const outcomeTick = table(
  { public: false },
  { scheduledId: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt() }
);

const spacetimedb = schema(
  {
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
    forecast,
    forecastHistory,
    satelliteProfile,
    archetype,
    debrisForecast,
    debrisComponent,
    debrisTrack,
    debrisHistory,
    elementsHistory,
    computeRun,
    reentryOutcome,
    forecastScore,
    outcomeProbe,
    replaySighting,
    workerRegistry,
    sweepTick,
    replayTick,
    noaaTick,
    celestrakTick,
    outcomeTick,
  },
  {
    // Optional on purpose: an empty database leaves the Space-Track path disabled.
    // Supply both at publish time from the shell, never from source.
    env: {
      SPACETRACK_USER: t.string().optional(),
      SPACETRACK_PASS: t.string().optional(),
    },
  }
);
export default spacetimedb;

// ============================================================ helpers
// Loosely typed so they accept any reducer/transaction context.
type AnyCtx = {
  db: any;
  sender: Identity;
  timestamp: Timestamp;
  databaseIdentity: Identity;
  env?: { SPACETRACK_USER?: string; SPACETRACK_PASS?: string };
};

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
    asOf: undefined,
  });
}

// One FORECAST job covers every tracked and candidate object (one GPU batch).
// Replay objects are skipped by the worker on this job; they have their own.
function enqueueForecast(ctx: AnyCtx): void {
  for (const j of ctx.db.computeJob.objectId.filter('*')) {
    if (j.kind === 'FORECAST' && j.status === 'QUEUED') return;
  }
  ctx.db.computeJob.insert({
    id: 0n,
    kind: 'FORECAST',
    objectId: '*',
    sightingId: undefined,
    status: 'QUEUED',
    claimedBy: undefined,
    claimedAt: undefined,
    attempts: 0,
    createdAt: ctx.timestamp,
    finishedAt: undefined,
    error: '',
    asOf: undefined,
  });
}

// Historical case: forecast one REPLAY object as of `asOf`, not as of now.
function enqueueReplayForecast(ctx: AnyCtx, objectId: string, asOf: Timestamp): void {
  for (const j of ctx.db.computeJob.objectId.filter(objectId)) {
    if (j.kind === 'FORECAST' && (j.status === 'QUEUED' || j.status === 'CLAIMED')) return;
  }
  ctx.db.computeJob.insert({
    id: 0n,
    kind: 'FORECAST',
    objectId,
    sightingId: undefined,
    status: 'QUEUED',
    claimedBy: undefined,
    claimedAt: undefined,
    attempts: 0,
    createdAt: ctx.timestamp,
    finishedAt: undefined,
    error: '',
    asOf,
  });
}

// DEBRIS shares the bulk lane with FORECAST: /debris reuses the forecast
// particles cached in the same compute process (~4 s), and one compute runs
// one simulation at a time, so in the fast lane it timed out queued behind a
// 9-min forecast. In the bulk lane it runs right after its forecast (rank).
const laneOf = (kind: string) => (kind === 'FORECAST' || kind === 'DEBRIS' ? 'bulk' : 'fast');

// One QUEUED debris job per object is enough (it reads the latest forecast).
function enqueueDebris(ctx: AnyCtx, objectId: string): void {
  for (const j of ctx.db.computeJob.objectId.filter(objectId)) {
    if (j.kind === 'DEBRIS' && j.status === 'QUEUED') return;
  }
  ctx.db.computeJob.insert({
    id: 0n,
    kind: 'DEBRIS',
    objectId,
    sightingId: undefined,
    status: 'QUEUED',
    claimedBy: undefined,
    claimedAt: undefined,
    attempts: 0,
    createdAt: ctx.timestamp,
    finishedAt: undefined,
    error: '',
    asOf: undefined,
  });
}

// Object type from the name when no catalog says otherwise.
function guessObjectType(name: string): string {
  const n = name.toUpperCase();
  if (/\bDEB\b/.test(n)) return 'DEB';
  if (/\bR\/B\b/.test(n)) return 'R/B';
  return 'PAY';
}

// Pick the archetype whose applies_to rules match best (highest priority wins).
function matchArchetype(ctx: AnyCtx, name: string, objectType: string, massKg?: number): { id: string; reason: string } {
  let best: { id: string; reason: string; prio: number } | null = null;
  for (const a of ctx.db.archetype.iter()) {
    let rule: any = {};
    try {
      rule = JSON.parse(a.appliesTo);
    } catch {
      continue;
    }
    const why: string[] = [];
    if (rule.object_type) {
      const types = Array.isArray(rule.object_type) ? rule.object_type : [rule.object_type];
      if (!types.includes(objectType)) continue;
      why.push(`type ${objectType}`);
    }
    if (rule.name_regex) {
      let ok = false;
      try {
        ok = new RegExp(rule.name_regex, 'i').test(name);
      } catch {
        ok = false;
      }
      if (!ok) continue;
      why.push(`name matches ${rule.name_regex}`);
    }
    if (Array.isArray(rule.mass_kg) && massKg !== undefined) {
      if (massKg < rule.mass_kg[0] || massKg > rule.mass_kg[1]) continue;
      why.push(`mass ${massKg} kg`);
    }
    const prio = Number(rule.priority ?? 0);
    if (!best || prio > best.prio) best = { id: a.id, reason: why.join(', ') || 'default', prio };
  }
  return best ? { id: best.id, reason: best.reason } : { id: 'generic', reason: 'no archetype matched (fallback)' };
}

// Every object with a NORAD id gets a profile: guessed from its name until a
// catalog import (ingest_profile) replaces it.
function ensureProfile(ctx: AnyCtx, noradId: number, name: string): void {
  if (!noradId || ctx.db.satelliteProfile.noradId.find(noradId)) return;
  const objectType = guessObjectType(name);
  const m = matchArchetype(ctx, name, objectType);
  ctx.db.satelliteProfile.insert({
    noradId,
    name,
    objectType,
    owner: '',
    launchDate: '',
    massKg: undefined,
    dims: '{}',
    shape: '',
    rcsSize: undefined,
    archetypeId: m.id,
    matchReason: `${m.reason}; type guessed from name`,
    sources: JSON.stringify([{ source: 'object name', field: 'OBJECT_NAME' }]),
    confidence: 'low',
    updatedAt: ctx.timestamp,
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
      asOf: undefined,
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
  const before = ctx.db.reentryObject.id.find(row.id);
  const existed = !!before;
  let epoch = '';
  try {
    epoch = String(JSON.parse(row.elements).EPOCH ?? '');
  } catch {
    /* not GP elements */
  }
  if (epoch) {
    let prevEpoch = '';
    try {
      prevEpoch = before ? String(JSON.parse(before.elements).EPOCH ?? '') : '';
    } catch {
      /* ignore */
    }
    if (epoch !== prevEpoch) {
      ctx.db.elementsHistory.insert({ id: 0n, objectId: row.id, epoch, elements: row.elements, fetchedAt: ctx.timestamp });
    }
  }
  if (existed) ctx.db.reentryObject.id.update(row);
  else ctx.db.reentryObject.insert(row);
  ensureProfile(ctx, Number(row.noradId ?? 0), String(row.name ?? ''));
  return !existed;
}

function writeCorridor(
  ctx: AnyCtx,
  objectId: string,
  bands: string,
  areaKm2_90: number,
  nSamples: number,
  nSightingsUsed: number,
  jobMs: number,
  tier: string,
  issuedAt?: Timestamp
): void {
  const at = issuedAt ?? ctx.timestamp;
  const prev = ctx.db.corridor.objectId.find(objectId);
  const version = prev ? prev.version + 1 : 1;
  const row = {
    objectId,
    version,
    bands,
    areaKm2_90,
    nSamples,
    nSightingsUsed,
    computedAt: at,
    computedBy: ctx.sender,
  };
  if (prev) ctx.db.corridor.objectId.update(row);
  else ctx.db.corridor.insert(row);
  ctx.db.corridorHistory.insert({
    id: 0n,
    objectId,
    version,
    bands,
    areaKm2_90,
    nSightingsUsed,
    computedAt: at,
    jobMs,
    tier,
  });
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
  ctx.db.outcomeTick.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(OUTCOME_EVERY) });
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
    // Drag depends on space weather: re-forecast when it moves noticeably.
    const moved =
      !prev ||
      (row.kp !== undefined && Math.abs((prev.kp ?? row.kp) - row.kp) >= 1) ||
      (row.f107 !== undefined && Math.abs((prev.f107 ?? row.f107) - row.f107) >= 10);
    if (moved) enqueueForecast(tx);
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
    if (rows.length > 0) enqueueForecast(tx); // new elements -> new forecasts
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

// ============================================================ forecast validation
// Official decay times live in reentry_outcome. forecast_score compares the
// latest forecast issued before that time. Nothing here is invented: a missing
// forecast is status no_forecast, and missing quantiles stay empty.

const ST_DISABLED = 'disabled: SPACETRACK_USER and SPACETRACK_PASS are not set on this database';
const ST_PARTIAL = 'disabled: Space-Track needs both SPACETRACK_USER and SPACETRACK_PASS';
const SATCAT_NOTE =
  'CelesTrak SATCAT DECAY_DATE is a calendar date with no time of day. Stored as 00:00:00Z, so hours error is coarse to about a day. https://celestrak.org/satcat/records.php';

function hoursBetween(later: Timestamp, earlier: Timestamp): number {
  return Number(micros(later) - micros(earlier)) / HOUR_US;
}

function sameTime(a: Timestamp, b: Timestamp): boolean {
  return micros(a) === micros(b);
}

function parseUtcDate(s: string): Timestamp | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return undefined;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return undefined;
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() + 1 !== Number(m[2]) || d.getUTCDate() !== Number(m[3])) {
    return undefined;
  }
  return Timestamp.fromDate(d);
}

function parseUtcDateTime(s: string): Timestamp | undefined {
  const t = s.trim();
  if (!t) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return parseUtcDate(t);
  let iso = t.includes('T') ? t : t.replace(' ', 'T');
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso)) iso += 'Z';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return Timestamp.fromDate(d);
}

function parseFinds(json: string): { lat: number; lon: number; note: string }[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json || '[]');
  } catch {
    throw new SenderError('finds must be a JSON array');
  }
  if (raw === null) return [];
  if (!Array.isArray(raw)) throw new SenderError('finds must be a JSON array');
  if (raw.length > 20) throw new SenderError('at most 20 find points');
  return raw.map(item => {
    const f = item as { lat?: unknown; lon?: unknown; note?: unknown };
    const lat = Number(f.lat);
    const lon = Number(f.lon);
    if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) throw new SenderError('find lat/lon out of range');
    return { lat, lon, note: String(f.note ?? '').slice(0, 200) };
  });
}

function pointInRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = Number(ring[i]?.[0]);
    const yi = Number(ring[i]?.[1]);
    const xj = Number(ring[j]?.[0]);
    const yj = Number(ring[j]?.[1]);
    if (![xi, yi, xj, yj].every(Number.isFinite)) continue;
    if (yi > lat === yj > lat) continue;
    const denom = yj - yi;
    if (denom === 0) continue;
    if (lon < ((xj - xi) * (lat - yi)) / denom + xi) inside = !inside;
  }
  return inside;
}

// level 90 is what gx10-compute writes. 0.9 is accepted so a hand-written band still counts.
function inside90(bandsJson: string, lat: number, lon: number): boolean {
  let bands: any[] = [];
  try {
    const parsed = JSON.parse(bandsJson);
    if (Array.isArray(parsed)) bands = parsed;
  } catch {
    return false;
  }
  for (const b of bands) {
    const level = Number(b?.level);
    if (level !== 90 && level !== 0.9) continue;
    if (!Array.isArray(b?.polygon)) continue;
    if (pointInRing(lon, lat, b.polygon)) return true;
  }
  return false;
}

function findHitsJson(findsJson: string, bandsJson: string | undefined): string {
  let finds: any[] = [];
  try {
    const parsed = JSON.parse(findsJson || '[]');
    if (Array.isArray(parsed)) finds = parsed;
  } catch {
    finds = [];
  }
  return JSON.stringify(
    finds.map(f => {
      const lat = Number(f?.lat);
      const lon = Number(f?.lon);
      const note = String(f?.note ?? '').slice(0, 200);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || bandsJson === undefined) {
        return { lat, lon, note, inside: null };
      }
      return { lat, lon, note, inside: inside90(bandsJson, lat, lon) };
    })
  );
}

function corridorBandsFor(ctx: AnyCtx, objectId: string, version: number, computedAt: Timestamp): string | undefined {
  const want = micros(computedAt);
  let fallback: string | undefined;
  for (const c of ctx.db.corridorHistory.objectId.filter(objectId)) {
    if (micros(c.computedAt) !== want) continue;
    if (c.version === version) return c.bands;
    fallback = c.bands;
  }
  return fallback;
}

function latestForecastBefore(ctx: AnyCtx, outcome: { noradId: number; objectId: string; decayAt: Timestamp }): any {
  const ids = new Set<string>();
  if (outcome.objectId) ids.add(outcome.objectId);
  for (const o of ctx.db.reentryObject.iter()) {
    if (Number(o.noradId) === Number(outcome.noradId)) ids.add(o.id);
  }
  const decay = micros(outcome.decayAt);
  let best: any = null;
  for (const id of ids) {
    for (const h of ctx.db.forecastHistory.objectId.filter(id)) {
      if (micros(h.computedAt) >= decay) continue;
      const newer = !best || micros(h.computedAt) > micros(best.computedAt);
      const tie =
        best &&
        micros(h.computedAt) === micros(best.computedAt) &&
        outcome.objectId !== '' &&
        h.objectId === outcome.objectId &&
        best.objectId !== outcome.objectId;
      if (newer || tie) best = h;
    }
  }
  return best;
}

function scoreIsReplay(ctx: AnyCtx, outcome: { replay: boolean; objectId: string }, forecastObjectId: string): boolean {
  if (outcome.replay) return true;
  for (const id of [outcome.objectId, forecastObjectId]) {
    if (!id) continue;
    const o = ctx.db.reentryObject.id.find(id);
    if (o && (o.source === 'REPLAY' || o.status === 'REPLAY')) return true;
  }
  return false;
}

// Append a score. Does not invent hours, a window, or a hit when the inputs are missing.
function scoreOutcome(ctx: AnyCtx, outcome: any): void {
  const best = latestForecastBefore(ctx, outcome);
  if (!best) {
    ctx.db.forecastScore.insert({
      id: 0n,
      noradId: outcome.noradId,
      objectId: outcome.objectId || '',
      forecastHistoryId: undefined,
      status: 'no_forecast',
      hoursError: undefined,
      insideWindow: undefined,
      findHits: findHitsJson(outcome.finds || '[]', undefined),
      leadTimeHours: undefined,
      calibrated: false,
      replay: scoreIsReplay(ctx, outcome, ''),
      source: outcome.source,
      forecastComputedAt: undefined,
      scoredAt: ctx.timestamp,
    });
    return;
  }
  const bands = corridorBandsFor(ctx, best.objectId, best.version, best.computedAt);
  let insideWindow: boolean | undefined;
  let calibrated = false;
  if (best.tQ05 && best.tQ95) {
    const decay = micros(outcome.decayAt);
    insideWindow = decay >= micros(best.tQ05) && decay <= micros(best.tQ95);
    calibrated = insideWindow;
  }
  ctx.db.forecastScore.insert({
    id: 0n,
    noradId: outcome.noradId,
    objectId: best.objectId,
    forecastHistoryId: best.id,
    status: 'scored',
    hoursError: best.tQ50 ? hoursBetween(best.tQ50, outcome.decayAt) : undefined,
    insideWindow,
    findHits: findHitsJson(outcome.finds || '[]', bands),
    leadTimeHours: hoursBetween(outcome.decayAt, best.computedAt),
    calibrated,
    replay: scoreIsReplay(ctx, outcome, best.objectId),
    source: outcome.source,
    forecastComputedAt: best.computedAt,
    scoredAt: ctx.timestamp,
  });
}

function autoOutcome(
  ctx: AnyCtx,
  next: { noradId: number; objectId: string; name: string; decayAt: Timestamp; source: string; note: string }
): boolean {
  const prev = ctx.db.reentryOutcome.noradId.find(next.noradId);
  if (prev && (OUTCOME_RANK[prev.source] ?? 0) > (OUTCOME_RANK[next.source] ?? 0)) return false;
  const row = {
    noradId: next.noradId,
    objectId: next.objectId || prev?.objectId || '',
    name: (next.name || prev?.name || '').slice(0, 120),
    decayAt: next.decayAt,
    source: next.source,
    finds: prev?.finds ?? '[]',
    note: next.note.slice(0, 500),
    replay: prev?.replay ?? false,
    updatedAt: ctx.timestamp,
  };
  if (
    prev &&
    prev.source === row.source &&
    sameTime(prev.decayAt, row.decayAt) &&
    prev.note === row.note &&
    prev.objectId === row.objectId &&
    prev.name === row.name
  ) {
    return false;
  }
  if (prev) ctx.db.reentryOutcome.noradId.update(row);
  else ctx.db.reentryOutcome.insert(row);
  scoreOutcome(ctx, row);
  return true;
}

type ArchivedNorad = { noradId: number; objectId: string; name: string };

function archivedNorads(ctx: AnyCtx): ArchivedNorad[] {
  const byId = new Map<number, ArchivedNorad>();
  const rank = (id: string) => (id.startsWith('TIP-') ? 3 : id.startsWith('CT-') ? 2 : id.startsWith('REPLAY-') ? 0 : 1);
  for (const h of ctx.db.elementsHistory.iter()) {
    let norad = 0;
    let name = '';
    try {
      const el = JSON.parse(h.elements);
      norad = Math.trunc(Number(el.NORAD_CAT_ID));
      name = String(el.OBJECT_NAME ?? '');
    } catch {
      /* not JSON elements */
    }
    if (!Number.isInteger(norad) || norad <= 0) {
      const m = /^(?:TIP|CT)-(\d+)$/.exec(h.objectId);
      if (m) norad = Number(m[1]);
    }
    if (!Number.isInteger(norad) || norad <= 0 || norad > 0xffffffff) continue;
    const prev = byId.get(norad);
    if (!prev || rank(h.objectId) > rank(prev.objectId)) byId.set(norad, { noradId: norad, objectId: h.objectId, name: name || prev?.name || '' });
    else if (!prev.name && name) prev.name = name;
  }
  return [...byId.values()].sort((a, b) => a.noradId - b.noradId);
}

function feedGapOpen(ctx: AnyCtx, feed: string, gap: bigint): boolean {
  const prev = ctx.db.feedStatus.feed.find(feed);
  return !prev || olderThan(ctx, prev.lastAttemptAt, gap);
}

function spaceTrackCreds(ctx: AnyCtx): { user: string; pass: string } | 'disabled' | 'partial' {
  const user = (ctx.env?.SPACETRACK_USER ?? '').trim();
  const pass = (ctx.env?.SPACETRACK_PASS ?? '').trim();
  if (!user && !pass) return 'disabled';
  if (!user || !pass) return 'partial';
  return { user, pass };
}

function hasGpElements(elementsJson: string): boolean {
  try {
    const el = JSON.parse(elementsJson);
    return !!el && typeof el === 'object' && 'MEAN_MOTION' in el && 'EPOCH' in el;
  } catch {
    return false;
  }
}

function sessionCookie(headers: { getSetCookie?: () => string[]; get: (name: string) => string | null }): string {
  const listed = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  const raws = listed.length > 0 ? listed : [headers.get('set-cookie') ?? ''].filter(s => s !== '');
  const map = new Map<string, string>();
  for (const raw of raws) {
    const pair = raw.split(';')[0]?.trim() ?? '';
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    map.set(pair.slice(0, eq).toLowerCase(), pair);
  }
  return [...map.values()].join('; ');
}

function groupByNorad(rows: any[]): Map<number, any[]> {
  const grouped = new Map<number, any[]>();
  for (const row of rows) {
    const id = Math.trunc(Number(row?.NORAD_CAT_ID));
    if (!Number.isInteger(id) || id <= 0) continue;
    const list = grouped.get(id) ?? [];
    list.push(row);
    grouped.set(id, list);
  }
  return grouped;
}

function isHistoricalDecay(msgType: string): boolean {
  const t = msgType.trim().toLowerCase();
  return t === 'satcat' || t === 'decay entry';
}

function bestHistoricalDecay(rows: any[]): any | null {
  let best: any = null;
  let bestPrec = Infinity;
  for (const row of rows) {
    if (!isHistoricalDecay(String(row?.MSG_TYPE ?? ''))) continue;
    if (!parseUtcDateTime(String(row?.DECAY_EPOCH ?? ''))) continue;
    const prec = Number(row?.PRECEDENCE);
    const p = Number.isFinite(prec) ? prec : 1e9;
    if (p < bestPrec) {
      best = row;
      bestPrec = p;
    }
  }
  return best;
}

function bestPassedTip(rows: any[], now: bigint): any | null {
  let best: any = null;
  let bestMsg = -1;
  for (const row of rows) {
    const decay = parseUtcDateTime(String(row?.DECAY_EPOCH ?? ''));
    if (!decay || micros(decay) > now) continue;
    const msg = parseUtcDateTime(String(row?.MSG_EPOCH ?? row?.INSERT_EPOCH ?? ''));
    const key = msg ? Number(micros(msg)) : 0;
    if (!best || key >= bestMsg) {
      best = row;
      bestMsg = key;
    }
  }
  return best;
}

function markProbe(ctx: AnyCtx, noradId: number, decayFound: boolean): void {
  const row = { noradId, checkedAt: ctx.timestamp, decayFound };
  if (ctx.db.outcomeProbe.noradId.find(noradId)) ctx.db.outcomeProbe.noradId.update(row);
  else ctx.db.outcomeProbe.insert(row);
}

// SATCAT has no multi-id query (one CATNR per request). At most SATCAT_BATCH
// archived objects per 2 h, and each id at most once a day. Space-Track is one
// combined decay query per day and one combined TIP query per hour, and only
// when both env values are set. Credentials are never written into feed_status.
function pollOutcomes(ctx: any): void {
  const plan: {
    creds: ReturnType<typeof spaceTrackCreds>;
    archived: ArchivedNorad[];
    batch: ArchivedNorad[];
    ids: number[];
    decayDue: boolean;
    tipDue: boolean;
  } = ctx.withTx((tx: AnyCtx) => {
    const creds = spaceTrackCreds(tx);
    const archived = archivedNorads(tx);
    const satcatDue = feedGapOpen(tx, 'celestrak_satcat', SATCAT_MIN_GAP);
    const batch = satcatDue
      ? archived
          .filter(o => {
            const probe = tx.db.outcomeProbe.noradId.find(o.noradId);
            return !probe || olderThan(tx, probe.checkedAt, SATCAT_PROBE_EVERY);
          })
          .slice(0, SATCAT_BATCH)
      : [];
    const ids = archived.map(o => o.noradId).slice(0, 40);
    return {
      creds,
      archived,
      batch,
      ids,
      decayDue: feedGapOpen(tx, 'spacetrack_decay', SPACETRACK_DECAY_GAP),
      tipDue: feedGapOpen(tx, 'spacetrack_tip', SPACETRACK_TIP_GAP),
    };
  });

  const satcatRows: { noradId: number; name: string; decay: string }[] = [];
  let satcatErr = '';
  let satcatChecked = 0;
  if (plan.batch.length > 0) {
    for (const item of plan.batch) {
      try {
        const r = ctx.http.fetch(`https://celestrak.org/satcat/records.php?CATNR=${item.noradId}&FORMAT=json`, {
          timeout: TimeDuration.fromMillis(10000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = r.json();
        const rec = Array.isArray(body) ? body[0] : undefined;
        satcatChecked++;
        satcatRows.push({
          noradId: item.noradId,
          name: String(rec?.OBJECT_NAME ?? item.name ?? ''),
          decay: String(rec?.DECAY_DATE ?? '').trim(),
        });
      } catch (e) {
        satcatErr = String(e).slice(0, 200);
        break;
      }
    }
  }

  let decayRows: any[] = [];
  let tipRows: any[] = [];
  let decayErr = '';
  let tipErr = '';
  const creds = plan.creds;
  const authed = typeof creds === 'object';
  const wantDecay = authed && plan.decayDue && plan.ids.length > 0;
  const wantTip = authed && plan.tipDue && plan.ids.length > 0;
  if (typeof creds === 'object' && (wantDecay || wantTip)) {
    try {
      const login = ctx.http.fetch('https://www.space-track.org/ajaxauth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `identity=${encodeURIComponent(creds.user)}&password=${encodeURIComponent(creds.pass)}`,
        timeout: TimeDuration.fromMillis(10000),
      });
      if (!login.ok) throw new Error(`login HTTP ${login.status}`);
      const cookie = sessionCookie(login.headers);
      if (!cookie) throw new Error('login returned no session cookie');
      const idList = plan.ids.join(',');
      const get = (path: string) => {
        const r = ctx.http.fetch(`https://www.space-track.org${path}`, {
          headers: { Cookie: cookie, Accept: 'application/json' },
          timeout: TimeDuration.fromMillis(15000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = r.json();
        if (!Array.isArray(body)) throw new Error('unexpected JSON');
        return body;
      };
      if (wantDecay) decayRows = get(`/basicspacedata/query/class/decay/NORAD_CAT_ID/${idList}/format/json`);
      if (wantTip) tipRows = get(`/basicspacedata/query/class/tip/NORAD_CAT_ID/${idList}/format/json`);
    } catch (e) {
      const msg = String(e).replace(/identity=|password=/gi, '').slice(0, 200);
      if (wantDecay) decayErr = msg;
      if (wantTip) tipErr = msg;
      decayRows = [];
      tipRows = [];
    }
  }

  ctx.withTx((tx: AnyCtx) => {
    const byNorad = new Map(plan.archived.map(o => [o.noradId, o]));
    let wrote = 0;
    for (const row of satcatRows) {
      const known = byNorad.get(row.noradId);
      const decayAt = row.decay ? parseUtcDate(row.decay) : undefined;
      markProbe(tx, row.noradId, !!decayAt);
      if (!decayAt) continue;
      if (
        autoOutcome(tx, {
          noradId: row.noradId,
          objectId: known?.objectId ?? '',
          name: row.name,
          decayAt,
          source: 'CELESTRAK_SATCAT',
          note: SATCAT_NOTE,
        })
      ) {
        wrote++;
      }
    }
    if (plan.batch.length > 0) {
      recordFeed(tx, 'celestrak_satcat', satcatErr === '', satcatErr, wrote);
      console.log(`celestrak_satcat: checked ${satcatChecked}/${plan.batch.length}, decay dates written ${wrote}`);
    } else if (plan.archived.length === 0) {
      console.log('celestrak_satcat: no archived objects to check');
    }

    if (creds === 'disabled' || creds === 'partial') {
      const why = creds === 'partial' ? ST_PARTIAL : ST_DISABLED;
      recordFeed(tx, 'spacetrack_decay', false, why, 0);
      recordFeed(tx, 'spacetrack_tip', false, why, 0);
      return;
    }
    if (wantDecay) {
      let n = 0;
      if (decayErr === '') {
        for (const [noradId, rows] of groupByNorad(decayRows)) {
          const chosen = bestHistoricalDecay(rows);
          const decayAt = chosen ? parseUtcDateTime(String(chosen.DECAY_EPOCH ?? '')) : undefined;
          if (!chosen || !decayAt) continue;
          const known = byNorad.get(noradId);
          if (
            autoOutcome(tx, {
              noradId,
              objectId: known?.objectId ?? '',
              name: String(chosen.OBJECT_NAME ?? known?.name ?? ''),
              decayAt,
              source: 'SPACETRACK_DECAY',
              note: `Space-Track decay class, MSG_TYPE ${String(chosen.MSG_TYPE ?? '')}. Historical decay epoch, not a TIP prediction.`,
            })
          ) {
            n++;
          }
        }
      }
      recordFeed(tx, 'spacetrack_decay', decayErr === '', decayErr, n);
    }
    if (wantTip) {
      let n = 0;
      if (tipErr === '') {
        const now = micros(tx.timestamp);
        for (const [noradId, rows] of groupByNorad(tipRows)) {
          const chosen = bestPassedTip(rows, now);
          const decayAt = chosen ? parseUtcDateTime(String(chosen.DECAY_EPOCH ?? '')) : undefined;
          if (!chosen || !decayAt) continue;
          const known = byNorad.get(noradId);
          const windowMin = Number(chosen.WINDOW);
          const windowNote = Number.isFinite(windowMin) ? ` TIP window ±${windowMin} min.` : '';
          if (
            autoOutcome(tx, {
              noradId,
              objectId: known?.objectId ?? '',
              name: String(chosen.OBJECT_NAME ?? known?.name ?? ''),
              decayAt,
              source: 'SPACETRACK_TIP',
              note: `Space-Track TIP DECAY_EPOCH is the predicted time at 10 km altitude, not a surveyed impact or a SATCAT decay date. Used only when no historical decay is on file.${windowNote}`,
            })
          ) {
            n++;
          }
        }
      }
      recordFeed(tx, 'spacetrack_tip', tipErr === '', tipErr, n);
    }
  });
}

export const outcomePoll = spacetimedb.procedure(
  { onSchedule: outcomeTick },
  { tick: outcomeTick.rowType },
  t.unit(),
  (ctx, _args) => {
    if (!ctx.sender.isEqual(ctx.databaseIdentity)) return {};
    pollOutcomes(ctx);
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
  pollOutcomes(ctx);
  return {};
});

// Operator correction. Replaces the outcome for this NORAD id and scores it again.
export const upsertOutcome = spacetimedb.reducer(
  {
    noradId: t.u32(),
    objectId: t.string(),
    name: t.string(),
    decayAt: t.timestamp(),
    source: t.string(),
    finds: t.string(),
    note: t.string(),
    replay: t.bool(),
  },
  (ctx, a) => {
    requireRole(ctx, 'operator');
    if (a.noradId <= 0) throw new SenderError('norad_id required');
    if (!OUTCOME_SOURCES.includes(a.source)) throw new SenderError('bad source');
    if (a.objectId) {
      const obj = ctx.db.reentryObject.id.find(a.objectId);
      if (!obj) throw new SenderError('unknown object');
      if (Number(obj.noradId) !== Number(a.noradId)) throw new SenderError('object norad_id does not match');
    }
    const row = {
      noradId: a.noradId,
      objectId: a.objectId,
      name: a.name.slice(0, 120),
      decayAt: a.decayAt,
      source: a.source,
      finds: JSON.stringify(parseFinds(a.finds)),
      note: a.note.slice(0, 500),
      replay: a.replay,
      updatedAt: ctx.timestamp,
    };
    if (ctx.db.reentryOutcome.noradId.find(a.noradId)) ctx.db.reentryOutcome.noradId.update(row);
    else ctx.db.reentryOutcome.insert(row);
    scoreOutcome(ctx, row);
  }
);

// Load one historical case. replay is forced on, so the score is never a live
// prediction. Elements are stored only when the caller supplies a real GP/OMM
// object; this reducer does not invent them. A GP set queues one FORECAST as of
// as_of (or the element EPOCH) through the normal worker path.
export const loadReplayCase = spacetimedb.reducer({ json: t.string() }, (ctx, { json }) => {
  requireRole(ctx, 'operator');
  let c: any;
  try {
    c = JSON.parse(json);
  } catch {
    throw new SenderError('replay case must be JSON');
  }
  const id = String(c.id ?? '');
  if (!id.startsWith('REPLAY-')) throw new SenderError('replay id must start with REPLAY-');
  const noradId = Math.trunc(Number(c.norad_id));
  if (!Number.isInteger(noradId) || noradId <= 0) throw new SenderError('norad_id required');
  if (c.elements != null && (typeof c.elements !== 'object' || Array.isArray(c.elements))) {
    throw new SenderError('elements must be a GP object or omitted');
  }
  const elements = c.elements ? JSON.stringify(c.elements) : '{}';
  const gp = c.elements ? hasGpElements(elements) : false;
  if (c.elements && !gp) throw new SenderError('elements must include MEAN_MOTION and EPOCH');
  const decayAt = parseUtcDateTime(String(c.decay_at ?? ''));
  if (!decayAt) throw new SenderError('bad decay_at');
  const source = String(c.source ?? 'OPERATOR');
  if (!OUTCOME_SOURCES.includes(source)) throw new SenderError('bad source');
  const name = String(c.name ?? id).slice(0, 120);
  upsertObject(ctx, {
    id,
    name,
    noradId,
    source: 'REPLAY',
    windowStart: undefined,
    windowEnd: undefined,
    elements,
    status: 'REPLAY',
    updatedAt: ctx.timestamp,
  });
  const row = {
    noradId,
    objectId: id,
    name,
    decayAt,
    source,
    finds: JSON.stringify(parseFinds(JSON.stringify(c.finds ?? []))),
    note: String(c.note ?? '').slice(0, 500),
    replay: true,
    updatedAt: ctx.timestamp,
  };
  if (ctx.db.reentryOutcome.noradId.find(noradId)) ctx.db.reentryOutcome.noradId.update(row);
  else ctx.db.reentryOutcome.insert(row);
  scoreOutcome(ctx, row);
  if (!gp) return;
  let asOf = c.as_of ? parseUtcDateTime(String(c.as_of)) : undefined;
  if (c.as_of && !asOf) throw new SenderError('bad as_of');
  if (!asOf) {
    try {
      asOf = parseUtcDateTime(String(JSON.parse(elements).EPOCH ?? ''));
    } catch {
      asOf = undefined;
    }
  }
  if (!asOf) throw new SenderError('GP elements need as_of or an EPOCH');
  if (micros(asOf) >= micros(decayAt)) throw new SenderError('as_of must be before decay_at');
  enqueueReplayForecast(ctx, id, asOf);
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
  // Two lanes per worker: one bulk job (FORECAST, DEBRIS) and one fast job
  // (CLASSIFY/UPDATE) at a time, so a long forecast never delays a sighting.
  const busy = new Set<string>();
  for (const j of ctx.db.computeJob.iter()) {
    if (j.claimedBy && j.claimedBy.isEqual(ctx.sender) && j.status === 'CLAIMED') busy.add(laneOf(j.kind));
  }
  const rank = (k: string) => (k === 'CLASSIFY' ? 0 : k === 'UPDATE' ? 1 : k === 'DEBRIS' ? 2 : 3);
  let next: any = null;
  for (const j of ctx.db.computeJob.iter()) {
    if (j.status !== 'QUEUED' || busy.has(laneOf(j.kind))) continue;
    // CLASSIFY first (it gates the sighting), then UPDATE, then DEBRIS, then FORECAST; oldest first.
    if (!next || rank(j.kind) < rank(next.kind) || (rank(j.kind) === rank(next.kind) && j.id < next.id)) {
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
    writeCorridor(ctx, job.objectId, a.bands, a.areaKm2_90, a.nSamples, a.nSightingsUsed, a.jobMs, tier);

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

// results: JSON list from gx10-compute /forecast. Writes the forecast table and,
// where the object re-enters inside the horizon, a new corridor version.
export const publishForecast = spacetimedb.reducer(
  {
    jobId: t.u64(),
    results: t.string(),
    jobMs: t.u32(),
    particleSteps: t.u64(),
    nPerObject: t.u32(),
    device: t.string(),
  },
  (ctx, a) => {
    requireRole(ctx, 'worker');
    const job = claimedJob(ctx, a.jobId, 'FORECAST');
    finishJob(ctx, job);
    // A replay job is scored as if it had been issued at as_of, not at wall clock.
    const issuedAt: Timestamp = job.asOf ?? ctx.timestamp;
    const me = ctx.db.computeStatus.worker.find(ctx.sender);
    const tier = me?.tier ?? 'unknown';
    let results: any[];
    try {
      results = JSON.parse(a.results);
    } catch {
      throw new SenderError('results must be JSON');
    }
    const ts = (iso?: string) => (iso ? Timestamp.fromDate(new Date(iso)) : undefined);
    let objects = 0;
    for (const r of results) {
      const obj = ctx.db.reentryObject.id.find(String(r.id));
      if (!obj) continue;
      objects++;
      const q = r.t_quantiles ?? {};
      const prev = ctx.db.forecast.objectId.find(obj.id);
      const row = {
        objectId: obj.id,
        version: prev ? prev.version + 1 : 1,
        status: String(r.status ?? 'error'),
        tQ05: ts(q['5']),
        tQ25: ts(q['25']),
        tQ50: ts(q['50']),
        tQ75: ts(q['75']),
        tQ95: ts(q['95']),
        decayedFrac: Number(r.decayed_frac ?? 0),
        horizonDays: Number(r.horizon_days ?? 0),
        nSamples: Number(r.n_samples ?? 0),
        ess: Number(r.ess ?? 0),
        calibrated: !!r.calibrated,
        bcM2Kg: Number(r.bc_m2_kg ?? 0),
        areaKm2_90: Number(r.area_km2_90 ?? 0),
        tier,
        device: a.device,
        computedAt: issuedAt,
        note: String(r.error ?? '').slice(0, 200),
      };
      if (prev) ctx.db.forecast.objectId.update(row);
      else ctx.db.forecast.insert(row);
      // Chain: objects likely to come down soon get a debris prediction.
      // Replay forecasts are for scoring a past case, not for live debris jobs.
      if (
        !job.asOf &&
        row.status === 'ok' &&
        row.decayedFrac >= DEBRIS_MIN_P &&
        row.tQ50 !== undefined &&
        micros(row.tQ50) - micros(ctx.timestamp) < DEBRIS_WITHIN
      ) {
        enqueueDebris(ctx, obj.id);
      }
      ctx.db.forecastHistory.insert({
        id: 0n,
        objectId: obj.id,
        version: row.version,
        tQ05: row.tQ05,
        tQ50: row.tQ50,
        tQ95: row.tQ95,
        decayedFrac: row.decayedFrac,
        nSamples: row.nSamples,
        tier,
        computedAt: issuedAt,
      });
      // Only re-draw the corridor from the forecast while no sightings shape it.
      const hasSightings = [...ctx.db.sighting.objectId.filter(obj.id)].some(
        (s: any) => s.verdict === 'ACCEPTED' || s.verdict === 'HELD'
      );
      if (Array.isArray(r.bands) && r.bands.length > 0 && !hasSightings) {
        writeCorridor(ctx, obj.id, JSON.stringify(r.bands), row.areaKm2_90, row.nSamples, 0, a.jobMs, tier, issuedAt);
      }
      const outcome = ctx.db.reentryOutcome.noradId.find(obj.noradId);
      if (outcome && micros(issuedAt) < micros(outcome.decayAt)) scoreOutcome(ctx, outcome);
    }
    ctx.db.computeRun.insert({
      id: 0n,
      kind: 'FORECAST',
      tier,
      device: a.device,
      objects,
      particles: BigInt(objects) * BigInt(a.nPerObject),
      particleSteps: a.particleSteps,
      ms: a.jobMs,
      finishedAt: ctx.timestamp,
    });
    if (me) {
      ctx.db.computeStatus.worker.update({
        ...me,
        variantsRunTotal: me.variantsRunTotal + BigInt(objects) * BigInt(a.nPerObject),
        lastJobMs: a.jobMs,
      });
    }
  }
);

// One-off: archive the elements we already hold (objects ingested before the
// archive existed). Skips objects whose current epoch is already archived.
export const archiveCurrentElements = spacetimedb.reducer({}, ctx => {
  requireRole(ctx, 'operator');
  for (const o of ctx.db.reentryObject.iter()) {
    let epoch = '';
    try {
      epoch = String(JSON.parse(o.elements).EPOCH ?? '');
    } catch {
      continue;
    }
    if (!epoch) continue;
    const have = [...ctx.db.elementsHistory.objectId.filter(o.id)].some((h: any) => h.epoch === epoch);
    if (!have) ctx.db.elementsHistory.insert({ id: 0n, objectId: o.id, epoch, elements: o.elements, fetchedAt: o.updatedAt });
  }
});

// result: JSON from gx10-compute /debris (docs/DEBRIS_MODEL.md §5).
export const publishDebris = spacetimedb.reducer(
  { jobId: t.u64(), result: t.string(), jobMs: t.u32(), particleSteps: t.u64(), device: t.string() },
  (ctx, a) => {
    requireRole(ctx, 'worker');
    const job = claimedJob(ctx, a.jobId, 'DEBRIS');
    finishJob(ctx, job);
    let r: any;
    try {
      r = JSON.parse(a.result);
    } catch {
      throw new SenderError('result must be JSON');
    }
    const me = ctx.db.computeStatus.worker.find(ctx.sender);
    const tier = me?.tier ?? 'unknown';
    const objectId = job.objectId;
    const prev = ctx.db.debrisForecast.objectId.find(objectId);
    const version = prev ? prev.version + 1 : 1;
    const fc = ctx.db.forecast.objectId.find(objectId);
    const num = (x: any, d = 0) => (Number.isFinite(Number(x)) ? Number(x) : d);
    const opt = (x: any) => (x === null || x === undefined || !Number.isFinite(Number(x)) ? undefined : Number(x));
    const row = {
      objectId,
      version,
      archetypeId: String(r.archetype ?? ''),
      forecastVersion: fc?.version ?? 0,
      nParticles: num(r.n_particles),
      pAnySurvives: num(r.p_any_survives),
      survivingMassKgMean: num(r.surviving_mass_kg?.mean),
      survivingMassKgP95: num(r.surviving_mass_kg?.p95),
      casualtyAreaM2Mean: num(r.casualty_area_m2?.mean),
      footprint: JSON.stringify(r.footprint?.bands ?? []),
      areaKm2_90: num(r.footprint?.area_km2_90),
      breakup: JSON.stringify(r.breakup ?? {}),
      tier,
      device: a.device,
      computedAt: ctx.timestamp,
      note: String(r.note ?? '').slice(0, 200),
    };
    if (prev) ctx.db.debrisForecast.objectId.update(row);
    else ctx.db.debrisForecast.insert(row);
    // Replace the child rows for this object.
    for (const c of [...ctx.db.debrisComponent.objectId.filter(objectId)]) ctx.db.debrisComponent.id.delete(c.id);
    for (const tr of [...ctx.db.debrisTrack.objectId.filter(objectId)]) ctx.db.debrisTrack.id.delete(tr.id);
    for (const c of r.components ?? []) {
      ctx.db.debrisComponent.insert({
        id: 0n,
        objectId,
        version,
        name: String(c.name ?? ''),
        material: String(c.material ?? ''),
        shape: String(c.shape ?? ''),
        count: num(c.count, 1),
        massKgStart: num(c.mass_kg?.start),
        pSurvive: num(c.p_survive),
        massKgMean: num(c.mass_kg?.mean),
        impactSpeedMsMean: opt(c.impact_speed_ms?.mean),
        impactEnergyJMean: opt(c.impact_energy_j?.mean),
        demiseAltKmMean: opt(c.demise_alt_km?.mean),
        impactLat: opt(c.impact?.lat),
        impactLon: opt(c.impact?.lon),
        footprint: JSON.stringify(c.footprint?.bands ?? []),
      });
    }
    for (const tr of (r.sample_tracks ?? []).slice(0, 80)) {
      ctx.db.debrisTrack.insert({
        id: 0n,
        objectId,
        version,
        component: String(tr.component ?? ''),
        survived: !!tr.survived,
        points: JSON.stringify((tr.points ?? []).slice(0, 60)),
      });
    }
    ctx.db.debrisHistory.insert({
      id: 0n,
      objectId,
      version,
      pAnySurvives: row.pAnySurvives,
      survivingMassKgMean: row.survivingMassKgMean,
      areaKm2_90: row.areaKm2_90,
      tier,
      computedAt: ctx.timestamp,
    });
    ctx.db.computeRun.insert({
      id: 0n,
      kind: 'DEBRIS',
      tier,
      device: a.device,
      objects: 1,
      particles: BigInt(row.nParticles),
      particleSteps: a.particleSteps,
      ms: a.jobMs,
      finishedAt: ctx.timestamp,
    });
  }
);

export const requestDebris = spacetimedb.reducer({ objectId: t.string() }, (ctx, { objectId }) => {
  requireRole(ctx, 'operator');
  if (!ctx.db.reentryObject.id.find(objectId)) throw new SenderError('unknown object');
  enqueueDebris(ctx, objectId);
});

// Store a documented archetype (data/archetypes/<id>.json).
export const upsertArchetype = spacetimedb.reducer({ id: t.string(), json: t.string() }, (ctx, { id, json }) => {
  requireRole(ctx, 'operator');
  let a: any;
  try {
    a = JSON.parse(json);
  } catch {
    throw new SenderError('archetype must be JSON');
  }
  if (!Array.isArray(a.components) || a.components.length === 0) throw new SenderError('components required');
  for (const c of a.components) {
    if (!c.name || !c.material || !c.shape || !(Number(c.mass_kg) > 0) || !Array.isArray(c.dims_m)) {
      throw new SenderError(`component ${c.name ?? '?'} needs name, material, shape, mass_kg, dims_m`);
    }
  }
  const row = {
    id,
    name: String(a.name ?? id),
    appliesTo: JSON.stringify(a.applies_to ?? {}),
    components: JSON.stringify(a.components),
    sources: JSON.stringify(a.sources ?? []),
    confidence: String(a.confidence ?? 'low'),
    updatedAt: ctx.timestamp,
  };
  if (ctx.db.archetype.id.find(id)) ctx.db.archetype.id.update(row);
  else ctx.db.archetype.insert(row);
});

// Catalog data for one object (GCAT / SATCAT / DISCOSweb via the poller).
export const ingestProfile = spacetimedb.reducer(
  {
    noradId: t.u32(),
    name: t.string(),
    objectType: t.string(),
    owner: t.string(),
    launchDate: t.string(),
    massKg: t.f64().optional(),
    dims: t.string(),
    shape: t.string(),
    rcsSize: t.string().optional(),
    sources: t.string(),
    confidence: t.string(),
  },
  (ctx, a) => {
    requireRole(ctx, 'poller', 'operator');
    const m = matchArchetype(ctx, a.name, a.objectType, a.massKg);
    const row = { ...a, massKg: a.massKg, rcsSize: a.rcsSize, archetypeId: m.id, matchReason: m.reason, updatedAt: ctx.timestamp };
    if (ctx.db.satelliteProfile.noradId.find(a.noradId)) ctx.db.satelliteProfile.noradId.update(row);
    else ctx.db.satelliteProfile.insert(row);
  }
);

// After loading or changing archetypes: re-match every profile and make sure
// every object has one.
export const rematchProfiles = spacetimedb.reducer({}, ctx => {
  requireRole(ctx, 'operator');
  for (const o of ctx.db.reentryObject.iter()) ensureProfile(ctx, o.noradId, o.name);
  for (const p of [...ctx.db.satelliteProfile.iter()]) {
    const m = matchArchetype(ctx, p.name, p.objectType, p.massKg);
    const guessed = p.confidence === 'low' && p.matchReason.includes('guessed');
    ctx.db.satelliteProfile.noradId.update({
      ...p,
      archetypeId: m.id,
      matchReason: guessed ? `${m.reason}; type guessed from name` : m.reason,
      updatedAt: ctx.timestamp,
    });
  }
});

export const requestForecast = spacetimedb.reducer({}, ctx => {
  requireRole(ctx, 'operator');
  enqueueForecast(ctx);
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
  const unhealthy = new Set<string>(); // fast lane: down after HEARTBEAT_STALE
  const gone = new Set<string>(); // bulk lane: reported unhealthy, or silent for HEARTBEAT_STALE_BULK
  for (const w of ctx.db.computeStatus.iter()) {
    const id = w.worker.toHexString();
    if (!w.healthy || olderThan(ctx, w.updatedAt, HEARTBEAT_STALE)) unhealthy.add(id);
    if (!w.healthy && !olderThan(ctx, w.updatedAt, HEARTBEAT_STALE)) gone.add(id); // worker said so itself
    if (olderThan(ctx, w.updatedAt, HEARTBEAT_STALE_BULK)) gone.add(id);
  }
  let forecastPending = false;
  let lastForecast = 0n;
  for (const j of [...ctx.db.computeJob.iter()]) {
    // Only the live batch (object_id *) holds the 20-minute forecast slot.
    // A replay FORECAST must not block or reset that schedule.
    if (j.kind === 'FORECAST' && j.objectId === '*') {
      if (j.status === 'QUEUED' || j.status === 'CLAIMED') forecastPending = true;
      if (micros(j.createdAt) > lastForecast) lastForecast = micros(j.createdAt);
    }
    if (j.status !== 'CLAIMED') continue;
    const bulk = laneOf(j.kind) === 'bulk';
    const lease = bulk ? LEASE_BULK : LEASE;
    const holderDown = j.claimedBy ? (bulk ? gone : unhealthy).has(j.claimedBy.toHexString()) : true;
    if (!holderDown && !olderThan(ctx, j.claimedAt, lease)) continue;
    const giveUp = j.attempts >= MAX_ATTEMPTS;
    ctx.db.computeJob.id.update({
      ...j,
      status: giveUp ? 'FAILED' : 'QUEUED',
      claimedBy: undefined,
      claimedAt: undefined,
      finishedAt: giveUp ? ctx.timestamp : undefined,
      error: holderDown ? 'worker went down' : 'lease expired',
    });
  }
  if (!forecastPending && micros(ctx.timestamp) - lastForecast > FORECAST_EVERY) enqueueForecast(ctx);
  for (const w of [...ctx.db.computeStatus.iter()]) {
    if (olderThan(ctx, w.updatedAt, WORKER_FORGET)) {
      ctx.db.computeStatus.worker.delete(w.worker); // gone for good: drop it from the panel
      continue;
    }
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
