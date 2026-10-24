import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SpacetimeDBProvider } from 'spacetimedb/react';
import { connectionBuilder } from './db.ts';
import { BigScreen } from './BigScreen.tsx';
import { Report } from './Report.tsx';
import './style.css';

// Two pages, no router: "/" is the big screen, "/report" is the phone page.
const isReport = window.location.pathname.replace(/\/+$/, '').endsWith('/report');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SpacetimeDBProvider connectionBuilder={connectionBuilder}>{isReport ? <Report /> : <BigScreen />}</SpacetimeDBProvider>
  </StrictMode>
);
