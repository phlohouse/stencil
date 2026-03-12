import { useState, useCallback, useRef, type DragEvent } from 'react';
import type { StencilVersion } from '../lib/types';

interface VersionManagerProps {
  versions: StencilVersion[];
  activeIndex: number;
  onSwitchVersion: (index: number) => void;
  onAddVersion: (discriminatorValue: string, copyFromIndex?: number, newFileBuffer?: ArrayBuffer) => void;
  onRemoveVersion: (index: number) => void;
  onUpdateDiscriminatorValue: (value: string) => void;
  onGuessDiscriminator?: (file: File) => Promise<string | null>;
}

export function VersionManager({
  versions,
  activeIndex,
  onSwitchVersion,
  onAddVersion,
  onRemoveVersion,
  onUpdateDiscriminatorValue,
  onGuessDiscriminator,
}: VersionManagerProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [newValue, setNewValue] = useState('');
  const [copyFromIndex, setCopyFromIndex] = useState<number | ''>('');
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleAdd = useCallback(() => {
    if (!newValue.trim()) return;

    if (pendingFile) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const buffer = e.target?.result as ArrayBuffer;
        if (buffer) {
          onAddVersion(newValue.trim(), copyFromIndex === '' ? undefined : copyFromIndex, buffer);
        }
      };
      reader.readAsArrayBuffer(pendingFile);
    } else {
      onAddVersion(newValue.trim(), copyFromIndex === '' ? undefined : copyFromIndex);
    }

    setNewValue('');
    setCopyFromIndex('');
    setPendingFile(null);
    setIsAdding(false);
  }, [copyFromIndex, newValue, onAddVersion, pendingFile]);

  const handleCancel = useCallback(() => {
    setNewValue('');
    setCopyFromIndex('');
    setPendingFile(null);
    setIsDragging(false);
    setIsAdding(false);
  }, []);

  const guessFromFile = useCallback((file: File) => {
    setPendingFile(file);
    if (onGuessDiscriminator && !newValue.trim()) {
      onGuessDiscriminator(file).then((value) => {
        if (value) setNewValue(value);
      });
    }
  }, [onGuessDiscriminator, newValue]);

  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file && /\.(xlsx|xls|xlsm)$/i.test(file.name)) {
      guessFromFile(file);
    }
  }, [guessFromFile]);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  return (
    <div className="flex items-center gap-1">
      {versions.map((v, i) => (
        <div key={i} className="flex items-center">
          <button
            onClick={() => onSwitchVersion(i)}
            className={`h-6 px-3 text-xs font-medium rounded-lg transition-colors ${
              i === activeIndex
                ? 'bg-accent text-white'
                : 'bg-elevated text-text-secondary hover:text-text border border-border'
            }`}
          >
            {v.discriminatorValue}
          </button>
          {i === activeIndex && (
            <div className="flex items-center ml-1 gap-1">
              <input
                type="text"
                value={v.discriminatorValue}
                onChange={(e) => onUpdateDiscriminatorValue(e.target.value)}
                className="w-20 h-6 px-2 bg-surface border border-border-strong rounded text-xs text-text font-mono focus:outline-none focus:border-accent"
                title="Version discriminator value"
              />
              {versions.length > 1 && (
                <button
                  onClick={() => onRemoveVersion(i)}
                  className="text-text-muted hover:text-red-400 p-1 transition-colors"
                  title="Remove version"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          )}
        </div>
      ))}

      {isAdding ? (
        <div className="flex items-center gap-1">
          <input
            type="text"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAdd();
              if (e.key === 'Escape') handleCancel();
            }}
            placeholder="v2.0"
            className="w-20 h-6 px-2 bg-surface border border-border-strong rounded text-xs text-text font-mono focus:outline-none focus:border-accent"
            autoFocus
          />
          <button
            onClick={handleAdd}
            className="text-green-400 hover:text-green-300 p-1"
            title="Add version"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </button>
          <button
            onClick={handleCancel}
            className="text-text-muted hover:text-text-secondary p-1"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          <select
            value={copyFromIndex}
            onChange={(e) => setCopyFromIndex(e.target.value === '' ? '' : parseInt(e.target.value, 10))}
            className="w-28 h-6 px-2 bg-surface border border-border-strong rounded text-xs text-text-secondary focus:outline-none focus:border-accent"
            title="Copy fields and validation from another version"
          >
            <option value="">Blank</option>
            {versions.map((v, i) => (
              <option key={`${v.discriminatorValue}-${i}`} value={i}>
                Copy {v.discriminatorValue}
              </option>
            ))}
          </select>
          <label
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            className={`h-6 px-2 text-[10px] rounded inline-flex items-center gap-1 cursor-pointer transition-colors border ${
              isDragging
                ? 'border-accent bg-accent/10 text-accent'
                : pendingFile
                  ? 'border-green-500/50 bg-green-500/10 text-green-400'
                  : 'border-dashed border-border-strong text-text-muted hover:text-text-secondary hover:border-border-strong'
            }`}
            title="Drop or click to load a spreadsheet for this version"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
            </svg>
            {pendingFile ? pendingFile.name.slice(0, 20) : 'Drop file'}
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.xlsm"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) guessFromFile(file);
                e.target.value = '';
              }}
              className="hidden"
            />
          </label>
          {pendingFile && (
            <button
              onClick={() => {
                setPendingFile(null);
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
              className="text-text-muted hover:text-text-secondary p-0.5"
              title="Remove file"
            >
              <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      ) : (
        <button
          onClick={() => setIsAdding(true)}
          className="h-6 px-2 text-xs text-text-secondary hover:text-text bg-elevated border border-border hover:border-border-strong rounded-lg transition-colors"
          title="Add version"
        >
          + Version
        </button>
      )}
    </div>
  );
}
