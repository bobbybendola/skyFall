import { useMemo, useRef, useState } from 'react';
import { useSpacetimeDB, useTable } from 'spacetimedb/react';
import { tables } from './module_bindings/index.ts';
import { MapView, type FC } from './MapView.tsx';
import {
  ago,
  corridorFC,
  ms,
  parseElements,
  pointFC,
  replayClockS,
  sightingsFC,
  stubGroundPoint,
  trackFC,
  useNow,
  VERDICT_COLOR,
} from './live.ts';
import { sgp4Point } from './orbit.ts';

export function BigScreen() {
  const conn = useSpacetimeDB();
  const now = useNow(1000);
  const slowNow = useNow(10000);

  const [objects] = useTable(tables.reentryObject);
  const [corridors] = useTable(tables.corridor);
  const [history] = useTable(tables.corridorHistory);
  const [jobs] = useTable(tables.computeJob);
  const [workers] = useTable(tables.computeStatus);
  const [feeds] = useTable(tables.feedStatus);
  const [weather] = useTable(tables.spaceWeather);
  const [replay] = useTable(tables.replayState);

  // Latency probe: when this screen saw the newest sighting vs the next corridor.
  const lastSightingSeen = useRef<number | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [sightings] = useTable(tables.sighting, {
    onInsert: () => {
      lastSightingSeen.current = performance.now();
    },
  });
  useTable(tables.corridor, {
    onUpdate: () => {
      if (lastSightingSeen.current !== null) {
        setLatencyMs(performance.now() - lastSightingSeen.current);
        lastSightingSeen.current = null;
      }
    },
  });

  const tracked = objects.filter(o => o.source !== 'CANDIDATE');
  const candidates = objects.filter(o => o.source === 'CANDIDATE');
  const [chosen, setChosen] = useState<string | null>(null);
  const objectId = chosen ?? tracked[0]?.id ?? null;
  const obj = tracked.find(o => o.id === objectId);
  const corridor = corridors.find(c => c.objectId === objectId);
  const rs = replay.find(r => r.id === 0);
  const [picked, setPicked] = useState<Record<string, unknown> | null>(null);

  const el = useMemo(() => (obj ? parseElements(obj.elements) : null), [obj?.elements]);
  const winStart = ms(obj?.windowStart);
  const winEnd = ms(obj?.windowEnd);

  // Object marker: replay clock for REPLAY objects, wall clock otherwise.
  const markerT =
    obj?.source === 'REPLAY'
      ? winStart + (rs?.eventId === obj.id ? replayClockS(rs, now) : 0) * 1000
      : now;

  const candidateFC: FC = useMemo(() => {
    const when = new Date(slowNow);
    const feats: GeoJSON.Feature[] = [];
    for (const c of candidates) {
      const p = sgp4Point(c.id, c.elements, when);
      if (p) {
        feats.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
          properties: { name: c.name, norad: c.noradId, altKm: Math.round(p.altKm) },
        });
      }
    }
    return { type: 'FeatureCollection', features: feats };
  }, [candidates.length, slowNow]);

  const data = useMemo(
    () => ({
      corridor: corridorFC(corridor?.bands),
      track: el && Number.isFinite(winStart) ? trackFC(el, winStart, winEnd) : undefined,
      marker: el && Number.isFinite(markerT) ? pointFC(stubGroundPoint(el, markerT)) : undefined,
      sightings: sightingsFC(sightings, objectId ?? undefined),
      candidates: candidateFC,
    }),
    [corridor?.bands, el, winStart, winEnd, Math.round(markerT / 2000), sightings, objectId, candidateFC]
  );

  const objHistory = history
    .filter(h => h.objectId === objectId)
    .sort((a, b) => b.version - a.version);
  const baseline = objHistory[objHistory.length - 1]?.areaKm290;
  const objSightings = sightings.filter(s => s.objectId === objectId);
  const countBy = (v: string) => objSightings.filter(s => s.verdict === v).length;
  const jobsBy = (s: string) => jobs.filter(j => j.status === s).length;
  const sw = weather.find(w => w.key === 'current');
  const lowest = candidateFC.features
    .map(f => f.properties as { name: string; altKm: number })
    .sort((a, b) => a.altKm - b.altKm)
    .slice(0, 5);

  return (
    <div className="screen">
      <MapView data={data} onFeatureClick={(_l, p) => setPicked(p)} onClick={() => setPicked(null)} />
      <aside className="panel">
        <header>
          <h1>SKYFALL</h1>
          <span className={conn.isActive ? 'ok' : 'bad'}>{conn.isActive ? 'live' : 'connecting…'}</span>
        </header>

        <section>
          <h2>Object</h2>
          {tracked.length > 1 && (
            <select value={objectId ?? ''} onChange={e => setChosen(e.target.value)}>
              {tracked.map(o => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          )}
          {obj ? (
            <>
              <div className="big">{obj.name}</div>
              {obj.source === 'REPLAY' && <div className="sim">SIMULATED REPLAY: not a live event</div>}
              <div>
                window {fmtTime(winStart)} → {fmtTime(winEnd)}
              </div>
              {obj.source === 'REPLAY' && rs?.eventId === obj.id && (
                <div>
                  replay {rs.running ? 'running' : 'paused'} · t+{Math.round(replayClockS(rs, now))}s · ×{rs.speed}
                </div>
              )}
            </>
          ) : (
            <div className="muted">no tracked object yet</div>
          )}
        </section>

        <section>
          <h2>Corridor</h2>
          {corridor ? (
            <>
              <div className="big">
                {fmtArea(corridor.areaKm290)} <span className="muted">90% area</span>
              </div>
              {baseline && baseline !== corridor.areaKm290 && (
                <div>
                  {Math.round((1 - corridor.areaKm290 / baseline) * 100)}% smaller than baseline ({fmtArea(baseline)})
                </div>
              )}
              <div>
                v{corridor.version} · {corridor.nSightingsUsed} sightings · {ago(corridor.computedAt, now)}
              </div>
              {latencyMs !== null && <div>last sighting → new corridor: {(latencyMs / 1000).toFixed(2)} s</div>}
              <table>
                <tbody>
                  {objHistory.slice(0, 6).map(h => (
                    <tr key={String(h.id)}>
                      <td>v{h.version}</td>
                      <td>{fmtArea(h.areaKm290)}</td>
                      <td>{h.nSightingsUsed} obs</td>
                      <td>{h.tier}</td>
                      <td>{h.jobMs} ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <div className="muted">waiting for first corridor</div>
          )}
        </section>

        <section>
          <h2>Sightings</h2>
          <div className="chips">
            {['ACCEPTED', 'HELD', 'PENDING', 'REJECTED'].map(v => (
              <span key={v} className="chip" style={{ borderColor: VERDICT_COLOR[v] }}>
                {v.toLowerCase()} {countBy(v)}
              </span>
            ))}
          </div>
          <div className="muted">white ring = simulated reporter</div>
          {picked && 'verdict' in picked && (
            <div className="pick">
              #{String(picked.id)} {String(picked.verdict)} ({String(picked.mode)}) · {String(picked.reason)}
              {picked.p !== null && picked.p !== undefined && ` · p=${Number(picked.p).toFixed(2)}`}
            </div>
          )}
          {picked && 'name' in picked && (
            <div className="pick">
              {String(picked.name)} (NORAD {String(picked.norad)}) · {String(picked.altKm)} km altitude now
            </div>
          )}
        </section>

        <section>
          <h2>Compute</h2>
          <div>
            queue: {jobsBy('QUEUED')} queued · {jobsBy('CLAIMED')} running · {jobsBy('DONE')} done · {jobsBy('FAILED')} failed
          </div>
          {workers.map(w => (
            <div key={w.worker.toHexString()} className={w.healthy ? 'ok' : 'bad'}>
              {w.tier.toUpperCase()} · {w.gpuName} · {w.healthy ? 'healthy' : 'down'} · beat {ago(w.updatedAt, now)} ·{' '}
              {w.variantsRunTotal.toLocaleString()} variants · {w.lastJobMs} ms
            </div>
          ))}
          {workers.length === 0 && <div className="muted">no workers</div>}
        </section>

        <section>
          <h2>Live data</h2>
          {sw && (
            <div>
              Kp {sw.kp ?? '?'} ({sw.kpTime}Z) · F10.7 {sw.f107 ?? '?'} ({sw.f107Time}Z)
            </div>
          )}
          {feeds.map(f => (
            <div key={f.feed} className={f.lastError ? 'bad' : ''}>
              {f.feed}: ok {ago(f.lastOkAt, now)}
              {f.lastError && ` · ${f.lastError}`}
            </div>
          ))}
          <div>
            {candidateFC.features.length} decaying objects plotted (CelesTrak, real, SGP4 now)
          </div>
          {lowest.length > 0 && (
            <div className="muted">lowest now: {lowest.map(l => `${l.name} ${l.altKm} km`).join(' · ')}</div>
          )}
        </section>
      </aside>
    </div>
  );
}

function fmtArea(km2: number): string {
  if (km2 >= 1e6) return `${(km2 / 1e6).toFixed(2)}M km²`;
  return `${Math.round(km2).toLocaleString()} km²`;
}

function fmtTime(t: number): string {
  if (!Number.isFinite(t)) return '?';
  return new Date(t).toISOString().slice(5, 16).replace('T', ' ') + 'Z';
}
