import { useMemo } from 'react';
import { schemaToYaml } from '../lib/yaml-export';
import type { StencilSchema } from '../lib/types';

interface YamlPreviewProps {
  schema: StencilSchema;
}

function highlightYaml(yaml: string): React.ReactNode[] {
  return yaml.split('\n').map((line, i) => {
    const parts: React.ReactNode[] = [];

    // Comment lines
    const commentMatch = line.match(/^(\s*)(#.*)$/);
    if (commentMatch) {
      parts.push(commentMatch[1]);
      parts.push(<span key="c" className="text-gray-600">{commentMatch[2]}</span>);
      return <div key={i}>{parts}{'\n'}</div>;
    }

    // Key: value lines
    const kvMatch = line.match(/^(\s*)([\w.[\]]+)(:)(.*)$/);
    if (kvMatch) {
      const [, indent, key, colon, rest] = kvMatch;
      parts.push(indent);
      parts.push(<span key="k" className="text-blue-400">{key}</span>);
      parts.push(<span key="co" className="text-gray-500">{colon}</span>);

      if (rest) {
        const value = rest.trimStart();
        const spacing = rest.slice(0, rest.length - value.length);
        parts.push(spacing);
        parts.push(highlightValue(value, 'v'));
      }
      return <div key={i}>{parts}{'\n'}</div>;
    }

    // List item lines
    const listMatch = line.match(/^(\s*)(- )(.*)$/);
    if (listMatch) {
      const [, indent, dash, value] = listMatch;
      parts.push(indent);
      parts.push(<span key="d" className="text-gray-500">{dash}</span>);
      parts.push(highlightValue(value, 'lv'));
      return <div key={i}>{parts}{'\n'}</div>;
    }

    return <div key={i}>{line}{'\n'}</div>;
  });
}

function highlightValue(value: string, keyPrefix: string): React.ReactNode {
  // Quoted strings
  if (/^["'].*["']$/.test(value)) {
    return <span key={keyPrefix} className="text-emerald-400">{value}</span>;
  }
  // Numbers
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return <span key={keyPrefix} className="text-amber-400">{value}</span>;
  }
  // Booleans / null
  if (/^(true|false|null)$/i.test(value)) {
    return <span key={keyPrefix} className="text-purple-400">{value}</span>;
  }
  // Type annotations (e.g., list[float], datetime)
  if (/^(str|int|float|bool|datetime|date|table|list\[.*\]|dict\[.*\])$/.test(value)) {
    return <span key={keyPrefix} className="text-cyan-400">{value}</span>;
  }
  // Cell/range references (e.g., A1, B3:D50, Sheet2!A1:D)
  if (/^[A-Z]+\d*(:[A-Z]+\d*)?$/.test(value) || /^.+![A-Z]+\d/.test(value)) {
    return <span key={keyPrefix} className="text-yellow-300">{value}</span>;
  }
  return <span key={keyPrefix} className="text-gray-300">{value}</span>;
}

export function YamlPreview({ schema }: YamlPreviewProps) {
  const yaml = useMemo(() => schemaToYaml(schema), [schema]);
  const highlighted = useMemo(() => highlightYaml(yaml), [yaml]);

  return (
    <div className="flex flex-col border-t border-gray-700 min-h-0 flex-1">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700 bg-gray-900/50 shrink-0">
        <span className="text-xs font-medium text-gray-400">YAML Preview</span>
        <button
          onClick={() => navigator.clipboard.writeText(yaml)}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          title="Copy to clipboard"
        >
          Copy
        </button>
      </div>
      <pre className="flex-1 overflow-auto px-3 py-2 text-[11px] font-mono bg-gray-950 leading-relaxed whitespace-pre">
        {highlighted}
      </pre>
    </div>
  );
}
