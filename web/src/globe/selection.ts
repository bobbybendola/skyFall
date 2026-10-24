// Shared "which object is selected" state for every globe task and panel.
// Tiny external store (no extra library): useSelected() re-renders on change;
// setSelected() can be called from anywhere (map click, list click, assistant).
import { useSyncExternalStore } from 'react';

let selected: string | null = null;
const listeners = new Set<() => void>();

export function setSelected(objectId: string | null): void {
  if (objectId === selected) return;
  selected = objectId;
  for (const l of listeners) l();
}

export function getSelected(): string | null {
  return selected;
}

export function useSelected(): string | null {
  return useSyncExternalStore(
    cb => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => selected
  );
}
