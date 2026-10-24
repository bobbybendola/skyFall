// G2 debris lines: for the selected satellite, a straight line from the
// satellite (moving with the Cesium clock; see lineStart) to each component's
// predicted landing point, colored by material; opacity and width by p_survive. Plus the
// impact zones (impactZones.ts) and hover/click info. One call in Globe.tsx:
//   const debrisUi = useDebrisLines(viewer, debris)  →  render {debrisUi}
import { createElement, useEffect, type ReactElement } from 'react';
import {
  ArcType,
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Color,
  CustomDataSource,
  defined,
  Ellipsoid,
  Entity,
  JulianDate,
  PolylineOutlineMaterialProperty,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  type Viewer,
} from 'cesium';
import type { DebrisComponent, DebrisResult } from './debrisTypes.ts';
import { hovered, materialColor, onlySurvivors, pickInfo, registerPick, visibleComponents } from './debrisPick.ts';
import { useImpactZones } from './impactZones.ts';
import { DebrisOverlay } from './debrisOverlay.tsx';

const MAX_SAMPLE_LINES = 12; // per component, when the real footprint has sampled impacts
const MARKER_HEIGHT_M = 200; // landing markers just above the ellipsoid (no z-fighting)

/** Line look for a survival chance: faint and thin when unlikely, bold when likely. */
export function lineStyle(p: number): { alpha: number; width: number } {
  const q = Math.min(1, Math.max(0, p));
  return { alpha: 0.25 + 0.75 * q, width: 1.5 + 4.5 * q };
}

/** Landing point of a component: its impact centre (mock), else the real footprint's `center` ([lon, lat]). */
export function landingPoint(c: DebrisComponent): { lat: number; lon: number } | null {
  if (c.impact) return c.impact;
  const center = (c.footprint as { center?: [number, number] | null }).center;
  return center ? { lon: center[0], lat: center[1] } : null;
}

function samplePoints(c: DebrisComponent): [number, number][] {
  const s = (c.footprint as { samples?: [number, number][] }).samples ?? [];
  if (s.length <= MAX_SAMPLE_LINES) return s;
  const step = s.length / MAX_SAMPLE_LINES;
  return Array.from({ length: MAX_SAMPLE_LINES }, (_, i) => s[Math.floor(i * step)]);
}

/** Dark materials (CFRP is black) get a light outline so they show on the night side. */
function outlineFor(color: Color): Color {
  const lum = 0.2126 * color.red + 0.7152 * color.green + 0.0722 * color.blue;
  return lum < 0.3 ? Color.fromCssColorString('#d0d0d0') : Color.BLACK;
}

/**
 * Where a line starts. The landing zones belong to the forecast re-entry time,
 * while the satellite (as G1 draws it: its orbit entity follows SGP4 on the
 * clock) may be anywhere on its orbit now. So: from the live satellite while the
 * landing point is above its horizon (e.g. when the clock is at break-up), else
 * from the predicted break-up point, so a line never cuts through the Earth.
 */
function lineStart(viewer: Viewer, debris: DebrisResult): (t: JulianDate, ground: Cartesian3) => Cartesian3 | undefined {
  const b = debris.breakup;
  const breakup = [b?.lat, b?.lon, b?.alt_km].every(Number.isFinite) ? Cartesian3.fromDegrees(b.lon, b.lat, b.alt_km * 1000) : undefined;
  const up = new Cartesian3();
  const toSat = new Cartesian3();
  let lastT: JulianDate | null = null;
  let sat: Cartesian3 | undefined;
  return (t, ground) => {
    if (!lastT || !JulianDate.equals(t, lastT)) {
      lastT = t.clone(lastT ?? undefined); // one SGP4 lookup per frame for all lines
      sat = viewer.entities.getById(`selected-orbit:${debris.id}`)?.position?.getValue(t);
    }
    if (!sat) return breakup; // SGP4 has no position (already re-entered); undefined = no line
    Ellipsoid.WGS84.geodeticSurfaceNormal(ground, up);
    return Cartesian3.dot(Cartesian3.subtract(sat, ground, toSat), up) > 0 ? sat : breakup; // hidden + no break-up point: no line
  };
}

const segment = (start: Cartesian3 | undefined, end: Cartesian3): Cartesian3[] => (start ? [start, end] : []);

