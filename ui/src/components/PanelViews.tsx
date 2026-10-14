import { useEffect } from 'react';
import { formatStamp, toMillis } from '../lib/time';
import type { AppState, AppStore } from '../state/store';
import { MarkList } from './MarkList';
import { Icon } from './Icon';
import { PrefsPane } from '../lib/prefsModule';

/** A full-pane view over the conversation. Esc closes it. */
function PanelShell({
  title,
  lede,
  store,
  children,
  testId,
}: {
  title: string;
  lede: string;
  store: AppStore;
  children: React.ReactNode;
  testId: string;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) store.closePanel();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [store]);
  return (
    <section className="panelview" aria-label={title} data-testid={testId}>
      <header className="panelview__h">
        <div>
          <h2>{title}</h2>
          <p>{lede}</p>
        </div>
        <button
          type="button"
          className="ib"
          aria-label={`Close ${title}`}
          onClick={() => store.closePanel()}
        >
          <Icon name="x" />
        </button>
      </header>
      <div className="panelview__body">{children}</div>
    </section>
  );
}

/** Everything waiting on the user, oldest first. Answering a prompt removes its row. */
export function ActivityView({ state, store }: { state: AppState; store: AppStore }) {
  useEffect(() => {
    void store.loadActivity();
  }, [store]);
  const name = (id: string) => state.sessions.find((s) => s.id === id)?.name ?? 'Deleted DM';
  return (
    <PanelShell
      title="Activity"
      lede="Prompts waiting on you and finished turns you have not read, oldest first."
      store={store}
      testId="activity"
    >
      {state.activity.length === 0 ? (
        <p className="listempty">Nothing is waiting on you.</p>
      ) : (
        <ol className="actlist">
          {state.activity.map((r) => (
            <li key={`${r.kind}:${r.id}:${r.promptId ?? r.itemKey ?? ''}`}>
              <button
                type="button"
                className="actrow"
                data-kind={r.kind}
                data-dm={r.id}
                onClick={() => store.openDm(r.id, { itemKey: r.itemKey, promptId: r.promptId })}
              >
                <span className={`tag${r.kind === 'prompt' ? ' needs' : ''}`}>
                  {r.kind === 'prompt' ? 'Needs you' : 'Unread'}
                </span>
                <span className="actrow__main">
                  <b>{name(r.id)}</b>
                  <span className="actrow__sum">{r.summary}</span>
                </span>
                <time>{formatStamp(toMillis(r.ts))}</time>
              </button>
            </li>
          ))}
        </ol>
      )}
    </PanelShell>
  );
}

/** Saved items across every DM. */
export function SavedView({ state, store }: { state: AppState; store: AppStore }) {
  const saved = state.marks.filter((m) => m.kind === 'saved');
  return (
    <PanelShell
      title="Saved items"
      lede="Messages you saved from any DM. Click one to open it."
      store={store}
      testId="saved"
    >
      <MarkList
        marks={saved}
        sessions={state.sessions}
        store={store}
        showDm
        empty="Nothing saved yet. Hover a message and choose Save."
        testId="saved-list"
      />
    </PanelShell>
  );
}

/** Preferences, from the prefs piece. A placeholder stands in until that piece is built. */
export function PrefsView({ state, store }: { state: AppState; store: AppStore }) {
  if (PrefsPane) {
    return (
      <PrefsPane
        onClose={() => store.closePanel()}
        dms={state.sessions.map((s) => ({ id: s.id, name: s.name }))}
      />
    );
  }
  return (
    <PanelShell
      title="Preferences"
      lede="Themes, notifications and sounds."
      store={store}
      testId="prefs-placeholder"
    >
      <p className="listempty">Preferences are not available in this build.</p>
    </PanelShell>
  );
}
