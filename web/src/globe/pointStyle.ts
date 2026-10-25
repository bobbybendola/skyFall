// What a satellite point looks like, answering two questions at a glance:
//   color = when could it come down? (earliest plausible re-entry, the forecast's
//           5th percentile, so "could come down tomorrow" is already red)
//   ring  = could it hurt someone? (modeled chance that a piece lands with > 15 J)
// The legend, the debris list and the info card all use these same rules.
import { useMemo } from 'react';
import { Color } from 'cesium';
import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings/index.ts';
import type { ReentryEntry } from './satellites.ts';
import { store } from './debrisPick.ts';

export type When = 'day' | 'days' | 'weeks' | 'later' | 'none' | 'passed';

const H = 3.6e6;
/** A ring when at least this modeled chance that a dangerous piece (> 15 J) lands. */
export const DANGER_P = 0.1;

export const WHEN_ROWS: Array<{ key: When; css: string; label: string }> = [
  { key: 'day', css: '#ff453a', label: 'could re-enter within 24 h' },
  { key: 'days', css: '#ff9f0a', label: '1–3 days' },
  { key: 'weeks', css: '#ffd60a', label: '3–14 days' },
  { key: 'later', css: '#8396b0', label: 'later, or not within the forecast window' },
  { key: 'none', css: 'transparent', label: 'no forecast yet' },
  { key: 'passed', css: 'rgba(130,130,130,0.35)', label: 'forecast window already passed' },
];
const CSS = Object.fromEntries(WHEN_ROWS.map(r => [r.key, r.css])) as Record<When, string>;
const COLOR = Object.fromEntries(
  WHEN_ROWS.map(r => [r.key, r.key === 'none' ? Color.LIGHTGRAY.withAlpha(0.12) : Color.fromCssColorString(r.css)])
) as Record<When, Color>;
export const SELECTED_CSS = '#00ffff';

/** When-category of an object. `forecasted` = a forecast ran (it may just not re-enter in the window). */
export function whenOf(r: ReentryEntry | undefined, forecasted: boolean, nowMs: number): When {
  if (!r) return forecasted ? 'later' : 'none';
  const latest = Number.isFinite(r.t95) ? r.t95 : r.t50;
  if (latest < nowMs) return 'passed';
  const earliest = Number.isFinite(r.t05) ? r.t05 : r.t50;
  const h = (earliest - nowMs) / H;
  if (h < 24) return 'day';
  if (h < 72) return 'days';
  if (h < 14 * 24) return 'weeks';
  return 'later';
}

export const whenCss = (w: When) => CSS[w];

export type PointLook = { color: Color; size: number; outlineColor: Color; outlineWidth: number };

export function pointLook(when: When, dangerous: boolean, selected: boolean): PointLook {
  const base = selected ? Color.CYAN : COLOR[when];
  const size = (selected ? 12 : 6) + (dangerous ? 3 : 0);
  if (dangerous) return { color: base, size, outlineColor: Color.WHITE, outlineWidth: 2 };
  if (when === 'none' && !selected) return { color: base, size, outlineColor: Color.LIGHTGRAY.withAlpha(0.8), outlineWidth: 1.5 };
  return { color: base, size, outlineColor: Color.BLACK, outlineWidth: 1 };
}

/** Ids whose forecast ran (status ok), whether or not it re-enters inside the window. */
export function useForecasted(): Set<string> {
  const [forecasts] = useTable(tables.forecast);
  return useMemo(() => new Set(forecasts.filter(f => f.status === 'ok').map(f => f.objectId)), [forecasts]);
}

/** Modeled chance a dangerous piece lands, by object id (only objects with a debris run that computed it). */
export function useDangerLookup(): Map<string, number> {
  const [rows] = useTable(tables.debrisForecast);
  return useMemo(() => new Map(rows.filter(r => r.pHazard >= 0).map(r => [r.objectId, r.pHazard])), [rows]);
}

/** Legend filter: show only one when-category, or only dangerous objects. null = everything. */
export const pointFilter = store<When | 'danger' | null>(null);

export function passesFilter(filter: When | 'danger' | null, when: When, dangerous: boolean): boolean {
  if (filter === null) return true;
  return filter === 'danger' ? dangerous : when === filter;
}
