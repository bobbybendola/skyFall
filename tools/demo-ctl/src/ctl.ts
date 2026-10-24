// SKYFALL operator console. Every command is a reducer call; the module decides
// whether it is allowed.
//
//   npm start -- <command> [args]
//
// Identity: OPERATOR_TOKEN from .env if set, otherwise the token of your
// `spacetime login` (read from the CLI config at runtime, never copied).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  poll                           fetch NOAA + CelesTrak now
  forecast                       queue a GPU forecast for all objects now
  archive                        archive current elements of every object (one-off backfill)
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
    case 'archive':
      return r.archiveCurrentElements({});
    case 'forecast':
      return r.requestForecast({});
    case 'poll':
      await conn.procedures.pollFeedsNow({});
      return;
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
        for (const w of d.computeStatus.iter()) {
          const age = Math.round((Date.now() - w.updatedAt.toDate().getTime()) / 1000);
          console.log(`worker ${w.worker.toHexString().slice(0, 12)}… ${w.tier} ${w.gpuName} ${w.healthy ? 'HEALTHY' : 'down'} (heartbeat ${age}s ago, ${w.variantsRunTotal} variants)`);
        }
        for (const f of d.feedStatus.iter()) {
          console.log(`feed ${f.feed}: last ok ${f.lastOkAt?.toDate().toISOString() ?? 'never'} ${f.lastError ? 'ERR ' + f.lastError : ''}`);
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
        'SELECT * FROM feed_status',
        'SELECT * FROM space_weather',
        'SELECT * FROM replay_state',
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
