import { useState, useCallback } from 'react';
import type { StencilVersion } from '../lib/types';

interface VersionManagerProps {
  versions: StencilVersion[];
  activeIndex: number;
  onSwitchVersion: (index: number) => void;
  onAddVersion: (discriminatorValue: string, copyFromIndex?: number) => void;
  onRemoveVersion: (index: number) => void;
  onUpdateDiscriminatorValue: (value: string) => void;
}

export function VersionManager({
  versions,
  activeIndex,
  onSwitchVersion,
  onAddVersion,
  onRemoveVersion,
  onUpdateDiscriminatorValue,
}: VersionManagerProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [newValue, setNewValue] = useState('');
  const [copyFromIndex, setCopyFromIndex] = useState<number | ''>('');

  const handleAdd = useCallback(() => {
    if (newValue.trim()) {
      onAddVersion(newValue.trim(), copyFromIndex === '' ? undefined : copyFromIndex);
      setNewValue('');
      setCopyFromIndex('');
      setIsAdding(false);
    }
  }, [copyFromIndex, newValue, onAddVersion]);

  return (
    <div className="flex items-center gap-1">
      {versions.map((v, i) => (
        <div key={i} className="flex items-center">
          <button
            onClick={() => onSwitchVersion(i)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
              i === activeIndex
                ? 'bg-accent text-text'
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
                className="w-20 px-2 py-1 bg-surface border border-border-strong rounded text-xs text-text font-mono focus:outline-none focus:border-accent"
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
              if (e.key === 'Escape') setIsAdding(false);
            }}
            placeholder="v2.0"
            className="w-20 px-2 py-1 bg-surface border border-border-strong rounded text-xs text-text font-mono focus:outline-none focus:border-accent"
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
            onClick={() => setIsAdding(false)}
            className="text-text-muted hover:text-text-secondary p-1"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          <select
            value={copyFromIndex}
            onChange={(e) => setCopyFromIndex(e.target.value === '' ? '' : parseInt(e.target.value, 10))}
            className="w-28 px-2 py-1 bg-surface border border-border-strong rounded text-xs text-text-secondary focus:outline-none focus:border-accent"
            title="Copy fields and validation from another version"
          >
            <option value="">Blank</option>
            {versions.map((v, i) => (
              <option key={`${v.discriminatorValue}-${i}`} value={i}>
                Copy {v.discriminatorValue}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <button
          onClick={() => setIsAdding(true)}
          className="px-2 py-1.5 text-xs text-text-secondary hover:text-text bg-elevated border border-border hover:border-border-strong rounded-lg transition-colors"
          title="Add version"
        >
          + Version
        </button>
      )}
    </div>
  );
}
