// G1 satellites layer: every tracked object with orbit elements, drawn at its
// real altitude from SGP4 and moved by the Cesium clock (scrubbing the
// timeline moves them). Look (color, danger ring) comes from pointStyle.ts. One point collection,
// so it scales to the full catalog later (see docs/SPACETRACK_NOTES.md).
import { useEffect, useMemo, useRef } from 'react';
import {
  Cartesian3,
  Color,
  JulianDate,
  NearFarScalar,
  PointPrimitiveCollection,
  type PointPrimitive,
  type Viewer,
} from 'cesium';
import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings/index.ts';
import { sgp4Point } from '../orbit.ts';
import { getSelected, useSelected } from './selection.ts';
import { DANGER_P, passesFilter, pointFilter, pointLook, useDangerLookup, useForecasted, whenOf, type When } from './pointStyle.ts';

const UPDATE_EVERY_MS = 1000; // wall time between position updates
const JUMP_S = 30; // or immediately when the clock jumps this far (scrubbing)

export type TrackedObject = { id: string; name: string; noradId: number; source: string; elements: string };

/** Forecast median (ms since epoch) by object id; NaN when unknown. */
export type ReentryEntry = { t50: number; t05: number; t95: number; p: number };
export type ReentryLookup = Map<string, ReentryEntry>;

/** Objects + their forecast, shared by the satellite layer and the selection. */
export function useTrackedObjects(): { objects: TrackedObject[]; reentry: ReentryLookup } {
  const [rows] = useTable(tables.reentryObject);
  const [forecasts] = useTable(tables.forecast);
  const objects = useMemo(
    () =>
      rows
        .filter(o => o.source !== 'REPLAY')
        .map(o => ({ id: o.id, name: o.name, noradId: o.noradId, source: o.source, elements: o.elements })),
    [rows]
  );
  const reentry = useMemo(() => {
    const m: ReentryLookup = new Map();
    for (const f of forecasts) {
      if (f.status !== 'ok' || !f.tQ50) continue;
      m.set(f.objectId, {
        t50: f.tQ50.toDate().getTime(),
        t05: f.tQ05 ? f.tQ05.toDate().getTime() : NaN,
        t95: f.tQ95 ? f.tQ95.toDate().getTime() : NaN,
        p: f.decayedFrac,
      });
    }
    return m;
  }, [forecasts]);
  return { objects, reentry };
}

/** Cache key that changes when the elements change (new epoch). */
export function satKey(o: TrackedObject): string {
  try {
    return `${o.id}@${JSON.parse(o.elements).EPOCH ?? ''}`;
  } catch {
    return o.id;
  }
}

export function useSatelliteLayer(viewer: Viewer | null, objects: TrackedObject[], reentry: ReentryLookup): void {
  const selected = useSelected();
  const forecasted = useForecasted();
  const danger = useDangerLookup();
  const filter = pointFilter.use();
  const points = useRef<Map<string, PointPrimitive>>(new Map());
  const collection = useRef<PointPrimitiveCollection | null>(null);
  const latest = useRef<Looks>({ objects, reentry, forecasted, danger, filter });
  latest.current = { objects, reentry, forecasted, danger, filter };

  // Create the collection once per viewer.
  useEffect(() => {
    if (!viewer) return;
    const c = viewer.scene.primitives.add(new PointPrimitiveCollection()) as PointPrimitiveCollection;
    collection.current = c;
    let lastWall = 0;
    let lastSim: JulianDate | null = null;
    const update = () => {
      const t = viewer.clock.currentTime;
      const wall = performance.now();
      const jumped = !lastSim || Math.abs(JulianDate.secondsDifference(t, lastSim)) > JUMP_S;
      if (!jumped && wall - lastWall < UPDATE_EVERY_MS) return;
      lastWall = wall;
      lastSim = t.clone();
      placeAll(points.current, latest.current, JulianDate.toDate(t));
    };
    const remove = viewer.scene.preUpdate.addEventListener(update);
    return () => {
      remove();
      points.current.clear();
      if (!viewer.isDestroyed()) viewer.scene.primitives.remove(c);
      collection.current = null;
    };
  }, [viewer]);

  // Rebuild points when the object list changes; recolor on forecast/selection change.
  useEffect(() => {
    const c = collection.current;
    if (!c || !viewer) return;
    const want = new Set(objects.map(o => o.id));
    for (const [id, p] of points.current) {
      if (!want.has(id)) {
        c.remove(p);
        points.current.delete(id);
      }
    }
    for (const o of objects) {
      if (!points.current.has(o.id)) {
        points.current.set(o.id, c.add({ id: o.id, pixelSize: 6, outlineColor: Color.BLACK, outlineWidth: 1, scaleByDistance: new NearFarScalar(1e6, 1.6, 4e7, 0.8) }));
      }
    }
    placeAll(points.current, latest.current, JulianDate.toDate(viewer.clock.currentTime));
  }, [viewer, objects, reentry, forecasted, danger, filter, selected]);
}

type Looks = {
  objects: TrackedObject[];
  reentry: ReentryLookup;
  forecasted: Set<string>;
  danger: Map<string, number>;
  filter: When | 'danger' | null;
};

function placeAll(points: Map<string, PointPrimitive>, { objects, reentry, forecasted, danger, filter }: Looks, when: Date): void {
  const sel = getSelected();
  const nowMs = when.getTime();
  for (const o of objects) {
    const p = points.get(o.id);
    if (!p) continue;
    const pos = sgp4Point(satKey(o), o.elements, when);
    if (!pos) {
      p.show = false; // no valid orbit at this time (e.g. already re-entered)
      continue;
    }
    const isSel = o.id === sel;
    const w = whenOf(reentry.get(o.id), forecasted.has(o.id), nowMs);
    const dangerous = (danger.get(o.id) ?? 0) >= DANGER_P;
    p.show = isSel || passesFilter(filter, w, dangerous);
    if (!p.show) continue;
    p.position = Cartesian3.fromDegrees(pos.lon, pos.lat, pos.altKm * 1000);
    const look = pointLook(w, dangerous, isSel);
    p.color = look.color;
    p.pixelSize = look.size;
    p.outlineColor = look.outlineColor;
    p.outlineWidth = look.outlineWidth;
  }
}
