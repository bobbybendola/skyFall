// Readability helpers for the globe: the point-color legend and plain-language
// re-entry times ("in 14 h (Sat 2:40 AM PDT)" instead of UTC timestamps).
import { useEffect, useState } from 'react';
import { JulianDate, type Viewer } from 'cesium';
import type { ReentryEntry, ReentryLookup, TrackedObject } from './satellites.ts';
import { PanelTitle, usePanelOpen } from './panel.tsx';
import { DANGER_P, pointFilter, SELECTED_CSS, WHEN_ROWS, whenCss, whenOf, type When } from './pointStyle.ts';

/** A point's swatch, same rules as the globe: color = when, white ring = dangerous. */
export function WhenDot({ when, dangerous = false }: { when: When; dangerous?: boolean }) {
  return <span className={`dot${when === 'none' ? ' hollow' : ''}${dangerous ? ' danger' : ''}`} style={{ background: whenCss(when) }} />;
}

/** Swatch for one object from its forecast (list rows, info card). */
export function EntryDot({ r, nowMs, dangerous }: { r: ReentryEntry | undefined; nowMs: number; dangerous?: boolean }) {
  return <WhenDot when={whenOf(r, false, nowMs)} dangerous={dangerous} />;
}

/** The Cesium clock time in ms, refreshed every second (so relative times follow a jump). */
export function useClockNow(viewer: Viewer | null): number {
  const read = () => (viewer && !viewer.isDestroyed() ? JulianDate.toDate(viewer.clock.currentTime).getTime() : Date.now());
  const [now, setNow] = useState(read);
  useEffect(() => {
    const t = setInterval(() => setNow(read()), 1000);
    return () => clearInterval(t);
  }, [viewer]); // eslint-disable-line react-hooks/exhaustive-deps
  return now;
}

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

type LegendProps = {
  viewer: Viewer | null;
  objects: TrackedObject[];
  reentry: ReentryLookup;
  forecasted: Set<string>;
  danger: Map<string, number>;
};

/** Point legend with live counts; click a row to show only those points (click again for all). */
export function Legend({ viewer, objects, reentry, forecasted, danger }: LegendProps) {
  const nowMs = useClockNow(viewer);
  const filter = pointFilter.use();
  const counts = new Map<When, number>();
  let dangerous = 0;
  for (const o of objects) {
    const w = whenOf(reentry.get(o.id), forecasted.has(o.id), nowMs);
    counts.set(w, (counts.get(w) ?? 0) + 1);
    if ((danger.get(o.id) ?? 0) >= DANGER_P) dangerous++;
  }
  const [open, toggleOpen] = usePanelOpen('legend');
  const toggle = (f: When | 'danger') => pointFilter.set(filter === f ? null : f);
  const row = (key: When | 'danger', dot: ReturnType<typeof WhenDot>, label: string, n: number) => (
    <button key={key} className={filter === key ? 'on' : filter ? 'off' : ''} onClick={() => toggle(key)} disabled={n === 0 && filter !== key}>
      {dot} {label} <span className="count">{n}</span>
    </button>
  );
  return (
    <div className="globe-legend">
      <PanelTitle open={open} onToggle={toggleOpen}>
        <b>When could it come down?</b>
      </PanelTitle>
      {open && (
        <>
          <div className="muted">color = earliest plausible re-entry</div>
          {WHEN_ROWS.map(r => row(r.key, <WhenDot when={r.key} />, r.label, counts.get(r.key) ?? 0))}
          <b>Could it hurt someone?</b>
          {row('danger', <WhenDot when="later" dangerous />, `ring: ≥ ${Math.round(DANGER_P * 100)}% chance a piece lands with > 15 J`, dangerous)}
          <div className="muted">modeled estimate; no ring = harmless or not modeled yet</div>
          <div>
            <span className="dot" style={{ background: SELECTED_CSS }} /> selected
          </div>
        </>
      )}
      {filter && (
        <button className="clear" onClick={() => pointFilter.set(null)}>
          show all points
        </button>
      )}
    </div>
  );
}
