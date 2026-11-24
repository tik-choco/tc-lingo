// Ported from tc-chat's Markdown parser tests.
import { describe, it, expect } from "vitest";
import type { MdBlock } from "../src/lib/markdown";
import { parseMarkdown } from "../src/lib/markdown";

// Convenience: most tests only care about a single paragraph's inline
// children, so unwrap that instead of repeating the block wrapper.
function inline(text: string) {
  const blocks = parseMarkdown(text);
  expect(blocks).toHaveLength(1);
  const block = blocks[0] as Extract<MdBlock, { type: "paragraph" }>;
  expect(block.type).toBe("paragraph");
  return block.children;
}

describe("parseMarkdown", () => {
  it("returns [] for empty input", () => {
    expect(parseMarkdown("")).toEqual([]);
  });

  it("parses a plain paragraph with no markup", () => {
    expect(inline("hello world")).toEqual([{ type: "text", value: "hello world" }]);
  });

  it("parses bold with **", () => {
    expect(inline("**bold**")).toEqual([{ type: "strong", children: [{ type: "text", value: "bold" }] }]);
  });

  it("parses italic with * and _", () => {
    expect(inline("*em*")).toEqual([{ type: "em", children: [{ type: "text", value: "em" }] }]);
    expect(inline("_em_")).toEqual([{ type: "em", children: [{ type: "text", value: "em" }] }]);
  });

  it("parses strikethrough with ~~", () => {
    expect(inline("~~gone~~")).toEqual([{ type: "strike", children: [{ type: "text", value: "gone" }] }]);
  });

  it("parses inline code verbatim", () => {
    expect(inline("`code`")).toEqual([{ type: "code", value: "code" }]);
  });

  it("nests bold and italic: **bold *italic***", () => {
    expect(inline("**bold *italic***")).toEqual([
      {
        type: "strong",
        children: [
          { type: "text", value: "bold " },
          { type: "em", children: [{ type: "text", value: "italic" }] },
        ],
      },
    ]);
  });

  it("treats unmatched ** as literal text", () => {
    expect(inline("**bold")).toEqual([{ type: "text", value: "**bold" }]);
  });

  it("treats unmatched * as literal text", () => {
    expect(inline("*oops")).toEqual([{ type: "text", value: "*oops" }]);
  });

  it("code spans suppress formatting and autolinks inside them", () => {
    expect(inline("`*not bold* http://example.com`")).toEqual([
      { type: "code", value: "*not bold* http://example.com" },
    ]);
  });

  it("parses a valid http(s) link", () => {
    expect(inline("[site](https://example.com/page)")).toEqual([
      { type: "link", href: "https://example.com/page", children: [{ type: "text", value: "site" }] },
    ]);
  });

  it("keeps a URL in a link label as text", () => {
    expect(inline("[**https://example.com**](https://example.org)")).toEqual([
      {
        type: "link",
        href: "https://example.org",
        children: [{ type: "strong", children: [{ type: "text", value: "https://example.com" }] }],
      },
    ]);
  });

  it("preserves raw HTML as text", () => {
    const src = "<b>bold</b>";
    expect(inline(src)).toEqual([{ type: "text", value: src }]);
  });

  it("rejects javascript: links to plain text", () => {
    const src = "[click me](javascript:alert(1))";
    expect(inline(src)).toEqual([{ type: "text", value: src }]);
  });

  it("rejects links with an unparsable/relative url to plain text", () => {
    const src = "[home](/relative/path)";
    expect(inline(src)).toEqual([{ type: "text", value: src }]);
  });

  it("autolinks a bare URL and trims trailing sentence punctuation", () => {
    expect(inline("Check https://example.com/page. Thanks")).toEqual([
      { type: "text", value: "Check " },
      { type: "autolink", href: "https://example.com/page" },
      { type: "text", value: ". Thanks" },
    ]);
  });

  it("does not autolink non-http schemes", () => {
    expect(inline("see javascript:alert(1) now")).toEqual([
      { type: "text", value: "see javascript:alert(1) now" },
    ]);
  });

  it("joins multi-line paragraphs with hard breaks", () => {
    expect(inline("line one\nline two")).toEqual([
      { type: "text", value: "line one" },
      { type: "br" },
      { type: "text", value: "line two" },
    ]);
  });

  it("separates blocks on a blank line", () => {
    const blocks = parseMarkdown("first\n\nsecond");
    expect(blocks).toEqual([
      { type: "paragraph", children: [{ type: "text", value: "first" }] },
      { type: "paragraph", children: [{ type: "text", value: "second" }] },
    ]);
  });

  it("parses headings level 1-3, requiring the space", () => {
    expect(parseMarkdown("# H1")).toEqual([
      { type: "heading", level: 1, children: [{ type: "text", value: "H1" }] },
    ]);
    expect(parseMarkdown("## H2")).toEqual([
      { type: "heading", level: 2, children: [{ type: "text", value: "H2" }] },
    ]);
    expect(parseMarkdown("### H3")).toEqual([
      { type: "heading", level: 3, children: [{ type: "text", value: "H3" }] },
    ]);
  });

  it("treats #### and #NoSpace as paragraph text, not a heading", () => {
    expect(parseMarkdown("#### not a heading")).toEqual([
      { type: "paragraph", children: [{ type: "text", value: "#### not a heading" }] },
    ]);
    expect(parseMarkdown("#NoSpace")).toEqual([
      { type: "paragraph", children: [{ type: "text", value: "#NoSpace" }] },
    ]);
  });

  it("parses a blockquote, recursively parsing its content as blocks", () => {
    expect(parseMarkdown("> # quoted heading\n> and text")).toEqual([
      {
        type: "blockquote",
        children: [
          { type: "heading", level: 1, children: [{ type: "text", value: "quoted heading" }] },
          { type: "paragraph", children: [{ type: "text", value: "and text" }] },
        ],
      },
    ]);
  });

  it("parses unordered lists with - and *", () => {
    expect(parseMarkdown("- one\n* two")).toEqual([
      {
        type: "list",
        ordered: false,
        items: [
          { children: [{ type: "text", value: "one" }] },
          { children: [{ type: "text", value: "two" }] },
        ],
      },
    ]);
  });

  it("parses ordered lists and only sets start when the first number isn't 1", () => {
    expect(parseMarkdown("1. one\n2. two")).toEqual([
      {
        type: "list",
        ordered: true,
        items: [
          { children: [{ type: "text", value: "one" }] },
          { children: [{ type: "text", value: "two" }] },
        ],
      },
    ]);
    expect(parseMarkdown("5. five\n6. six")).toEqual([
      {
        type: "list",
        ordered: true,
        start: 5,
        items: [
          { children: [{ type: "text", value: "five" }] },
          { children: [{ type: "text", value: "six" }] },
        ],
      },
    ]);
  });

  it("does not support nested lists — a nested marker is literal text in the item", () => {
    // "- - inner" is just another top-level list item whose own content
    // happens to start with "- " — that inner marker is never re-parsed as
    // a nested list, it's plain literal text within the item.
    expect(parseMarkdown("- outer\n- - inner")).toEqual([
      {
        type: "list",
        ordered: false,
        items: [
          { children: [{ type: "text", value: "outer" }] },
          { children: [{ type: "text", value: "- inner" }] },
        ],
      },
    ]);
  });

  it("parses fenced code blocks verbatim, with an optional language tag", () => {
    expect(parseMarkdown("```ts\nconst x = 1;\n**not bold**\n```")).toEqual([
      { type: "codeBlock", lang: "ts", value: "const x = 1;\n**not bold**" },
    ]);
  });

  it("runs an unclosed fence to end of input", () => {
    expect(parseMarkdown("```js\nconst x = 1;")).toEqual([
      { type: "codeBlock", lang: "js", value: "const x = 1;" },
    ]);
  });

  it("parses a fence with no language tag", () => {
    expect(parseMarkdown("```\nplain\n```")).toEqual([{ type: "codeBlock", lang: undefined, value: "plain" }]);
  });

  it("never throws on pathological input", () => {
    const inputs = [
      "*".repeat(50),
      "`".repeat(20),
      "[[[[]]]](((((",
      "~*_`~*_`~*_`",
      "```\n".repeat(5),
    ];
    for (const input of inputs) {
      expect(() => parseMarkdown(input)).not.toThrow();
    }
  });
});

