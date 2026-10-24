// SKYFALL compute worker. Stateless: everything it needs comes from its
// SpacetimeDB subscription, and everything it produces goes through reducers.
// The rules (who gets which job, leases, failover) live in the module.
//
//   WORKER_TIER=gpu  on the GX10
//   WORKER_TIER=cpu  on the fallback laptop (only gets work when no GPU worker is healthy)

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
const COMPUTE_TIMEOUT_MS = 8000; // the module's lease is 10 s

// One identity per machine and tier, kept across restarts (*.token is git-ignored).
const tokenFile = join(here, '..', `.${TIER}.token`);
const savedToken =
  process.env.WORKER_TOKEN || (existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : undefined);

let conn: DbConnection;
let me: Identity;
let approved = false;
let healthy = false;
let gpuName = TIER === 'cpu' ? 'cpu' : 'unknown';
let busy: bigint | null = null; // job id being processed
let lastNote = '';

function log(msg: string): void {
  console.log(`${new Date().toISOString().slice(11, 19)} [${TIER}] ${msg}`);
}
function note(msg: string): void {
  if (msg !== lastNote) log(msg);
  lastNote = msg;
}
const iso = (ts: Timestamp) => ts.toDate().toISOString();

async function post(path: string, body: unknown): Promise<any> {
  const r = await fetch(`${COMPUTE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(COMPUTE_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`compute ${path} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
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
  try {
    await conn.reducers.reportComputeStatus({ tier: TIER, gpuName, healthy });
    if (!approved) log(`approved; compute ${healthy ? 'healthy' : 'DOWN'} at ${COMPUTE}`);
    approved = true;
    note(healthy ? `compute healthy (${gpuName})` : `compute DOWN at ${COMPUTE}`);
  } catch (e) {
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
  if (busy !== null || !approved || !healthy) return;
  // Shortcut only: the module enforces the same rule in claim_job.
  if (TIER === 'cpu' && gpuWorkerHealthy()) return;
  let queued = false;
  for (const j of conn.db.computeJob.iter()) if (j.status === 'QUEUED') queued = true;
  if (!queued) return;
  try {
    await conn.reducers.claimJob({});
  } catch (e) {
    note(`claim_job refused: ${String(e).slice(0, 120)}`);
  }
}

function checkForMyJob(): void {
  if (busy !== null) return;
  for (const j of conn.db.computeJob.iter()) {
    if (j.status === 'CLAIMED' && j.claimedBy && j.claimedBy.isEqual(me)) {
      void run(j);
      return;
    }
  }
}

// ---------------------------------------------------------------- jobs

type Job = { id: bigint; kind: string; objectId: string; sightingId?: bigint; attempts: number };

async function run(job: Job): Promise<void> {
  busy = job.id;
  const t0 = performance.now();
  try {
    if (job.kind === 'CLASSIFY') await runClassify(job);
    else if (job.kind === 'UPDATE') await runUpdate(job, t0);
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
    busy = null;
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

async function runUpdate(job: Job, t0: number): Promise<void> {
  const obj = conn.db.reentryObject.id.find(job.objectId);
  if (!obj) throw new Error(`object ${job.objectId} not in subscription`);
  if (!obj.windowStart || !obj.windowEnd) throw new Error('object has no re-entry window');
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
    object: { elements: JSON.parse(obj.elements), window_start: iso(obj.windowStart), window_end: iso(obj.windowEnd) },
    sightings,
    space_weather: sw ? { kp: sw.kp ?? null, f107: sw.f107 ?? null } : null,
  });
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
