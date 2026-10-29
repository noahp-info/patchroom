import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import './prefs.css';
import { DictationSection } from './DictationSection.tsx';
import { DndSection } from './DndSection.tsx';
import { HooksSection } from './HooksSection.tsx';
import { AccountsSection } from './AccountsSection.tsx';
import { LinksSection } from './LinksSection.tsx';
import { ModelsSection } from './ModelsSection.tsx';
import { UpdatesSection } from './UpdatesSection.tsx';
import { NotificationsSection } from './NotificationsSection.tsx';
import { StatusBarSection } from './StatusBarSection.tsx';
import { SoundsSection } from './SoundsSection.tsx';
import { getPrefsStore } from './store.ts';
import { TerminalSection } from './TerminalSection.tsx';
import { ThemesSection } from './ThemesSection.tsx';
import type { PrefsDm, PrefsSection } from './types.ts';
import { useOverlay } from '../../state/overlays';
import { PrefsNavContext, type PrefsNav } from './nav.ts';
import { searchSettings, sectionLabel, SECTIONS, type SectionId } from './registry.ts';

export type TabId = SectionId;

/** How long a row found by search stays highlighted. */
const FLASH_MS = 1800;

export interface PrefsPaneProps {
  onClose(): void;
  /** DMs to list in the per-DM controls. */
  dms?: PrefsDm[];
  /** Sidebar sections, for the per-section and per-folder bundle choice. */
  sections?: PrefsSection[];
  /** Section to open first. */
  initialTab?: TabId;
  /** Scroll to and flash this setting (a registry id) once the first section is open. */
  initialSetting?: string;
  /** Open this DM's sound settings in the Sounds section. */
  targetDm?: string;
}

/**
 * Preferences, as a modal over the app. A search field tops the sidebar: Cmd+F focuses it,
 * results list section and setting, and choosing one opens the section at that row. Esc clears
 * the search first, then closes.
 */
