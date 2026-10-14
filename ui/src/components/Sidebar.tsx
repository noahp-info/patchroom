import { useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { SessionInfo, SessionStatus } from '../ipc';
import { beginDrag } from '../lib/dnd';
import { ARCHIVED_GROUP, STARRED_GROUP, buildGroups, type Group } from '../lib/groups';
import type { AppState, AppStore, DropDest } from '../state/store';
import { ContextMenu, appRoot, type Anchor, type MenuItem } from './Floating';
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

/** Titles claude sets before it has anything to say; not worth a subtitle. */
const PLAIN_TITLES = new Set(['', 'Claude Code', 'Starting', 'claude']);

const COLLAPSE_KEY = 'patchroom.sidebar.collapsed';

function readCollapsed(): Record<string, boolean> {
  try {
    const v = JSON.parse(window.localStorage.getItem(COLLAPSE_KEY) ?? '{}') as unknown;
    if (v && typeof v === 'object') return { [ARCHIVED_GROUP]: true, ...(v as object) };
  } catch {
    // Fall through to the defaults.
  }
  return { [ARCHIVED_GROUP]: true };
}

type MenuState = { anchor: Anchor; kind: 'dm' | 'section'; id: string };

interface DropAt {
  groupId: string;
  beforeId: string | null;
}

export interface SidebarProps {
  state: AppState;
  store: AppStore;
  onNewDm(): void;
}

const isMenuKey = (e: KeyboardEvent) => e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey);

