import { useCallback, useRef } from 'react';
import { parseYaml } from '../lib/yaml-export';
import type { StencilSchema } from '../lib/types';

interface ImportButtonProps {
  onImport: (schema: StencilSchema) => void;
}

export function ImportButton({ onImport }: ImportButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClick = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = () => {
        try {
          const schema = parseYaml(reader.result as string);
          onImport(schema);
        } catch (err) {
          alert(`Failed to parse YAML: ${err}`);
        }
      };
      reader.readAsText(file);

      // Reset so the same file can be re-imported
      e.target.value = '';
    },
    [onImport],
  );

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".yaml,.yml"
        onChange={handleChange}
        className="hidden"
      />
      <button
        onClick={handleClick}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-elevated text-text-secondary border border-border-strong hover:border-border-strong transition-colors"
        title="Import .stencil.yaml"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
        </svg>
        Import
      </button>
    </>
  );
}