describe("parseMarkdown: opt-in tables", () => {
  const options = { tables: true };

  function table(text: string): Extract<MdBlock, { type: "table" }> {
    const blocks = parseMarkdown(text, options);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("table");
    return blocks[0] as Extract<MdBlock, { type: "table" }>;
  }

  it("parses a basic table with header and body cells", () => {
    expect(table("| Name | Count |\n| --- | --- |\n| Apples | 2 |")).toEqual({
      type: "table",
      align: [null, null],
      header: [[{ type: "text", value: "Name" }], [{ type: "text", value: "Count" }]],
      rows: [[[{ type: "text", value: "Apples" }], [{ type: "text", value: "2" }]]],
    });
  });

  it("parses left, center, right, and unspecified column alignment", () => {
    expect(table("| L | C | R | N |\n| :- | :-: | -: | - |").align).toEqual([
      "left", "center", "right", null,
    ]);
  });

  it("accepts rows without outer pipes and strips only one outer pipe", () => {
    const result = table("a | b\n- | -\n1 | 2");
    expect(result.header).toEqual([[{ type: "text", value: "a" }], [{ type: "text", value: "b" }]]);
    expect(result.rows).toEqual([[[{ type: "text", value: "1" }], [{ type: "text", value: "2" }]]]);
    expect(table("|| x ||\n|-|-|-|").header).toEqual([[], [{ type: "text", value: "x" }], []]);
  });

  it("unescapes escaped pipes in header, body, and code cells before inline parsing", () => {
    const result = table("| a \\| b | code | tail |\n| - | - | - |\n| c \\| d | `x\\|y` | end\\| |");
    expect(result.header[0]).toEqual([{ type: "text", value: "a | b" }]);
    expect(result.rows[0]).toEqual([
      [{ type: "text", value: "c | d" }],
      [{ type: "code", value: "x|y" }],
      [{ type: "text", value: "end|" }],
    ]);
  });

  it("recognizes escaped pipes by backslash parity, including at the end of a row", () => {
    const slashes = "\\".repeat(2);
    const result = table(`a ${slashes}| b\n- | -\nvalue | end\\|`);
    expect(result.header).toEqual([
      [{ type: "text", value: `a ${slashes}` }],
      [{ type: "text", value: "b" }],
    ]);
    expect(result.rows[0][1]).toEqual([{ type: "text", value: "end|" }]);
    expect(parseMarkdown("a \\| b\n-", options)).toEqual(parseMarkdown("a \\| b\n-"));
  });

  it("splits unescaped pipes inside backticks", () => {
    expect(table("| `x|y` | z |\n| - | - | - |").header).toEqual([
      [{ type: "text", value: "`x" }],
      [{ type: "text", value: "y`" }],
      [{ type: "text", value: "z" }],
    ]);
  });

  it("parses inline markdown within cells", () => {
    const result = table("| **bold** | `code` | [site](https://example.com) |\n| - | - | - |");
    expect(result.header).toEqual([
      [{ type: "strong", children: [{ type: "text", value: "bold" }] }],
      [{ type: "code", value: "code" }],
      [{ type: "link", href: "https://example.com", children: [{ type: "text", value: "site" }] }],
    ]);
  });

  it("pads short rows with empty cells and truncates long rows", () => {
    const result = table("| a | b |\n| - | - |\n| 1 |\n| 2 | 3 | 4 |");
    expect(result.rows).toEqual([
      [[{ type: "text", value: "1" }], []],
      [[{ type: "text", value: "2" }], [{ type: "text", value: "3" }]],
    ]);
  });

  it("leaves mismatched or invalid delimiter rows as paragraphs", () => {
    for (const text of ["| a | b |\n| --- |\n| 1 | 2 |", "| a | b |\n| --- | :: |", "| a | b |\n| --- | --x | "]) {
      expect(parseMarkdown(text, options)).toEqual(parseMarkdown(text));
      expect(parseMarkdown(text, options)[0].type).toBe("paragraph");
    }
  });

  it("stops a paragraph before a table without a blank line", () => {
    const blocks = parseMarkdown("intro text\n| a | b |\n|---|---|\n| 1 | 2 |", options);
    expect(blocks[0]).toEqual({ type: "paragraph", children: [{ type: "text", value: "intro text" }] });
    expect(blocks[1]).toEqual({
      type: "table",
      align: [null, null],
      header: [[{ type: "text", value: "a" }], [{ type: "text", value: "b" }]],
      rows: [[[{ type: "text", value: "1" }], [{ type: "text", value: "2" }]]],
    });
    expect(blocks).toHaveLength(2);
  });

  it("ends a table at a blank line or a line without an unescaped pipe", () => {
    const prefix = "| a | b |\n| - | - |\n| 1 | 2 |";
    for (const suffix of ["\n\ncontinued", "\ncontinued", "\ncontinued \\| escaped"]) {
      const blocks = parseMarkdown(prefix + suffix, options);
      expect(blocks).toHaveLength(2);
      expect(blocks[0].type).toBe("table");
      expect(blocks[1].type).toBe("paragraph");
    }
  });

  it("ends a table when a different block starts, even if its line contains a pipe", () => {
    const blocks = parseMarkdown("| a | b |\n| - | - |\n# heading | here\n- item | here", options);
    expect(blocks.map((block) => block.type)).toEqual(["table", "heading", "list"]);
    expect((blocks[0] as Extract<MdBlock, { type: "table" }>).rows).toEqual([]);
  });

  it("propagates the option through nested blockquotes", () => {
    const text = "> > | a | b |\n> > | - | - |\n> > | 1 | 2 |";
    const blocks = parseMarkdown(text, options);
    expect(blocks).toEqual([{
      type: "blockquote",
      children: [{
        type: "blockquote",
        children: [{
          type: "table",
          align: [null, null],
          header: [[{ type: "text", value: "a" }], [{ type: "text", value: "b" }]],
          rows: [[[{ type: "text", value: "1" }], [{ type: "text", value: "2" }]]],
        }],
      }],
    }]);
    expect(parseMarkdown(text, { tables: false })).toEqual(parseMarkdown(text));
  });

  it("treats incomplete headers and standalone delimiter rows as paragraphs", () => {
    for (const text of ["| a | b |", "| --- | --- |", "a | b\n---"]) {
      expect(parseMarkdown(text, options)).toEqual(parseMarkdown(text));
      expect(parseMarkdown(text, options)[0].type).toBe("paragraph");
    }
  });

  it("preserves the old paragraph output when tables are omitted or false", () => {
    const text = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    const oldOutput: MdBlock[] = [{
      type: "paragraph",
      children: [
        { type: "text", value: "| a | b |" },
        { type: "br" },
        { type: "text", value: "| --- | --- |" },
        { type: "br" },
        { type: "text", value: "| 1 | 2 |" },
      ],
    }];
    expect(parseMarkdown(text)).toEqual(oldOutput);
    expect(parseMarkdown(text, { tables: false })).toEqual(oldOutput);
    expect(parseMarkdown(text, options)[0].type).toBe("table");
  });
});
