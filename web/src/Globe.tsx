// "/" page: the 3D globe. Each globe task adds its layer as one hook call in
// <Layers> (see docs/GLOBE_TASKS.md); panels (G4) go inside <GlobeView>.
import { useSpacetimeDB } from 'spacetimedb/react';
import { GlobeView, useViewer } from './globe/GlobeView.tsx';
import { useSatelliteLayer, useTrackedObjects } from './globe/satellites.ts';
import { SelectedCard, useClickToSelect, useSelectedOrbit } from './globe/selectionLayer.tsx';
import { useSelectedDebris } from './globe/debris.ts';
import { useDebrisLines } from './globe/debrisLines.tsx';

function Layers() {
  const viewer = useViewer();
  const { objects, reentry } = useTrackedObjects();
  useSatelliteLayer(viewer, objects, reentry); // G1
  useClickToSelect(viewer); // G1
  useSelectedOrbit(viewer, objects, reentry); // G1
  const debris = useSelectedDebris(objects, reentry); // shared by G2-G4 (mock until the debris tables exist)
  const debrisLines = useDebrisLines(viewer, debris, objects); // G2
  return (
    <>
      {debrisLines}
      <SelectedCard viewer={viewer} objects={objects} reentry={reentry} debris={debris} />
    </>
  );
}

export function Globe() {
  const conn = useSpacetimeDB();
  return (
    <GlobeView>
      <Layers />
      <div className="globe-hud">
        <b>SKYFALL</b>
        <span className={conn.isActive ? 'ok' : 'bad'}>{conn.isActive ? ' live' : ' connecting…'}</span>
        <a href="/2d">2D prototype</a>
      </div>
    </GlobeView>
  );
}