function addLines(ds: CustomDataSource, viewer: Viewer, debris: DebrisResult, components: DebrisComponent[]): void {
  const from = lineStart(viewer, debris);
  const mock = debris.source === 'mock';
  components.forEach((c, ci) => {
    const land = landingPoint(c);
    if (!land) return; // burns up in every run: no landing point
    const color = materialColor(c.material);
    const { alpha, width } = lineStyle(c.p_survive);
    const ground = Cartesian3.fromDegrees(land.lon, land.lat, 0);
    const line = ds.entities.add(
      new Entity({
        id: `debris-line:${debris.id}:${ci}`,
        polyline: {
          positions: new CallbackProperty(time => segment(from(time ?? viewer.clock.currentTime, ground), ground), false),
          width: width + 2,
          arcType: ArcType.NONE, // straight through space, not along the surface
          material: new PolylineOutlineMaterialProperty({ color: color.withAlpha(alpha), outlineColor: outlineFor(color).withAlpha(alpha * 0.8), outlineWidth: 1 }),
        },
      })
    );
    registerPick(line, { component: c, kind: 'line', mock });
    const marker = ds.entities.add(
      new Entity({
        id: `debris-land:${debris.id}:${ci}`,
        position: Cartesian3.fromDegrees(land.lon, land.lat, MARKER_HEIGHT_M),
        point: { pixelSize: 5 + 6 * c.p_survive, color: color.withAlpha(Math.max(alpha, 0.6)), outlineColor: outlineFor(color), outlineWidth: 1 },
      })
    );
    registerPick(marker, { component: c, kind: 'line', mock });
    // Real results also carry sampled impacts: faint extra lines show the spread.
    samplePoints(c).forEach(([lon, lat], si) => {
      const g = Cartesian3.fromDegrees(lon, lat, 0);
      const e = ds.entities.add(
        new Entity({
          id: `debris-line:${debris.id}:${ci}:s${si}`,
          polyline: { positions: new CallbackProperty(time => segment(from(time ?? viewer.clock.currentTime, g), g), false), width: 1, arcType: ArcType.NONE, material: color.withAlpha(alpha * 0.25) },
        })
      );
      registerPick(e, { component: c, kind: 'line', mock });
    });
  });
}

/** Hover shows the tooltip; click pins it (click empty space to unpin). */
function useDebrisPicking(viewer: Viewer | null): void {
  useEffect(() => {
    if (!viewer) return;
    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    let pending: Cartesian2 | null = null;
    let frame = 0;
    const pickAt = (pos: Cartesian2) => {
      const picked = viewer.scene.pick(pos);
      return defined(picked) ? pickInfo(picked.id) : undefined;
    };
    handler.setInputAction((e: { endPosition: Cartesian2 }) => {
      if (hovered.get()?.pinned) return;
      pending = Cartesian2.clone(e.endPosition, pending ?? undefined);
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!pending || viewer.isDestroyed()) return;
        const info = pickAt(pending);
        hovered.set(info ? { info, x: pending.x, y: pending.y, pinned: false } : null);
      });
    }, ScreenSpaceEventType.MOUSE_MOVE);
    handler.setInputAction((e: { position: Cartesian2 }) => {
      const info = pickAt(e.position);
      hovered.set(info ? { info, x: e.position.x, y: e.position.y, pinned: true } : null);
    }, ScreenSpaceEventType.LEFT_CLICK);
    return () => {
      cancelAnimationFrame(frame);
      handler.destroy();
      hovered.set(null);
    };
  }, [viewer]);
}

export function useDebrisLines(viewer: Viewer | null, debris: DebrisResult | null): ReactElement | null {
  const only = onlySurvivors.use();
  useImpactZones(viewer, debris, only);
  useDebrisPicking(viewer);

  useEffect(() => {
    if (!viewer || !debris) return;
    const ds = new CustomDataSource('g2-debris-lines');
    viewer.dataSources.add(ds);
    addLines(ds, viewer, debris, visibleComponents(debris.components, only));
    return () => {
      hovered.set(null);
      if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
    };
  }, [viewer, debris, only]);

  return debris ? createElement(DebrisOverlay, { debris }) : null;
}
