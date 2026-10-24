import { useEffect, useRef, useState } from 'react';
import {
  ArcType,
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Color,
  defined,
  Entity,
  JulianDate,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  type Viewer,
} from 'cesium';
import type { DebrisResult } from './debrisTypes.ts';
import { MATERIAL_COLOR, OTHER_MATERIAL_COLOR } from './debrisTypes.ts';
import { addImpactZones } from './impactZones.ts';
import { useSelected } from './selection.ts';
import { satKey, type TrackedObject } from './satellites.ts';
import { sgp4Point } from '../orbit.ts';

const MIN_SURVIVAL = 0.1;

type DebrisTooltip = {
  component: string;
  material: string;
  survival: number;
  massKg: number;
  impactEnergyJ: number | null;
  zoneLevel: number | null;
  x: number;
  y: number;
};

function pickedTooltip(viewer: Viewer, position: Cartesian2): Omit<DebrisTooltip, 'x' | 'y'> | null {
  const picked = viewer.scene.pick(position);
  if (!defined(picked) || !(picked.id instanceof Entity) || !picked.id.properties) return null;
  const raw: unknown = picked.id.properties.getValue(viewer.clock.currentTime);
  if (!raw || typeof raw !== 'object') return null;
  const properties = raw as Record<string, unknown>;
  if (
    typeof properties.component !== 'string' ||
    typeof properties.material !== 'string' ||
    typeof properties.p_survive !== 'number' ||
    typeof properties.mass_kg !== 'number'
  ) {
    return null;
  }
  return {
    component: properties.component,
    material: properties.material,
    survival: properties.p_survive,
    massKg: properties.mass_kg,
    impactEnergyJ: typeof properties.impact_energy_j === 'number' ? properties.impact_energy_j : null,
    zoneLevel: typeof properties.zone_level === 'number' ? properties.zone_level : null,
  };
}

function formatMass(value: number): string {
  return `${Number(value.toFixed(2))} kg`;
}

function formatEnergy(value: number | null): string {
  return value === null ? 'not available' : `${Math.round(value).toLocaleString()} J`;
}

export function useDebrisLines(
  viewer: Viewer | null,
  debris: DebrisResult | null,
  objects: TrackedObject[]
) {
  const selected = useSelected();
  const [showOnlyLikelySurvivors, setShowOnlyLikelySurvivors] = useState(false);
  const [tooltip, setTooltip] = useState<DebrisTooltip | null>(null);
  const pinned = useRef(false);

  useEffect(() => {
    setTooltip(null);
    pinned.current = false;
    if (!viewer || !debris || debris.id !== selected) return;
    const object = objects.find(item => item.id === debris.id);
    if (!object) return;

    const created: Entity[] = [];
    const fallback = Cartesian3.fromDegrees(debris.breakup.lon, debris.breakup.lat, debris.breakup.alt_km * 1000);
    for (const component of debris.components) {
      const impact = component.impact;
      if (!impact || (showOnlyLikelySurvivors && component.p_survive < MIN_SURVIVAL)) continue;
      const destination = Cartesian3.fromDegrees(impact.lon, impact.lat);
      const color = Color.fromCssColorString(MATERIAL_COLOR[component.material] ?? OTHER_MATERIAL_COLOR) ?? Color.MAGENTA;
      const alpha = 0.12 + 0.88 * Math.max(0, Math.min(1, component.p_survive));
      const positions = new CallbackProperty(time => {
        const when = JulianDate.toDate(time ?? viewer.clock.currentTime);
        const satellite = sgp4Point(satKey(object), object.elements, when);
        const start = satellite
          ? Cartesian3.fromDegrees(satellite.lon, satellite.lat, satellite.altKm * 1000)
          : fallback;
        return [start, destination];
      }, false);
      created.push(
        viewer.entities.add({
          id: `debris-line:${debris.id}:${component.name}`,
          polyline: {
            positions,
            width: 1.5 + 4 * Math.sqrt(Math.max(0, component.p_survive)),
            material: color.withAlpha(alpha),
            arcType: ArcType.GEODESIC,
          },
          properties: {
            component: component.name,
            material: component.material,
            p_survive: component.p_survive,
            mass_kg: component.mass_kg.mean,
            impact_energy_j: component.impact_energy_j.mean,
          },
        })
      );
    }

    created.push(...addImpactZones(viewer, debris, showOnlyLikelySurvivors));

    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((event: { endPosition: Cartesian2 }) => {
      if (pinned.current) return;
      const details = pickedTooltip(viewer, event.endPosition);
      setTooltip(
        details
          ? {
              ...details,
              x: event.endPosition.x + 12,
              y: event.endPosition.y + 12,
            }
          : null
      );
    }, ScreenSpaceEventType.MOUSE_MOVE);
    handler.setInputAction((event: { position: Cartesian2 }) => {
      const details = pickedTooltip(viewer, event.position);
      pinned.current = details !== null;
      setTooltip(
        details
          ? {
              ...details,
              x: event.position.x + 12,
              y: event.position.y + 12,
            }
          : null
      );
    }, ScreenSpaceEventType.LEFT_CLICK);

    return () => {
      handler.destroy();
      if (viewer.isDestroyed()) return;
      for (const entity of created) viewer.entities.remove(entity);
    };
  }, [viewer, debris, objects, selected, showOnlyLikelySurvivors]);

  if (!viewer || !debris || debris.id !== selected) return null;
  const canvasBounds = viewer.scene.canvas.getBoundingClientRect();
  return (
    <>
      <div className="debris-controls">
        <label>
          <input
            type="checkbox"
            checked={showOnlyLikelySurvivors}
            onChange={event => setShowOnlyLikelySurvivors(event.currentTarget.checked)}
          />
          Show only pieces with ≥ 10% survival
        </label>
        <span className="debris-material-legend">Line and zone color indicates material</span>
      </div>
      {tooltip && (
        <div
          className="debris-tooltip"
          style={{ left: tooltip.x + canvasBounds.left, top: tooltip.y + canvasBounds.top }}
          role="status"
        >
          <b>{tooltip.component}</b>
          <div>{tooltip.material}{tooltip.zoneLevel ? ` · ${tooltip.zoneLevel}% zone` : ''}</div>
          <div>{Math.round(tooltip.survival * 100)}% survival · {formatMass(tooltip.massKg)}</div>
          <div>Impact energy: {formatEnergy(tooltip.impactEnergyJ)}</div>
          <small>Modeled estimate · {debris.source === 'mock' ? 'MOCK data' : 'live debris data'}</small>
        </div>
      )}
    </>
  );
}
