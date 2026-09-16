import { describe, expect, it } from 'vitest';
import { createHistory, recordChange, redoStep, undoStep, HISTORY_LIMIT } from './history';

describe('history', () => {
  it('walks back and forward through recorded states', () => {
    let history = createHistory<string>();
    history = recordChange(history, 'a');
    history = recordChange(history, 'b');

    const undone = undoStep(history, 'c');
    expect(undone?.state).toBe('b');

    const undoneAgain = undoStep(undone!.history, 'b');
    expect(undoneAgain?.state).toBe('a');

    const redone = redoStep(undoneAgain!.history, 'a');
    expect(redone?.state).toBe('b');
  });

  it('does nothing when there is nothing to undo or redo', () => {
    const history = createHistory<string>();
    expect(undoStep(history, 'a')).toBeNull();
    expect(redoStep(history, 'a')).toBeNull();
  });

  it('drops the redo branch once a new change is recorded', () => {
    let history = createHistory<string>();
    history = recordChange(history, 'a');
    const undone = undoStep(history, 'b');
    expect(undone).not.toBeNull();

    const afterNewChange = recordChange(undone!.history, 'a');
    expect(afterNewChange.future).toHaveLength(0);
    expect(redoStep(afterNewChange, 'c')).toBeNull();
  });

  it('keeps the most recent states when the limit is reached', () => {
    let history = createHistory<number>();
    for (let index = 0; index < HISTORY_LIMIT + 10; index += 1) {
      history = recordChange(history, index);
    }

    expect(history.past).toHaveLength(HISTORY_LIMIT);
    expect(history.past[0]).toBe(10);
  });
});