export function PrefsPane({
  onClose,
  dms = [],
  sections = [],
  initialTab = 'themes',
  initialSetting,
  targetDm,
}: PrefsPaneProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLUListElement>(null);
  const uid = useId();
  const [tab, setTab] = useState<TabId>(initialTab);
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState<{ id: string; n: number } | null>(
    initialSetting ? { id: initialSetting, n: 0 } : null,
  );
  const [picked, setPicked] = useState<string | null>(null);
  /** The ring drawn around a row found by search, in `.prefs__main` scroll coordinates. */
  const [flash, setFlash] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);
  // Settings draws over the side pane: the native viewer steps aside while it is open.
  useOverlay('settings');

  useEffect(() => {
    const dlg = ref.current;
    if (dlg && !dlg.open) dlg.showModal();
    void getPrefsStore().start();
  }, []);

  // Cmd+F finds a setting while Settings is open (the app's chat find stands aside).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        e.stopPropagation();
        field.current?.focus();
        field.current?.select();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // After a jump, once the section has rendered: scroll to the row and flash it.
  useEffect(() => {
    if (!target) return;
    const dlg = ref.current;
    let off = 0;
    const raf = requestAnimationFrame(() => {
      const row = ref.current?.querySelector<HTMLElement>(
        `.prefs__main [data-setting="${CSS.escape(target.id)}"]`,
      );
      const main = ref.current?.querySelector<HTMLElement>('.prefs__main');
      if (!row) {
        main?.scrollTo({ top: 0 });
        return;
      }
      row.scrollIntoView({ block: 'center' });
      row.setAttribute('data-flash', 'true');
      // A separate ring one --ring-pad outside the row: no layout shift, nothing covered.
      if (main) {
        const m = main.getBoundingClientRect();
        const r = row.getBoundingClientRect();
        const pad = parseFloat(getComputedStyle(main).getPropertyValue('--ring-pad')) || 8;
        setFlash({
          top: r.top - m.top + main.scrollTop - pad,
          left: r.left - m.left + main.scrollLeft - pad,
          width: r.width + 2 * pad,
          height: r.height + 2 * pad,
        });
      }
      off = window.setTimeout(() => {
        row.removeAttribute('data-flash');
        setFlash(null);
      }, FLASH_MS);
    });
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(off);
      setFlash(null);
      dlg?.querySelectorAll('[data-flash]').forEach((el) => el.removeAttribute('data-flash'));
    };
  }, [target]);

  const nav = useMemo<PrefsNav>(
    () => ({
      jump(section, setting) {
        setTab(section);
        if (setting) setTarget((t) => ({ id: setting, n: (t?.n ?? 0) + 1 }));
        else ref.current?.querySelector('.prefs__main')?.scrollTo({ top: 0 });
      },
    }),
    [],
  );

  const found = useMemo(() => searchSettings(query), [query]);
  const searching = query.trim() !== '';
  const choose = (section: SectionId, setting?: string) => {
    setPicked(`${section}/${setting ?? ''}`);
    nav.jump(section, setting);
  };

  const onFieldKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && found.length) {
      e.preventDefault();
      results.current?.querySelector<HTMLButtonElement>('button')?.focus();
    } else if (e.key === 'Enter' && found[0]) {
      e.preventDefault();
      choose(found[0].section, found[0].setting?.id);
    }
  };
  const onResultsKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const btns = [...(results.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const at = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowUp' && at <= 0) field.current?.focus();
    else btns[Math.min(btns.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1))]?.focus();
  };

  return (
    <dialog
      ref={ref}
      className="prefs"
      aria-labelledby="prefs-title"
      onClose={onClose}
      onCancel={(e) => {
        // Esc clears the search first; the next Esc closes Settings.
        if (!searching) return;
        e.preventDefault();
        setQuery('');
        field.current?.focus();
      }}
      onClick={(e) => {
        if (e.target === ref.current) ref.current?.close();
      }}
    >
      <header className="prefs__head">
        <h1 id="prefs-title">Settings</h1>
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
        <div className="prefs__side">
          <div className="prefs__find" role="search">
            <input
              ref={field}
              type="search"
              className="prefs__q"
              placeholder="Search settings"
              aria-label="Search settings"
              aria-keyshortcuts="Meta+F"
              aria-controls={searching ? `${uid}-results` : undefined}
              data-testid="prefs-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onFieldKey}
            />
          </div>
          {searching ? (
            <div className="prefs__results" data-testid="prefs-results">
              <p className="sr-only" role="status" aria-live="polite">
                {found.length
                  ? `${found.length} ${found.length === 1 ? 'setting' : 'settings'} found`
                  : `No settings match ${query.trim()}`}
              </p>
              {found.length === 0 ? (
                <p className="prefs__none" data-testid="prefs-no-results">
                  No settings match “{query.trim()}”
                </p>
              ) : (
                <ul
                  ref={results}
                  id={`${uid}-results`}
                  aria-label="Matching settings"
                  onKeyDown={onResultsKey}
                >
                  {found.map((r) => {
                    const key = `${r.section}/${r.setting?.id ?? ''}`;
                    return (
                      <li key={key}>
                        <button
                          type="button"
                          className="pres"
                          data-result={r.setting?.id ?? r.section}
                          aria-current={picked === key ? 'true' : undefined}
                          onClick={() => choose(r.section, r.setting?.id)}
                        >
                          <span className="pres__sec">
                            {r.setting ? sectionLabel(r.section) : 'Section'}
                          </span>
                          <span className="pres__set">
                            {r.setting ? r.setting.label : sectionLabel(r.section)}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ) : (
            <nav className="prefs__nav" aria-label="Settings sections">
              {SECTIONS.map((t) => (
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
          )}
        </div>
        <div className="prefs__main">
          {flash && (
            <div
              className="pf-flash"
              aria-hidden="true"
              data-testid="pf-flash"
              style={{ top: flash.top, left: flash.left, width: flash.width, height: flash.height }}
            />
          )}
          <PrefsNavContext.Provider value={nav}>
            {tab === 'themes' && <ThemesSection />}
            {tab === 'terminal' && <TerminalSection dms={dms} />}
            {tab === 'statusbar' && <StatusBarSection dms={dms} />}
            {tab === 'notifications' && <NotificationsSection dms={dms} />}
            {tab === 'sounds' && <SoundsSection dms={dms} openDm={targetDm} />}
            {tab === 'dnd' && <DndSection />}
            {tab === 'hooks' && <HooksSection />}
            {tab === 'links' && <LinksSection />}
            {tab === 'dictation' && <DictationSection />}
            {tab === 'models' && <ModelsSection dms={dms} sections={sections} />}
            {tab === 'updates' && <UpdatesSection />}
            {tab === 'accounts' && <AccountsSection />}
          </PrefsNavContext.Provider>
        </div>
      </div>
    </dialog>
  );
}
