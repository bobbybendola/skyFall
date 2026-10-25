// Camera drags with a predictable pivot (replaces Cesium's default rotate/tilt,
// which grab whatever point is under the cursor and jump around over terrain).
//
//   left-drag            nothing selected: spin the globe around Earth's center,
//                        speed scaled by height (so up close it pans smoothly)
//   ctrl/middle-drag     nothing selected: orbit the ground at the screen center
//                        when close, blending to Earth's center when zoomed out
//   either, selected     orbit the selected satellite
//   "Fly to" (tracked)   Cesium's own entity orbit, unchanged
//
// Letting go mid-drag keeps the globe turning and slows it to a stop (drift);
// any new press, scroll or "Fly to" stops it.
//
// Scroll/right-drag zoom, shift-drag look and touch pinch stay Cesium's.
import {
  Cartesian2,
  Cartesian3,
  CameraEventType,
  Ellipsoid,
  Math as CesiumMath,
  Matrix4,
  Transforms,
  type Viewer,
} from 'cesium';
import { useEffect } from 'react';
import { getSelected } from './selection.ts';
import { trackId } from './selectionLayer.tsx';

const BLEND_NEAR_M = 200_000; // below this height the orbit pivot is the ground point
const BLEND_FAR_M = 2_000_000; // above this it is Earth's center
const MIN_CLEARANCE_M = 20; // orbiting never takes the camera below the ground
const DRIFT_SAMPLE_MS = 80; // release speed = movement over about the last 80 ms of the drag
const DRIFT_HOLD_MS = 60; // held still this long before letting go: no drift
const DRIFT_TAU_MS = 300; // drift speed falls to 1/e every 300 ms
const DRIFT_MIN_PX_MS = 0.02; // stop below this speed (px per ms)

type Mode = 'spin' | 'orbit';
type Drag = { mode: Mode; x: number; y: number; frame: Matrix4 | null; id: number; startT: number; samples: { t: number; dx: number; dy: number }[] };
type Drift = { mode: Mode; frame: Matrix4 | null; vx: number; vy: number; last: number; raf: number };

export function useOrbitControls(viewer: Viewer | null): void {
  useEffect(() => {
    if (!viewer) return;
    const ssc = viewer.scene.screenSpaceCameraController;
    const defaults = { rotate: ssc.rotateEventTypes, tilt: ssc.tiltEventTypes };
    // While Cesium tracks an entity its own controls orbit that entity; otherwise ours run.
    const syncCesium = () => {
      const tracked = !!viewer.trackedEntity;
      ssc.rotateEventTypes = tracked ? defaults.rotate : [];
      ssc.tiltEventTypes = tracked ? defaults.tilt : CameraEventType.PINCH; // keep two-finger tilt on touch
    };
    syncCesium();
    const offTracked = viewer.trackedEntityChanged.addEventListener(syncCesium);

    const canvas = viewer.scene.canvas;
    let drag: Drag | null = null;
    let drift: Drift | null = null;
    const stopDrift = () => {
      if (drift) cancelAnimationFrame(drift.raf);
      drift = null;
    };
    const apply = (mode: Mode, frame: Matrix4 | null, dx: number, dy: number) => {
      if (mode === 'spin') spin(viewer, dx, dy);
      else if (frame) orbit(viewer, frame, dx, dy);
    };
    const step = (now: number) => {
      if (!drift || viewer.isDestroyed() || viewer.trackedEntity) return stopDrift();
      const dt = Math.min(now - drift.last, 50); // a stalled tab does not jump the globe
      drift.last = now;
      apply(drift.mode, drift.frame, drift.vx * dt, drift.vy * dt);
      const k = Math.exp(-dt / DRIFT_TAU_MS);
      drift.vx *= k;
      drift.vy *= k;
      if (Math.hypot(drift.vx, drift.vy) < DRIFT_MIN_PX_MS) return stopDrift();
      drift.raf = requestAnimationFrame(step);
    };
    const startDrift = (d: Drag) => {
      const now = performance.now();
      const last = d.samples[d.samples.length - 1];
      if (!last || now - last.t > DRIFT_HOLD_MS) return; // held still before letting go
      // Speed over roughly the last DRIFT_SAMPLE_MS, measured from the sample just before
      // that window (works for both 1000 Hz mice and sparse touch/trackpad events).
      let i = d.samples.length - 1;
      while (i > 0 && now - d.samples[i - 1].t <= DRIFT_SAMPLE_MS) i--;
      const from = i > 0 ? d.samples[i - 1].t : d.startT;
      const span = Math.max(now - from, 16);
      const recent = d.samples.slice(i);
      const vx = recent.reduce((a, s) => a + s.dx, 0) / span;
      const vy = recent.reduce((a, s) => a + s.dy, 0) / span;
      if (Math.hypot(vx, vy) < DRIFT_MIN_PX_MS * 5) return;
      drift = { mode: d.mode, frame: d.frame, vx, vy, last: now, raf: requestAnimationFrame(step) };
    };

    const down = (e: PointerEvent) => {
      stopDrift();
      if (viewer.trackedEntity || e.shiftKey || !e.isPrimary) return;
      if (e.button !== 0 && e.button !== 1) return;
      const sat = selectedSatPosition(viewer);
      const mode = sat || e.button === 1 || e.ctrlKey ? 'orbit' : 'spin';
      const frame = mode === 'orbit' ? orbitFrame(viewer, sat) : null;
      drag = { mode, x: e.clientX, y: e.clientY, frame, id: e.pointerId, startT: performance.now(), samples: [] };
      canvas.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id || viewer.isDestroyed()) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (!dx && !dy) return;
      const t = performance.now();
      drag.samples.push({ t, dx, dy });
      while (drag.samples.length && t - drag.samples[0].t > DRIFT_SAMPLE_MS * 2) drag.samples.shift();
      apply(drag.mode, drag.frame, dx, dy);
    };
    const up = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      if (e.type === 'pointerup') startDrift(drag);
      drag = null;
    };
    const offTrackedDrift = viewer.trackedEntityChanged.addEventListener(stopDrift);
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', stopDrift, { passive: true });
    return () => {
      stopDrift();
      offTracked();
      offTrackedDrift();
      canvas.removeEventListener('wheel', stopDrift);
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      if (!viewer.isDestroyed()) {
        ssc.rotateEventTypes = defaults.rotate;
        ssc.tiltEventTypes = defaults.tilt;
      }
    };
  }, [viewer]);
}

