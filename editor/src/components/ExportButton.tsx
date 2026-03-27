import { useCallback } from 'react';
import type { StencilSchema } from '../lib/types';
import { downloadYaml } from '../lib/yaml-export';
import { Button } from './ui/button';

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
    <Button
      onClick={handleExport}
      disabled={disabled || !hasFields}
      size="sm"
      className="h-8 rounded-none bg-emerald-600 px-3 text-xs font-medium text-white hover:bg-emerald-700 disabled:bg-border disabled:text-text-muted"
      title={hasFields ? 'Export .stencil.yaml' : 'Define at least one field to export'}
    >
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
        />
      </svg>
      Export
    </Button>
  );
}
