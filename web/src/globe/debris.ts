// Debris data for the selected object, for G2 (lines/zones), G3 (animation)
// and G4 (breakdown panel). Live from the debris_* tables when the GX10 has
// published a prediction for this object; otherwise MOCK (src/mock/debris.ts).
// Consumers get the same DebrisResult shape either way; check `source`.
import { useMemo } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings/index.ts';
import { mockDebris } from '../mock/debris.ts';
import type { Band, DebrisResult } from './debrisTypes.ts';
import type { ReentryLookup, TrackedObject } from './satellites.ts';
import { useSelected } from './selection.ts';

function parse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function useSelectedDebris(objects: TrackedObject[], reentry: ReentryLookup): DebrisResult | null {
  const selected = useSelected();
  const [forecasts] = useTable(tables.debrisForecast);
  const [components] = useTable(tables.debrisComponent);
  const [tracks] = useTable(tables.debrisTrack);
  const obj = objects.find(o => o.id === selected);
  const t50 = obj ? reentry.get(obj.id)?.t50 : undefined;
  const live = forecasts.find(f => f.objectId === selected);

  return useMemo(() => {
    if (!obj) return null;
    if (live) {
      const comps = components.filter(c => c.objectId === obj.id && c.version === live.version);
      const trs = tracks.filter(t => t.objectId === obj.id && t.version === live.version);
      const result: DebrisResult = {
        id: obj.id,
        archetype: live.archetypeId,
        source: 'live',
        n_particles: live.nParticles,
        breakup: parse(live.breakup, { t_unix_s: 0, lat: 0, lon: 0, alt_km: 0 }),
        p_any_survives: live.pAnySurvives,
        surviving_mass_kg: { mean: live.survivingMassKgMean, p95: live.survivingMassKgP95 },
        casualty_area_m2: { mean: live.casualtyAreaM2Mean },
        components: comps.map(c => ({
          name: c.name,
          material: c.material,
          shape: c.shape,
          count: c.count,
          p_survive: c.pSurvive,
          mass_kg: { start: c.massKgStart, mean: c.massKgMean },
          impact_speed_ms: { mean: c.impactSpeedMsMean ?? null },
          impact_energy_j: { mean: c.impactEnergyJMean ?? null },
          demise_alt_km: { mean: c.demiseAltKmMean ?? null },
          impact: c.impactLat !== undefined && c.impactLon !== undefined ? { lat: c.impactLat, lon: c.impactLon } : null,
          footprint: { bands: parse<Band[]>(c.footprint, []) },
        })),
        footprint: { bands: parse<Band[]>(live.footprint, []), area_km2_90: live.areaKm290 },
        sample_tracks: trs.map(t => ({ component: t.component, survived: t.survived, points: parse(t.points, []) })),
      };
      return result;
    }
    // MOCK: anchor at the forecast median, or "now + 1 h" if it has passed.
    const now = Date.now();
    const anchor = t50 !== undefined && t50 > now ? t50 : undefined;
    return mockDebris(obj.id, obj.elements, anchor, now);
  }, [obj?.id, obj?.elements, t50, live, components, tracks]);
}
