// Testing aid: lists every object with a live GPU debris prediction
// (debris_forecast rows). Click a name to select it and lock the camera onto it.
import type { Viewer } from 'cesium';
import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings/index.ts';
import { satKey, type ReentryLookup, type TrackedObject } from './satellites.ts';
import { reentryCss, relTime, useClockNow } from './legend.tsx';
import { followObject } from './selectionLayer.tsx';
import { setSelected, useSelected } from './selection.ts';
import { sgp4Point } from '../orbit.ts';

function altKm(obj: TrackedObject, nowMs: number): string {
  const p = sgp4Point(satKey(obj), obj.elements, new Date(nowMs));
  return p ? `${Math.round(p.altKm)} km` : '— km';
}

export function DebrisList({ viewer, objects, reentry }: { viewer: Viewer | null; objects: TrackedObject[]; reentry: ReentryLookup }) {
  const [forecasts] = useTable(tables.debrisForecast);
  const selected = useSelected();
  const nowMs = useClockNow(viewer);
  const rows = forecasts
    .map(f => ({ f, obj: objects.find(o => o.id === f.objectId) }))
    .filter((r): r is { f: (typeof forecasts)[number]; obj: TrackedObject } => r.obj !== undefined)
    .map(r => ({ ...r, t50: reentry.get(r.obj.id)?.t50 ?? Infinity }))
    .sort((a, b) => a.t50 - b.t50 || a.obj.name.localeCompare(b.obj.name)); // soonest re-entry first

  const pick = (obj: TrackedObject) => {
    setSelected(obj.id);
    if (viewer) followObject(viewer, obj.id);
  };

  return (
    <div className="globe-debris-list">
      <b>Live debris ({rows.length})</b> <span className="muted">soonest first ·</span> <span className="muted">GPU, modeled estimate</span>
      {rows.length === 0 && <div className="muted">none yet</div>}
      {rows.map(({ f, obj, t50 }) => (
        <button key={obj.id} className={obj.id === selected ? 'sel' : ''} onClick={() => pick(obj)}>
          <span className="dot" style={{ background: reentryCss(t50, nowMs) }} />
          {obj.name} <span className="muted">· {Number.isFinite(t50) ? relTime(t50, nowMs) : 'no forecast'} · {altKm(obj, nowMs)} · {f.pHazard >= 0 ? `~${f.hazardPiecesMean >= 2 ? Math.round(f.hazardPiecesMean) : f.hazardPiecesMean.toFixed(1)} dangerous` : `${Math.round(f.pAnySurvives * 100)}% any piece`} · ~{Math.round(f.survivingMassKgMean)} kg</span>
        </button>
      ))}
    </div>
  );
}
