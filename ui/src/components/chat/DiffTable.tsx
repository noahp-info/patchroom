import { highlight, langOfPath } from '../../lib/highlight';
import type { DiffView } from '../../lib/diff';

/** Inline diff in the reference screen's table form: two gutters and the code. */
export function DiffTable({ diff }: { diff: DiffView }) {
  const lang = langOfPath(diff.path);
  return (
    <div className="diffwrap" tabIndex={0}>
      {diff.path && <div className="diff-path">{diff.path}</div>}
      <table className="diff" aria-label={`Diff of ${diff.path ?? 'file'}`}>
        <tbody>
          {diff.rows.map((r, i) => (
            <tr
              key={i}
              className={
                r.type === 'hunk'
                  ? 'hunk'
                  : r.type === 'add'
                    ? 'a'
                    : r.type === 'del'
                      ? 'd'
                      : undefined
              }
            >
              <td className="n">{r.oldN ?? ''}</td>
              <td className="n">{r.newN ?? ''}</td>
              <td className="c">
                {r.type === 'add' ? '+' : r.type === 'del' ? '-' : r.type === 'ctx' ? ' ' : ''}
                {r.type === 'hunk'
                  ? r.text
                  : highlight(r.text, lang).map((t, j) =>
                      t.cls ? (
                        <span key={j} className={`tk-${t.cls}`}>
                          {t.text}
                        </span>
                      ) : (
                        t.text
                      ),
                    )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
