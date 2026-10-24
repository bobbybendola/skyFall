// The single Cesium Viewer for the whole app. Layers (G1 satellites, G2 lines
// and zones, G3 animation) attach through useViewer() and clean up after
// themselves; panels (G4) render as children on top of the globe.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Viewer } from 'cesium';
import { createViewer } from './cesium-setup.ts';

const ViewerContext = createContext<Viewer | null>(null);

/** The Cesium viewer, or null until it is created. */
export function useViewer(): Viewer | null {
  return useContext(ViewerContext);
}

export function GlobeView({ children }: { children?: ReactNode }) {
  const el = useRef<HTMLDivElement>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);

  useEffect(() => {
    if (!el.current) return;
    const v = createViewer(el.current);
    setViewer(v);
    return () => {
      setViewer(null);
      v.destroy();
    };
  }, []);

  return (
    <ViewerContext.Provider value={viewer}>
      <div className="globe">
        <div ref={el} className="globe-canvas" />
        {viewer && children}
      </div>
    </ViewerContext.Provider>
  );
}
