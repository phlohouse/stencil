import { useCallback, useState, type DragEvent, type ChangeEvent } from 'react';

interface FileUploadProps {
  onFileLoaded: (buffer: ArrayBuffer) => void;
}

export function FileUpload({ onFileLoaded }: FileUploadProps) {
  const [isDragging, setIsDragging] = useState(false);

  const handleFile = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const buffer = e.target?.result as ArrayBuffer;
        if (buffer) onFileLoaded(buffer);
      };
      reader.readAsArrayBuffer(file);
    },
    [onFileLoaded],
  );

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const onDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const onDragLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  const onChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  return (
    <div className="flex items-center justify-center min-h-[80vh]">
      <div
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        className={`
          flex flex-col items-center justify-center
          w-full max-w-xl p-16 rounded-2xl border-2 border-dashed
          transition-colors cursor-pointer
          ${isDragging
            ? 'border-blue-400 bg-blue-400/10'
            : 'border-gray-600 bg-gray-900/50 hover:border-gray-500 hover:bg-gray-900/80'
          }
        `}
      >
        <svg
          className="w-16 h-16 text-gray-500 mb-6"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"
          />
        </svg>
        <p className="text-lg font-medium text-gray-300 mb-2">
          Drop an Excel file here
        </p>
        <p className="text-sm text-gray-500 mb-6">or click to browse</p>
        <label className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium cursor-pointer transition-colors">
          Choose File
          <input
            type="file"
            accept=".xlsx,.xls,.xlsm"
            onChange={onChange}
            className="hidden"
          />
        </label>
      </div>
    </div>
  );
}
