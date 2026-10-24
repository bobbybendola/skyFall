// SKYFALL SpacetimeDB module. Table and reducer names are the contract in
// docs/ARCHITECTURE.md. TS uses camelCase; the default case policy stores them
// as snake_case (submitSighting -> submit_sighting, objectId -> object_id).
import { schema, table, t, SenderError } from 'spacetimedb/server';
import type { Identity } from 'spacetimedb';

// ---------- tables ----------

const reentryObject = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    name: t.string(),
    noradId: t.u32(),
    source: t.string(), // 'TIP' | 'REPLAY'
    windowStart: t.timestamp(),
    windowEnd: t.timestamp(),
    elements: t.string(), // JSON of GP/element fields
    status: t.string(),
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
    reporter: t.identity(),
    mode: t.string(), // 'DEMO' | 'LIVE'
    verdict: t.string(), // 'PENDING' | 'ACCEPTED' | 'HELD' | 'REJECTED'
    reason: t.string(),
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
  }
);

const computeStatus = table(
  { public: true },
  {
    worker: t.identity().primaryKey(),
    variantsRunTotal: t.u64(),
    lastJobMs: t.u32(),
    sightingsClassified: t.u32(),
    healthy: t.bool(),
    gpuName: t.string(),
    updatedAt: t.timestamp(),
  }
);

const feedStatus = table(
  { public: true },
  {
    feed: t.string().primaryKey(),
    lastOkAt: t.timestamp().optional(),
    lastError: t.string(),
    rowsIngested: t.u32(),
  }
);

// Single row, id = 0.
const replayState = table(
  { public: true },
  {
    id: t.u32().primaryKey(),
    running: t.bool(),
    tOffset: t.f64(), // seconds into the replay when startedAt was set
    eventId: t.string(),
    startedAt: t.timestamp(),
  }
);

// Private: who may call worker/poller/operator reducers.
const workerRegistry = table(
  { public: false },
  {
    identity: t.identity().primaryKey(),
    role: t.string(), // 'worker' | 'poller' | 'operator'
  }
);

const spacetimedb = schema({
  reentryObject,
  sighting,
  corridor,
  computeStatus,
  feedStatus,
  replayState,
  workerRegistry,
});
export default spacetimedb;

// ---------- helpers ----------

const ROLES = ['worker', 'poller', 'operator'];
const VERDICTS = ['PENDING', 'ACCEPTED', 'HELD', 'REJECTED'];

// Loosely typed so both helpers accept any reducer context.
function roleOf(ctx: { db: any; sender: Identity }): string | null {
  const row = ctx.db.workerRegistry.identity.find(ctx.sender);
  return row ? row.role : null;
}

function requireRole(ctx: { db: any; sender: Identity }, ...allowed: string[]): void {
  const role = roleOf(ctx);
  if (role === null || !allowed.includes(role)) {
    throw new SenderError(`caller is not authorized (needs ${allowed.join(' or ')})`);
  }
}

// ---------- reducers ----------

// Each role is claimed once by the first identity that asks for it. An
// existing operator may re-assign any role. Limit: whoever registers first
// wins, so register the bridge/poller/operator before the demo opens.
export const registerWorker = spacetimedb.reducer(
  { role: t.string() },
  (ctx, { role }) => {
    if (!ROLES.includes(role)) throw new SenderError(`unknown role ${role}`);
    const callerIsOperator = roleOf(ctx) === 'operator';
    const taken = [...ctx.db.workerRegistry.iter()].some(r => r.role === role);
    if (taken && !callerIsOperator) {
      const mine = ctx.db.workerRegistry.identity.find(ctx.sender);
      if (mine && mine.role === role) return; // already registered, idempotent
      throw new SenderError(`role ${role} already claimed`);
    }
    const existing = ctx.db.workerRegistry.identity.find(ctx.sender);
    if (existing) ctx.db.workerRegistry.identity.update({ identity: ctx.sender, role });
    else ctx.db.workerRegistry.insert({ identity: ctx.sender, role });
  }
);

