import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SpacetimeDBProvider } from 'spacetimedb/react';
import { connectionBuilder } from './db.ts';
import { BigScreen } from './BigScreen.tsx';
import { Report } from './Report.tsx';
import { Globe } from './Globe.tsx';
import './style.css';

// Pages, no router: "/" 3D globe, "/2d" the 2D prototype (until the G4 panels
// move to the globe), "/report" the parked phone page.
const path = window.location.pathname.replace(/\/+$/, '');
const page = path.endsWith('/report') ? <Report /> : path.endsWith('/2d') ? <BigScreen /> : <Globe />;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SpacetimeDBProvider connectionBuilder={connectionBuilder}>{page}</SpacetimeDBProvider>
  </StrictMode>
);
