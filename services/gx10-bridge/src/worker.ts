// SKYFALL compute worker. Stateless: everything it needs comes from its
// SpacetimeDB subscription, and everything it produces goes through reducers.
// The rules (who gets which job, leases, failover) live in the module.
//
//   WORKER_TIER=gpu  on the GX10
//   WORKER_TIER=cpu  on the fallback laptop (only gets work when no GPU worker is healthy)

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Identity, Timestamp } from 'spacetimedb';
import { DbConnection } from './module_bindings/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
for (const f of [join(here, '..', '.env'), join(root, '.env')]) {
  if (existsSync(f)) process.loadEnvFile(f);
}

const TIER = process.env.WORKER_TIER === 'cpu' ? 'cpu' : 'gpu';
const URI = process.env.SPACETIMEDB_URI || 'wss://maincloud.spacetimedb.com';
const DB = process.env.SPACETIMEDB_MODULE || 'skyfall-calhacks';
const COMPUTE = (process.env.COMPUTE_URL || 'http://localhost:8000').replace(/\/$/, '');
const HEARTBEAT_MS = 3000;
const CLAIM_POLL_MS = 300;
const FAST_TIMEOUT_MS = 55_000; // module fast-lane lease is 60 s
const BULK_TIMEOUT_MS = 14 * 60_000; // module bulk-lane lease is 15 min

// One identity per machine and tier, kept across restarts (*.token is git-ignored).
const tokenFile = join(here, '..', `.${TIER}.token`);
const savedToken =
  process.env.WORKER_TOKEN || (existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : undefined);

let conn: DbConnection;
let me: Identity;
let approved = false;
let healthy = false;
let gpuName = TIER === 'cpu' ? 'cpu' : 'unknown';
// Two lanes, mirroring the module: one bulk job (FORECAST, DEBRIS) and one fast job.
const busy: Record<'fast' | 'bulk', bigint | null> = { fast: null, bulk: null };
// Mirrors the module: DEBRIS runs in the bulk lane (see laneOf in spacetimedb/src/index.ts).
const laneOf = (kind: string): 'fast' | 'bulk' => (kind === 'FORECAST' || kind === 'DEBRIS' ? 'bulk' : 'fast');
let lastNote = '';

function log(msg: string): void {
  console.log(`${new Date().toISOString().slice(11, 19)} [${TIER}] ${msg}`);
}
function note(msg: string): void {
  if (msg !== lastNote) log(msg);
  lastNote = msg;
}
const iso = (ts: Timestamp) => ts.toDate().toISOString();

// Uses node:http, not fetch: fetch (undici) drops any request whose response
// headers take over 5 min, which cut off full-size GPU forecasts. Here the
// only limit is timeoutMs (the lane's lease).
function post(path: string, body: unknown, timeoutMs = FAST_TIMEOUT_MS): Promise<any> {
  const url = new URL(`${COMPUTE}${path}`);
  const data = Buffer.from(JSON.stringify(body));
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': data.length },
        signal: AbortSignal.timeout(timeoutMs),
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`compute ${path} HTTP ${status}: ${text.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (e) {
            reject(new Error(`compute ${path} returned invalid JSON: ${String(e)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.end(data);
  });
}

// ---------------------------------------------------------------- heartbeat

async function heartbeat(): Promise<void> {
  try {
    const r = await fetch(`${COMPUTE}/health`, { signal: AbortSignal.timeout(2000) });
    const h: any = await r.json();
    healthy = r.ok && h.ok === true;
    if (h.gpu) gpuName = String(h.gpu);
  } catch {
    healthy = false;
  }
  const t0 = Date.now();
  try {
    await conn.reducers.reportComputeStatus({ tier: TIER, gpuName, healthy });
    const ms = Date.now() - t0;
    if (ms > 5000) log(`slow heartbeat: maincloud took ${ms} ms (bulk jobs are kept for 60 s of silence)`);
    if (!approved) log(`approved; compute ${healthy ? 'healthy' : 'DOWN'} at ${COMPUTE}`);
    approved = true;
    note(healthy ? `compute healthy (${gpuName})` : `compute DOWN at ${COMPUTE}`);
  } catch (e) {
    if (approved) log(`heartbeat failed after ${Date.now() - t0} ms: ${String(e).slice(0, 120)}`);
    approved = false;
    note(
      `not approved yet. Operator: spacetime call ${DB} approve_worker ${me.toHexString()} --server maincloud` +
        `  (${String(e).slice(0, 80)})`
    );
  }
}

// ---------------------------------------------------------------- claiming

function gpuWorkerHealthy(): boolean {
  for (const w of conn.db.computeStatus.iter()) if (w.tier === 'gpu' && w.healthy) return true;
  return false;
}

async function maybeClaim(): Promise<void> {
  if (!approved || !healthy) return;
  // Shortcut only: the module enforces the same rule in claim_job.
  if (TIER === 'cpu' && gpuWorkerHealthy()) return;
  let queued = false;
  for (const j of conn.db.computeJob.iter()) {
    if (j.status === 'QUEUED' && busy[laneOf(j.kind)] === null) queued = true;
  }
  if (!queued) return;
  try {
    await conn.reducers.claimJob({});
  } catch (e) {
    note(`claim_job refused: ${String(e).slice(0, 120)}`);
  }
}

