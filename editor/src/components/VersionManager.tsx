import { useState, useCallback } from 'react';
import type { StencilVersion } from '../lib/types';

interface VersionManagerProps {
  versions: StencilVersion[];
  activeIndex: number;
  onSwitchVersion: (index: number) => void;
  onAddVersion: (discriminatorValue: string) => void;
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

  const handleAdd = useCallback(() => {
    if (newValue.trim()) {
      onAddVersion(newValue.trim());
      setNewValue('');
      setIsAdding(false);
    }
  }, [newValue, onAddVersion]);

  return (
    <div className="flex items-center gap-1">
      {versions.map((v, i) => (
        <div key={i} className="flex items-center">
          <button
            onClick={() => onSwitchVersion(i)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
              i === activeIndex
                ? 'bg-blue-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:text-gray-200 border border-gray-700'
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
                className="w-20 px-2 py-1 bg-gray-900 border border-gray-600 rounded text-xs text-white font-mono focus:outline-none focus:border-blue-500"
                title="Version discriminator value"
              />
              {versions.length > 1 && (
                <button
                  onClick={() => onRemoveVersion(i)}
                  className="text-gray-500 hover:text-red-400 p-1 transition-colors"
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
            className="w-20 px-2 py-1 bg-gray-900 border border-gray-600 rounded text-xs text-white font-mono focus:outline-none focus:border-blue-500"
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
            className="text-gray-500 hover:text-gray-300 p-1"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ) : (
        <button
          onClick={() => setIsAdding(true)}
          className="px-2 py-1.5 text-xs text-gray-400 hover:text-white bg-gray-800 border border-gray-700 hover:border-gray-500 rounded-lg transition-colors"
          title="Add version"
        >
          + Version
        </button>
      )}
    </div>
  );
}
