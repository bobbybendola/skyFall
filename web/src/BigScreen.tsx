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
import { ComputeStatusBanner } from './computeStatus.tsx';

export function BigScreen() {
  const conn = useSpacetimeDB();
  const now = useNow(1000);
  const slowNow = useNow(10000);

  const [objects] = useTable(tables.reentryObject);
  const [corridors] = useTable(tables.corridor);
  const [history] = useTable(tables.corridorHistory);
  const [forecasts] = useTable(tables.forecast);
  const [runs] = useTable(tables.computeRun);
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

  const byId = useMemo(() => new Map(objects.map(o => [o.id, o])), [objects]);
  const fcById = useMemo(() => new Map(forecasts.map(f => [f.objectId, f])), [forecasts]);

  // "Coming down next": objects the GPU forecast to re-enter inside its horizon.
  const upcoming = useMemo(
    () =>
      forecasts
        .filter(f => f.status === 'ok' && f.decayedFrac > 0.02 && f.tQ50)
        .sort((a, b) => ms(a.tQ50) - ms(b.tQ50)),
    [forecasts]
  );
  const reentered = forecasts.filter(f => f.status === 'likely_reentered');
  const replayObj = objects.find(o => o.source === 'REPLAY');

  const [chosen, setChosen] = useState<string | null>(null);
  const objectId = chosen ?? upcoming[0]?.objectId ?? replayObj?.id ?? null;
  const obj = objectId ? byId.get(objectId) : undefined;
  const fc = objectId ? fcById.get(objectId) : undefined;
  const corridor = corridors.find(c => c.objectId === objectId);
  const rs = replay.find(r => r.id === 0);
  const [picked, setPicked] = useState<Record<string, unknown> | null>(null);

  const el = useMemo(() => (obj ? parseElements(obj.elements) : null), [obj?.elements]);
  const isStubReplay = obj?.source === 'REPLAY' && el?.model === 'circular-ground-track-stub';
  const winStart = ms(obj?.windowStart);
  const winEnd = ms(obj?.windowEnd);
  const markerT = isStubReplay ? winStart + (rs?.eventId === obj?.id ? replayClockS(rs, now) : 0) * 1000 : now;

  // Live positions of every object with real elements (SGP4, in the browser).
  const liveFC: FC = useMemo(() => {
    const when = new Date(slowNow);
    const feats: GeoJSON.Feature[] = [];
    for (const o of objects) {
      if (o.source === 'REPLAY') continue;
      const p = sgp4Point(o.id, o.elements, when);
      if (p) {
        feats.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
          properties: { objectId: o.id, name: o.name, norad: o.noradId, altKm: Math.round(p.altKm) },
        });
      }
    }
    return { type: 'FeatureCollection', features: feats };
  }, [objects, slowNow]);

  // Other objects' corridors drawn faintly; the selected one strongly.
  const othersFC: FC = useMemo(() => {
    const feats: GeoJSON.Feature[] = [];
    for (const c of corridors) {
      if (c.objectId === objectId) continue;
      const f = fcById.get(c.objectId);
      if (!f || f.status !== 'ok' || f.decayedFrac < 0.5) continue;
      for (const ft of corridorFC(c.bands).features) if (ft.properties?.level === 50) feats.push(ft);
    }
    return { type: 'FeatureCollection', features: feats };
  }, [corridors, objectId, fcById]);

  const selectedPoint = liveFC.features.find(f => f.properties?.objectId === objectId);

  const data = useMemo(
    () => ({
      corridor: corridorFC(corridor?.bands),
      others: othersFC,
      track: isStubReplay && el && Number.isFinite(winStart) ? trackFC(el, winStart, winEnd) : undefined,
      marker: isStubReplay && el
        ? pointFC(stubGroundPoint(el, markerT))
        : selectedPoint
          ? pointFC(selectedPoint.geometry.type === 'Point' ? (selectedPoint.geometry.coordinates as [number, number]) : null)
          : undefined,
      sightings: sightingsFC(sightings, objectId ?? undefined),
      candidates: liveFC,
    }),
    [corridor?.bands, othersFC, isStubReplay, el, winStart, winEnd, Math.round(markerT / 2000), selectedPoint, sightings, objectId, liveFC]
  );

  const objHistory = history.filter(h => h.objectId === objectId).sort((a, b) => b.version - a.version);
  const baseline = objHistory[objHistory.length - 1]?.areaKm290;
  const objSightings = sightings.filter(s => s.objectId === objectId);
  const countBy = (v: string) => objSightings.filter(s => s.verdict === v).length;
  const jobsBy = (s: string) => jobs.filter(j => j.status === s).length;
  const sw = weather.find(w => w.key === 'current');
  const lastRun = [...runs].sort((a, b) => Number(b.id - a.id))[0];
  const forecastJob = jobs.find(j => j.kind === 'FORECAST' && j.status === 'CLAIMED');

  return (
    <div className="screen">
      <MapView
        data={data}
        onFeatureClick={(_l, p) => {
          if (typeof p.objectId === 'string') setChosen(p.objectId);
          setPicked(p);
        }}
        onClick={() => setPicked(null)}
      />
      <aside className="panel">
        <header>
          <h1>SKYFALL</h1>
          <span className={conn.isActive ? 'ok' : 'bad'}>{conn.isActive ? 'live' : 'connecting…'}</span>
        </header>

        <ComputeStatusBanner placement="panel" />

        <section>
          <h2>Coming down next ({upcoming.length})</h2>
          <table className="list">
            <tbody>
              {upcoming.slice(0, 10).map(f => {
                const o = byId.get(f.objectId);
                return (
                  <tr key={f.objectId} className={f.objectId === objectId ? 'sel' : ''} onClick={() => setChosen(f.objectId)}>
                    <td>{o?.name ?? f.objectId}</td>
                    <td>{fmtTime(ms(f.tQ50))}</td>
                    <td>±{fmtSpan((ms(f.tQ95) - ms(f.tQ05)) / 2)}</td>
                    <td>{Math.round(f.decayedFrac * 100)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="muted">
            median re-entry · half-width of 90% window · chance within {upcoming[0]?.horizonDays ?? '?'} days
            {reentered.length > 0 && ` · ${reentered.length} likely already re-entered`}
          </div>
          {replayObj && (
            <button className="link" onClick={() => setChosen(replayObj.id)}>
              replay: {replayObj.name}
            </button>
          )}
        </section>

        <section>
          <h2>Selected</h2>
          {obj ? (
            <>
              <div className="big">{obj.name}</div>
              {obj.source === 'REPLAY' && <div className="sim">SIMULATED REPLAY: not a live event</div>}
              {obj.source !== 'REPLAY' && (
                <div className="muted">
                  NORAD {obj.noradId} · real orbit data ({obj.source === 'CANDIDATE' ? 'CelesTrak' : obj.source}) · elements{' '}
                  {String((parseElements(obj.elements) as any).EPOCH ?? '').slice(0, 16)}Z
                </div>
              )}
              {fc && fc.status === 'ok' && fc.tQ50 && (
                <div>
                  re-entry {fmtTime(ms(fc.tQ05))} → <b>{fmtTime(ms(fc.tQ50))}</b> → {fmtTime(ms(fc.tQ95))}
                  <div className="muted">
                    5% / median / 95% · {Math.round(fc.decayedFrac * 100)}% inside {fc.horizonDays} d · drag{' '}
                    {fc.calibrated ? 'fitted to observed decay' : 'from BSTAR (uncalibrated)'} · {fc.nSamples.toLocaleString()} particles ·{' '}
                    {fc.tier.toUpperCase()}
                  </div>
                </div>
              )}
              {fc && fc.status === 'ok' && !fc.tQ50 && <div className="muted">survives the {fc.horizonDays}-day horizon</div>}
              {fc && fc.status !== 'ok' && <div className="muted">{fc.status}: {fc.note}</div>}
              {isStubReplay && (
                <div>
                  window {fmtTime(winStart)} → {fmtTime(winEnd)}
                  {rs?.eventId === obj.id && ` · replay ${rs.running ? 'running' : 'paused'} t+${Math.round(replayClockS(rs, now))}s ×${rs.speed}`}
                </div>
              )}
            </>
          ) : (
            <div className="muted">waiting for forecasts</div>
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
                  {Math.round((1 - corridor.areaKm290 / baseline) * 100)}% smaller than first forecast ({fmtArea(baseline)})
                </div>
              )}
              <div>
                v{corridor.version} · {corridor.nSightingsUsed} sightings · {ago(corridor.computedAt, now)}
              </div>
              {latencyMs !== null && <div>last sighting → new corridor: {(latencyMs / 1000).toFixed(2)} s</div>}
              <table>
                <tbody>
                  {objHistory.slice(0, 5).map(h => (
                    <tr key={String(h.id)}>
                      <td>v{h.version}</td>
                      <td>{fmtArea(h.areaKm290)}</td>
                      <td>{h.nSightingsUsed} obs</td>
                      <td>{h.tier}</td>
                      <td>{(h.jobMs / 1000).toFixed(1)} s</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <div className="muted">no corridor (re-entry not inside the horizon)</div>
          )}
          <div className="chips">
            {['ACCEPTED', 'HELD', 'PENDING', 'REJECTED'].map(v => (
              <span key={v} className="chip" style={{ borderColor: VERDICT_COLOR[v] }}>
                {v.toLowerCase()} {countBy(v)}
              </span>
            ))}
          </div>
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
          {lastRun && (
            <div>
              last forecast: {lastRun.objects} objects · {Number(lastRun.particles).toLocaleString()} particles ·{' '}
              {(Number(lastRun.particleSteps) / 1e9).toFixed(2)}×10⁹ particle-steps · {(lastRun.ms / 1000).toFixed(0)} s on{' '}
              {lastRun.device} ({lastRun.tier.toUpperCase()}) · {ago(lastRun.finishedAt, now)}
            </div>
          )}
          {forecastJob && <div className="ok">forecast running…</div>}
          <div>
            queue: {jobsBy('QUEUED')} queued · {jobsBy('CLAIMED')} running · {jobsBy('DONE')} done · {jobsBy('FAILED')} failed
          </div>
          {workers.map(w => (
            <div key={w.worker.toHexString()} className={w.healthy ? 'ok' : 'bad'}>
              {w.tier.toUpperCase()} · {w.gpuName} · {w.healthy ? 'healthy' : 'down'} · beat {ago(w.updatedAt, now)} ·{' '}
              {Number(w.variantsRunTotal).toLocaleString()} particles total
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
          <div>{liveFC.features.length} decaying objects plotted live (CelesTrak elements, SGP4)</div>
        </section>
      </aside>
    </div>
  );
}

function fmtArea(km2: number): string {
  if (km2 >= 1e6) return `${(km2 / 1e6).toFixed(1)}M km²`;
  return `${Math.round(km2).toLocaleString()} km²`;
}

function fmtTime(t: number): string {
  if (!Number.isFinite(t)) return '?';
  return new Date(t).toISOString().slice(5, 16).replace('T', ' ') + 'Z';
}

function fmtSpan(msSpan: number): string {
  if (!Number.isFinite(msSpan)) return '?';
  const h = msSpan / 3.6e6;
  return h >= 1 ? `${h.toFixed(h >= 10 ? 0 : 1)} h` : `${Math.round(h * 60)} min`;
}
