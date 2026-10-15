import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { FolderSession, SectionInfo, SessionInfo, SessionStatus } from '../ipc';
import { beginDrag } from '../lib/dnd';
import { DEFAULT_ARCHIVE_DAYS, layoutFolder, type FolderEntry } from '../lib/folder';
import {
  ARCHIVED_GROUP,
  STARRED_GROUP,
  buildGroups,
  dividerOf,
  isFoldingDivider,
  type Group,
} from '../lib/groups';
import type { AppState, AppStore, DropDest } from '../state/store';
import { SidebarResizer } from './SidebarResizer';
import { ContextMenu, Floating, appRoot, type Anchor, type MenuItem } from './Floating';
import {
  ArchiveDaysForm,
  BranchChip,
  FolderRow,
  FolderTip,
  WorktreeGlyph,
  branchChip,
  isWorktree,
} from './FolderRows';
import { ClaudeGlyph, Icon } from './Icon';
import { AddForm, RenameForm } from './SectionEdit';

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

type MenuState =
  | { anchor: Anchor; kind: 'dm' | 'section'; id: string }
  | { anchor: Anchor; kind: 'folder-session'; id: string; sectionId: string }
  | { anchor: Anchor; kind: 'new' };

interface DropAt {
  groupId: string;
  beforeId: string | null;
}

export interface SidebarProps {
  state: AppState;
  store: AppStore;
  /** Open the New DM dialog; a folder section id starts it in that section's folder. */
  onNewDm(sectionId?: string): void;
  /** Current sidebar width and its handlers (the shell owns the grid column). */
  width: number;
  onResizePreview(w: number): void;
  onResizeCommit(w: number): void;
}

const isMenuKey = (e: KeyboardEvent) => e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey);

