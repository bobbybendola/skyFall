// SKYFALL operator console. Every command is a reducer call; the module decides
// whether it is allowed.
//
//   npm start -- <command> [args]
//
// Identity: OPERATOR_TOKEN from .env if set, otherwise the token of your
// `spacetime login` (read from the CLI config at runtime, never copied).

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Timestamp } from 'spacetimedb';
import { DbConnection } from './module_bindings/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));

const URI = process.env.SPACETIMEDB_URI || 'wss://maincloud.spacetimedb.com';
const DB = process.env.SPACETIMEDB_MODULE || 'skyfall-calhacks';

function cliToken(): string | undefined {
  const dirs = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'SpacetimeDB', 'config'),
    process.env.HOME && join(process.env.HOME, '.config', 'spacetime'),
  ].filter(Boolean) as string[];
  for (const d of dirs) {
    const f = join(d, 'cli.toml');
    if (!existsSync(f)) continue;
    const m = readFileSync(f, 'utf8').match(/^spacetimedb_token\s*=\s*"([^"]+)"/m);
    if (m) return m[1];
  }
  return undefined;
}

const HELP = `commands:
  whoami                         print this identity
  status                         objects, corridor, jobs, workers, feeds
  claim-operator                 register this identity as operator (first come)
  approve <identity-hex>         let a worker take jobs
  revoke <identity-hex>
  seed [file]                    ingest a replay object (default data/replay/placeholder-event.json)
  script <event-id> <file>       load a simulated sighting script (from tools/sighting-gen)
  start <event-id> [offset_s] [speed]
  pause
  reset <event-id>               clear DEMO/SIM sightings, history; queue a baseline corridor
  poll                           fetch NOAA, CelesTrak, and outcome decay dates now
  forecast                       queue a GPU forecast for all objects now
  outcome <norad> <decay-iso> <source> <replay 0|1> [object-id] [finds-json] [note]
                                 insert or correct an official decay, then score it
  load-replay [file]             load historical cases (default data/replay/historical-cases.json)
  archive                        archive current elements of every object (one-off backfill)
  seed-archetypes [dir]          load data/archetypes/*.json, then re-match every profile
  rematch                        re-match every satellite profile to an archetype
  debris <object-id>             queue a debris prediction for one object now
  export <file>                  write objects + space weather as JSON (test input for gx10-compute)`;

const [cmd, ...args] = process.argv.slice(2);
if (!cmd || cmd === 'help') {
  console.log(HELP);
  process.exit(0);
}

const tsOf = (s?: string) => (s ? Timestamp.fromDate(new Date(s)) : undefined);

async function runCommand(conn: DbConnection, idHex: string): Promise<void> {
  const r = conn.reducers;
  switch (cmd) {
    case 'whoami':
      console.log(idHex);
      return;
    case 'claim-operator':
      return r.registerWorker({ role: 'operator' });
    case 'approve':
      return r.approveWorker({ identityHex: need(args[0], 'identity hex') });
    case 'revoke':
      return r.revokeWorker({ identityHex: need(args[0], 'identity hex') });
    case 'seed': {
      const file = args[0] ?? join(root, 'data', 'replay', 'placeholder-event.json');
      const o = JSON.parse(readFileSync(file, 'utf8'));
      await r.ingestObject({
        id: o.id,
        name: o.name,
        noradId: Number(o.norad_id ?? 0),
        source: o.source,
        windowStart: tsOf(o.window_start),
        windowEnd: tsOf(o.window_end),
        elements: JSON.stringify(o.elements),
        status: o.status,
      });
      console.log(`seeded ${o.id}`);
      return;
    }
    case 'script': {
      const rows = readFileSync(need(args[1], 'file'), 'utf8');
      await r.loadReplayScript({ eventId: need(args[0], 'event id'), rows });
      console.log(`loaded ${JSON.parse(rows).length} simulated sightings`);
      return;
    }
    case 'start':
      return r.startReplay({
        eventId: need(args[0], 'event id'),
        tOffset: Number(args[1] ?? 0),
        speed: Number(args[2] ?? 1),
      });
    case 'pause':
      return r.pauseReplay({});
    case 'reset':
      return r.resetDemo({ objectId: need(args[0], 'event id') });
    case 'seed-archetypes': {
      const dir = args[0] ?? join(root, 'data', 'archetypes');
      const files = readdirSync(dir).filter(f => f.endsWith('.json'));
      for (const f of files) {
        const json = readFileSync(join(dir, f), 'utf8');
        const id = JSON.parse(json).id ?? f.replace(/\.json$/, '');
        await r.upsertArchetype({ id, json });
        console.log(`archetype ${id}`);
      }
      await r.rematchProfiles({});
      console.log(`loaded ${files.length} archetypes; profiles re-matched`);
      return;
    }
    case 'rematch':
      return r.rematchProfiles({});
    case 'debris':
      return r.requestDebris({ objectId: need(args[0], 'object id') });
    case 'archive':
      return r.archiveCurrentElements({});
    case 'forecast':
      return r.requestForecast({});
    case 'poll':
      await conn.procedures.pollFeedsNow({});
      return;
    case 'outcome':
      await r.upsertOutcome({
        noradId: Number(need(args[0], 'norad id')),
        decayAt: tsOf(need(args[1], 'decay iso'))!,
        source: need(args[2], 'source'),
        replay: args[3] === '1' || args[3] === 'true',
        objectId: args[4] ?? '',
        finds: args[5] ?? '[]',
        note: args[6] ?? '',
        name: '',
      });
      console.log(`outcome ${args[0]}`);
      return;
    case 'load-replay': {
      const file = args[0] ?? join(root, 'data', 'replay', 'historical-cases.json');
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      const cases = Array.isArray(parsed) ? parsed : (parsed.cases ?? [parsed]);
      for (const c of cases) {
        await r.loadReplayCase({ json: JSON.stringify(c) });
        console.log(`replay case ${c.id} (elements ${c.elements ? 'yes' : 'omitted'})`);
      }
      return;
    }
    case 'status':
      return printStatus(conn);
    case 'export':
      return exportJson(conn, need(args[0], 'file'));
    default:
      throw new Error(`unknown command ${cmd}\n${HELP}`);
  }
}

