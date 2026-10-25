// Warning levels (#18): per ~110 km cell, the modeled chance that a dangerous piece
// (>= 15 J at impact) lands there, from debris_forecast.hazard_grid. Drawn as one
// equirectangular image on the globe (1 px per cell), so thousands of cells cost
// one texture. Every level is a modeled estimate.
import { useEffect } from 'react';
import { ImageryLayer, Rectangle, SingleTileImageryProvider, TextureMagnificationFilter, type Viewer } from 'cesium';
import type { DebrisResult } from './debrisTypes.ts';

export type Level = { name: 'Advisory' | 'Watch' | 'Warning'; min: number; css: string; blurb: string };

// Highest first. Thresholds agreed for #18.
export const LEVELS: Level[] = [
  { name: 'Warning', min: 0.01, css: 'rgba(255, 59, 59, 0.70)', blurb: '≥ 1% chance a dangerous piece lands in this ~110 km cell' },
  { name: 'Watch', min: 0.001, css: 'rgba(255, 140, 0, 0.55)', blurb: '≥ 0.1%' },
  { name: 'Advisory', min: 0.0001, css: 'rgba(255, 216, 77, 0.40)', blurb: '≥ 0.01% (any simulated run)' },
];

// Re-entry time is uncertain by hours to days until close in, so Warning is only
// shown within this long of the predicted break-up; earlier, Warning cells show as Watch.
export const WARNING_WINDOW_MS = 24 * 3600_000;

export function levelFor(p: number, warningAllowed: boolean): Level | null {
  for (const l of LEVELS) {
    if (p < l.min) continue;
    if (l.name === 'Warning' && !warningAllowed) return LEVELS[1];
    return l;
  }
  return null;
}

/** Cell counts per level, for the legend. */
export function levelCounts(debris: DebrisResult, warningAllowed: boolean): Record<Level['name'], number> {
  const out = { Warning: 0, Watch: 0, Advisory: 0 };
  const g = debris.hazard_grid;
  if (!g || g.n_runs <= 0) return out;
  for (const [, , runs] of g.cells) {
    const l = levelFor(runs / g.n_runs, warningAllowed);
    if (l) out[l.name]++;
  }
  return out;
}

function gridImage(debris: DebrisResult, warningAllowed: boolean): string | null {
  const g = debris.hazard_grid;
  if (!g || g.n_runs <= 0 || g.cells.length === 0) return null;
  const w = Math.round(360 / g.cell_deg);
  const h = Math.round(180 / g.cell_deg);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  for (const [latS, lonW, runs] of g.cells) {
    const l = levelFor(runs / g.n_runs, warningAllowed);
    if (!l) continue;
    ctx.fillStyle = l.css;
    const x = Math.round((lonW + 180) / g.cell_deg);
    const y = Math.round((90 - latS) / g.cell_deg) - 1; // row 0 is the north edge
    ctx.fillRect(x, y, 1, 1);
  }
  return canvas.toDataURL('image/png');
}

/** Breakup time of the selected object (ms), when known. */
export function breakupMs(debris: DebrisResult | null): number | undefined {
  const t = debris?.breakup?.t_unix_s;
  return t && t > 0 ? t * 1000 : undefined;
}

export function useWarningLayer(viewer: Viewer | null, debris: DebrisResult | null, on: boolean, warningAllowed: boolean): void {
  useEffect(() => {
    if (!viewer || !debris || !on) return;
    const url = gridImage(debris, warningAllowed);
    if (!url) return;
    let layer: ImageryLayer | null = null;
    let cancelled = false;
    SingleTileImageryProvider.fromUrl(url, { rectangle: Rectangle.MAX_VALUE }).then(provider => {
      if (cancelled || viewer.isDestroyed()) return;
      layer = new ImageryLayer(provider, { magnificationFilter: TextureMagnificationFilter.NEAREST });
      viewer.imageryLayers.add(layer);
    });
    return () => {
      cancelled = true;
      if (layer && !viewer.isDestroyed()) viewer.imageryLayers.remove(layer, true);
    };
  }, [viewer, debris, on, warningAllowed]);
}
