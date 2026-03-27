import { useMemo, useState } from 'react';

import { buildHeaderFooterRef, getHeaderFooterValue } from '../lib/excel';
import type { Workbook } from '../lib/excel';
import type { HeaderFooterKind, HeaderFooterPage, HeaderFooterSection } from '../lib/types';
import { Button } from './ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';

interface DiscriminatorPickerProps {
  isActive: boolean;
  currentCell: string;
  cells?: string[];
  workbook: Workbook | null;
  sheetNames: string[];
  activeSheet: string;
  onToggle: () => void;
  onAddRef: (ref: string, value?: string | null) => void;
  onRemoveCell: (cell: string) => void;
  onClearAll: () => void;
}

export function DiscriminatorPicker({
  isActive,
  currentCell,
  cells,
  workbook,
  sheetNames,
  activeSheet,
  onToggle,
  onAddRef,
  onRemoveCell,
  onClearAll,
}: DiscriminatorPickerProps) {
  const [showHeaderFooterForm, setShowHeaderFooterForm] = useState(false);
  const [kind, setKind] = useState<HeaderFooterKind>('header');
  const [page, setPage] = useState<HeaderFooterPage>('odd');
  const [section, setSection] = useState<HeaderFooterSection>('right');
  const [selectedSheet, setSelectedSheet] = useState('');

  const openHeaderFooterForm = () => {
    if (!showHeaderFooterForm && workbook) {
      const kinds: HeaderFooterKind[] = ['header', 'footer'];
      const pages: HeaderFooterPage[] = ['odd', 'first', 'even'];
      const sections: HeaderFooterSection[] = ['left', 'center', 'right'];
      const sheet = selectedSheet || activeSheet || sheetNames[0] || '';
      outer: for (const k of kinds) {
        for (const p of pages) {
          for (const s of sections) {
            if (getHeaderFooterValue(workbook, sheet, k, p, s)) {
              setKind(k);
              setPage(p);
              setSection(s);
              break outer;
            }
          }
        }
      }
    }
    setShowHeaderFooterForm((current) => !current);
  };
  const discriminatorCells = cells?.length ? cells : (currentCell ? [currentCell] : []);
  const count = discriminatorCells.length;
  const cellSummary = count > 0 ? `${count} cell${count === 1 ? '' : 's'}` : 'none';
  const defaultSheet = sheetNames[0] ?? '';
  const effectiveSheet = selectedSheet || activeSheet || defaultSheet;
  const headerFooterRef = useMemo(
    () => buildHeaderFooterRef(effectiveSheet, defaultSheet, kind, page, section),
    [defaultSheet, effectiveSheet, kind, page, section],
  );
  const headerFooterValue = useMemo(
    () => (
      workbook && effectiveSheet
        ? getHeaderFooterValue(workbook, effectiveSheet, kind, page, section)
        : null
    ),
    [effectiveSheet, kind, page, section, workbook],
  );

  return (
    <div className="relative flex items-center gap-2">
        <div className="text-[11px] uppercase tracking-[0.18em] text-text-muted shrink-0">Disc</div>

        {currentCell ? (
          <span className="flex items-center gap-1.5 text-xs min-w-0">
            <span className="font-mono text-text truncate">{currentCell}</span>
            {count > 1 && <span className="text-text-muted shrink-0">+{count - 1}</span>}
          </span>
        ) : (
          <span className="text-xs text-text-secondary">—</span>
        )}

        {count > 0 && (
          <div className="flex items-center gap-1.5">
            {discriminatorCells.map((cell) => (
              <span
                key={cell}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-bg px-2 py-0.5 text-xs text-text"
              >
                <span className="truncate font-mono max-w-[80px]">{cell}</span>
                <Button
                  type="button"
                  onClick={() => onRemoveCell(cell)}
                  variant="ghost"
                  size="icon-xs"
                  className="size-4 text-text-muted hover:text-red-300"
                  title={`Remove discriminator ${cell}`}
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </Button>
              </span>
            ))}
            <Button
              type="button"
              onClick={onClearAll}
              variant="ghost"
              size="xs"
              className="px-1.5 text-[11px] text-text-muted hover:text-red-300"
              title="Remove all discriminator cells"
            >
              ✕All
            </Button>
          </div>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Button
            onClick={onToggle}
            size="sm"
            variant={isActive ? 'secondary' : 'outline'}
            className={`h-8 gap-1.5 px-2.5 text-xs ${
              isActive
                ? 'border-amber-500/50 bg-amber-500/20 text-amber-300'
                : 'bg-elevated text-text-secondary hover:text-text'
            }`}
            title={isActive ? 'Click a cell to add as discriminator' : `Add discriminator cell (${cellSummary})`}
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"
              />
            </svg>
            <span>{isActive ? 'Pick' : 'Cell'}</span>
          </Button>

          <Button
            type="button"
            onClick={openHeaderFooterForm}
            size="sm"
            variant={showHeaderFooterForm ? 'secondary' : 'outline'}
            className={`h-8 gap-1.5 px-2.5 text-xs ${
              showHeaderFooterForm
                ? 'border-amber-500/50 bg-amber-500/15 text-amber-200'
                : 'bg-elevated text-text-secondary hover:text-text'
            }`}
            title="Add a header or footer discriminator"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h7" />
            </svg>
            H/F
          </Button>
        </div>

      {showHeaderFooterForm && (
        <div className="absolute right-0 top-full z-20 mt-3 w-[360px] rounded-xl border border-border bg-surface p-3 shadow-2xl">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <div className="text-xs font-medium text-text">Header/Footer Discriminator</div>
              <div className="text-[11px] text-text-muted">Build a `header:*` or `footer:*` discriminator ref.</div>
            </div>
            <Button
              type="button"
              onClick={() => setShowHeaderFooterForm(false)}
              variant="ghost"
              size="icon-sm"
              className="text-text-muted hover:text-text"
              title="Close"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-[11px] text-text-secondary">
              Sheet
              <Select
                value={effectiveSheet}
                onValueChange={setSelectedSheet}
              >
                <SelectTrigger className="w-full bg-input text-xs text-text">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {sheetNames.map((sheetName) => (
                    <SelectItem key={sheetName} value={sheetName}>
                      {sheetName}
                      {sheetName === defaultSheet ? ' (default)' : ''}
                      {sheetName === activeSheet ? ' (active)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>

            <label className="flex flex-col gap-1 text-[11px] text-text-secondary">
              Kind
              <Select
                value={kind}
                onValueChange={(value) => setKind(value as HeaderFooterKind)}
              >
                <SelectTrigger className="w-full bg-input text-xs text-text">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="header">Header</SelectItem>
                  <SelectItem value="footer">Footer</SelectItem>
                </SelectContent>
              </Select>
            </label>

            <label className="flex flex-col gap-1 text-[11px] text-text-secondary">
              Page
              <Select
                value={page}
                onValueChange={(value) => setPage(value as HeaderFooterPage)}
              >
                <SelectTrigger className="w-full bg-input text-xs text-text">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="odd">Odd / default</SelectItem>
                  <SelectItem value="first">First page</SelectItem>
                  <SelectItem value="even">Even pages</SelectItem>
                </SelectContent>
              </Select>
            </label>

            <label className="flex flex-col gap-1 text-[11px] text-text-secondary">
              Section
              <Select
                value={section}
                onValueChange={(value) => setSection(value as HeaderFooterSection)}
              >
                <SelectTrigger className="w-full bg-input text-xs text-text">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="left">Left</SelectItem>
                  <SelectItem value="center">Center</SelectItem>
                  <SelectItem value="right">Right</SelectItem>
                </SelectContent>
              </Select>
            </label>
          </div>

          <div className="mt-3 rounded-lg border border-border bg-bg px-3 py-2">
            <div className="text-[11px] text-text-muted">Ref</div>
            <div className="font-mono text-xs text-text">{headerFooterRef}</div>
          </div>

          <div className="mt-2 rounded-lg border border-border bg-bg px-3 py-2">
            <div className="text-[11px] text-text-muted">Current value</div>
            <div className="text-xs text-text break-words">
              {headerFooterValue || 'No text found for this header/footer section.'}
            </div>
          </div>

          <div className="mt-3 flex justify-end gap-2">
            <Button
              type="button"
              onClick={() => setShowHeaderFooterForm(false)}
              variant="outline"
              size="sm"
              className="bg-elevated text-xs text-text-secondary hover:text-text"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                onAddRef(headerFooterRef, headerFooterValue);
                setShowHeaderFooterForm(false);
              }}
              variant="secondary"
              size="sm"
              className="border border-amber-500/50 bg-amber-500/15 text-xs font-medium text-amber-200 hover:bg-amber-500/20"
              disabled={!effectiveSheet}
            >
              Add Ref
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
