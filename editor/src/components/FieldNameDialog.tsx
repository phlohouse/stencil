import { useEffect, useState, type FormEvent } from 'react';

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-xl border border-gray-700 bg-gray-800 p-6 shadow-2xl"
      >
        <h3 className="text-lg font-semibold text-white">{title}</h3>
        <p className="mt-1 text-sm text-gray-400">
          Choose the field name before saving it into the schema.
        </p>

        <label className="mt-5 block">
          <span className="mb-1 block text-sm text-gray-300">Field Name</span>
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="w-full rounded-lg border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-white font-mono focus:border-blue-500 focus:outline-none"
            autoFocus
          />
        </label>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-gray-600 px-3 py-1.5 text-sm text-gray-300 hover:border-gray-500 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors"
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

