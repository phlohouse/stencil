import { useCallback } from 'react';
import type { StencilSchema } from '../lib/types';
import { downloadYaml } from '../lib/yaml-export';

interface ExportButtonProps {
  schema: StencilSchema;
  disabled?: boolean;
}

export function ExportButton({ schema, disabled }: ExportButtonProps) {
  const handleExport = useCallback(() => {
    downloadYaml(schema);
  }, [schema]);

  const hasFields = schema.versions.some((v) => v.fields.length > 0);

  return (
    <button
      onClick={handleExport}
      disabled={disabled || !hasFields}
      className="flex items-center gap-2 px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed text-white rounded-lg text-xs font-medium transition-colors"
      title={hasFields ? 'Export .stencil.yaml' : 'Define at least one field to export'}
    >
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
        />
      </svg>
      Export YAML
    </button>
  );
}
