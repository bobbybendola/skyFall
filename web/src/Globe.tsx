// "/" page: the 3D globe. Each globe task adds its layer as one hook call
// here (see docs/GLOBE_TASKS.md); panels (G4) go inside <GlobeView>.
import { useSpacetimeDB } from 'spacetimedb/react';
import { GlobeView } from './globe/GlobeView.tsx';

export function Globe() {
  const conn = useSpacetimeDB();
  return (
    <GlobeView>
      <div className="globe-hud">
        <b>SKYFALL</b>
        <span className={conn.isActive ? 'ok' : 'bad'}>{conn.isActive ? ' live' : ' connecting…'}</span>
        <a href="/2d">2D prototype</a>
      </div>
    </GlobeView>
  );
}
