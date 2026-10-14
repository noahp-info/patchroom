import { useState, type FormEvent } from 'react';
import type { SectionInfo, SessionInfo, SessionStatus } from '../ipc';
import type { AppState } from '../state/store';
import { ClaudeGlyph, Icon } from './Icon';

/** Presence class from the theme: busy filled, idle hollow, needs ringed. */
function presence(status: SessionStatus): 'busy' | 'idle' | 'needs' {
  if (status === 'busy') return 'busy';
  if (status === 'waiting') return 'needs';
  return 'idle';
}

const PRESENCE_LABEL: Record<SessionStatus, string> = {
  busy: 'Working',
  idle: 'Idle',
  waiting: 'Needs you',
  exited: 'Ended',
};

/** Id of the group for DMs with no stored section. */
export const DEFAULT_GROUP = '__default__';

interface Group {
  id: string;
  title: string;
  /** The stored section behind this group, if any. */
  section: SectionInfo | null;
  items: SessionInfo[];
}

/** Stored sections in position order, each holding the DMs filed under it. */
export function groupsOf(sections: SectionInfo[], sessions: SessionInfo[]): Group[] {
  const known = new Set(sections.map((s) => s.id));
  const groups: Group[] = sections.map((section) => ({
    id: section.id,
    title: section.name,
    section,
    items: sessions.filter((s) => s.sectionId === section.id),
  }));
  // A DM whose section was deleted, or that has none, falls back to the default group.
  const loose = sessions.filter((s) => s.sectionId === null || !known.has(s.sectionId));
  return [
    { id: DEFAULT_GROUP, title: 'Direct messages', section: null, items: loose },
    ...groups,
  ].filter((g) => g.items.length > 0 || g.section !== null);
}

export interface SidebarProps {
  state: AppState;
  onSelect(id: string): void;
  onNewDm(): void;
  onNewSection(name: string): Promise<void>;
  onToggleSection(id: string, collapsed: boolean): void;
}

export function Sidebar({ state, onSelect, onNewDm, onNewSection, onToggleSection }: SidebarProps) {
  const [defaultClosed, setDefaultClosed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [sectionName, setSectionName] = useState('');
  const groups = groupsOf(state.sections, state.sessions);

  // Needs-you holds until the prompt is answered, whichever DM is open. Unread clears on view.
  const needsOf = (s: SessionInfo) =>
    Math.max(state.badges[s.id]?.needsYou ?? 0, s.status === 'waiting' ? 1 : 0);
  const unreadOf = (s: SessionInfo) =>
    s.id === state.activeId ? 0 : (state.badges[s.id]?.unread ?? 0);

  async function addSection(e: FormEvent) {
    e.preventDefault();
    await onNewSection(sectionName);
    setSectionName('');
    setAdding(false);
  }

  return (
    <aside className="side" aria-label="Direct messages">
      <div className="ws">
        <span className="ws-mark" aria-hidden="true">
          P
        </span>
        <div>
          <strong>Patchroom</strong>
          <small>{state.sessions.length === 1 ? '1 DM' : `${state.sessions.length} DMs`}</small>
        </div>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          aria-label="New section"
          title="New section"
          aria-expanded={adding}
        >
          <Icon name="section" />
        </button>
        <button type="button" onClick={onNewDm} aria-label="New DM" title="New DM">
          <Icon name="plus" />
        </button>
      </div>
      {adding && (
        <form className="side-add" onSubmit={(e) => void addSection(e)}>
          <input
            value={sectionName}
            onChange={(e) => setSectionName(e.target.value)}
            placeholder="Section name"
            aria-label="Section name"
            autoFocus
            onKeyDown={(e) => e.key === 'Escape' && setAdding(false)}
          />
          <button type="submit" className="btn sec" disabled={sectionName.trim() === ''}>
            Add
          </button>
        </form>
      )}
      <nav className="side-scroll">
        {state.sessions.length === 0 && state.ready && <p className="side-empty">No DMs yet.</p>}
        {groups.map((g) => {
          const closed = g.section ? g.section.collapsed : defaultClosed;
          const needing = g.items.filter((s) => needsOf(s) > 0).length;
          const unreadTotal = g.items.reduce((n, s) => n + unreadOf(s), 0);
          return (
            <div className="sec" key={g.id} data-section={g.id}>
              <button
                type="button"
                className="sec-h sec-toggle"
                aria-expanded={!closed}
                onClick={() =>
                  g.section ? onToggleSection(g.section.id, !closed) : setDefaultClosed(!closed)
                }
              >
                <Icon name={closed ? 'right' : 'down'} />
                <span className="sec-name">{g.title}</span>
                {closed && unreadTotal > 0 && (
                  <span className="bdg unr" aria-label={`${unreadTotal} unread`}>
                    {unreadTotal}
                  </span>
                )}
                {closed && needing > 0 && (
                  <span className="bdg needs" aria-label={`${needing} need you`}>
                    {needing}
                  </span>
                )}
              </button>
              {!closed &&
                g.items.map((s) => {
                  const needs = needsOf(s);
                  const unread = unreadOf(s);
                  return (
                    <button
                      type="button"
                      key={s.id}
                      className={`row${s.id === state.activeId ? ' active' : ''}${
                        needs > 0 || unread > 0 ? ' unread' : ''
                      }${s.status === 'exited' ? ' ended' : ''}`}
                      aria-current={s.id === state.activeId ? 'true' : undefined}
                      onClick={() => onSelect(s.id)}
                      title={`${s.name}: ${PRESENCE_LABEL[s.status]}`}
                      data-status={s.status}
                      data-unread={unread}
                      data-needs={needs}
                    >
                      <span
                        className={`dot ${presence(s.status)}`}
                        role="img"
                        aria-label={PRESENCE_LABEL[s.status]}
                      />
                      <ClaudeGlyph />
                      <span className="nm">{s.name}</span>
                      {unread > 0 && (
                        <span className="bdg unr" aria-label={`${unread} unread`}>
                          {unread}
                        </span>
                      )}
                      {needs > 0 && (
                        <span className="bdg needs" aria-label="Needs you">
                          {needs}
                        </span>
                      )}
                    </button>
                  );
                })}
            </div>
          );
        })}
      </nav>
      <div className="side-foot">
        <span className="legend" aria-hidden="true">
          <span>
            <i className="dot busy" /> Working
          </span>
          <span>
            <i className="dot idle" /> Idle
          </span>
          <span>
            <i className="dot needs" /> Needs you
          </span>
        </span>
      </div>
    </aside>
  );
}
