import { useMemo, useState } from 'react';
import { Timestamp } from 'spacetimedb';
import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { reducers, tables } from './module_bindings/index.ts';
import { MapView } from './MapView.tsx';
import { corridorFC, ms, parseElements, pointFC, replayClockS, sightingsFC, trackFC, useNow, VERDICT_COLOR } from './live.ts';

export function Report() {
  const conn = useSpacetimeDB();
  useNow(1000); // re-render so the replay clock stays current
  const [objects] = useTable(tables.reentryObject);
  const [corridors] = useTable(tables.corridor);
  const [replay] = useTable(tables.replayState);
  const [mine] = useTable(tables.mySightings);
  const submit = useReducer(reducers.submitSighting);

  const [forecasts] = useTable(tables.forecast);
  // Objects people could see now: real ones forecast to come down soonest, then the replay.
  const tracked = useMemo(() => {
    const soon = forecasts
      .filter(f => f.status === 'ok' && f.decayedFrac > 0.02 && f.tQ50)
      .sort((a, b) => ms(a.tQ50) - ms(b.tQ50))
      .map(f => objects.find(o => o.id === f.objectId))
      .filter((o): o is (typeof objects)[number] => !!o);
    return [...soon, ...objects.filter(o => o.source === 'REPLAY')];
  }, [forecasts, objects]);
  const [chosen, setChosen] = useState<string | null>(null);
  const obj = tracked.find(o => o.id === (chosen ?? tracked[0]?.id));
  const corridor = corridors.find(c => c.objectId === obj?.id);
  const rs = replay.find(r => r.id === 0);
  const [pick, setPick] = useState<[number, number] | null>(null);
  const [bearing, setBearing] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [sending, setSending] = useState(false);

  const isReplay = obj?.source === 'REPLAY';
  const el = useMemo(() => (obj ? parseElements(obj.elements) : null), [obj?.elements]);
  const winStart = ms(obj?.windowStart);
  const winEnd = ms(obj?.windowEnd);

  const data = useMemo(
    () => ({
      corridor: corridorFC(corridor?.bands),
      track: el && Number.isFinite(winStart) ? trackFC(el, winStart, winEnd) : undefined,
      sightings: sightingsFC(mine, obj?.id),
      pick: pointFC(pick),
    }),
    [corridor?.bands, el, winStart, winEnd, mine, obj?.id, pick]
  );

  async function send() {
    if (!obj || !pick) return;
    // A replay sighting is stamped at the replay clock, so it lines up with
    // the simulated event; a live report is stamped now.
    const at = isReplay && rs?.eventId === obj.id ? winStart + replayClockS(rs, Date.now()) * 1000 : Date.now();
    const b = bearing.trim() === '' ? undefined : Number(bearing);
    setSending(true);
    setStatus(null);
    try {
      await submit({
        objectId: obj.id,
        lon: pick[0],
        lat: pick[1],
        observedAt: Timestamp.fromDate(new Date(at)),
        bearingDeg: b,
        clipRef: undefined,
        mode: isReplay ? 'DEMO' : 'LIVE',
      });
      setStatus({ ok: true, text: 'Sent. Watch the big screen.' });
      setPick(null);
    } catch (e) {
      setStatus({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="phone">
      <header>
        <h1>SKYFALL · report</h1>
        <span className={conn.isActive ? 'ok' : 'bad'}>{conn.isActive ? 'live' : 'connecting…'}</span>
      </header>
      {tracked.length > 1 && (
        <select value={obj?.id ?? ''} onChange={e => setChosen(e.target.value)}>
          {tracked.map(o => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      )}
      {obj && isReplay && <div className="sim">Demo on a SIMULATED replay. Your tap is marked DEMO.</div>}
      <p className="muted">Tap where you saw it streak across the sky.</p>
      <MapView data={data} onClick={(lon, lat) => setPick([lon, lat])} center={[-110, 30]} zoom={1.2} />
      <div className="form">
        <label>
          heading (optional, 0–359°)
          <input inputMode="numeric" value={bearing} onChange={e => setBearing(e.target.value)} placeholder="e.g. 270" />
        </label>
        <button disabled={!pick || !obj || sending || !conn.isActive} onClick={send}>
          {sending ? 'sending…' : pick ? `Report at ${pick[1].toFixed(2)}, ${pick[0].toFixed(2)}` : 'tap the map first'}
        </button>
        {status && <div className={status.ok ? 'ok' : 'bad'}>{status.text}</div>}
      </div>
      <section>
        <h2>My reports</h2>
        {[...mine]
          .sort((a, b) => Number(b.id - a.id))
          .slice(0, 8)
          .map(s => (
            <div key={String(s.id)}>
              <span className="dot" style={{ background: VERDICT_COLOR[s.verdict] }} /> #{String(s.id)}{' '}
              {s.verdict.toLowerCase()} · {s.reason}
              {s.pInlier !== undefined && ` · p=${s.pInlier.toFixed(2)}`}
            </div>
          ))}
        {mine.length === 0 && <div className="muted">none yet</div>}
      </section>
    </div>
  );
}
