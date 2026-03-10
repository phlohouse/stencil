import { useMemo, useState } from 'react';
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
      parts.push(<span key="c" className="text-text-faint">{commentMatch[2]}</span>);
      return <div key={i}>{parts}{'\n'}</div>;
    }

    // Key: value lines
    const kvMatch = line.match(/^(\s*)([\w.[\]]+)(:)(.*)$/);
    if (kvMatch) {
      const [, indent, key, colon, rest] = kvMatch;
      parts.push(indent);
      parts.push(<span key="k" className="text-blue-400">{key}</span>);
      parts.push(<span key="co" className="text-text-muted">{colon}</span>);

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
      parts.push(<span key="d" className="text-text-muted">{dash}</span>);
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
  return <span key={keyPrefix} className="text-text-secondary">{value}</span>;
}

export function YamlPreview({ schema }: YamlPreviewProps) {
  const yaml = useMemo(() => schemaToYaml(schema), [schema]);
  const highlighted = useMemo(() => highlightYaml(yaml), [yaml]);
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="flex flex-col border-t border-border min-h-0 shrink-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-surface/50 shrink-0">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex min-w-0 flex-1 items-center justify-between text-left hover:text-text transition-colors"
        >
          <span className="text-xs font-medium text-text-secondary">YAML Preview</span>
          <svg
            className={`w-3.5 h-3.5 text-text-secondary transition-transform ${expanded ? 'rotate-90' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>
        <button
          onClick={() => navigator.clipboard.writeText(yaml)}
          className="text-xs text-text-muted hover:text-text-secondary transition-colors"
          title="Copy to clipboard"
        >
          Copy
        </button>
      </div>
      {expanded && (
        <pre className="max-h-[40vh] overflow-auto px-3 py-2 text-[11px] font-mono bg-bg leading-relaxed whitespace-pre">
          {highlighted}
        </pre>
      )}
    </div>
  );
}
