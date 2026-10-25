// G2 impact zones: each component's 50/90% footprint (debris_component.footprint)
// plus the combined footprint of all surviving pieces (debris_forecast.footprint),
// on the ground with a translucent fill and an outline. Colors by material.
// Every zone is a modeled estimate (or MOCK); the overlay says which.
import { useEffect } from 'react';
import { Cartesian3, Color, CustomDataSource, Entity, PolygonHierarchy, type Viewer } from 'cesium';
import type { Band, DebrisResult } from './debrisTypes.ts';
import { materialColor, MIN_SURVIVAL, registerPick } from './debrisPick.ts';

const COMBINED_COLOR = Color.fromCssColorString('#ff4d4d');
const FILL_ALPHA = { 90: 0.12, 50: 0.28 } as const;
const OUTLINE_ALPHA = { 90: 0.55, 50: 0.95 } as const;

/** [lon, lat] ring → positions at the surface; drops the repeated closing point. */
function ringPositions(polygon: Band['polygon']): Cartesian3[] {
  const ring = polygon.length > 1 && polygon[0][0] === polygon.at(-1)![0] && polygon[0][1] === polygon.at(-1)![1] ? polygon.slice(0, -1) : polygon;
  return Cartesian3.fromDegreesArray(ring.flat());
}

function addBand(ds: CustomDataSource, id: string, band: Band, color: Color, width: number): Entity[] {
  const pos = ringPositions(band.polygon);
  if (pos.length < 3) return [];
  const fill = ds.entities.add(
    new Entity({
      id: `${id}:fill`,
      polygon: { hierarchy: new PolygonHierarchy(pos), material: color.withAlpha(FILL_ALPHA[band.level]) },
    })
  );
  // No height: the fill is draped on the terrain. Polygon outlines are 1 px on most WebGL platforms, so draw the outline as a ground-clamped line.
  const outline = ds.entities.add(
    new Entity({
      id: `${id}:outline`,
      polyline: { positions: [...pos, pos[0]], width, clampToGround: true, material: color.withAlpha(OUTLINE_ALPHA[band.level]) },
    })
  );
  return [fill, outline];
}

export function useImpactZones(viewer: Viewer | null, debris: DebrisResult | null, only: boolean, focus: string | null = null): void {
  useEffect(() => {
    if (!viewer || !debris) return;
    const ds = new CustomDataSource('g2-impact-zones');
    viewer.dataSources.add(ds);
    const mock = debris.source === 'mock';

    // Combined footprint first (underneath), then the components. A part focused in the
    // model viewer shows alone: no combined footprint, and the survival filter is ignored.
    if (!focus) {
      debris.footprint.bands.forEach((b, i) => {
        for (const e of addBand(ds, `debris-zone:${debris.id}:all:${b.level}:${i}`, b, COMBINED_COLOR, b.level === 50 ? 2.5 : 1.5)) {
          registerPick(e, { component: null, kind: 'zone', level: b.level, mock });
        }
      });
    }
    debris.components.forEach((c, ci) => {
      if (focus ? c.name !== focus : only && c.p_survive < MIN_SURVIVAL) return;
      const color = materialColor(c.material);
      c.footprint.bands.forEach((b, i) => {
        for (const e of addBand(ds, `debris-zone:${debris.id}:${ci}:${b.level}:${i}`, b, color, b.level === 50 ? 2.5 : 1.5)) {
          registerPick(e, { component: c, kind: 'zone', level: b.level, mock });
        }
      });
    });
    return () => {
      if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
    };
  }, [viewer, debris, only, focus]);
}
