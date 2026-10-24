import {
  Cartesian3,
  Color,
  HeightReference,
  PolygonHierarchy,
  type Entity,
  type Viewer,
} from 'cesium';
import type { Band, DebrisComponent, DebrisResult } from './debrisTypes.ts';
import { MATERIAL_COLOR, OTHER_MATERIAL_COLOR } from './debrisTypes.ts';

const MIN_SURVIVAL = 0.1;

function unwrapRing(ring: [number, number][]): number[] {
  if (ring.length < 4 || ring.some(([lon, lat]) => !Number.isFinite(lon) || !Number.isFinite(lat))) return [];
  const positions: number[] = [];
  let previousLon = ring[0][0];
  for (const [rawLon, lat] of ring) {
    let lon = rawLon;
    while (lon - previousLon > 180) lon -= 360;
    while (lon - previousLon < -180) lon += 360;
    positions.push(lon, lat);
    previousLon = lon;
  }
  return positions;
}

function addBand(
  viewer: Viewer,
  ring: [number, number][],
  band: Band,
  label: string,
  material: string,
  survival: number,
  massKg: number,
  impactEnergyJ: number | null,
  color: Color
): Entity | null {
  const coordinates = unwrapRing(ring);
  if (coordinates.length < 8) return null;
  const confidence = band.level === 50 ? 0.28 : 0.16;
  const alpha = confidence * Math.max(0.12, Math.min(1, survival));
  return viewer.entities.add({
    id: `debris-zone:${label}:${band.level}:${viewer.entities.values.length}`,
    polygon: {
      hierarchy: new PolygonHierarchy(Cartesian3.fromDegreesArray(coordinates)),
      height: 0,
      heightReference: HeightReference.CLAMP_TO_GROUND,
      material: color.withAlpha(alpha),
      outline: true,
      outlineColor: color.withAlpha(Math.min(0.9, alpha + 0.24)),
      outlineWidth: band.level === 50 ? 2 : 1,
    },
    properties: {
      component: label,
      material,
      p_survive: survival,
      mass_kg: massKg,
      impact_energy_j: impactEnergyJ,
      zone_level: band.level,
    },
  });
}

function addBands(
  viewer: Viewer,
  bands: Band[],
  label: string,
  material: string,
  survival: number,
  massKg: number,
  impactEnergyJ: number | null,
  color: Color
): Entity[] {
  const entities: Entity[] = [];
  for (const band of bands) {
    const entity = addBand(viewer, band.polygon, band, label, material, survival, massKg, impactEnergyJ, color);
    if (entity) entities.push(entity);
  }
  return entities;
}

function componentColor(component: DebrisComponent): Color {
  const hex = MATERIAL_COLOR[component.material] ?? OTHER_MATERIAL_COLOR;
  return Color.fromCssColorString(hex) ?? Color.MAGENTA;
}

export function addImpactZones(viewer: Viewer, debris: DebrisResult, showOnlyLikelySurvivors: boolean): Entity[] {
  const entities: Entity[] = [];
  for (const component of debris.components) {
    if (!component.impact || (showOnlyLikelySurvivors && component.p_survive < MIN_SURVIVAL)) continue;
    const color = componentColor(component);
    entities.push(
      ...addBands(
        viewer,
        component.footprint.bands,
        component.name,
        component.material,
        component.p_survive,
        component.mass_kg.mean,
        component.impact_energy_j.mean,
        color
      )
    );
  }

  const combinedColor = Color.fromCssColorString('#9dcfff') ?? Color.CYAN;
  entities.push(
    ...addBands(
      viewer,
      debris.footprint.bands,
      'Combined footprint',
      'All materials',
      debris.p_any_survives,
      debris.surviving_mass_kg.mean,
      null,
      combinedColor
    )
  );
  return entities;
}
