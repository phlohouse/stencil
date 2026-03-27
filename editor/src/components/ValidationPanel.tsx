import { useState, useCallback } from 'react';
import type { StencilField, StencilValidation } from '../lib/types';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';

interface ValidationPanelProps {
  fields: StencilField[];
  validation: Record<string, StencilValidation>;
  onSetValidation: (fieldName: string, validation: StencilValidation) => void;
  onRemoveValidation: (fieldName: string) => void;
}

export function ValidationPanel({
  fields,
  validation,
  onSetValidation,
  onRemoveValidation,
}: ValidationPanelProps) {
  const REQUIRED_UNSET = '__unset__';
  const [expanded, setExpanded] = useState(false);
  const [selectedField, setSelectedField] = useState('');

  const handleUpdate = useCallback(
    (fieldName: string, key: keyof StencilValidation, value: string) => {
      const current = validation[fieldName] ?? {};
      const updated = { ...current };

      if (key === 'min' || key === 'max') {
        if (value === '') {
          delete updated[key];
        } else {
          updated[key] = parseFloat(value);
        }
      } else if (key === 'pattern') {
        if (value === '') {
          delete updated[key];
        } else {
          updated[key] = value;
        }
      } else if (key === 'required') {
        updated[key] = value === 'true';
      }

      const hasValues = Object.keys(updated).length > 0;
      if (hasValues) {
        onSetValidation(fieldName, updated);
      } else {
        onRemoveValidation(fieldName);
      }
    },
    [validation, onSetValidation, onRemoveValidation],
  );

  return (
    <div className="border-t border-border shrink-0">
      <Button
        onClick={() => setExpanded(!expanded)}
        variant="ghost"
        className="h-auto w-full justify-between rounded-none px-3 py-2 text-xs font-medium text-text-secondary hover:text-text"
      >
        <span>Validation Rules</span>
        <svg
          className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </Button>

      {expanded && (
        <div className="px-4 pb-3 space-y-3">
          <Select
            value={selectedField}
            onValueChange={setSelectedField}
            disabled={fields.filter((f) => !f.computed).length === 0}
          >
            <SelectTrigger className="w-full bg-surface text-xs">
              <SelectValue placeholder="Select a field..." />
            </SelectTrigger>
            <SelectContent>
              {fields
                .filter((f) => !f.computed)
                .map((f) => (
                  <SelectItem key={f.name} value={f.name}>
                    {f.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>

          {fields.filter((f) => !f.computed).length === 0 && (
            <div className="rounded-lg border border-border bg-bg/40 px-3 py-3 text-xs text-text-muted">
              Add a non-computed field to define validation rules.
            </div>
          )}

          {selectedField && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Label className="w-14 text-xs text-text-secondary">Min</Label>
                <Input
                  type="number"
                  value={validation[selectedField]?.min ?? ''}
                  onChange={(e) => handleUpdate(selectedField, 'min', e.target.value)}
                  className="h-8 flex-1 bg-surface text-xs font-mono"
                />
              </div>
              <div className="flex items-center gap-2">
                <Label className="w-14 text-xs text-text-secondary">Max</Label>
                <Input
                  type="number"
                  value={validation[selectedField]?.max ?? ''}
                  onChange={(e) => handleUpdate(selectedField, 'max', e.target.value)}
                  className="h-8 flex-1 bg-surface text-xs font-mono"
                />
              </div>
              <div className="flex items-center gap-2">
                <Label className="w-14 text-xs text-text-secondary">Pattern</Label>
                <Input
                  type="text"
                  value={validation[selectedField]?.pattern ?? ''}
                  onChange={(e) => handleUpdate(selectedField, 'pattern', e.target.value)}
                  placeholder="^[A-Za-z]+$"
                  className="h-8 flex-1 bg-surface text-xs font-mono"
                />
              </div>
              <div className="flex items-center gap-2">
                <Label className="w-14 text-xs text-text-secondary">Required</Label>
                <Select
                  value={String(validation[selectedField]?.required ?? REQUIRED_UNSET)}
                  onValueChange={(value) => handleUpdate(selectedField, 'required', value === REQUIRED_UNSET ? '' : value)}
                >
                  <SelectTrigger className="h-8 flex-1 bg-surface text-xs">
                    <SelectValue placeholder="-" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={REQUIRED_UNSET}>-</SelectItem>
                    <SelectItem value="true">Yes</SelectItem>
                    <SelectItem value="false">No</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
