import { useCallback, useRef } from 'react';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { downloadYaml, parseYaml } from '../lib/yaml-export';
import type { StencilSchema } from '../lib/types';

interface FileMenuProps {
  schema: StencilSchema;
  onNew: () => void;
  onOpenWorkbook: (buffer: ArrayBuffer) => void;
  onImportSchema: (schema: StencilSchema) => void;
}

/** One place for the schema and workbook file actions. */
export function FileMenu({ schema, onNew, onOpenWorkbook, onImportSchema }: FileMenuProps) {
  const workbookInputRef = useRef<HTMLInputElement>(null);
  const schemaInputRef = useRef<HTMLInputElement>(null);

  const hasFields = schema.versions.some((version) => version.fields.length > 0);

  const handleWorkbookFile = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const buffer = event.target?.result as ArrayBuffer;
        if (buffer) onOpenWorkbook(buffer);
      };
      reader.readAsArrayBuffer(file);
    },
    [onOpenWorkbook],
  );

  const handleSchemaFile = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          onImportSchema(parseYaml(reader.result as string));
        } catch (error) {
          alert(`Failed to parse YAML: ${error}`);
        }
      };
      reader.readAsText(file);
    },
    [onImportSchema],
  );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 bg-elevated px-3 text-xs text-text-secondary hover:text-text"
          >
            File
            <svg
              className="size-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onSelect={onNew}>
            New schema
            <DropdownMenuShortcut>⌘N</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => workbookInputRef.current?.click()}>
            Open workbook…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => schemaInputRef.current?.click()}>
            Import schema…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={!hasFields}
            onSelect={() => downloadYaml(schema)}
            title={hasFields ? 'Download the .stencil.yaml' : 'Define at least one field to export'}
          >
            Export YAML
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <input
        ref={workbookInputRef}
        type="file"
        accept=".xlsx,.xlsm"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) handleWorkbookFile(file);
          event.target.value = '';
        }}
      />
      <input
        ref={schemaInputRef}
        type="file"
        accept=".yaml,.yml"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) handleSchemaFile(file);
          event.target.value = '';
        }}
      />
    </>
  );
}
