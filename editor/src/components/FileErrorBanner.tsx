import { Button } from './ui/button';

interface FileErrorBannerProps {
  message: string;
  onDismiss: () => void;
}

/** Shown when a workbook cannot be read, instead of failing silently. */
export function FileErrorBanner({ message, onDismiss }: FileErrorBannerProps) {
  return (
    <div
      role="alert"
      className="mx-4 mt-3 flex items-start justify-between gap-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-200"
    >
      <span className="min-w-0 break-words">{message}</span>
      <Button
        onClick={onDismiss}
        variant="ghost"
        size="xs"
        className="shrink-0 text-xs text-red-700 hover:text-red-800 dark:text-red-200 dark:hover:text-red-100"
      >
        Dismiss
      </Button>
    </div>
  );
}
