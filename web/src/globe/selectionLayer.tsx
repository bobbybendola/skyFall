// G1 selection: click a satellite to select it (shared via selection.ts);
// the selected one gets its orbit path for the next few hours (with
// altitude), a label, and an info card with a fly-to button.
import { useEffect, useMemo } from 'react';
import {
  CallbackPositionProperty,
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Color,
  defined,
  Entity,
  JulianDate,
  LabelStyle,
  PolylineGlowMaterialProperty,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  VerticalOrigin,
  type Viewer,
} from 'cesium';
import { sgp4Point } from '../orbit.ts';
import { satKey, type ReentryLookup, type TrackedObject } from './satellites.ts';
import { setSelected, useSelected } from './selection.ts';

const PATH_HOURS = 3;
const PATH_STEP_S = 60;
const PATH_REFRESH_S = 300; // recompute the path when the clock moves this far

function positionAt(o: TrackedObject, when: Date): Cartesian3 | undefined {
  const p = sgp4Point(satKey(o), o.elements, when);
  return p ? Cartesian3.fromDegrees(p.lon, p.lat, p.altKm * 1000) : undefined;
}

function pathFrom(o: TrackedObject, start: Date): Cartesian3[] {
  const out: Cartesian3[] = [];
  for (let s = 0; s <= PATH_HOURS * 3600; s += PATH_STEP_S) {
    const c = positionAt(o, new Date(start.getTime() + s * 1000));
    if (c) out.push(c);
  }
  return out;
}

/** Click-to-select on the globe (empty space clears the selection). */
export function useClickToSelect(viewer: Viewer | null): void {
  useEffect(() => {
    if (!viewer) return;
    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((e: { position: Cartesian2 }) => {
      const picked = viewer.scene.pick(e.position);
      // Points carry the object id as `id`; entities from other layers carry an Entity.
      const id = defined(picked) && typeof picked.id === 'string' ? picked.id : null;
      if (id) setSelected(id);
      else if (!defined(picked)) setSelected(null);
    }, ScreenSpaceEventType.LEFT_CLICK);
    return () => handler.destroy();
  }, [viewer]);
}

/** Orbit path + label for the selected object. */
export function useSelectedOrbit(viewer: Viewer | null, objects: TrackedObject[], reentry: ReentryLookup): void {
  const selected = useSelected();
  const obj = useMemo(() => objects.find(o => o.id === selected), [objects, selected]);

  useEffect(() => {
    if (!viewer || !obj) return;
    let cachedAt: JulianDate | null = null;
    let cached: Cartesian3[] = [];
    const path = new CallbackProperty(time => {
      const t = time ?? viewer.clock.currentTime;
      if (!cachedAt || Math.abs(JulianDate.secondsDifference(t, cachedAt)) > PATH_REFRESH_S) {
        cachedAt = t.clone();
        cached = pathFrom(obj, JulianDate.toDate(t));
      }
      return cached;
    }, false);
    const r = reentry.get(obj.id);
    const when = r ? ` · re-entry ~${new Date(r.t50).toISOString().slice(5, 16).replace('T', ' ')}Z` : '';
    const entity = viewer.entities.add(
      new Entity({
        id: `selected-orbit:${obj.id}`,
        position: new CallbackPositionProperty(time => positionAt(obj, JulianDate.toDate(time ?? viewer.clock.currentTime)), false),
        polyline: {
          positions: path,
          width: 3,
          material: new PolylineGlowMaterialProperty({ glowPower: 0.2, color: Color.CYAN.withAlpha(0.8) }),
        },
        label: {
          text: `${obj.name} (${obj.noradId})${when}`,
          font: '14px sans-serif',
          fillColor: Color.WHITE,
          outlineColor: Color.BLACK,
          outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: VerticalOrigin.BOTTOM,
          pixelOffset: new Cartesian2(0, -14),
        },
      })
    );
    return () => {
      if (!viewer.isDestroyed()) viewer.entities.remove(entity);
    };
  }, [viewer, obj, reentry]);
}

/** Small info card for the selected object (G4 will replace this with the real panel). */
export function SelectedCard({ viewer, objects, reentry }: { viewer: Viewer | null; objects: TrackedObject[]; reentry: ReentryLookup }) {
  const selected = useSelected();
  const obj = objects.find(o => o.id === selected);
  if (!obj || !viewer) return null;
  const r = reentry.get(obj.id);
  let el: Record<string, unknown> = {};
  try {
    el = JSON.parse(obj.elements);
  } catch {
    /* ignore */
  }
  const fmt = (t: number) => (Number.isFinite(t) ? new Date(t).toISOString().slice(5, 16).replace('T', ' ') + 'Z' : '?');
  const flyTo = () => {
    const now = JulianDate.toDate(viewer.clock.currentTime);
    const p = sgp4Point(satKey(obj), obj.elements, now);
    if (p) viewer.camera.flyTo({ destination: Cartesian3.fromDegrees(p.lon, p.lat, p.altKm * 1000 + 3_000_000) });
  };
  return (
    <div className="globe-info">
      <b>{obj.name}</b> <span className="muted">NORAD {obj.noradId}</span>
      <div className="muted">
        real orbit data ({obj.source === 'CANDIDATE' ? 'CelesTrak' : obj.source}) · elements {String(el.EPOCH ?? '').slice(0, 16)}Z
      </div>
      {r ? (
        <div>
          re-entry forecast {fmt(r.t05)} → <b>{fmt(r.t50)}</b> → {fmt(r.t95)} ({Math.round(r.p * 100)}% inside horizon)
        </div>
      ) : (
        <div className="muted">no re-entry forecast inside the horizon</div>
      )}
      <button onClick={flyTo}>Fly to</button> <button onClick={() => setSelected(null)}>Clear</button>
    </div>
  );
}
