// Debris data for the selected object, for G2 (lines/zones), G3 (animation)
// and G4 (breakdown panel). Today it returns MOCK data (src/mock/debris.ts);
// when R3's debris_forecast / debris_component / debris_track tables land,
// switch this hook to read them and set source = 'live'. Consumers don't change.
import { useMemo } from 'react';
import { mockDebris } from '../mock/debris.ts';
import type { DebrisResult } from './debrisTypes.ts';
import type { ReentryLookup, TrackedObject } from './satellites.ts';
import { useSelected } from './selection.ts';

export function useSelectedDebris(objects: TrackedObject[], reentry: ReentryLookup): DebrisResult | null {
  const selected = useSelected();
  const obj = objects.find(o => o.id === selected);
  const t50 = obj ? reentry.get(obj.id)?.t50 : undefined;
  return useMemo(() => {
    if (!obj) return null;
    // Anchor at the forecast median; if it has passed, use "now + 1 h" so the mock stays in the future.
    const now = Date.now();
    const anchor = t50 !== undefined && t50 > now ? t50 : undefined;
    return mockDebris(obj.id, obj.elements, anchor, now);
  }, [obj?.id, obj?.elements, t50]);
}
