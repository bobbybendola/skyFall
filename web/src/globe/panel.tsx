// Collapsible globe panels. Each panel remembers whether it is open (per browser);
// on narrow screens panels start collapsed so the globe stays visible.
import { useState, type ReactNode } from 'react';

export const NARROW = '(max-width: 640px)';

function read(id: string): boolean | null {
  try {
    const v = localStorage.getItem(`skyfall.panel.${id}`);
    return v === null ? null : v === '1';
  } catch {
    return null;
  }
}

function write(id: string, open: boolean) {
  try {
    localStorage.setItem(`skyfall.panel.${id}`, open ? '1' : '0');
  } catch {
    /* storage blocked: the choice just isn't remembered */
  }
}

/** Open state of a panel: the remembered choice, else open on wide screens and collapsed on narrow ones. */
export function usePanelOpen(id: string): [boolean, () => void] {
  const [open, setOpen] = useState(() => read(id) ?? !window.matchMedia?.(NARROW).matches);
  const toggle = () =>
    setOpen(o => {
      write(id, !o);
      return !o;
    });
  return [open, toggle];
}

/** Panel heading that collapses/expands the panel. */
export function PanelTitle({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <button type="button" className="panel-title" aria-expanded={open} onClick={onToggle}>
      <span className="chev" aria-hidden>
        {open ? '▾' : '▸'}
      </span>
      {children}
    </button>
  );
}
