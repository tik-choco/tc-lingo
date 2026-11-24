// Ported from tc-chat's MarkdownView. Renders Markdown through Preact VNodes.
import type { VNode } from "preact";
import { useMemo } from "preact/hooks";
import type { MdBlock, MdInline, MdListItem } from "../lib/markdown";
import { parseMarkdown } from "../lib/markdown";
import "../styles/markdown.css";

function renderInline(nodes: MdInline[], keyPrefix: string): (VNode | string)[] {
  return nodes.map((node, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (node.type) {
      case "text":
        return node.value;
      case "br":
        return <br key={key} />;
      case "strong":
        return <strong key={key}>{renderInline(node.children, key)}</strong>;
      case "em":
        return <em key={key}>{renderInline(node.children, key)}</em>;
      case "strike":
        return <s key={key}>{renderInline(node.children, key)}</s>;
      case "code":
        return (
          <code key={key} class="md-code">
            {node.value}
          </code>
        );
      case "link":
        return (
          <a key={key} class="msg-link" href={node.href} target="_blank" rel="noopener noreferrer">
            {renderInline(node.children, key)}
          </a>
        );
      case "autolink":
        return (
          <a key={key} class="msg-link" href={node.href} target="_blank" rel="noopener noreferrer">
            {node.href}
          </a>
        );
    }
  });
}

function renderListItem(item: MdListItem, key: string): VNode {
  return <li key={key}>{renderInline(item.children, key)}</li>;
}

function renderBlock(block: MdBlock, key: string): VNode {
  switch (block.type) {
    case "paragraph":
      return (
        <p key={key} class="md-p">
          {renderInline(block.children, key)}
        </p>
      );
    case "heading": {
      const cls = `md-h md-h${block.level}`;
      const children = renderInline(block.children, key);
      if (block.level === 1) return <h1 key={key} class={cls}>{children}</h1>;
      if (block.level === 2) return <h2 key={key} class={cls}>{children}</h2>;
      return <h3 key={key} class={cls}>{children}</h3>;
    }
    case "codeBlock":
      return (
        <pre key={key} class="md-pre">
          <code class={block.lang ? `lang-${block.lang}` : undefined}>{block.value}</code>
        </pre>
      );
    case "blockquote":
      return (
        <blockquote key={key} class="md-quote">
          {renderBlocks(block.children, key)}
        </blockquote>
      );
    case "list":
      return block.ordered ? (
        <ol key={key} class="md-list md-list--ordered" start={block.start}>
          {block.items.map((item, i) => renderListItem(item, `${key}-${i}`))}
        </ol>
      ) : (
        <ul key={key} class="md-list">
          {block.items.map((item, i) => renderListItem(item, `${key}-${i}`))}
        </ul>
      );
    case "table":
      return (
        <div key={key} class="md-table-wrap">
          <table class="md-table">
            <thead>
              <tr>
                {block.header.map((cell, column) => {
                  const align = block.align[column];
                  return (
                    <th key={column} style={align == null ? undefined : { textAlign: align }}>
                      {renderInline(cell, `${key}-h-${column}`)}
                    </th>
                  );
                })}
              </tr>
            </thead>
            {block.rows.length > 0 && (
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, column) => {
                      const align = block.align[column];
                      return (
                        <td key={column} style={align == null ? undefined : { textAlign: align }}>
                          {renderInline(cell, `${key}-${rowIndex}-${column}`)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>
      );
  }
}

function renderBlocks(blocks: MdBlock[], keyPrefix = "b"): VNode[] {
  return blocks.map((block, i) => renderBlock(block, `${keyPrefix}-${i}`));
}

export function MarkdownView({ text, tables }: { text: string; tables?: boolean }) {
  const blocks = useMemo(() => renderBlocks(parseMarkdown(text, { tables })), [text, tables]);
  return <>{blocks}</>;
}