export const ingestObject = spacetimedb.reducer(
  {
    id: t.string(),
    name: t.string(),
    noradId: t.u32(),
    source: t.string(),
    windowStart: t.timestamp(),
    windowEnd: t.timestamp(),
    elements: t.string(),
    status: t.string(),
  },
  (ctx, a) => {
    requireRole(ctx, 'poller', 'operator');
    if (a.source !== 'TIP' && a.source !== 'REPLAY') throw new SenderError('bad source');
    const row = { ...a, updatedAt: ctx.timestamp };
    if (ctx.db.reentryObject.id.find(a.id)) ctx.db.reentryObject.id.update(row);
    else ctx.db.reentryObject.insert(row);
  }
);

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
    if (!ctx.db.reentryObject.id.find(a.objectId)) throw new SenderError('unknown object');
    if (!(a.lat >= -90 && a.lat <= 90 && a.lon >= -180 && a.lon <= 180)) {
      throw new SenderError('lat/lon out of range');
    }
    if (a.mode !== 'DEMO' && a.mode !== 'LIVE') throw new SenderError('mode must be DEMO or LIVE');
    if (a.bearingDeg !== undefined && !(a.bearingDeg >= 0 && a.bearingDeg < 360)) {
      throw new SenderError('bearing must be in [0, 360)');
    }
    ctx.db.sighting.insert({
      id: 0n,
      objectId: a.objectId,
      lat: a.lat,
      lon: a.lon,
      observedAt: a.observedAt,
      bearingDeg: a.bearingDeg,
      clipRef: a.clipRef,
      reporter: ctx.sender,
      mode: a.mode,
      verdict: 'PENDING',
      reason: '',
    });
  }
);

export const setVerdict = spacetimedb.reducer(
  { sightingId: t.u64(), verdict: t.string(), reason: t.string() },
  (ctx, { sightingId, verdict, reason }) => {
    requireRole(ctx, 'worker');
    if (!VERDICTS.includes(verdict)) throw new SenderError('bad verdict');
    const row = ctx.db.sighting.id.find(sightingId);
    if (!row) return; // deleted by reset_demo; not an error
    ctx.db.sighting.id.update({ ...row, verdict, reason });
  }
);

export const publishCorridor = spacetimedb.reducer(
  {
    objectId: t.string(),
    bands: t.string(),
    areaKm2_90: t.f64(),
    nSamples: t.u32(),
    nSightingsUsed: t.u32(),
  },
  (ctx, a) => {
    requireRole(ctx, 'worker');
    const prev = ctx.db.corridor.objectId.find(a.objectId);
    const row = { ...a, version: prev ? prev.version + 1 : 1, computedAt: ctx.timestamp };
    if (prev) ctx.db.corridor.objectId.update(row);
    else ctx.db.corridor.insert(row);
  }
);

export const reportComputeStatus = spacetimedb.reducer(
  {
    variantsRunTotal: t.u64(),
    lastJobMs: t.u32(),
    sightingsClassified: t.u32(),
    healthy: t.bool(),
    gpuName: t.string(),
  },
  (ctx, a) => {
    requireRole(ctx, 'worker');
    const row = { ...a, worker: ctx.sender, updatedAt: ctx.timestamp };
    if (ctx.db.computeStatus.worker.find(ctx.sender)) ctx.db.computeStatus.worker.update(row);
    else ctx.db.computeStatus.insert(row);
  }
);

export const reportFeedStatus = spacetimedb.reducer(
  { feed: t.string(), ok: t.bool(), error: t.string(), rowsIngested: t.u32() },
  (ctx, { feed, ok, error, rowsIngested }) => {
    requireRole(ctx, 'poller', 'operator');
    const prev = ctx.db.feedStatus.feed.find(feed);
    const row = {
      feed,
      lastOkAt: ok ? ctx.timestamp : prev?.lastOkAt,
      lastError: ok ? '' : error,
      rowsIngested: (prev?.rowsIngested ?? 0) + rowsIngested,
    };
    if (prev) ctx.db.feedStatus.feed.update(row);
    else ctx.db.feedStatus.insert(row);
  }
);

export const startReplay = spacetimedb.reducer(
  { eventId: t.string(), tOffset: t.f64() },
  (ctx, { eventId, tOffset }) => {
    requireRole(ctx, 'operator');
    if (!ctx.db.reentryObject.id.find(eventId)) throw new SenderError('unknown replay object');
    const row = { id: 0, running: true, tOffset, eventId, startedAt: ctx.timestamp };
    if (ctx.db.replayState.id.find(0)) ctx.db.replayState.id.update(row);
    else ctx.db.replayState.insert(row);
  }
);

// Clears DEMO sightings and the corridor for one object. The bridge sees the
// corridor row disappear and republishes the no-sightings baseline.
export const resetDemo = spacetimedb.reducer(
  { objectId: t.string() },
  (ctx, { objectId }) => {
    requireRole(ctx, 'operator');
    for (const s of [...ctx.db.sighting.objectId.filter(objectId)]) {
      if (s.mode === 'DEMO') ctx.db.sighting.id.delete(s.id);
    }
    ctx.db.corridor.objectId.delete(objectId);
    const rs = ctx.db.replayState.id.find(0);
    if (rs) ctx.db.replayState.id.update({ ...rs, running: false, tOffset: 0 });
  }
);
