import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { describeLargeWorkbook } from '../lib/file-guard';

interface LargeFileDialogProps {
  /** Size in bytes of the workbook waiting to be opened, or null when closed. */
  sizeBytes: number | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function LargeFileDialog({ sizeBytes, onConfirm, onCancel }: LargeFileDialogProps) {
  return (
    <Dialog open={sizeBytes != null} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Open this large workbook?</DialogTitle>
          <DialogDescription>
            {sizeBytes != null ? describeLargeWorkbook(sizeBytes) : ''}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onConfirm}>Open Workbook</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
