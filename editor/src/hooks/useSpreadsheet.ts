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
  isSelecting: boolean;
}

export function useSpreadsheet() {
  const [state, setState] = useState<SpreadsheetState>({
    workbook: null,
    sheetNames: [],
    activeSheet: '',
    sheetData: null,
    selection: null,
    isSelecting: false,
  });

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
      isSelecting: false,
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

  const loadFile = useCallback((buffer: ArrayBuffer) => {
    loadFromBuffer(buffer, true);
  }, [loadFromBuffer]);

  const reset = useCallback(() => {
    setState({
      workbook: null,
      sheetNames: [],
      activeSheet: '',
      sheetData: null,
      selection: null,
      isSelecting: false,
    });
  }, []);

  const switchSheet = useCallback(
    (sheetName: string) => {
      if (!state.workbook) return;
      const sheetData = getSheetData(state.workbook, sheetName);
      setState((s) => ({
        ...s,
        activeSheet: sheetName,
        sheetData,
        selection: null,
      }));
    },
    [state.workbook],
  );

  const startSelection = useCallback((addr: CellAddress) => {
    setState((s) => ({
      ...s,
      selection: { start: addr, end: addr },
      isSelecting: true,
    }));
  }, []);

  const extendSelection = useCallback((addr: CellAddress) => {
    setState((s) => {
      if (!s.isSelecting) return s;
      return {
        ...s,
        selection: s.selection ? { start: s.selection.start, end: addr } : null,
      };
    });
  }, []);

  const setSelection = useCallback((start: CellAddress, end: CellAddress) => {
    setState((s) => ({
      ...s,
      selection: { start, end },
      isSelecting: true,
    }));
  }, []);

  const endSelection = useCallback(() => {
    setState((s) => ({ ...s, isSelecting: false }));
  }, []);

  const clearSelection = useCallback(() => {
    setState((s) => ({ ...s, selection: null, isSelecting: false }));
  }, []);

  return {
    workbook: state.workbook,
    sheetNames: state.sheetNames,
    activeSheet: state.activeSheet,
    sheetData: state.sheetData,
    selection: state.selection,
    isSelecting: state.isSelecting,
    loadFile,
    reset,
    switchSheet,
    startSelection,
    extendSelection,
    setSelection,
    endSelection,
    clearSelection,
  };
}
