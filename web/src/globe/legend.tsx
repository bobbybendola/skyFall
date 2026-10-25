// Readability helpers for the globe: the point-color legend and plain-language
// re-entry times ("in 14 h (Sat 2:40 AM PDT)" instead of UTC timestamps).
import { Color } from 'cesium';
import { reentryColor } from './satellites.ts';

/** CSS color of a point, same rule as the globe (satellites.reentryColor). */
export const reentryCss = (t50: number | undefined, nowMs: number) => reentryColor(t50, nowMs, false).toCssColorString();

/** "in 14 h", "in 2.5 days", "3 h ago". */
export function relTime(t: number, nowMs: number): string {
  if (!Number.isFinite(t)) return '?';
  const h = (t - nowMs) / 3.6e6;
  const a = Math.abs(h);
  const s = a < 1 ? `${Math.max(1, Math.round(a * 60))} min` : a < 48 ? `${Math.round(a)} h` : `${(a / 24).toFixed(1)} days`;
  return h >= 0 ? `in ${s}` : `${s} ago`;
}

/** Local wall time, e.g. "Sat 2:40 AM PDT". */
export const localTime = (t: number) =>
  Number.isFinite(t) ? new Date(t).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) : '?';

const ROWS: Array<[Color, string]> = [
  [Color.RED, 're-entry in < 12 h'],
  [Color.ORANGE, '12–48 h'],
  [Color.YELLOW, '2–7 days'],
  [Color.LIGHTGRAY, 'later than 7 days'],
  [Color.LIGHTGRAY.withAlpha(0.8), 'no forecast yet'],
  [Color.DIMGRAY, 'forecast time passed'],
  [Color.CYAN, 'selected'],
];

export function Legend() {
  return (
    <div className="globe-legend">
      <b>Point color = forecast re-entry</b>
      {ROWS.map(([c, label]) => (
        <div key={label}>
          <span className="dot" style={{ background: c.toCssColorString() }} /> {label}
        </div>
      ))}
    </div>
  );
}