function need(v: string | undefined, what: string): string {
  if (!v) throw new Error(`missing ${what}`);
  return v;
}

function exportJson(conn: DbConnection, file: string): Promise<void> {
  return new Promise(resolve => {
    conn
      .subscriptionBuilder()
      .onApplied(() => {
        const objects = [...conn.db.reentryObject.iter()].map(o => ({
          id: o.id,
          name: o.name,
          source: o.source,
          elements: JSON.parse(o.elements),
          window_start: o.windowStart?.toDate().toISOString() ?? null,
          window_end: o.windowEnd?.toDate().toISOString() ?? null,
        }));
        const sw = conn.db.spaceWeather.key.find('current');
        const out = { exported_at: new Date().toISOString(), space_weather: sw ? { kp: sw.kp ?? null, f107: sw.f107 ?? null } : null, objects };
        writeFileSync(file, JSON.stringify(out, null, 1));
        console.log(`wrote ${objects.length} objects to ${file}`);
        resolve();
      })
      .subscribe(['SELECT * FROM reentry_object', 'SELECT * FROM space_weather']);
  });
}

function printStatus(conn: DbConnection): Promise<void> {
  return new Promise(resolve => {
    conn
      .subscriptionBuilder()
      .onApplied(() => {
        const d = conn.db;
        const objs = [...d.reentryObject.iter()];
        console.log(`objects: ${objs.length} (${objs.filter(o => o.source !== 'CANDIDATE').map(o => o.id).join(', ') || 'no tracked'})`);
        for (const c of d.corridor.iter()) {
          console.log(`corridor ${c.objectId}: v${c.version}, 90% area ${Math.round(c.areaKm290)} km2, ${c.nSightingsUsed} sightings`);
        }
        const jobs = [...d.computeJob.iter()];
        const by = (s: string) => jobs.filter(j => j.status === s).length;
        console.log(`jobs: queued ${by('QUEUED')}, claimed ${by('CLAIMED')}, done ${by('DONE')}, failed ${by('FAILED')}`);
        const debrisJobs = jobs.filter(j => j.kind === 'DEBRIS');
        const byDebris = (s: string) => debrisJobs.filter(j => j.status === s).length;
        console.log(`debris jobs: queued ${byDebris('QUEUED')}, claimed ${byDebris('CLAIMED')}, done ${byDebris('DONE')}, failed ${byDebris('FAILED')}`);
        for (const j of debrisJobs.filter(j => j.status !== 'DONE').slice(0, 12)) {
          console.log(`  debris job ${j.id} ${j.objectId} ${j.status} attempts ${j.attempts}${j.error ? ' ' + j.error : ''}`);
        }
        const nowMs = Date.now();
        const hour72 = 72 * 3600 * 1000;
        const nameOf = (id: string) => objs.find(o => o.id === id)?.name ?? id;
        const forecasts = [...d.forecast.iter()];
        const soon = forecasts
          .filter(f => {
            const t50 = f.tQ50?.toDate().getTime();
            return f.status === 'ok' && f.decayedFrac >= 0.2 && t50 !== undefined && t50 - nowMs < hour72 && t50 > nowMs - 6 * 3600 * 1000;
          })
          .sort((a, b) => a.tQ50!.toDate().getTime() - b.tQ50!.toDate().getTime());
        console.log(`forecasts: ${forecasts.length}; debris candidates (p>=0.2, median within 72h): ${soon.length}`);
        for (const f of soon.slice(0, 12)) {
          console.log(`  candidate ${f.objectId} ${nameOf(f.objectId)} p=${f.decayedFrac.toFixed(2)} t50=${f.tQ50!.toDate().toISOString()} ${f.tier}`);
        }
        const debris = [...d.debrisForecast.iter()];
        console.log(`debris results: ${debris.length}`);
        for (const row of debris) {
          console.log(
            `  debris ${row.objectId} ${nameOf(row.objectId)} v${row.version} ${row.tier} ${row.device} archetype=${row.archetypeId} p_any=${row.pAnySurvives.toFixed(2)} particles=${row.nParticles}`
          );
        }
        for (const w of d.computeStatus.iter()) {
          const age = Math.round((Date.now() - w.updatedAt.toDate().getTime()) / 1000);
          console.log(`worker ${w.worker.toHexString().slice(0, 12)}… ${w.tier} ${w.gpuName} ${w.healthy ? 'HEALTHY' : 'down'} (heartbeat ${age}s ago, ${w.variantsRunTotal} variants)`);
        }
        for (const f of d.feedStatus.iter()) {
          console.log(`feed ${f.feed}: last ok ${f.lastOkAt?.toDate().toISOString() ?? 'never'} ${f.lastError ? 'ERR ' + f.lastError : ''} rows ${f.rowsIngested}`);
        }
        for (const o of d.reentryOutcome.iter()) {
          console.log(`outcome ${o.noradId} ${o.source} ${o.decayAt.toDate().toISOString()} replay=${o.replay}`);
        }
        const scores = [...d.forecastScore.iter()].sort((a, b) => Number(a.id - b.id));
        for (const s of scores) {
          console.log(
            `score ${s.id} norad ${s.noradId} ${s.status} err ${s.hoursError ?? '—'}h inside ${s.insideWindow ?? '—'} calibrated ${s.calibrated} lead ${s.leadTimeHours ?? '—'}h replay=${s.replay} ${s.source} finds ${s.findHits}`
          );
        }
        const sw = d.spaceWeather.key.find('current');
        if (sw) console.log(`space weather: Kp ${sw.kp ?? '?'} (${sw.kpTime}), F10.7 ${sw.f107 ?? '?'} (${sw.f107Time})`);
        const rs = d.replayState.id.find(0);
        if (rs) console.log(`replay: ${rs.eventId} ${rs.running ? 'RUNNING' : 'paused'} at t+${Math.round(rs.tOffset)}s x${rs.speed}`);
        resolve();
      })
      .subscribe([
        'SELECT * FROM reentry_object',
        'SELECT * FROM corridor',
        'SELECT * FROM compute_job',
        'SELECT * FROM compute_status',
        'SELECT * FROM forecast',
        'SELECT * FROM debris_forecast',
        'SELECT * FROM feed_status',
        'SELECT * FROM space_weather',
        'SELECT * FROM replay_state',
        'SELECT * FROM reentry_outcome',
        'SELECT * FROM forecast_score',
      ]);
  });
}

// Exiting inside a socket callback trips a libuv assertion on Windows.
function finish(conn: DbConnection, code: number): void {
  process.exitCode = code;
  conn.disconnect();
  setTimeout(() => process.exit(code), 200);
}

DbConnection.builder()
  .withUri(URI)
  .withDatabaseName(DB)
  .withToken(process.env.OPERATOR_TOKEN || cliToken())
  .onConnect(async (conn, identity) => {
    try {
      await runCommand(conn, identity.toHexString());
      if (cmd !== 'status' && cmd !== 'whoami') console.log('ok');
      finish(conn, 0);
    } catch (e) {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      finish(conn, 1);
    }
  })
  .onConnectError((_ctx, err) => {
    console.error(`connect error: ${err.message}`);
    process.exit(1);
  })
  .build();
