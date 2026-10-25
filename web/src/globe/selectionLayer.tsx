// G1 selection: click a satellite to select it (shared via selection.ts);
// the selected one gets its orbit path for the next few hours (with
// altitude), a label, and an info card with a fly-to button.
import { useEffect, useMemo } from 'react';
import {
  CallbackPositionProperty,
  CallbackProperty,
  ConstantProperty,
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
import type { DebrisResult } from './debrisTypes.ts';
import { setSelected, useSelected } from './selection.ts';
import { localTime, reentryCss, relTime, useClockNow } from './legend.tsx';
import { resetClock } from './cesium-setup.ts';

const PATH_HOURS = 3;
const PATH_STEP_S = 60;
const PATH_REFRESH_S = 300; // recompute the path when the clock moves this far
const trackId = (id: string) => `selected-track:${id}`;

// Object the camera should stay locked on. Its entity may not exist yet when
// "Fly to" is clicked (selection effects run after render), so remember it.
let followId: string | null = null;

/** Lock the camera onto an object; it follows it as the clock moves. */
export function followObject(viewer: Viewer, id: string): void {
  followId = id;
  const e = viewer.entities.getById(trackId(id));
  if (e) viewer.trackedEntity = e;
}

/** Release the camera lock. */
export function unfollow(viewer: Viewer): void {
  followId = null;
  viewer.trackedEntity = undefined;
}

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
        polyline: {
          positions: path,
          width: 3,
          material: new PolylineGlowMaterialProperty({ glowPower: 0.2, color: Color.CYAN.withAlpha(0.8) }),
        },
      })
    );
    // Separate entity for the moving point + label, so camera tracking frames
    // the object and not the whole 3 h orbit line.
    const track = viewer.entities.add(
      new Entity({
        id: trackId(obj.id),
        position: new CallbackPositionProperty(time => positionAt(obj, JulianDate.toDate(time ?? viewer.clock.currentTime)), false),
        viewFrom: new ConstantProperty(new Cartesian3(0, -2_000_000, 1_500_000)),
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
    if (followId === obj.id) viewer.trackedEntity = track;
    return () => {
      if (viewer.isDestroyed()) return;
      if (viewer.trackedEntity === track) viewer.trackedEntity = undefined;
      viewer.entities.remove(entity);
      viewer.entities.remove(track);
    };
  }, [viewer, obj, reentry]);
}

/** Small info card for the selected object (G4 will replace this with the real panel). */
export function SelectedCard({
  viewer,
  objects,
  reentry,
  debris,
}: {
  viewer: Viewer | null;
  objects: TrackedObject[];
  reentry: ReentryLookup;
  debris?: DebrisResult | null;
}) {
  const selected = useSelected();
  const nowMs = useClockNow(viewer);
  const obj = objects.find(o => o.id === selected);
  if (!obj || !viewer) return null;
  const r = reentry.get(obj.id);
  let el: Record<string, unknown> = {};
  try {
    el = JSON.parse(obj.elements);
  } catch {
    /* ignore */
  }
  const flyTo = () => followObject(viewer, obj.id);
  // Re-entry moment: the debris break-up time (80 km) when we have a live one, else the forecast median.
  const b = debris?.source === 'live' ? debris.breakup.t_unix_s * 1000 : NaN;
  const reentryMs = Number.isFinite(b) && b > 0 ? b : r?.t50;
  const jumpToReentry = () => {
    if (reentryMs === undefined || !Number.isFinite(reentryMs)) return;
    viewer.clock.currentTime = JulianDate.fromDate(new Date(reentryMs - 3 * 60_000)); // 3 min before
    viewer.clock.multiplier = 10;
    viewer.clock.shouldAnimate = true;
    followObject(viewer, obj.id);
  };
  const atNow = Math.abs(nowMs - Date.now()) < 60_000;
  return (
    <div className="globe-info">
      <b>{obj.name}</b> <span className="muted">NORAD {obj.noradId}</span>
      <div className="muted">
        real orbit data ({obj.source === 'CANDIDATE' ? 'CelesTrak' : obj.source}) · elements {String(el.EPOCH ?? '').slice(0, 16)}Z
      </div>
      {r ? (
        <>
          <div>
            <span className="dot" style={{ background: reentryCss(r.t50, nowMs) }} /> Likely re-entry <b>{relTime(r.t50, nowMs)}</b> ({localTime(r.t50)})
          </div>
          <div className="muted">
            90% chance between {relTime(r.t05, nowMs).replace(/^in /, '')} and {relTime(r.t95, nowMs).replace(/^in /, '')} from now · {Math.round(r.p * 100)}% of runs re-enter inside the forecast window
          </div>
        </>
      ) : (
        <div className="muted">no re-entry forecast inside the horizon</div>
      )}
      {debris && (
        <div>
          {debris.source === 'mock' ? <span className="mock">MOCK</span> : <span className="muted">modeled estimate ({debris.archetype}) ·</span>} debris: {Math.round(debris.p_any_survives * 100)}% chance any piece survives ·{' '}
          {debris.components.length} component types · ~{debris.surviving_mass_kg.mean} kg
        </div>
      )}
      <button onClick={flyTo}>Fly to</button>{' '}
      {reentryMs !== undefined && Number.isFinite(reentryMs) && <button onClick={jumpToReentry}>Jump to re-entry</button>}{' '}
      {!atNow && <button onClick={() => resetClock(viewer)}>Back to now</button>}{' '}
      <button onClick={() => { unfollow(viewer); setSelected(null); }}>Clear</button>
    </div>
  );
}
