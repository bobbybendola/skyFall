import { useEffect, useState } from 'react';
import type { Timestamp } from 'spacetimedb';
import type { FC } from './MapView.tsx';
import { stubGroundPoint, stubTrack, type StubElements } from './orbit.ts';

export const VERDICT_COLOR: Record<string, string> = {
  PENDING: '#9e9e9e',
  ACCEPTED: '#2e9d4f',
  HELD: '#f08c00',
  REJECTED: '#444444',
};

export const ms = (ts: Timestamp | undefined) => (ts ? ts.toDate().getTime() : NaN);

export function ago(ts: Timestamp | undefined, now: number): string {
  const t = ms(ts);
  if (!Number.isFinite(t)) return 'never';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

export function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

type SightingLike = {
  id: bigint;
  objectId: string;
  lat: number;
  lon: number;
  verdict: string;
  reason: string;
  mode: string;
  pInlier?: number;
  reporterKey: string;
};

export function sightingsFC(rows: readonly SightingLike[], objectId?: string): FC {
  return {
    type: 'FeatureCollection',
    features: rows
      .filter(s => !objectId || s.objectId === objectId)
      .map(s => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
        properties: {
          id: String(s.id),
          color: VERDICT_COLOR[s.verdict] ?? '#000',
          sim: s.mode === 'SIM',
          verdict: s.verdict,
          reason: s.reason,
          mode: s.mode,
          p: s.pInlier ?? null,
          reporter: s.reporterKey.startsWith('sim-') ? s.reporterKey : s.reporterKey.slice(0, 8),
        },
      })),
  };
}

export function corridorFC(bandsJson: string | undefined): FC {
  if (!bandsJson) return { type: 'FeatureCollection', features: [] };
  let bands: Array<{ level: number; polygon: number[][] }> = [];
  try {
    bands = JSON.parse(bandsJson);
  } catch {
    /* bad row: draw nothing */
  }
  return {
    type: 'FeatureCollection',
    features: bands.map(b => ({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [b.polygon] },
      properties: { level: b.level },
    })),
  };
}

export function parseElements(json: string): StubElements & Record<string, unknown> {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

export function trackFC(el: StubElements, fromMs: number, toMs: number): FC {
  return {
    type: 'FeatureCollection',
    features: stubTrack(el, fromMs, toMs).map(seg => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: seg },
      properties: {},
    })),
  };
}

export function pointFC(p: [number, number] | null, props: Record<string, unknown> = {}): FC {
  return {
    type: 'FeatureCollection',
    features: p ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: props }] : [],
  };
}

export { stubGroundPoint };

// Replay clock, same formula as the module: t_offset + (now - started_at) * speed.
export function replayClockS(
  rs: { running: boolean; tOffset: number; startedAt: Timestamp; speed: number } | undefined,
  now: number
): number {
  if (!rs) return 0;
  if (!rs.running) return rs.tOffset;
  return rs.tOffset + ((now - ms(rs.startedAt)) / 1000) * rs.speed;
}
