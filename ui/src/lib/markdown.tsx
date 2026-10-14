import { cloneElement, type ReactElement, type ReactNode } from 'react';
import { highlight } from './highlight';

/**
 * Markdown to React elements. No HTML is ever injected: raw HTML in a message prints as text.
 * Covers what Claude writes: headings, paragraphs, lists (nested), fenced code, tables, quotes,
 * rules, and inline code, emphasis, strike, links and bare URLs.
 */

type Align = 'left' | 'center' | 'right' | undefined;

type Block =
  | { t: 'p'; text: string }
  | { t: 'h'; level: number; text: string }
  | { t: 'code'; lang: string; text: string }
  | { t: 'hr' }
  | { t: 'quote'; blocks: Block[] }
  | {
      t: 'list';
      ordered: boolean;
      start: number;
      items: { tight: boolean; blocks: Block[]; task?: boolean | null }[];
    }
  | { t: 'table'; head: string[]; align: Align[]; rows: string[][] };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (ch === '`') {
      inCode = !inCode;
      cur += ch;
    } else if (ch === '|' && !inCode) {
      cells.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function isSeparator(line: string): Align[] | null {
  if (!line.includes('-')) return null;
  const cells = splitRow(line);
  if (cells.length === 0) return null;
  const out: Align[] = [];
  for (const c of cells) {
    if (!/^:?-{1,}:?$/.test(c)) return null;
    out.push(
      c.startsWith(':') && c.endsWith(':')
        ? 'center'
        : c.endsWith(':')
          ? 'right'
          : c.startsWith(':')
            ? 'left'
            : undefined,
    );
  }
  return out;
}

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  const para: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push({ t: 'p', text: para.join('\n') });
    para.length = 0;
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flushPara();
      const mark = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[i]);
        if (close && close[1][0] === mark[0] && close[1].length >= mark.length) break;
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence (or end of input for an unterminated block)
      blocks.push({ t: 'code', lang: fence[2], text: body.join('\n') });
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      i++;
      continue;
    }
    if (HR.test(line)) {
      flushPara();
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }
    const h = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flushPara();
      blocks.push({ t: 'h', level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      flushPara();
      const inner: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
        inner.push(lines[i].replace(/^ {0,3}> ?/, ''));
        i++;
      }
      blocks.push({ t: 'quote', blocks: parseBlocks(inner.join('\n')) });
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length) {
      const align = isSeparator(lines[i + 1]);
      const head = splitRow(line);
      if (align && align.length === head.length) {
        flushPara();
        i += 2;
        const rows: string[][] = [];
        while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
          const cells = splitRow(lines[i]);
          while (cells.length < head.length) cells.push('');
          rows.push(cells.slice(0, head.length));
          i++;
        }
        blocks.push({ t: 'table', head, align, rows });
        continue;
      }
    }
    const li = LIST.exec(line);
    if (li && !(para.length && /^\d/.test(li[2]) && !li[2].startsWith('1'))) {
      flushPara();
      const baseIndent = li[1].length;
      const ordered = /\d/.test(li[2][0]);
      const start = ordered ? Number.parseInt(li[2], 10) : 1;
      const items: { tight: boolean; blocks: Block[]; task?: boolean | null }[] = [];
      let loose = false;
      while (i < lines.length) {
        const m = LIST.exec(lines[i]);
        if (!m || m[1].length !== baseIndent || /\d/.test(m[2][0]) !== ordered) break;
        const contentIndent = m[1].length + m[2].length + 1;
        const body: string[] = [m[3]];
        i++;
        let blankBefore = false;
        while (i < lines.length) {
          const l = lines[i];
          if (l.trim() === '') {
            blankBefore = true;
            body.push('');
            i++;
            continue;
          }
          const indent = /^\s*/.exec(l)![0].length;
          if (indent >= Math.min(contentIndent, baseIndent + 2) && indent > baseIndent) {
            body.push(l.slice(Math.min(indent, contentIndent)));
            blankBefore = false;
            i++;
            continue;
          }
          if (!blankBefore && indent > baseIndent) {
            body.push(l.trim());
            i++;
            continue;
          }
          // Lazy continuation of a paragraph line.
          if (
            !blankBefore &&
            indent === baseIndent &&
            !LIST.test(l) &&
            !FENCE.test(l) &&
            !/^#{1,6}\s/.test(l) &&
            !/^ {0,3}>/.test(l)
          ) {
            body.push(l.trim());
            i++;
            continue;
          }
          break;
        }
        while (body.length && body[body.length - 1] === '') {
          body.pop();
          loose = loose || false;
        }
        if (body.includes('')) loose = true;
        let task: boolean | null = null;
        const tm = /^\[( |x|X)\]\s+/.exec(body[0]);
        if (tm) {
          task = tm[1] !== ' ';
          body[0] = body[0].slice(tm[0].length);
        }
        items.push({ tight: true, blocks: parseBlocks(body.join('\n')), task });
        // A blank line between items makes the list loose.
        if (i < lines.length && lines[i].trim() === '' && LIST.test(lines[i + 1] ?? '')) {
          loose = true;
          i++;
        }
      }
      for (const it of items) it.tight = !loose;
      blocks.push({ t: 'list', ordered, start, items });
      continue;
    }
    para.push(line.trim() === line ? line : line.replace(/^\s+/, ''));
    i++;
  }
  flushPara();
  return blocks;
}

