/** Undo/redo bookkeeping for a value that is replaced wholesale on every change. */

export interface History<T> {
  past: T[];
  future: T[];
}

export const HISTORY_LIMIT = 50;

export function createHistory<T>(): History<T> {
  return { past: [], future: [] };
}

/** Record the value that is being replaced, dropping any redo branch. */
export function recordChange<T>(history: History<T>, previous: T, limit = HISTORY_LIMIT): History<T> {
  const past = [...history.past, previous];
  return {
    past: past.length > limit ? past.slice(past.length - limit) : past,
    future: [],
  };
}

export function undoStep<T>(history: History<T>, current: T): { state: T; history: History<T> } | null {
  const previous = history.past[history.past.length - 1];
  if (previous === undefined) return null;

  return {
    state: previous,
    history: {
      past: history.past.slice(0, -1),
      future: [...history.future, current],
    },
  };
}

export function redoStep<T>(history: History<T>, current: T): { state: T; history: History<T> } | null {
  const next = history.future[history.future.length - 1];
  if (next === undefined) return null;

  return {
    state: next,
    history: {
      past: [...history.past, current],
      future: history.future.slice(0, -1),
    },
  };
}