function checkForMyJob(): void {
  for (const j of conn.db.computeJob.iter()) {
    if (j.status === 'CLAIMED' && j.claimedBy && j.claimedBy.isEqual(me) && busy[laneOf(j.kind)] === null) {
      void run(j);
    }
  }
}

// ---------------------------------------------------------------- jobs

type Job = { id: bigint; kind: string; objectId: string; sightingId?: bigint; attempts: number; asOf?: Timestamp };

async function run(job: Job): Promise<void> {
  const lane = laneOf(job.kind);
  busy[lane] = job.id;
  const t0 = performance.now();
  try {
    if (job.kind === 'CLASSIFY') await runClassify(job);
    else if (job.kind === 'UPDATE') await runUpdate(job, t0);
    else if (job.kind === 'FORECAST') await runForecast(job, t0);
    else if (job.kind === 'DEBRIS') await runDebris(job, t0);
    else throw new Error(`unknown job kind ${job.kind}`);
    log(`job ${job.id} ${job.kind} ${job.objectId} done in ${Math.round(performance.now() - t0)} ms`);
  } catch (e) {
    log(`job ${job.id} ${job.kind} failed: ${String(e).slice(0, 200)}`);
    try {
      await conn.reducers.failJob({ jobId: job.id, error: String(e).slice(0, 300) });
    } catch (e2) {
      log(`fail_job refused (lease probably expired): ${String(e2).slice(0, 120)}`);
    }
  } finally {
    busy[lane] = null;
    setImmediate(() => void maybeClaim());
  }
}

async function runClassify(job: Job): Promise<void> {
  const s = job.sightingId === undefined ? undefined : conn.db.sighting.id.find(job.sightingId);
  if (!s) throw new Error('sighting not in subscription');
  const out = await post('/classify', { clip_ref: s.clipRef });
  const verdict = out.label === 'reentry' ? 'ACCEPTED' : 'REJECTED';
  const reason = `${out.label} (${Number(out.confidence).toFixed(2)}): ${out.reason ?? ''}`.slice(0, 200);
  await conn.reducers.setVerdict({ jobId: job.id, verdict, reason });
}

function trustOf(reporterKey: string): number {
  const r = conn.db.reporterStats.reporterKey.find(reporterKey);
  if (!r) return 0.5;
  // Same formula as docs/ARCHITECTURE.md (gx10-compute API).
  return (r.agreed + r.accepted + 1) / (r.agreed + r.disagreed + r.accepted + r.rejected + 2);
}

const isGp = (el: any) => el && typeof el === 'object' && 'MEAN_MOTION' in el && 'EPOCH' in el;

// Live batch: every GP object except REPLAY (those run as their own job, as of a past date).
// Replay job: that one object, with as_of so SGP4 starts from the historical epoch.
async function runForecast(job: Job, t0: number): Promise<void> {
  const replayOne = job.objectId !== '*';
  const objects = [...conn.db.reentryObject.iter()]
    .filter(o => (replayOne ? o.id === job.objectId : o.source !== 'REPLAY'))
    .map(o => ({ id: o.id, elements: JSON.parse(o.elements) }))
    .filter(o => isGp(o.elements));
  if (objects.length === 0) throw new Error(replayOne ? 'replay object has no orbit elements' : 'no objects with orbit elements');
  const sw = conn.db.spaceWeather.key.find('current');
  const body: Record<string, unknown> = {
    objects,
    space_weather: sw ? { kp: sw.kp ?? null, f107: sw.f107 ?? null } : null,
  };
  if (job.asOf) body.as_of = iso(job.asOf);
  log(`forecast: ${objects.length} objects on ${gpuName}${job.asOf ? ` as of ${iso(job.asOf)}` : ''}...`);
  const out = await post('/forecast', body, BULK_TIMEOUT_MS);
  await conn.reducers.publishForecast({
    jobId: job.id,
    results: JSON.stringify(out.results),
    jobMs: Math.round(performance.now() - t0),
    particleSteps: BigInt(Math.round(Number(out.particle_steps) || 0)),
    nPerObject: Number(out.n_per_object) || 0,
    device: String(out.device ?? gpuName),
  });
  const ok = out.results.filter((r: any) => r.status === 'ok').length;
  log(`forecast: ${ok}/${objects.length} ok, ${(Number(out.particle_steps) / 1e9).toFixed(2)}e9 particle-steps on ${out.device}`);
}

