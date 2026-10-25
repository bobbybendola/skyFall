// "/" page: the 3D globe. Each globe task adds its layer as one hook call in
// <Layers> (see docs/GLOBE_TASKS.md); panels (G4) go inside <GlobeView>.
import { useSpacetimeDB } from 'spacetimedb/react';
import { GlobeView, useViewer } from './globe/GlobeView.tsx';
import { useSatelliteLayer, useTrackedObjects } from './globe/satellites.ts';
import { SelectedCard, useClickToSelect, useSelectedOrbit } from './globe/selectionLayer.tsx';
import { useSelectedDebris } from './globe/debris.ts';
import { DebrisList } from './globe/debrisList.tsx';
import { useDebrisLines } from './globe/debrisLines.ts';
import { Legend } from './globe/legend.tsx';
import { SatModelPanel } from './globe/SatModelPanel.tsx';
import { useDetailedMap } from './globe/mapLayers.ts';
import { MapControls } from './globe/mapControls.tsx';
import { useOrbitControls } from './globe/orbitControls.ts';

function Layers() {
  const viewer = useViewer();
  useDetailedMap(viewer); // Esri imagery + terrain (falls back to the offline globe)
  useOrbitControls(viewer); // drag pivots: Earth's center, ground point or the selected satellite
  const { objects, reentry } = useTrackedObjects();
  useSatelliteLayer(viewer, objects, reentry); // G1
  useClickToSelect(viewer); // G1
  useSelectedOrbit(viewer, objects); // G1
  const debris = useSelectedDebris(objects, reentry); // shared by G2-G4 (mock until the debris tables exist)
  const debrisUi = useDebrisLines(viewer, debris); // G2: lines to landing points + impact zones
  // G3: useFallingDebris(viewer, debris)
  return (
    <>
      {debrisUi}
      <Legend />
      <MapControls viewer={viewer} />
      <DebrisList viewer={viewer} objects={objects} reentry={reentry} />
      <SelectedCard viewer={viewer} objects={objects} reentry={reentry} debris={debris} />
      <SatModelPanel objects={objects} debris={debris} />
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
