// Minimal immutable undo/redo stack for the rack builder's placement list.

export interface History<T> { past: T[]; present: T; future: T[]; }

export function createHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}

export function push<T>(h: History<T>, next: T): History<T> {
  return { past: [...h.past, h.present], present: next, future: [] };
}

export function undo<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h;
  return {
    past: h.past.slice(0, -1),
    present: h.past[h.past.length - 1],
    future: [h.present, ...h.future],
  };
}

export function redo<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h;
  return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) };
}

export const canUndo = <T,>(h: History<T>): boolean => h.past.length > 0;
export const canRedo = <T,>(h: History<T>): boolean => h.future.length > 0;