// Debris prediction for one object: its elements, profile, archetype, forecast
// and space weather all come from the subscription (stateless worker).
async function runDebris(job: Job, t0: number): Promise<void> {
  const obj = conn.db.reentryObject.id.find(job.objectId);
  if (!obj) throw new Error(`object ${job.objectId} not in subscription`);
  const elements = JSON.parse(obj.elements);
  if (!isGp(elements)) throw new Error('object has no orbit elements');
  const profile = conn.db.satelliteProfile.noradId.find(obj.noradId);
  const archId = profile?.archetypeId || 'generic';
  const arch = conn.db.archetype.id.find(archId) ?? conn.db.archetype.id.find('generic');
  if (!arch) throw new Error(`archetype ${archId} not loaded (run demo-ctl seed-archetypes)`);
  const fc = conn.db.forecast.objectId.find(obj.id);
  const sw = conn.db.spaceWeather.key.find('current');
  const out = await post('/debris', {
    object: { id: obj.id, name: obj.name, elements },
    profile: profile
      ? {
          norad_id: profile.noradId,
          object_type: profile.objectType,
          mass_kg: profile.massKg ?? null,
          rcs_size: profile.rcsSize ?? null,
          confidence: profile.confidence,
        }
      : null,
    archetype: { id: arch.id, name: arch.name, components: JSON.parse(arch.components), confidence: arch.confidence },
    forecast: fc?.tQ50 ? { t_q50: iso(fc.tQ50), t_q05: fc.tQ05 ? iso(fc.tQ05) : null, t_q95: fc.tQ95 ? iso(fc.tQ95) : null } : null,
    space_weather: sw ? { kp: sw.kp ?? null, f107: sw.f107 ?? null } : null,
  }, BULK_TIMEOUT_MS);
  await conn.reducers.publishDebris({
    jobId: job.id,
    result: JSON.stringify(out),
    jobMs: Math.round(performance.now() - t0),
    particleSteps: BigInt(Math.round(Number(out.particle_steps) || 0)),
    device: String(out.device ?? gpuName),
  });
}

async function runUpdate(job: Job, t0: number): Promise<void> {
  const obj = conn.db.reentryObject.id.find(job.objectId);
  if (!obj) throw new Error(`object ${job.objectId} not in subscription`);
  const elements = JSON.parse(obj.elements);
  const gp = isGp(elements);
  if (!gp && (!obj.windowStart || !obj.windowEnd)) throw new Error('object has no re-entry window');
  const sightings = [...conn.db.sighting.iter()]
    .filter(s => s.objectId === job.objectId && (s.verdict === 'ACCEPTED' || s.verdict === 'HELD'))
    .map(s => ({
      id: Number(s.id),
      trust: trustOf(s.reporterKey),
      lat: s.lat,
      lon: s.lon,
      observed_at: iso(s.observedAt),
      bearing_deg: s.bearingDeg ?? null,
    }));
  const sw = conn.db.spaceWeather.key.find('current');
  const out = await post('/update', {
    object: {
      id: obj.id,
      elements,
      window_start: obj.windowStart ? iso(obj.windowStart) : null,
      window_end: obj.windowEnd ? iso(obj.windowEnd) : null,
    },
    sightings,
    space_weather: sw ? { kp: sw.kp ?? null, f107: sw.f107 ?? null } : null,
  });
  if (gp && (!out.bands || out.bands.length === 0)) throw new Error('no re-entry inside the horizon for this object');
  await conn.reducers.publishCorridor({
    jobId: job.id,
    bands: JSON.stringify(out.bands),
    areaKm290: Number(out.area_km2_90),
    nSamples: Math.max(0, Math.round(Number(out.n_samples) || 0)),
    nSightingsUsed: sightings.length,
    jobMs: Math.round(performance.now() - t0),
    scores: JSON.stringify(out.scores ?? []),
  });
}

// ---------------------------------------------------------------- connect

conn = DbConnection.builder()
  .withUri(URI)
  .withDatabaseName(DB)
  .withToken(savedToken)
  .onConnect((c, identity, token) => {
    me = identity;
    if (!process.env.WORKER_TOKEN) writeFileSync(tokenFile, token);
    log(`connected to ${DB} as ${identity.toHexString()}`);
    c.subscriptionBuilder()
      .onApplied(() => {
        log('subscribed');
        void heartbeat();
        checkForMyJob();
      })
      .onError(ctx => log(`subscription error: ${String((ctx as any).event ?? ctx)}`))
      .subscribe([
        'SELECT * FROM compute_job',
        'SELECT * FROM compute_status',
        'SELECT * FROM reentry_object',
        'SELECT * FROM sighting',
        'SELECT * FROM reporter_stats',
        'SELECT * FROM space_weather',
        'SELECT * FROM forecast',
        'SELECT * FROM satellite_profile',
        'SELECT * FROM archetype',
      ]);
    c.db.computeJob.onInsert(() => void maybeClaim());
    c.db.computeJob.onUpdate(() => {
      checkForMyJob();
      void maybeClaim();
    });
    c.db.computeStatus.onUpdate(() => void maybeClaim()); // e.g. GPU worker went unhealthy
  })
  .onConnectError((_ctx, err) => {
    log(`connect error: ${err.message}`);
    process.exit(1);
  })
  .onDisconnect(() => {
    log('disconnected; exiting (restart me, held jobs come back through lease expiry)');
    process.exit(1);
  })
  .build();

setInterval(() => void heartbeat(), HEARTBEAT_MS);
setInterval(() => void maybeClaim(), CLAIM_POLL_MS);
log(`starting: tier=${TIER} compute=${COMPUTE} db=${DB} uri=${URI}`);