export function Sidebar({
  state,
  store,
  onNewDm,
  width,
  onResizePreview,
  onResizeCommit,
}: SidebarProps) {
  const [collapsedVirtual, setCollapsedVirtual] = useState(readCollapsed);
  // The create row under the header: a section, or a divider (label optional).
  const [adding, setAdding] = useState<'section' | 'divider' | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ kind: 'dm' | 'section'; id: string; label: string } | null>(
    null,
  );
  const [ghost, setGhost] = useState({ x: 0, y: 0 });
  const [drop, setDrop] = useState<DropAt | null>(null);
  const [secDrop, setSecDrop] = useState<{ groupId: string; after: boolean } | null>(null);
  // Folder sections: the "Show N hidden" toggle, the Older dropdown, a pending live-session
  // confirm, the hover card and the "Older than X days" editor.
  const [showHidden, setShowHidden] = useState<Record<string, boolean>>({});
  const [olderOpen, setOlderOpen] = useState<Record<string, boolean>>({});
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [tip, setTip] = useState<{ id: string; info: FolderSession; rect: DOMRect } | null>(null);
  const [daysEdit, setDaysEdit] = useState<{ id: string; anchor: Anchor } | null>(null);
  const tipTimer = useRef(0);
  // Relative times re-read the clock twice a minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  const groups = buildGroups(state.sections, state.sessions);
  const under = dividerOf(groups);
  const root = useRef<HTMLElement>(null);
  const plusBtn = useRef<HTMLButtonElement>(null);

  // Needs-you holds until the prompt is answered, whichever DM is open. Unread clears on view.
  // Archived DMs never badge.
  const needsOf = (s: SessionInfo) =>
    s.archived ? 0 : Math.max(state.badges[s.id]?.needsYou ?? 0, s.status === 'waiting' ? 1 : 0);
  const unreadOf = (s: SessionInfo) =>
    s.archived || s.id === state.activeId ? 0 : (state.badges[s.id]?.unread ?? 0);

  // Set for the length of a DM or section drag. No hover card may open while it is true.
  const dragging = useRef(false);

  function showTip(info: FolderSession, rect: DOMRect | null, immediate: boolean) {
    window.clearTimeout(tipTimer.current);
    if (!rect || dragging.current) {
      setTip(null);
      return;
    }
    const set = () => {
      // Read the row again: it may have scrolled or been dragged away during the delay. A card
      // only shows for the row the pointer is on, or the one holding keyboard focus.
      const el = rowEl(info.sessionId);
      if (dragging.current) return;
      if (!el || !(el.matches(':hover') || el.matches(':focus-visible'))) return;
      setTip({ id: info.sessionId, info, rect: el.getBoundingClientRect() });
    };
    if (immediate) setTip({ id: info.sessionId, info, rect });
    else tipTimer.current = window.setTimeout(set, 140);
  }

  const rowEl = (sessionId: string) =>
    root.current?.querySelector<HTMLElement>(
      `[data-fs-session="${CSS.escape(sessionId)}"], [data-tip-session="${CSS.escape(sessionId)}"]`,
    ) ?? null;
  const openTipId = tip?.id ?? null;
  // The hover card follows the pointer, never the layout. Scrolling, a press, a drag or a pointer
  // that has left the row all dismiss it, so it cannot sit beside a different row.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const drop = () => {
      window.clearTimeout(tipTimer.current);
      setTip(null);
    };
    // A scroll only hides the card. A pending show stays: it re-checks :hover when it fires.
    const hide = () => setTip(null);
    el.addEventListener('scroll', hide, true);
    el.addEventListener('wheel', hide, { passive: true });
    window.addEventListener('pointerdown', drop, true);
    const move = (e: globalThis.PointerEvent) => {
      if (!openTipId) return;
      const row = rowEl(openTipId);
      if (!row) return drop();
      if (!row.contains(e.target as Node) && !row.matches(':focus-visible')) drop();
    };
    window.addEventListener('pointermove', move, true);
    return () => {
      window.clearTimeout(tipTimer.current);
      el.removeEventListener('scroll', hide, true);
      el.removeEventListener('wheel', hide);
      window.removeEventListener('pointerdown', drop, true);
      window.removeEventListener('pointermove', move, true);
    };
  }, [openTipId]);

  function activateLazy(section: SectionInfo, info: FolderSession) {
    setTip(null);
    // A live row opens as a read-only mirror; it asks first, inside the sidebar.
    if (info.liveElsewhere) setConfirmId(info.sessionId);
    else void store.openFolderSession(section.id, info.sessionId);
  }

  // A divider with no label is a rule only: it never folds anything.
  const isClosed = (g: Group) =>
    g.kind === 'divider'
      ? isFoldingDivider(g) && !!g.section?.collapsed
      : g.section
        ? g.section.collapsed
        : !!collapsedVirtual[g.id];
  const toggles = (g: Group) => g.kind !== 'divider' || isFoldingDivider(g);

  /** Option+click or Option+Enter on any header: fold everything, or open everything. */
  function toggleAll() {
    const all = groups.filter(toggles);
    const collapse = all.some((g) => !isClosed(g));
    void store.setSectionsCollapsed(
      all.flatMap((g) => (g.section ? [g.section.id] : [])),
      collapse,
    );
    const next = { ...collapsedVirtual };
    for (const g of all) if (!g.section) next[g.id] = collapse;
    setCollapsedVirtual(next);
    try {
      window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
    } catch {
      // The collapsed state is a convenience.
    }
  }
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

  async function addEntry(name: string, emoji: string | null) {
    if (adding === 'divider') await store.createDivider(name);
    else await store.createSection(name, emoji);
    setAdding(null);
  }

  async function fromFolder() {
    const id = await store.createFolderSection();
    if (id) setAdding(null);
  }

  function closeMenu() {
    const was = menu?.kind;
    setMenu(null);
    // Hand focus back to the + button; a chosen action then moves it on (dialog, name field).
    if (was === 'new') plusBtn.current?.focus();
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
    // A divider holds no DMs: a drop on it, or on its needs-you rows, goes nowhere.
    if (!el || !root.current?.contains(el) || el.dataset.kind === 'divider') return null;
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
      onStart: () => {
        window.clearTimeout(tipTimer.current);
        setTip(null);
        dragging.current = true;
        setDrag({ kind: 'dm', id: s.id, label: s.name });
      },
      onMove: (x, y, under) => {
        setGhost({ x, y });
        setDrop(resolveDrop(y, under, s.id));
      },
      onEnd: (_x, y, under, committed) => {
        dragging.current = false;
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
    const el = under?.closest<HTMLElement>(
      '[data-group][data-kind="section"], [data-group][data-kind="divider"]',
    );
    if (!el || !root.current?.contains(el) || el.dataset.group === selfId) return null;
    const b = el.getBoundingClientRect();
    return { groupId: el.dataset.group ?? '', after: y > b.top + b.height / 2 };
  }

  function dragSection(e: PointerEvent, g: Group) {
    if (!g.section || renaming === g.id) return;
    beginDrag(e, {
      onStart: () => {
        window.clearTimeout(tipTimer.current);
        setTip(null);
        dragging.current = true;
        setDrag({ kind: 'section', id: g.id, label: g.title });
      },
      onMove: (x, y, under) => {
        setGhost({ x, y });
        setSecDrop(resolveSection(y, under, g.id));
      },
      onEnd: (_x, y, under, committed) => {
        dragging.current = false;
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
    if (m.kind === 'new') {
      return [
        { label: 'New DM', onSelect: () => onNewDm() },
        { label: 'New section', onSelect: () => setAdding('section') },
        { label: 'New divider', onSelect: () => setAdding('divider') },
        { label: 'New section from folder...', onSelect: () => void fromFolder() },
      ];
    }
    if (m.kind === 'folder-session') {
      const section = state.sections.find((x) => x.id === m.sectionId);
      const info = state.folders[m.sectionId]?.sessions.find((x) => x.sessionId === m.id);
      if (!section || !info) return [];
      return [
        { label: 'Open', onSelect: () => activateLazy(section, info) },
        info.hidden
          ? {
              label: 'Unhide',
              onSelect: () => void store.hideFolderSession(section.id, info.sessionId, false),
            }
          : {
              label: 'Hide',
              onSelect: () => void store.hideFolderSession(section.id, info.sessionId, true),
            },
      ];
    }
    if (m.kind === 'section') {
      const sec = state.sections.find((x) => x.id === m.id);
      const divider = sec?.kind === 'divider';
      const items: MenuItem[] = [];
      if (sec?.folder) {
        const days = sec.archiveDays ?? DEFAULT_ARCHIVE_DAYS;
        items.push(
          { label: 'New DM here', onSelect: () => onNewDm(sec.id) },
          {
            label: `Older than ${days} days...`,
            onSelect: () => setDaysEdit({ id: sec.id, anchor: menu?.anchor ?? { x: 0, y: 0 } }),
          },
        );
      }
      items.push(
        {
          label: divider ? 'Rename divider' : 'Rename section',
          separator: items.length > 0,
          onSelect: () => setRenaming(m.id),
        },
        {
          label: 'New divider',
          onSelect: () => void store.createDivider('', m.id),
        },
        {
          label: divider ? 'Delete divider' : 'Delete section',
          danger: true,
          onSelect: () => void store.deleteSection(m.id),
        },
      );
      return items;
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
      .filter((x) => x.id !== here && x.kind !== 'divider')
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
    items.push({
      label: 'Terminal look...',
      separator: true,
      onSelect: () => store.openPrefs({ tab: 'terminal', dmId: s.id }),
    });
    items.push({
      label: 'Sounds...',
      onSelect: () => store.openPrefs({ tab: 'sounds', dmId: s.id }),
    });
    return items;
  }

  /** The body of a folder section: open DMs and lazy session rows, hidden toggle, Older dropdown. */
  function folderBody(
    section: SectionInfo,
    dms: SessionInfo[],
    renderDm: (s: SessionInfo, info: FolderSession | null) => ReactNode,
  ) {
    const listing = state.folders[section.id];
    const days = section.archiveDays ?? DEFAULT_ARCHIVE_DAYS;
    const shown = !!showHidden[section.id];
    const layout = layoutFolder({
      dms,
      openIds: new Set(state.sessions.map((x) => x.id)),
      sessions: listing?.sessions ?? [],
      needs: (x) => needsOf(x) > 0,
      archiveDays: days,
      showHidden: shown,
      now,
    });
    const lazy = (e: Extract<FolderEntry, { kind: 'lazy' }>) => (
      <FolderRow
        key={e.info.sessionId}
        info={e.info}
        home={section.folder}
        now={now}
        confirming={confirmId === e.info.sessionId}
        tipOpen={tip?.id === e.info.sessionId}
        onActivate={() => activateLazy(section, e.info)}
        onMenu={(anchor) =>
          setMenu({ anchor, kind: 'folder-session', id: e.info.sessionId, sectionId: section.id })
        }
        onTip={(rect, immediate) => showTip(e.info, rect, immediate)}
        onConfirm={() => {
          setConfirmId(null);
          void store.openFolderSession(section.id, e.info.sessionId);
        }}
        onCancel={() => setConfirmId(null)}
      />
    );
    const row = (e: FolderEntry) => (e.kind === 'dm' ? renderDm(e.session, e.info) : lazy(e));
    const hidden = listing?.hiddenCount ?? 0;
    const empty =
      listing &&
      !listing.loading &&
      !listing.error &&
      layout.main.length === 0 &&
      layout.older.length === 0 &&
      hidden === 0;
    const olderOpened = !!olderOpen[section.id];
    return (
      <div className="fs-body" data-folder-body={section.id}>
        {(!listing || listing.loading) && (
          <p className="sec-hint" role="status">
            Looking for sessions...
          </p>
        )}
        {listing?.error && (
          <p className="sec-hint fs-error" role="alert">
            Could not read the sessions.{' '}
            <button
              type="button"
              className="fs-link"
              onClick={() => void store.loadFolder(section.id)}
            >
              Try again
            </button>
          </p>
        )}
        {empty && (
          <p className="sec-hint" data-testid="fs-empty">
            No resumable sessions in this folder yet.
          </p>
        )}
        {layout.main.map(row)}
        {hidden > 0 && (
          <button
            type="button"
            className="fs-toggle"
            aria-pressed={shown}
            onClick={() => setShowHidden({ ...showHidden, [section.id]: !shown })}
          >
            {shown ? `Hide ${hidden} hidden` : `Show ${hidden} hidden`}
          </button>
        )}
        {layout.older.length > 0 && (
          <>
            <button
              type="button"
              className="fs-toggle fs-older"
              aria-expanded={olderOpened}
              aria-controls={`fs-older-${section.id}`}
              onClick={() => setOlderOpen({ ...olderOpen, [section.id]: !olderOpened })}
            >
              <Icon name={olderOpened ? 'down' : 'right'} />
              {`Older than ${days} days (${layout.older.length})`}
            </button>
            {olderOpened && (
              <div id={`fs-older-${section.id}`} className="fs-older-list">
                {layout.older.map((e) => (e.kind === 'lazy' ? lazy(e) : null))}
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  // ---- rows ------------------------------------------------------------------------------

  /** One open DM row. `info` is its folder-session entry when the section is a folder section. */
  function dmRow(s: SessionInfo, g: Group, info: FolderSession | null = null) {
    const needs = needsOf(s);
    const unread = unreadOf(s);
    const sub = PLAIN_TITLES.has(s.title) ? '' : s.title;
    const home = g.section?.folder ?? state.sections.find((x) => x.id === s.sectionId)?.folder;
    const branch = info ? branchChip(info) : null;
    const wt = !!info && isWorktree(info, home);
    const before = drop?.beforeId === s.id && drop.groupId === g.id;
    return (
      <button
        type="button"
        key={s.id}
        className={`row${s.id === state.activeId ? ' active' : ''}${
          needs > 0 || unread > 0 ? ' unread' : ''
        }${s.status === 'exited' ? ' ended' : ''}${drag?.id === s.id ? ' dragging' : ''}${before ? ' drop-before' : ''}`}
        aria-current={s.id === state.activeId ? 'true' : undefined}
        aria-describedby={
          info && tip?.id === info.sessionId ? `fs-tip-${info.sessionId}` : undefined
        }
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
        // A DM that has a transcript entry shows the hover card (branch, path, last prompt).
        // Any other keeps the plain title.
        title={info ? undefined : `${s.name}: ${PRESENCE_LABEL[s.status]}${sub ? `. ${sub}` : ''}`}
        data-tip-session={info?.sessionId}
        onPointerEnter={
          info ? (e) => showTip(info, e.currentTarget.getBoundingClientRect(), false) : undefined
        }
        onPointerLeave={info ? () => showTip(info, null, true) : undefined}
        onFocus={
          info
            ? (e) => {
                if (e.currentTarget.matches(':focus-visible'))
                  showTip(info, e.currentTarget.getBoundingClientRect(), true);
              }
            : undefined
        }
        onBlur={info ? () => showTip(info, null, true) : undefined}
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
        <span
          className={`jack ${presence(s.status)}${s.id === state.activeId ? ' plugged' : ''}`}
        />
        <ClaudeGlyph />
        <span className="nm">{s.name}</span>
        {branch && <BranchChip branch={branch} />}
        {info && wt && <WorktreeGlyph info={info} />}
        {s.folderChip && (
          <span
            className="fs-chip fs-chip--away"
            data-testid="folder-chip"
            title={`Runs in ${s.cwd}, outside this section's folder`}
          >
            <Icon name="folder" />
            <span>{s.folderChip}</span>
          </span>
        )}
        {sub && (
          <span className="sub" data-testid="row-subtitle">
            {sub}
          </span>
        )}
        {s.hasDraft && (
          <span className="draft" role="img" aria-label="Draft" data-testid="draft-mark">
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
  }

  /** The folder-session entry of an open DM, when its group is a folder section. */
  const infoOf = (g: Group, s: SessionInfo) =>
    g.section?.folder
      ? (state.folders[g.section.id]?.sessions.find((f) => f.dmId === s.id) ?? null)
      : null;

  /**
   * What a collapsed section or divider group still shows: every DM in it that needs you, as a
   * row under the header. Collapsing never hides what is waiting on the user.
   */
  function peekRows(groups: Group[]) {
    const rows = groups.flatMap((h) =>
      h.items.filter((s) => needsOf(s) > 0).map((s) => ({ s, h })),
    );
    if (rows.length === 0) return null;
    return (
      <div className="sec-peek" data-testid="needs-peek">
        {rows.map(({ s, h }) => dmRow(s, h, infoOf(h, s)))}
      </div>
    );
  }

  const activityCount = state.activity.length;
  const savedCount = state.marks.filter((m) => m.kind === 'saved').length;

  return (
    <aside className="side" aria-label="Direct messages" ref={root}>
      <div className="ws">
        {/* The app icon stands in for a team avatar until workspaces have their own. */}
        <img
          className="ws-mark ws-mark--logo"
          src={`${import.meta.env.BASE_URL}brand/patchroom-mark.svg`}
          alt=""
          draggable={false}
        />
        <div>
          <strong>Patchroom</strong>
          <small>{state.sessions.length === 1 ? '1 DM' : `${state.sessions.length} DMs`}</small>
        </div>
        <button
          type="button"
          ref={plusBtn}
          className="ws-new"
          aria-label="Create new"
          title="New DM, section or divider"
          aria-haspopup="menu"
          aria-expanded={menu?.kind === 'new'}
          data-testid="new-menu"
          onClick={(e) =>
            setMenu(
              menu?.kind === 'new'
                ? null
                : { anchor: e.currentTarget.getBoundingClientRect(), kind: 'new' },
            )
          }
          onKeyDown={(e) => {
            if (e.key !== 'ArrowDown') return;
            e.preventDefault();
            setMenu({ anchor: e.currentTarget.getBoundingClientRect(), kind: 'new' });
          }}
        >
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
        <AddForm
          mode={adding}
          onSubmit={(n, e) => void addEntry(n, e)}
          onCancel={() => setAdding(null)}
        />
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
      <nav className="side-scroll" aria-label="Sections">
        {state.sessions.length === 0 && state.ready && <p className="side-empty">No DMs yet.</p>}
        {groups.map((g) => {
          const parent = under.get(g.id) ?? null;
          // A group under a folded divider shows nothing of its own: the divider carries its
          // needs-you rows.
          if (parent && isClosed(parent)) return null;
          const closed = isClosed(g);
          const isDivider = g.kind === 'divider';
          // A folded divider answers for every group below it, up to the next divider.
          const covered = isDivider && closed ? groups.filter((h) => under.get(h.id) === g) : [g];
          const pool = covered.flatMap((h) => h.items);
          const needing = pool.filter((s) => needsOf(s) > 0).length;
          const unreadTotal = pool.reduce((n, s) => n + unreadOf(s), 0);
          const target = drop?.groupId === g.id;
          const editing = renaming === g.id && g.section;
          const secMark =
            secDrop?.groupId === g.id ? (secDrop.after ? ' drop-after' : ' drop-before') : '';
          return (
            <div
              className={`sec${isDivider ? ' sec--divider' : ''}${target ? ' drop' : ''}${secMark}${drag?.id === g.id ? ' dragging' : ''}`}
              key={g.id}
              data-section={g.id}
              data-group={g.id}
              data-kind={g.kind}
              data-collapsed={toggles(g) ? String(closed) : undefined}
            >
              {editing && g.section ? (
                <RenameForm
                  name={g.title}
                  emoji={g.section.emoji ?? null}
                  divider={isDivider}
                  onCommit={(name) => {
                    setRenaming(null);
                    void store.renameSection(g.id, name);
                  }}
                  onEmoji={(e) => void store.setSectionEmoji(g.id, e)}
                  onCancel={() => setRenaming(null)}
                />
              ) : (
                <button
                  type="button"
                  className={`sec-h sec-toggle${isDivider ? ' sec-h--divider' : ''}`}
                  aria-expanded={toggles(g) ? !closed : undefined}
                  aria-label={isDivider && !isFoldingDivider(g) ? 'Divider, no label' : undefined}
                  title={g.section?.folder ?? undefined}
                  data-testid={isDivider ? 'divider-h' : 'section-h'}
                  onClick={(e) => {
                    if (e.altKey) return toggleAll();
                    if (toggles(g)) return toggleGroup(g);
                    // An unlabeled divider is a rule: activating it offers a label.
                    setRenaming(g.id);
                  }}
                  onPointerDown={(e) => dragSection(e, g)}
                  onDoubleClick={() => g.section && setRenaming(g.id)}
                  onContextMenu={(e) => {
                    if (!g.section) return;
                    e.preventDefault();
                    setMenu({ anchor: { x: e.clientX, y: e.clientY }, kind: 'section', id: g.id });
                  }}
                  onKeyDown={(e) => {
                    // Option+Enter or Option+Space: the keyboard form of Option+click.
                    if (e.altKey && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault();
                      toggleAll();
                      return;
                    }
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
                  {toggles(g) && <Icon name={closed ? 'right' : 'down'} />}
                  {g.section?.emoji ? (
                    <span className="sec-emoji" data-testid="sec-emoji" aria-hidden="true">
                      {g.section.emoji}
                    </span>
                  ) : (
                    <>
                      {g.kind === 'starred' && <Icon name="star" />}
                      {g.kind === 'archived' && <Icon name="archive" />}
                      {g.section?.folder && <Icon name="folder" />}
                    </>
                  )}
                  {(!isDivider || g.title.trim() !== '') && (
                    <span className="sec-name">{g.title}</span>
                  )}
                  {isDivider && <span className="sec-rule" aria-hidden="true" />}
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
              {closed && peekRows(covered)}
              {!closed &&
                g.section?.folder &&
                folderBody(g.section, g.items, (s, info) => dmRow(s, g, info))}
              {!closed && !g.section?.folder && g.items.map((s) => dmRow(s, g))}
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
      <SidebarResizer width={width} onPreview={onResizePreview} onCommit={onResizeCommit} />
      {menu && (
        <ContextMenu
          anchor={menu.anchor}
          label={
            menu.kind === 'dm'
              ? 'DM actions'
              : menu.kind === 'section'
                ? 'Section actions'
                : menu.kind === 'new'
                  ? 'Create new'
                  : 'Session actions'
          }
          items={menuItems(menu)}
          onClose={closeMenu}
        />
      )}
      {daysEdit && (
        <Floating
          anchor={daysEdit.anchor}
          onClose={() => setDaysEdit(null)}
          label="Older than days"
          className="fs-pop"
        >
          <ArchiveDaysForm
            value={
              state.sections.find((x) => x.id === daysEdit.id)?.archiveDays ?? DEFAULT_ARCHIVE_DAYS
            }
            onSave={(n) => {
              void store.setArchiveDays(daysEdit.id, n);
              setDaysEdit(null);
            }}
          />
        </Floating>
      )}
      {tip && <FolderTip info={tip.info} rect={tip.rect} id={`fs-tip-${tip.id}`} />}
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
