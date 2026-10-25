// G2 shared bits: what a hovered/clicked line or zone refers to, and the
// "show only pieces with >= 10% survival" toggle. Tiny external stores (same
// pattern as selection.ts), so the overlay re-renders without per-frame React state.
import { useSyncExternalStore } from 'react';
import { Color, type Entity } from 'cesium';
import { MATERIAL_COLOR, OTHER_MATERIAL_COLOR, type DebrisComponent } from './debrisTypes.ts';

export const MIN_SURVIVAL = 0.1;

/** Material display color (debrisTypes.MATERIAL_COLOR; purple for anything else). */
export function materialColor(material: string): Color {
  return Color.fromCssColorString(MATERIAL_COLOR[material] ?? OTHER_MATERIAL_COLOR);
}

/** What a picked G2 entity shows in the tooltip. `component` is null for the combined footprint. */
export type PickInfo = { component: DebrisComponent | null; kind: 'line' | 'zone'; level?: 50 | 90; mock: boolean };

const picks = new WeakMap<Entity, PickInfo>();

export function registerPick(entity: Entity, info: PickInfo): void {
  picks.set(entity, info);
}

export function pickInfo(entity: unknown): PickInfo | undefined {
  return entity && typeof entity === 'object' ? picks.get(entity as Entity) : undefined;
}

export function store<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (v: T) => {
      if (v === value) return;
      value = v;
      for (const l of listeners) l();
    },
    use: () =>
      useSyncExternalStore(
        cb => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
        () => value
      ),
  };
}

/** Toggle: hide components below MIN_SURVIVAL (lines and zones). Default on. */
export const onlySurvivors = store(true);

/** Toggle: warning-level cells (#18) on the globe. Default off. */
export const showWarnings = store(false);

/** Tooltip state: what is under the cursor (or pinned by a click), and where. */
export const hovered = store<{ info: PickInfo; x: number; y: number; pinned: boolean } | null>(null);

/** Satellite model viewer: the part being hovered or pinned there. While set, the globe
 * shows only that part's lines and zones. */
export const focusedPart = store<{ name: string; pinned: boolean } | null>(null);

/** Components shown under the current toggle. A focused part shows alone, even below MIN_SURVIVAL. */
export function visibleComponents(components: DebrisComponent[], only: boolean, focus: string | null = null): DebrisComponent[] {
  if (focus) return components.filter(c => c.name === focus);
  return only ? components.filter(c => c.p_survive >= MIN_SURVIVAL) : components;
}
