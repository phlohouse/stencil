import { useState, useCallback, useRef, type DragEvent } from 'react';
import type { StencilVersion } from '../lib/types';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Input } from './ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';

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
  const COPY_BLANK = '__blank__';
  const [isAdding, setIsAdding] = useState(false);
  const [newValue, setNewValue] = useState('');
  const [copyFromIndex, setCopyFromIndex] = useState<number | ''>('');
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [pendingDeleteIndex, setPendingDeleteIndex] = useState<number | null>(null);
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

  const pendingDeleteVersion =
    pendingDeleteIndex != null ? versions[pendingDeleteIndex] ?? null : null;

  return (
    <>
      <div className="flex items-center gap-1">
        {versions.map((v, i) => (
          <div key={i} className="flex items-center">
            <Button
              onClick={() => onSwitchVersion(i)}
              size="sm"
              variant={i === activeIndex ? 'default' : 'outline'}
              className={`h-6 px-3 text-xs ${
                i === activeIndex
                  ? ''
                  : 'bg-elevated text-text-secondary hover:text-text'
              }`}
            >
              {v.discriminatorValue}
            </Button>
            {i === activeIndex && (
              <div className="flex items-center ml-1 gap-1">
                <Input
                  type="text"
                  value={v.discriminatorValue}
                  onChange={(e) => onUpdateDiscriminatorValue(e.target.value)}
                  className="h-6 w-20 bg-surface px-2 text-xs font-mono"
                  title="Version discriminator value"
                />
                {versions.length > 1 && (
                  <Button
                    onClick={() => setPendingDeleteIndex(i)}
                    variant="ghost"
                    size="icon-xs"
                    className="text-text-muted hover:text-red-400"
                    title="Remove version"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </Button>
                )}
              </div>
            )}
          </div>
        ))}

        {isAdding ? (
          <div className="flex items-center gap-1">
            <Input
              type="text"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAdd();
                if (e.key === 'Escape') handleCancel();
              }}
              placeholder="v2.0"
              className="h-6 w-20 bg-surface px-2 text-xs font-mono"
              autoFocus
            />
            <Button
              onClick={handleAdd}
              variant="ghost"
              size="icon-xs"
              className="text-green-400 hover:text-green-300"
              title="Add version"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </Button>
            <Button
              onClick={handleCancel}
              variant="ghost"
              size="icon-xs"
              className="text-text-muted hover:text-text-secondary"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </Button>
            <Select
              value={copyFromIndex === '' ? COPY_BLANK : String(copyFromIndex)}
              onValueChange={(value) => setCopyFromIndex(value === COPY_BLANK ? '' : parseInt(value, 10))}
            >
              <SelectTrigger
                className="h-6 w-32 bg-surface px-2 text-xs text-text-secondary"
                title="Copy fields and validation from another version"
              >
                <SelectValue placeholder="Blank" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={COPY_BLANK}>Blank</SelectItem>
                {versions.map((v, i) => (
                  <SelectItem key={`${v.discriminatorValue}-${i}`} value={String(i)}>
                    Copy {v.discriminatorValue}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
              <Button
                onClick={() => {
                  setPendingFile(null);
                  if (fileInputRef.current) fileInputRef.current.value = '';
                }}
                variant="ghost"
                size="icon-xs"
                className="text-text-muted hover:text-text-secondary"
                title="Remove file"
              >
                <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </Button>
            )}
          </div>
        ) : (
          <Button
            onClick={() => setIsAdding(true)}
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs text-text-secondary hover:text-text bg-elevated"
            title="Add version"
          >
            + Version
          </Button>
        )}
      </div>

      <Dialog open={pendingDeleteIndex != null} onOpenChange={(open) => { if (!open) setPendingDeleteIndex(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Version?</DialogTitle>
            <DialogDescription>
              {pendingDeleteVersion
                ? `This will remove version "${pendingDeleteVersion.discriminatorValue}" from the schema.`
                : 'This will remove the selected version from the schema.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingDeleteIndex(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (pendingDeleteIndex == null) return;
                onRemoveVersion(pendingDeleteIndex);
                setPendingDeleteIndex(null);
              }}
            >
              Delete Version
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
