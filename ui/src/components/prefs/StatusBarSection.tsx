import { useState } from 'react';
import type { StatusModuleId } from '../../ipc';
import { MODULE_IDS } from '../../lib/statusBar.ts';
import { StatusBarEditor } from '../chat/StatusBarEditor.tsx';
import { getPrefsStore, usePrefs } from './store.ts';
import type { PrefsDm } from './types.ts';

const ALL = '';

const known = (l: readonly string[]): StatusModuleId[] =>
  l.filter((x): x is StatusModuleId => (MODULE_IDS as string[]).includes(x));

/** Status bar layout: the global default and one override per DM. */
export function StatusBarSection({ dms }: { dms: PrefsDm[] }) {
  const prefs = usePrefs();
  const store = getPrefsStore();
  const [scope, setScope] = useState<string>(ALL);
  const sb = prefs.statusBar ?? { default: null, perDm: {} };
  const own = scope === ALL ? sb.default : (sb.perDm[scope] ?? null);
  const saved = known(own ?? sb.default ?? MODULE_IDS);
  const tray = MODULE_IDS.filter((id) => !saved.includes(id)).map((id) => ({
    id,
    duplicate: false,
  }));

  function save(list: string[] | null) {
    if (scope === ALL) {
      void store.update({ statusBar: { ...sb, default: list } });
      return;
    }
    const perDm = { ...sb.perDm };
    if (list) perDm[scope] = list;
    else delete perDm[scope];
    void store.update({ statusBar: { ...sb, perDm } });
  }

  return (
    <div className="pf-section" data-testid="prefs-statusbar">
      <h2>Status bar</h2>
      <p className="pf-hint">
        Drag modules to reorder them, remove the ones you do not want, and add them back from the
        tray. Until you save a layout, chips your own statusLine already prints stay hidden.
      </p>
      <label className="pf pf--inline">
        <span>Applies to</span>
        <select
          aria-label="Status bar applies to"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
        >
          <option value={ALL}>All DMs</option>
          {dms.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
              {sb.perDm[d.id] ? ' (own layout)' : ''}
            </option>
          ))}
        </select>
      </label>
      <StatusBarEditor active={saved} tray={tray} onChange={(next) => save(next)} />
      <div className="pf-row">
        <button
          type="button"
          className="btn sec"
          disabled={own === null}
          data-testid="statusbar-reset"
          onClick={() => save(null)}
        >
          {scope === ALL ? 'Reset to the built-in layout' : 'Use the default layout'}
        </button>
      </div>
    </div>
  );
}
