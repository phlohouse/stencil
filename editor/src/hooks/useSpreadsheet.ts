import { useState, useCallback } from 'react';
import type { WorkBook } from 'xlsx';
import { parseWorkbook, getSheetNames, getSheetData } from '../lib/excel';
import type { SheetData } from '../lib/excel';
import type { Selection, CellAddress } from '../lib/types';

interface SpreadsheetState {
  workbook: WorkBook | null;
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

  const loadFile = useCallback((buffer: ArrayBuffer) => {
    const workbook = parseWorkbook(buffer);
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

  const extendSelection = useCallback(
    (addr: CellAddress) => {
      if (!state.isSelecting) return;
      setState((s) => ({
        ...s,
        selection: s.selection ? { start: s.selection.start, end: addr } : null,
      }));
    },
    [state.isSelecting],
  );

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
    switchSheet,
    startSelection,
    extendSelection,
    endSelection,
    clearSelection,
  };
}
