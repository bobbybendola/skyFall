// Map panel: detailed/basic map toggle, relief exaggeration, and the ground
// elevation under the cursor (from the loaded terrain tiles).
import { useEffect, useState } from 'react';
import { Cartographic, defined, ScreenSpaceEventHandler, ScreenSpaceEventType, type Cartesian2, type Viewer } from 'cesium';
import { detailedMap, reliefScale } from './mapLayers.ts';

const RELIEF_STEPS = [1, 2, 3, 5];

type Ground = { lat: number; lon: number; elevM: number | null };

function useGroundUnderCursor(viewer: Viewer | null, on: boolean): Ground | null {
  const [ground, setGround] = useState<Ground | null>(null);
  useEffect(() => {
    if (!viewer || !on) return setGround(null);
    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    let frame = 0;
    let pending: Cartesian2 | null = null;
    handler.setInputAction((e: { endPosition: Cartesian2 }) => {
      pending = e.endPosition;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!pending || viewer.isDestroyed()) return;
        const ray = viewer.camera.getPickRay(pending);
        const hit = ray && viewer.scene.globe.pick(ray, viewer.scene);
        if (!defined(hit)) return setGround(null);
        const c = Cartographic.fromCartesian(hit);
        const h = viewer.scene.globe.getHeight(c);
        setGround({
          lat: (c.latitude * 180) / Math.PI,
          lon: (c.longitude * 180) / Math.PI,
          elevM: h === undefined ? null : h / (viewer.scene.verticalExaggeration || 1),
        });
      });
    }, ScreenSpaceEventType.MOUSE_MOVE);
    return () => {
      cancelAnimationFrame(frame);
      handler.destroy();
    };
  }, [viewer, on]);
  return ground;
}

export function MapControls({ viewer }: { viewer: Viewer | null }) {
  const detailed = detailedMap.use();
  const relief = reliefScale.use();
  const ground = useGroundUnderCursor(viewer, detailed);
  return (
    <div className="globe-map-controls">
      <label>
        <input type="checkbox" checked={detailed} onChange={e => detailedMap.set(e.target.checked)} /> Detailed map + terrain
      </label>
      {detailed && (
        <>
          <label>
            Relief{' '}
            <select value={relief} onChange={e => reliefScale.set(Number(e.target.value))}>
              {RELIEF_STEPS.map(s => (
                <option key={s} value={s}>
                  {s === 1 ? '×1 (true scale)' : `×${s}`}
                </option>
              ))}
            </select>
          </label>
          <span className="ground">
            {ground
              ? `${ground.lat.toFixed(3)}°, ${ground.lon.toFixed(3)}° · ${ground.elevM === null ? 'elevation loading…' : `${Math.round(ground.elevM).toLocaleString()} m`}`
              : 'point at the ground for elevation'}
          </span>
        </>
      )}
    </div>
  );
}
