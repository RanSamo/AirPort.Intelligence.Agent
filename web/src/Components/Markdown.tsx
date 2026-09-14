import type { JSX } from 'react';

/**
 * Minimal Markdown renderer for agent answers.
 *
 * The agent replies with headings, bold, bullets and tables. Rendering those
 * four things directly is a few dozen lines and avoids pulling in a Markdown
 * library plus a sanitizer for what is otherwise a fully controlled output.
 */
export function Markdown({ text }: { text: string }) {
  const blocks: JSX.Element[] = [];
  const lines = text.split('\n');

  let listBuffer: string[] = [];
  let tableBuffer: string[] = [];

  const FlushList = () => {
    if (listBuffer.length === 0) return;
    blocks.push(
      <ul key={`ul-${blocks.length}`}>
        {listBuffer.map((item, index) => (
          <li key={index}>
            <Inline text={item} />
          </li>
        ))}
      </ul>,
    );
    listBuffer = [];
  };

  const FlushTable = () => {
    if (tableBuffer.length === 0) return;

    const rows = tableBuffer.map((row) =>
      row
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((cell) => cell.trim()),
    );
    // The second row of a Markdown table is the |---|---| separator.
    const [header, ...rest] = rows;
    const body = rest.filter((row) => !row.every((cell) => /^-{2,}:?$|^:?-{2,}$/.test(cell)));

    blocks.push(
      <div className="table-wrap" key={`table-${blocks.length}`}>
        <table>
          <thead>
            <tr>
              {header.map((cell, index) => (
                <th key={index}>
                  <Inline text={cell} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>
                    <Inline text={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>,
    );
    tableBuffer = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      FlushList();
      tableBuffer.push(trimmed);
      continue;
    }
    FlushTable();

    if (/^[-*]\s+/.test(trimmed)) {
      listBuffer.push(trimmed.replace(/^[-*]\s+/, ''));
      continue;
    }
    if (/^\d+\.\s+/.test(trimmed)) {
      listBuffer.push(trimmed.replace(/^\d+\.\s+/, ''));
      continue;
    }
    FlushList();

    if (trimmed === '') continue;

    if (trimmed.startsWith('### ')) {
      blocks.push(<h4 key={blocks.length}>{trimmed.slice(4)}</h4>);
      continue;
    }
    if (trimmed.startsWith('## ')) {
      blocks.push(<h3 key={blocks.length}>{trimmed.slice(3)}</h3>);
      continue;
    }
    if (trimmed.startsWith('# ')) {
      blocks.push(<h3 key={blocks.length}>{trimmed.slice(2)}</h3>);
      continue;
    }

    blocks.push(
      <p key={blocks.length}>
        <Inline text={trimmed} />
      </p>,
    );
  }

  FlushList();
  FlushTable();

  return <div className="markdown">{blocks}</div>;
}

/** Handles **bold**, *italic* and `code` within a line. */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g).filter(Boolean);

  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={index}>{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith('`') && part.endsWith('`')) {
          return <code key={index}>{part.slice(1, -1)}</code>;
        }
        if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
          return <em key={index}>{part.slice(1, -1)}</em>;
        }
        return <span key={index}>{part}</span>;
      })}
    </>
  );
}
