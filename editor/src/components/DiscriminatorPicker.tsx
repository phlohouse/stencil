import { useMemo, useState } from 'react';

import { buildHeaderFooterRef, getHeaderFooterValue } from '../lib/excel';
import type { Workbook } from '../lib/excel';
import type { HeaderFooterKind, HeaderFooterPage, HeaderFooterSection } from '../lib/types';

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
      <button
        onClick={onToggle}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
          isActive
            ? 'bg-amber-500/20 text-amber-300 border border-amber-500/50'
            : currentCell
              ? 'bg-elevated text-text-secondary border border-border-strong hover:border-border-strong'
              : 'bg-elevated text-text-secondary border border-border hover:border-border-strong'
        }`}
        title={isActive ? 'Click a cell to add as discriminator' : `Add discriminator cell (${cellSummary})`}
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"
          />
        </svg>
        {isActive ? (
          <span>Click a cell…</span>
        ) : currentCell ? (
          <span>
            Discriminator:
            {' '}
            <span className="font-mono">{currentCell}</span>
            {count > 1 ? ` +${count - 1}` : ''}
          </span>
        ) : (
          <span>Add Discriminator</span>
        )}
      </button>

      <button
        type="button"
        onClick={() => setShowHeaderFooterForm((current) => !current)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium bg-elevated text-text-secondary border border-border hover:border-border-strong transition-colors"
        title="Add a header or footer discriminator"
      >
        <span>Header/Footer</span>
      </button>

      {count > 0 && (
        <>
          <div className="flex items-center gap-1 max-w-[360px] overflow-x-auto">
            {discriminatorCells.map((cell) => (
              <span
                key={cell}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text"
              >
                <span className="font-mono">{cell}</span>
                <button
                  type="button"
                  onClick={() => onRemoveCell(cell)}
                  className="text-text-muted hover:text-red-300 transition-colors"
                  title={`Remove discriminator ${cell}`}
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </span>
            ))}
          </div>

          <button
            type="button"
            onClick={onClearAll}
            className="px-2 py-1 text-xs text-text-secondary hover:text-red-300 bg-elevated border border-border hover:border-border-strong rounded transition-colors"
            title="Remove all discriminator cells"
          >
            Clear
          </button>
        </>
      )}

      {showHeaderFooterForm && (
        <div className="absolute right-0 top-full z-20 mt-2 w-[360px] rounded-xl border border-border bg-surface p-3 shadow-2xl">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <div className="text-xs font-medium text-text">Header/Footer Discriminator</div>
              <div className="text-[11px] text-text-muted">Build a `header:*` or `footer:*` discriminator ref.</div>
            </div>
            <button
              type="button"
              onClick={() => setShowHeaderFooterForm(false)}
              className="text-text-muted hover:text-text transition-colors"
              title="Close"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-[11px] text-text-secondary">
              Sheet
              <select
                value={effectiveSheet}
                onChange={(event) => setSelectedSheet(event.target.value)}
                className="rounded-md border border-border bg-input px-2 py-1 text-xs text-text focus:outline-none focus:border-accent"
              >
                {sheetNames.map((sheetName) => (
                  <option key={sheetName} value={sheetName}>
                    {sheetName}
                    {sheetName === defaultSheet ? ' (default)' : ''}
                    {sheetName === activeSheet ? ' (active)' : ''}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-[11px] text-text-secondary">
              Kind
              <select
                value={kind}
                onChange={(event) => setKind(event.target.value as HeaderFooterKind)}
                className="rounded-md border border-border bg-input px-2 py-1 text-xs text-text focus:outline-none focus:border-accent"
              >
                <option value="header">Header</option>
                <option value="footer">Footer</option>
              </select>
            </label>

            <label className="flex flex-col gap-1 text-[11px] text-text-secondary">
              Page
              <select
                value={page}
                onChange={(event) => setPage(event.target.value as HeaderFooterPage)}
                className="rounded-md border border-border bg-input px-2 py-1 text-xs text-text focus:outline-none focus:border-accent"
              >
                <option value="odd">Odd / default</option>
                <option value="first">First page</option>
                <option value="even">Even pages</option>
              </select>
            </label>

            <label className="flex flex-col gap-1 text-[11px] text-text-secondary">
              Section
              <select
                value={section}
                onChange={(event) => setSection(event.target.value as HeaderFooterSection)}
                className="rounded-md border border-border bg-input px-2 py-1 text-xs text-text focus:outline-none focus:border-accent"
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
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
            <button
              type="button"
              onClick={() => setShowHeaderFooterForm(false)}
              className="rounded-md border border-border bg-elevated px-3 py-1.5 text-xs text-text-secondary transition-colors hover:border-border-strong hover:text-text"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                onAddRef(headerFooterRef, headerFooterValue);
                setShowHeaderFooterForm(false);
              }}
              className="rounded-md border border-amber-500/50 bg-amber-500/15 px-3 py-1.5 text-xs font-medium text-amber-200 transition-colors hover:bg-amber-500/20"
              disabled={!effectiveSheet}
            >
              Add Ref
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
