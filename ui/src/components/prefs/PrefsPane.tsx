import { useEffect, useRef, useState } from 'react';
import './prefs.css';
import { DndSection } from './DndSection.tsx';
import { HooksSection } from './HooksSection.tsx';
import { LinksSection } from './LinksSection.tsx';
import { NotificationsSection } from './NotificationsSection.tsx';
import { StatusBarSection } from './StatusBarSection.tsx';
import { SoundsSection } from './SoundsSection.tsx';
import { getPrefsStore } from './store.ts';
import { TerminalSection } from './TerminalSection.tsx';
import { ThemesSection } from './ThemesSection.tsx';
import type { PrefsDm } from './types.ts';

const TABS = [
  { id: 'themes', label: 'Themes' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'statusbar', label: 'Status bar' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'sounds', label: 'Sounds' },
  { id: 'dnd', label: 'Do Not Disturb' },
  { id: 'hooks', label: 'Sound hooks' },
  { id: 'links', label: 'Links' },
] as const;
type TabId = (typeof TABS)[number]['id'];

export interface PrefsPaneProps {
  onClose(): void;
  /** DMs to list in the per-DM controls. */
  dms?: PrefsDm[];
  /** Section to open first. */
  initialTab?: TabId;
  /** Open this DM's sound settings in the Sounds section. */
  targetDm?: string;
}

/** Preferences, as a modal over the app. Esc and the close button call `onClose`. */
export function PrefsPane({ onClose, dms = [], initialTab = 'themes', targetDm }: PrefsPaneProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<TabId>(initialTab);

  useEffect(() => {
    const dlg = ref.current;
    if (dlg && !dlg.open) dlg.showModal();
    void getPrefsStore().start();
  }, []);

  return (
    <dialog
      ref={ref}
      className="prefs"
      aria-labelledby="prefs-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) ref.current?.close();
      }}
    >
      <header className="prefs__head">
        <h1 id="prefs-title">Preferences</h1>
        <button
          type="button"
          className="prefs__x"
          aria-label="Close preferences"
          onClick={() => ref.current?.close()}
        >
          Close
        </button>
      </header>
      <div className="prefs__body">
        <nav className="prefs__nav" aria-label="Preferences sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-current={tab === t.id ? 'page' : undefined}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="prefs__main">
          {tab === 'themes' && <ThemesSection />}
          {tab === 'terminal' && <TerminalSection dms={dms} />}
          {tab === 'statusbar' && <StatusBarSection dms={dms} />}
          {tab === 'notifications' && <NotificationsSection dms={dms} />}
          {tab === 'sounds' && <SoundsSection dms={dms} openDm={targetDm} />}
          {tab === 'dnd' && <DndSection />}
          {tab === 'hooks' && <HooksSection />}
          {tab === 'links' && <LinksSection />}
        </div>
      </div>
    </dialog>
  );
}
