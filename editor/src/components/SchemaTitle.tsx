import { useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import type { StencilSchema } from '../lib/types';

interface SchemaTitleProps {
  schema: StencilSchema;
  onRename: (name: string) => void;
  onDescribe: (description: string) => void;
}

/**
 * The schema's identity in the toolbar: its name, clickable to edit the name
 * and description without giving two inputs permanent space.
 */
export function SchemaTitle({ schema, onRename, onDescribe }: SchemaTitleProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(schema.name);
  const [description, setDescription] = useState(schema.description);

  const openDialog = () => {
    setName(schema.name);
    setDescription(schema.description);
    setOpen(true);
  };

  const commit = () => {
    onRename(name.trim());
    onDescribe(description);
    setOpen(false);
  };

  return (
    <>
      <Button
        onClick={openDialog}
        variant="ghost"
        size="sm"
        className="h-8 min-w-0 max-w-[16rem] gap-2 px-2 text-sm hover:bg-elevated"
        title="Edit the schema name and description"
      >
        <span className={`truncate font-medium ${schema.name ? 'text-text' : 'text-text-muted'}`}>
          {schema.name || 'Untitled schema'}
        </span>
        <svg
          className="size-3.5 shrink-0 text-text-muted"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.862 4.487z"
          />
        </svg>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Schema details</DialogTitle>
            <DialogDescription>
              The name becomes the table name in generated Phlo artifacts; the description is
              copied into the exported YAML.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="schema-name" className="text-xs text-text-secondary">
                Name
              </Label>
              <Input
                id="schema-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commit();
                }}
                placeholder="lab_report"
                autoFocus
                className="h-8 bg-surface font-mono text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="schema-description" className="text-xs text-text-secondary">
                Description
              </Label>
              <Input
                id="schema-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commit();
                }}
                placeholder="Monthly lab report from ACME Labs"
                className="h-8 bg-surface text-sm"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={commit}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