// ---------------------------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------------------------

const SAFE_URL = /^(https?:|mailto:)/i;

function Link({ href, children }: { href: string; children: ReactNode }) {
  if (!SAFE_URL.test(href)) return <>{children}</>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" title={href}>
      {children}
    </a>
  );
}

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|~<>$"'&]/;

/** Index of the closing delimiter, skipping code spans and escapes; -1 when absent. */
function findClose(s: string, from: number, delim: string): number {
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '`') {
      const run = /^`+/.exec(s.slice(i))![0];
      const end = s.indexOf(run, i + run.length);
      if (end > 0) i = end + run.length - 1;
      continue;
    }
    if (s.startsWith(delim, i)) {
      // Closers must not follow whitespace.
      if (i > from && !/\s/.test(s[i - 1])) return i;
    }
  }
  return -1;
}

export function renderInline(s: string, keyPrefix = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let text = '';
  let n = 0;
  const pushText = () => {
    if (text) out.push(text);
    text = '';
  };
  const push = (node: ReactElement) => {
    pushText();
    out.push(cloneElement(node, { key: `${keyPrefix}${n++}` }));
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') {
      if (s[i + 1] === '\n') {
        pushText();
        out.push(<br key={`${keyPrefix}${n++}`} />);
        i++;
      } else if (i + 1 < s.length && ESCAPABLE.test(s[i + 1])) {
        text += s[i + 1];
        i++;
      } else text += ch;
      continue;
    }
    if (ch === '\n') {
      if (/ {2,}$/.test(text)) {
        text = text.replace(/ +$/, '');
        pushText();
        out.push(<br key={`${keyPrefix}${n++}`} />);
      } else text += '\n';
      continue;
    }
    if (ch === '`') {
      const run = /^`+/.exec(s.slice(i))![0];
      const end = s.indexOf(run, i + run.length);
      if (end > 0) {
        let code = s.slice(i + run.length, end).replace(/\n/g, ' ');
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ')) code = code.slice(1, -1);
        push(<code>{code}</code>);
        i = end + run.length - 1;
        continue;
      }
      text += run;
      i += run.length - 1;
      continue;
    }
    if (ch === '!' && s[i + 1] === '[') {
      const m = /^!\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/.exec(s.slice(i));
      if (m) {
        push(<Link href={m[2]}>{m[1] || m[2]}</Link>);
        i += m[0].length - 1;
        continue;
      }
    }
    if (ch === '[') {
      // Find the matching ] allowing one level of nesting and code spans.
      let depth = 0;
      let j = i;
      for (; j < s.length; j++) {
        if (s[j] === '\\') j++;
        else if (s[j] === '[') depth++;
        else if (s[j] === ']' && --depth === 0) break;
      }
      if (j < s.length && s[j + 1] === '(') {
        const close = /^\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/.exec(s.slice(j + 1));
        if (close) {
          push(<Link href={close[1]}>{renderInline(s.slice(i + 1, j), `${keyPrefix}${n}l`)}</Link>);
          i = j + close[0].length;
          continue;
        }
      }
      text += ch;
      continue;
    }
    if (ch === '<') {
      const m = /^<((?:https?:\/\/|mailto:)[^>\s]+)>/.exec(s.slice(i));
      if (m) {
        push(<Link href={m[1]}>{m[1]}</Link>);
        i += m[0].length - 1;
        continue;
      }
    }
    if (
      ch === 'h' &&
      (s.startsWith('http://', i) || s.startsWith('https://', i)) &&
      (i === 0 || /[\s(]/.test(s[i - 1]))
    ) {
      const m = /^https?:\/\/[^\s<>]+/.exec(s.slice(i))!;
      let url = m[0];
      // Trailing punctuation belongs to the sentence, not the link.
      const trail = /[.,;:!?)\]'"]+$/.exec(url);
      if (trail) {
        let strip = trail[0];
        if (
          strip.includes(')') &&
          (url.match(/\(/g) ?? []).length >= (url.match(/\)/g) ?? []).length
        ) {
          strip = strip.replace(/\)/, '');
        }
        url = url.slice(0, url.length - strip.length);
      }
      if (url.length > 8) {
        push(<Link href={url}>{url}</Link>);
        i += url.length - 1;
        continue;
      }
    }
    if (ch === '~' && s[i + 1] === '~') {
      const end = findClose(s, i + 2, '~~');
      if (end > 0) {
        push(<del>{renderInline(s.slice(i + 2, end), `${keyPrefix}${n}d`)}</del>);
        i = end + 1;
        continue;
      }
    }
    if (ch === '*' || ch === '_') {
      const prev = s[i - 1] ?? ' ';
      const intraword = ch === '_' && /[A-Za-z0-9]/.test(prev);
      const dbl = s[i + 1] === ch;
      const delim = dbl ? ch + ch : ch;
      const after = s[i + delim.length] ?? ' ';
      if (!intraword && !/\s/.test(after)) {
        let end = findClose(s, i + delim.length, delim);
        // `_` closers must not sit inside a word either.
        while (end > 0 && ch === '_' && /[A-Za-z0-9]/.test(s[end + delim.length] ?? ' ')) {
          end = findClose(s, end + 1, delim);
        }
        if (end > 0) {
          const inner = renderInline(s.slice(i + delim.length, end), `${keyPrefix}${n}e`);
          push(dbl ? <strong>{inner}</strong> : <em>{inner}</em>);
          i = end + delim.length - 1;
          continue;
        }
      }
      text += ch;
      continue;
    }
    text += ch;
  }
  pushText();
  return out;
}

// ---------------------------------------------------------------------------------------------
// Blocks to elements
// ---------------------------------------------------------------------------------------------

export function CodeBlock({ lang, text }: { lang?: string; text: string }) {
  const toks = highlight(text, lang);
  return (
    <pre className="code" tabIndex={0} data-lang={lang || undefined}>
      {lang ? <span className="code__lang">{lang}</span> : null}
      <code>
        {toks.map((t, i) =>
          t.cls ? (
            <span key={i} className={`tk-${t.cls}`}>
              {t.text}
            </span>
          ) : (
            t.text
          ),
        )}
      </code>
    </pre>
  );
}

function renderBlocks(blocks: Block[], tight = false): ReactNode[] {
  return blocks.map((b, i) => {
    switch (b.t) {
      case 'p':
        return tight ? (
          <span key={i} className="tp">
            {renderInline(b.text)}
          </span>
        ) : (
          <p key={i}>{renderInline(b.text)}</p>
        );
      case 'h': {
        const Tag = `h${Math.min(6, b.level + 1)}` as 'h2';
        return <Tag key={i}>{renderInline(b.text)}</Tag>;
      }
      case 'code':
        return <CodeBlock key={i} lang={b.lang} text={b.text} />;
      case 'hr':
        return <hr key={i} />;
      case 'quote':
        return <blockquote key={i}>{renderBlocks(b.blocks)}</blockquote>;
      case 'list': {
        const items = b.items.map((it, j) => (
          <li key={j} className={it.task !== null && it.task !== undefined ? 'task' : undefined}>
            {it.task !== null && it.task !== undefined && (
              <input
                type="checkbox"
                checked={it.task}
                readOnly
                disabled
                aria-label={it.task ? 'done' : 'not done'}
              />
            )}
            {renderBlocks(it.blocks, it.tight)}
          </li>
        ));
        return b.ordered ? (
          <ol key={i} start={b.start !== 1 ? b.start : undefined}>
            {items}
          </ol>
        ) : (
          <ul key={i}>{items}</ul>
        );
      }
      case 'table':
        return (
          <div className="tablewrap" key={i} tabIndex={0}>
            <table>
              <thead>
                <tr>
                  {b.head.map((c, j) => (
                    <th key={j} style={{ textAlign: b.align[j] }}>
                      {renderInline(c)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) => (
                  <tr key={j}>
                    {r.map((c, k) => (
                      <td key={k} style={{ textAlign: b.align[k] }}>
                        {renderInline(c)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

const parsed = new Map<string, Block[]>();

/** Render markdown text. Parsed blocks are cached by text, so scrolling back is free. */
export function Markdown({ text }: { text: string }) {
  let blocks = parsed.get(text);
  if (!blocks) {
    blocks = parseBlocks(text);
    if (parsed.size > 400) parsed.delete(parsed.keys().next().value as string);
    parsed.set(text, blocks);
  }
  return <div className="md">{renderBlocks(blocks)}</div>;
}
