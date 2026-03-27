import { useEffect, useState, type FormEvent } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from './ui/sheet';

interface FieldNameDialogProps {
  title: string;
  initialValue: string;
  confirmLabel: string;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

export function FieldNameDialog({
  title,
  initialValue,
  confirmLabel,
  onConfirm,
  onCancel,
}: FieldNameDialogProps) {
  const [name, setName] = useState(initialValue);

  useEffect(() => {
    setName(initialValue);
  }, [initialValue]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
  };

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <SheetContent
        side="right"
        className="w-full border-l border-border bg-elevated p-0 text-text sm:max-w-md"
      >
        <SheetHeader className="border-b border-border px-6 py-5 text-left">
          <SheetTitle className="text-lg font-semibold text-text">{title}</SheetTitle>
          <SheetDescription className="text-sm text-text-secondary">
            Choose the field name before saving it into the schema.
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={handleSubmit} className="flex h-full min-h-0 flex-col">
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <div className="block">
              <Label className="mb-1 text-sm text-text-secondary">Field Name</Label>
              <Input
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="bg-surface font-mono text-sm text-text"
                autoFocus
              />
            </div>
          </div>

          <SheetFooter className="border-t border-border bg-elevated px-6 py-4 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit">{confirmLabel}</Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