export function Sidebar({ state, store, onNewDm }: SidebarProps) {
  const [collapsedVirtual, setCollapsedVirtual] = useState(readCollapsed);
  const [adding, setAdding] = useState(false);
  const [sectionName, setSectionName] = useState('');
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ kind: 'dm' | 'section'; id: string; label: string } | null>(
    null,
  );
  const [ghost, setGhost] = useState({ x: 0, y: 0 });
  const [drop, setDrop] = useState<DropAt | null>(null);
  const [secDrop, setSecDrop] = useState<{ groupId: string; after: boolean } | null>(null);
  const groups = buildGroups(state.sections, state.sessions);
  const root = useRef<HTMLElement>(null);

  // Needs-you holds until the prompt is answered, whichever DM is open. Unread clears on view.
  // Archived DMs never badge.
  const needsOf = (s: SessionInfo) =>
    s.archived ? 0 : Math.max(state.badges[s.id]?.needsYou ?? 0, s.status === 'waiting' ? 1 : 0);
  const unreadOf = (s: SessionInfo) =>
    s.archived || s.id === state.activeId ? 0 : (state.badges[s.id]?.unread ?? 0);

  const isClosed = (g: Group) => (g.section ? g.section.collapsed : !!collapsedVirtual[g.id]);
  function toggleGroup(g: Group) {
    if (g.section) {
      void store.setSectionCollapsed(g.section.id, !g.section.collapsed);
      return;
    }
    const next = { ...collapsedVirtual, [g.id]: !collapsedVirtual[g.id] };
    setCollapsedVirtual(next);
    try {
      window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
    } catch {
      // The collapsed state is a convenience.
    }
  }

  async function addSection(e: FormEvent) {
    e.preventDefault();
    await store.createSection(sectionName);
    setSectionName('');
    setAdding(false);
  }

  // ---- drag and drop ----------------------------------------------------------------------

  const destOf = (g: Group): DropDest =>
    g.kind === 'starred'
      ? { kind: 'starred' }
      : g.kind === 'archived'
        ? { kind: 'archived' }
        : g.section
          ? { kind: 'section', sectionId: g.section.id }
          : { kind: 'default' };

  function resolveDrop(y: number, under: Element | null, dmId: string): DropAt | null {
    const el = under?.closest<HTMLElement>('[data-group]');
    if (!el || !root.current?.contains(el)) return null;
    let beforeId: string | null = null;
    for (const r of el.querySelectorAll<HTMLElement>('[data-dm]')) {
      if (r.dataset.dm === dmId) continue;
      const b = r.getBoundingClientRect();
      if (y < b.top + b.height / 2) {
        beforeId = r.dataset.dm ?? null;
        break;
      }
    }
    return { groupId: el.dataset.group ?? '', beforeId };
  }

  function dragDm(e: PointerEvent, s: SessionInfo) {
    beginDrag(e, {
      onStart: () => setDrag({ kind: 'dm', id: s.id, label: s.name }),
      onMove: (x, y, under) => {
        setGhost({ x, y });
        setDrop(resolveDrop(y, under, s.id));
      },
      onEnd: (_x, y, under, committed) => {
        setDrag(null);
        setDrop(null);
        const at = committed ? resolveDrop(y, under, s.id) : null;
        const g = at && groups.find((x) => x.id === at.groupId);
        if (!at || !g) return;
        const ids = g.items.map((x) => x.id).filter((x) => x !== s.id);
        const idx = at.beforeId ? ids.indexOf(at.beforeId) : -1;
        ids.splice(idx < 0 ? ids.length : idx, 0, s.id);
        void store.dropSession(s.id, destOf(g), ids);
      },
    });
  }

  function resolveSection(y: number, under: Element | null, selfId: string) {
    const el = under?.closest<HTMLElement>('[data-group][data-kind="section"]');
    if (!el || !root.current?.contains(el) || el.dataset.group === selfId) return null;
    const b = el.getBoundingClientRect();
    return { groupId: el.dataset.group ?? '', after: y > b.top + b.height / 2 };
  }

  function dragSection(e: PointerEvent, g: Group) {
    if (!g.section || renaming === g.id) return;
    beginDrag(e, {
      onStart: () => setDrag({ kind: 'section', id: g.id, label: g.title }),
      onMove: (x, y, under) => {
        setGhost({ x, y });
        setSecDrop(resolveSection(y, under, g.id));
      },
      onEnd: (_x, y, under, committed) => {
        setDrag(null);
        setSecDrop(null);
        const at = committed ? resolveSection(y, under, g.id) : null;
        if (!at) return;
        const ids = state.sections.map((x) => x.id).filter((x) => x !== g.id);
        const idx = ids.indexOf(at.groupId);
        ids.splice(idx + (at.after ? 1 : 0), 0, g.id);
        void store.reorderSections(ids);
      },
    });
  }

  // ---- context menus ----------------------------------------------------------------------

  function menuItems(m: MenuState): MenuItem[] {
    if (m.kind === 'section') {
      return [
        { label: 'Rename section', onSelect: () => setRenaming(m.id) },
        { label: 'Delete section', danger: true, onSelect: () => void store.deleteSection(m.id) },
      ];
    }
    const s = state.sessions.find((x) => x.id === m.id);
    if (!s) return [];
    const items: MenuItem[] = [
      {
        label: s.starred ? 'Unstar' : 'Star',
        onSelect: () => void store.setFlags(s.id, { starred: !s.starred }),
      },
      {
        label: s.archived ? 'Unarchive' : 'Archive',
        onSelect: () => void store.setFlags(s.id, { archived: !s.archived }),
      },
    ];
    const here = s.sectionId;
    if (here !== null && state.sections.some((x) => x.id === here)) {
      items.push({
        label: 'Move to Direct messages',
        separator: true,
        onSelect: () => void store.moveSession(s.id, null),
      });
    }
    state.sections
      .filter((x) => x.id !== here)
      .forEach((x, i) =>
        items.push({
          label: `Move to ${x.name}`,
          separator: i === 0 && here === null,
          onSelect: () => void store.moveSession(s.id, x.id),
        }),
      );
    if (unreadOf(s) > 0) {
      items.push({ label: 'Mark as read', separator: true, onSelect: () => store.markRead(s.id) });
    }
    return items;
  }

  const activityCount = state.activity.length;
  const savedCount = state.marks.filter((m) => m.kind === 'saved').length;

  return (
    <aside className="side" aria-label="Direct messages" ref={root}>
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
        <button
          type="button"
          onClick={() => store.setPanel(state.panel === 'prefs' ? null : 'prefs')}
          aria-label="Preferences"
          title={'Preferences (⌘,)'}
          aria-pressed={state.panel === 'prefs'}
        >
          <Icon name="gear" />
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
      <div className="navs" role="group" aria-label="Views">
        <button
          type="button"
          className="navrow"
          aria-pressed={state.panel === 'activity'}
          onClick={() => store.setPanel(state.panel === 'activity' ? null : 'activity')}
          data-testid="nav-activity"
        >
          <Icon name="bell" />
          <span className="nm">Activity</span>
          {activityCount > 0 && (
            <span className="bdg needs" aria-label={`${activityCount} waiting`}>
              {activityCount}
            </span>
          )}
        </button>
        <button
          type="button"
          className="navrow"
          aria-pressed={state.panel === 'saved'}
          onClick={() => store.setPanel(state.panel === 'saved' ? null : 'saved')}
          data-testid="nav-saved"
        >
          <Icon name="bookmark" />
          <span className="nm">Saved items</span>
          {savedCount > 0 && <span className="ct">{savedCount}</span>}
        </button>
        <button
          type="button"
          className="navrow"
          aria-pressed={state.panel === 'search'}
          onClick={() => store.setPanel(state.panel === 'search' ? null : 'search', 'all')}
          data-testid="nav-search"
        >
          <Icon name="search" />
          <span className="nm">Search</span>
          <kbd className="ct">{'⌘⇧F'}</kbd>
        </button>
      </div>
      <nav className="side-scroll">
        {state.sessions.length === 0 && state.ready && <p className="side-empty">No DMs yet.</p>}
        {groups.map((g) => {
          const closed = isClosed(g);
          const needing = g.items.filter((s) => needsOf(s) > 0).length;
          const unreadTotal = g.items.reduce((n, s) => n + unreadOf(s), 0);
          const target = drop?.groupId === g.id;
          const editing = renaming === g.id && g.section;
          const secMark =
            secDrop?.groupId === g.id ? (secDrop.after ? ' drop-after' : ' drop-before') : '';
          return (
            <div
              className={`sec${target ? ' drop' : ''}${secMark}${drag?.id === g.id ? ' dragging' : ''}`}
              key={g.id}
              data-section={g.id}
              data-group={g.id}
              data-kind={g.kind}
            >
              {editing ? (
                <form
                  className="sec-h sec-edit"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const v = new FormData(e.currentTarget).get('name');
                    setRenaming(null);
                    void store.renameSection(g.id, String(v ?? ''));
                  }}
                >
                  <input
                    name="name"
                    defaultValue={g.title}
                    aria-label="Section name"
                    autoFocus
                    onFocus={(e) => e.currentTarget.select()}
                    onKeyDown={(e) => e.key === 'Escape' && setRenaming(null)}
                    onBlur={(e) => {
                      setRenaming(null);
                      void store.renameSection(g.id, e.currentTarget.value);
                    }}
                  />
                </form>
              ) : (
                <button
                  type="button"
                  className="sec-h sec-toggle"
                  aria-expanded={!closed}
                  onClick={() => toggleGroup(g)}
                  onPointerDown={(e) => dragSection(e, g)}
                  onDoubleClick={() => g.section && setRenaming(g.id)}
                  onContextMenu={(e) => {
                    if (!g.section) return;
                    e.preventDefault();
                    setMenu({ anchor: { x: e.clientX, y: e.clientY }, kind: 'section', id: g.id });
                  }}
                  onKeyDown={(e) => {
                    if (g.section && isMenuKey(e)) {
                      e.preventDefault();
                      setMenu({
                        anchor: e.currentTarget.getBoundingClientRect(),
                        kind: 'section',
                        id: g.id,
                      });
                    }
                  }}
                >
                  <Icon name={closed ? 'right' : 'down'} />
                  {g.kind === 'starred' && <Icon name="star" />}
                  {g.kind === 'archived' && <Icon name="archive" />}
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
              )}
              {!closed && g.id === STARRED_GROUP && g.items.length === 0 && (
                <p className="sec-hint">Star a DM from its right-click menu to keep it here.</p>
              )}
              {!closed &&
                g.items.map((s) => {
                  const needs = needsOf(s);
                  const unread = unreadOf(s);
                  const sub = PLAIN_TITLES.has(s.title) ? '' : s.title;
                  const before = drop?.beforeId === s.id && drop.groupId === g.id;
                  return (
                    <button
                      type="button"
                      key={s.id}
                      className={`row${s.id === state.activeId ? ' active' : ''}${
                        needs > 0 || unread > 0 ? ' unread' : ''
                      }${s.status === 'exited' ? ' ended' : ''}${drag?.id === s.id ? ' dragging' : ''}${before ? ' drop-before' : ''}`}
                      aria-current={s.id === state.activeId ? 'true' : undefined}
                      onClick={() => store.openDm(s.id)}
                      onPointerDown={(e) => dragDm(e, s)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setMenu({ anchor: { x: e.clientX, y: e.clientY }, kind: 'dm', id: s.id });
                      }}
                      onKeyDown={(e) => {
                        if (!isMenuKey(e)) return;
                        e.preventDefault();
                        setMenu({
                          anchor: e.currentTarget.getBoundingClientRect(),
                          kind: 'dm',
                          id: s.id,
                        });
                      }}
                      title={`${s.name}: ${PRESENCE_LABEL[s.status]}${sub ? `. ${sub}` : ''}`}
                      data-dm={s.id}
                      data-status={s.status}
                      data-unread={unread}
                      data-needs={needs}
                      data-starred={s.starred ? 'true' : undefined}
                      data-archived={s.archived ? 'true' : undefined}
                    >
                      <span
                        className={`dot ${presence(s.status)}`}
                        role="img"
                        aria-label={PRESENCE_LABEL[s.status]}
                      />
                      <ClaudeGlyph />
                      <span className="nm">{s.name}</span>
                      {sub && (
                        <span className="sub" data-testid="row-subtitle">
                          {sub}
                        </span>
                      )}
                      {s.hasDraft && (
                        <span
                          className="draft"
                          role="img"
                          aria-label="Draft"
                          data-testid="draft-mark"
                        >
                          <Icon name="pencil" />
                        </span>
                      )}
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
              {!closed && target && drop?.beforeId === null && drag?.kind === 'dm' && (
                <div className="drop-end" aria-hidden="true" />
              )}
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
      {menu && (
        <ContextMenu
          anchor={menu.anchor}
          label={menu.kind === 'dm' ? 'DM actions' : 'Section actions'}
          items={menuItems(menu)}
          onClose={() => setMenu(null)}
        />
      )}
      {drag &&
        createPortal(
          <div className="drag-ghost" style={{ left: ghost.x + 12, top: ghost.y + 8 }}>
            {drag.label}
          </div>,
          appRoot(),
        )}
    </aside>
  );
}
