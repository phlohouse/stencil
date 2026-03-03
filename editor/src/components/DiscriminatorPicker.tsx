interface DiscriminatorPickerProps {
  isActive: boolean;
  currentCell: string;
  onToggle: () => void;
}

export function DiscriminatorPicker({
  isActive,
  currentCell,
  onToggle,
}: DiscriminatorPickerProps) {
  return (
    <button
      onClick={onToggle}
      className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
        isActive
          ? 'bg-amber-500/20 text-amber-300 border border-amber-500/50'
          : currentCell
            ? 'bg-gray-800 text-gray-300 border border-gray-600 hover:border-gray-500'
            : 'bg-gray-800 text-gray-400 border border-gray-700 hover:border-gray-500'
      }`}
      title={isActive ? 'Click a cell to set discriminator' : 'Set discriminator cell'}
    >
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"
        />
      </svg>
      {isActive ? (
        <span>Click a cell…</span>
      ) : currentCell ? (
        <span className="font-mono">{currentCell}</span>
      ) : (
        <span>Set Discriminator</span>
      )}
    </button>
  );
}