/** Where the selected satellite is right now, if one is selected and drawn. */
function selectedSatPosition(viewer: Viewer): Cartesian3 | undefined {
  const id = getSelected();
  const entity = id ? viewer.entities.getById(trackId(id)) : undefined;
  return entity?.position?.getValue(viewer.clock.currentTime);
}

/** Left-drag: rotate the camera around Earth's polar axis and its own right axis, so
 * the ground under the cursor follows the cursor at any height. */
function spin(viewer: Viewer, dx: number, dy: number): void {
  const camera = viewer.camera;
  const height = Math.max(camera.positionCartographic.height, 1);
  const fovy = (camera.frustum as { fovy?: number }).fovy ?? CesiumMath.PI_OVER_THREE;
  const radPerPx = (height / Ellipsoid.WGS84.maximumRadius) * (fovy / viewer.scene.canvas.clientHeight);
  const lat = camera.positionCartographic.latitude;
  // Grab the globe: the ground under the cursor follows it. A longitude step covers
  // less ground away from the equator, so horizontal steps grow with 1/cos(latitude).
  camera.rotate(Cartesian3.UNIT_Z, (dx * radPerPx) / Math.max(Math.cos(lat), 0.15));
  // Vertical: around the camera's horizontal axis through Earth's center; stop short of the poles.
  const axis = Cartesian3.normalize(Cartesian3.cross(camera.position, Cartesian3.UNIT_Z, new Cartesian3()), new Cartesian3());
  const step = dy * radPerPx;
  const limit = CesiumMath.toRadians(89);
  const next = CesiumMath.clamp(lat + step, -limit, limit);
  if (Number.isFinite(axis.x)) camera.rotate(axis, -(next - lat));
}

/** Local east-north-up frame for orbiting: at the satellite, or at a point between the
 * ground under the screen center (close) and Earth's center (far). */
function orbitFrame(viewer: Viewer, sat: Cartesian3 | undefined): Matrix4 {
  if (sat) return Transforms.eastNorthUpToFixedFrame(sat);
  const { scene, camera } = viewer;
  const center = new Cartesian2(scene.canvas.clientWidth / 2, scene.canvas.clientHeight / 2);
  const ray = camera.getPickRay(center);
  const ground =
    (ray && scene.globe.pick(ray, scene)) ??
    camera.pickEllipsoid(center) ??
    Ellipsoid.WGS84.scaleToGeodeticSurface(camera.position, new Cartesian3());
  const frame = Transforms.eastNorthUpToFixedFrame(ground ?? camera.position);
  const t = CesiumMath.clamp((camera.positionCartographic.height - BLEND_NEAR_M) / (BLEND_FAR_M - BLEND_NEAR_M), 0, 1);
  const w = t * t * (3 - 2 * t); // smoothstep
  const pivot = Cartesian3.multiplyByScalar(ground ?? Cartesian3.ZERO, 1 - w, new Cartesian3());
  return Matrix4.setTranslation(frame, pivot, frame);
}

/** Ctrl/middle-drag (or any drag with a satellite selected): horizontal turns around the
 * pivot's local up, vertical tilts; the camera never goes past straight down or below ground. */
function orbit(viewer: Viewer, frame: Matrix4, dx: number, dy: number): void {
  const camera = viewer.camera;
  const canvas = viewer.scene.canvas;
  const saved = { position: camera.position.clone(), direction: camera.direction.clone(), up: camera.up.clone(), right: camera.right.clone() };
  const constrained = camera.constrainedAxis;
  camera.lookAtTransform(frame);
  camera.constrainedAxis = Cartesian3.UNIT_Z;
  // Same directions as Cesium's own tilt: drag right turns the scene with the cursor,
  // drag down tilts toward looking straight down.
  camera.rotateRight((dx / canvas.clientWidth) * 1.5 * Math.PI);
  camera.rotateUp((-dy / canvas.clientHeight) * Math.PI);
  camera.lookAtTransform(Matrix4.IDENTITY);
  camera.constrainedAxis = constrained;
  const c = camera.positionCartographic;
  const ground = viewer.scene.globe.getHeight(c) ?? 0;
  if (c.height < ground + MIN_CLEARANCE_M) {
    camera.position = saved.position;
    camera.direction = saved.direction;
    camera.up = saved.up;
    camera.right = saved.right;
  }
}
