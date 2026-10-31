/** Small regex highlighter for chat code blocks and diffs. Classes map to the `syn-*` tokens. */

export type TokClass = 'kw' | 'cm' | 'ty' | 'fn' | 'str' | 'num';
export interface Tok {
  text: string;
  cls?: TokClass;
}

const KW: Record<string, string> = {
  js: 'async await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while with yield as type interface enum implements readonly declare namespace abstract public private protected',
  py: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield match case self',
  rs: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
  sh: 'if then else elif fi for while until do done case esac in function select return exit export local readonly unset set source alias cd echo',
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil',
  c: 'auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while class public private protected namespace template typename new delete true false null nullptr using',
  json: 'true false null',
  sql: 'select from where insert into values update set delete create table alter drop join left right inner outer on group by order having limit and or not null as distinct union primary key foreign references index',
  css: '',
};

const ALIAS: Record<string, string> = {
  javascript: 'js',
  jsx: 'js',
  typescript: 'js',
  ts: 'js',
  tsx: 'js',
  mjs: 'js',
  node: 'js',
  python: 'py',
  python3: 'py',
  rust: 'rs',
  bash: 'sh',
  shell: 'sh',
  zsh: 'sh',
  console: 'sh',
  golang: 'go',
  java: 'c',
  cpp: 'c',
  'c++': 'c',
  cs: 'c',
  csharp: 'c',
  swift: 'c',
  kotlin: 'c',
  jsonc: 'json',
  json5: 'json',
  yaml: 'json',
  yml: 'json',
  toml: 'json',
  postgresql: 'sql',
  scss: 'css',
};

const cache = new Map<string, RegExp>();

function grammar(family: string): RegExp {
  let rx = cache.get(family);
  if (rx) return rx;
  const words = (KW[family] ?? '').split(' ').filter(Boolean);
  const comment =
    family === 'py' || family === 'sh' || family === 'json'
      ? '#[^\\n]*'
      : family === 'sql'
        ? '--[^\\n]*|/\\*[\\s\\S]*?\\*/'
        : '//[^\\n]*|/\\*[\\s\\S]*?\\*/';
  const str = '"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'|`(?:\\\\.|[^`\\\\])*`';
  const kw = words.length ? `\\b(?:${words.join('|')})\\b` : '(?!)';
  // Groups: 1 comment, 2 string, 3 number, 4 keyword, 5 type, 6 function.
  rx = new RegExp(
    `(${comment})|(${str})|(\\b0x[0-9a-fA-F]+\\b|\\b\\d+(?:\\.\\d+)?\\b)|(${kw})|(\\b[A-Z][A-Za-z0-9_]*\\b)|(\\b[A-Za-z_][A-Za-z0-9_]*(?=\\())`,
    family === 'sql' ? 'gi' : 'g',
  );
  cache.set(family, rx);
  return rx;
}

const MAX_CHARS = 30_000;

/** Tokenize one code string. Unknown languages come back as one plain token. */
export function highlight(code: string, lang?: string): Tok[] {
  const key = (lang ?? '').toLowerCase().trim();
  const family = KW[key] !== undefined ? key : ALIAS[key];
  if (!family || code.length > MAX_CHARS) return [{ text: code }];
  const rx = grammar(family);
  rx.lastIndex = 0;
  const out: Tok[] = [];
  let last = 0;
  for (let m = rx.exec(code); m; m = rx.exec(code)) {
    if (m[0] === '') {
      rx.lastIndex++;
      continue;
    }
    if (m.index > last) out.push({ text: code.slice(last, m.index) });
    const cls: TokClass = m[1]
      ? 'cm'
      : m[2]
        ? 'str'
        : m[3]
          ? 'num'
          : m[4]
            ? 'kw'
            : m[5]
              ? 'ty'
              : 'fn';
    out.push({ text: m[0], cls });
    last = m.index + m[0].length;
  }
  if (last < code.length) out.push({ text: code.slice(last) });
  return out;
}

/** Guess a language from a file path, for diffs. */
export function langOfPath(path: string | undefined): string | undefined {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path ?? '')?.[1]?.toLowerCase();
  return ext;
}
