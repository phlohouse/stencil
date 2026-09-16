import { useState, useCallback, useEffect } from 'react';
import { parseWorkbook, getSheetNames, getSheetData } from '../lib/excel';
import type { SheetData, Workbook } from '../lib/excel';
import type { Selection, CellAddress } from '../lib/types';
import { saveFile as saveToIDB, loadFile as loadFromIDB } from '../lib/storage';

interface SpreadsheetState {
  workbook: Workbook | null;
  sheetNames: string[];
  activeSheet: string;
  sheetData: SheetData | null;
  selection: Selection | null;
}

const EMPTY_STATE: SpreadsheetState = {
  workbook: null,
  sheetNames: [],
  activeSheet: '',
  sheetData: null,
  selection: null,
};

export function useSpreadsheet() {
  const [state, setState] = useState<SpreadsheetState>(EMPTY_STATE);

  const loadFromBuffer = useCallback(async (buffer: ArrayBuffer, persist = false) => {
    const workbook = await parseWorkbook(buffer);
    const sheetNames = getSheetNames(workbook);
    const activeSheet = sheetNames[0] ?? '';
    const sheetData = activeSheet ? getSheetData(workbook, activeSheet) : null;

    setState({
      workbook,
      sheetNames,
      activeSheet,
      sheetData,
      selection: null,
    });

    if (persist) {
      saveToIDB(buffer).catch(() => { /* ignore */ });
    }
  }, []);

  // Restore file from IndexedDB on mount
  useEffect(() => {
    loadFromIDB()
      .then((buffer) => { if (buffer) loadFromBuffer(buffer); })
      .catch(() => { /* ignore */ });
  }, [loadFromBuffer]);

  const loadFile = useCallback(
    (buffer: ArrayBuffer) => loadFromBuffer(buffer, true),
    [loadFromBuffer],
  );

  const reset = useCallback(() => {
    setState(EMPTY_STATE);
  }, []);

  const switchSheet = useCallback((sheetName: string) => {
    setState((s) => {
      if (!s.workbook) return s;
      return {
        ...s,
        activeSheet: sheetName,
        sheetData: getSheetData(s.workbook, sheetName),
        selection: null,
      };
    });
  }, []);

  /**
   * The single writer for the grid selection. Gestures call this on every live
   * update and again on release, so the app never has to read selection state
   * that React has not committed yet.
   */
  const setSelection = useCallback((selection: Selection | null) => {
    setState((s) => {
      if (selection === null) {
        return s.selection === null ? s : { ...s, selection: null };
      }
      return { ...s, selection: { start: selection.start, end: selection.end } };
    });
  }, []);

  const setSelectionCell = useCallback((cell: CellAddress) => {
    setState((s) => ({ ...s, selection: { start: cell, end: cell } }));
  }, []);

  const clearSelection = useCallback(() => {
    setSelection(null);
  }, [setSelection]);

  return {
    workbook: state.workbook,
    sheetNames: state.sheetNames,
    activeSheet: state.activeSheet,
    sheetData: state.sheetData,
    selection: state.selection,
    loadFile,
    loadFromBuffer,
    reset,
    switchSheet,
    setSelection,
    setSelectionCell,
    clearSelection,
  };
}
