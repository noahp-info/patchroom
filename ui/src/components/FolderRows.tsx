import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { FolderSession } from '../ipc';
import { NAME_SOURCE_LABEL, relativeAge, relativeAgeLong } from '../lib/folder';
import { toMillis } from '../lib/time';
import { appRoot } from './Floating';
import { Icon } from './Icon';

const isMenuKey = (e: KeyboardEvent) => e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey);

/**
 * The branch to show as a chip, or null. A chip appears only when the session's branch differs
 * from the branch checked out in the section's folder: a column of identical "dev" chips is noise.
 * Claude's auto-named worktree branch (`worktree-<folder>`) repeats the worktree glyph, so it
 * stays in the hover card only.
 */
export function branchChip(info: FolderSession): string | null {
  const { branch, folderBranch } = info;
  if (!branch || !folderBranch || branch === folderBranch) return null;
  const leaf = info.relPath.split('/').pop() ?? '';
  if (info.relPath && branch === `worktree-${leaf}`) return null;
  return branch;
}

const under = (path: string, home: string) => {
  const h = home.replace(/\/+$/, '');
  return path === h || path.startsWith(`${h}/`);
};

/** A session in a linked git worktree: outside the section's folder, or under `.claude/worktrees`. */
export function isWorktree(info: FolderSession, home: string | null | undefined): boolean {
  if (/(^|\/)worktrees\//.test(info.relPath)) return true;
  return !!home && !!info.launchCwd && !under(info.launchCwd, home);
}

/** The small worktree glyph a session row wears in place of a path line. */
export function WorktreeGlyph({ info }: { info: FolderSession }) {
  return (
    <span
      className="fs-wt"
      role="img"
      data-testid="wt-glyph"
      aria-label={`Worktree: ${info.relPath || info.launchCwd}`}
    >
      <Icon name="worktree" />
    </span>
  );
}

/**
 * The part of a branch name that tells branches apart: `feat/lane-3` is `lane-3`. A bare version
 * leaf keeps its parent, so `release/2.4` stays whole.
 */
export function branchLeaf(branch: string): string {
  const parts = branch.split('/').filter(Boolean);
  const leaf = parts[parts.length - 1] ?? branch;
  if (parts.length > 1 && !/[A-Za-z]{3}/.test(leaf)) return parts.slice(-2).join('/');
  return leaf;
}

/**
 * One quiet chip: the branch, when it differs from the folder's. It never shrinks: the last
 * segment is what distinguishes branches, so the session name gives way first. The full branch
 * stays in the title and the hover card.
 */
export function BranchChip({ branch }: { branch: string }) {
  return (
    <span className="fs-chip" data-chip="branch" title={branch} aria-label={`Branch ${branch}`}>
      <Icon name="branch" />
      <span>{branchLeaf(branch)}</span>
    </span>
  );
}

/** Hover card for a listed session: branch, path, where its name came from, what was said last. */
export function FolderTip({ info, rect, id }: { info: FolderSession; rect: DOMRect; id: string }) {
  const last = (info.lastPrompt || info.firstPrompt).trim();
  const at = toMillis(info.lastActivity);
  const side = rect.right + 10 + 300 < window.innerWidth;
  const top = Math.min(rect.top, window.innerHeight - 230);
  return createPortal(
    <div
      id={id}
      role="tooltip"
      className="fs-tip"
      data-testid="folder-tip"
      style={{ top: Math.max(8, top), ...(side ? { left: rect.right + 10 } : { right: 12 }) }}
    >
      <strong className="fs-tip__name">{info.name}</strong>
      <span className="fs-tip__src">{NAME_SOURCE_LABEL[info.nameSource] ?? 'Name'}</span>
      {info.branch && (
        <span className="fs-tip__branch" data-testid="tip-branch">
          <Icon name="branch" />
          <span>{info.branch}</span>
        </span>
      )}
      {last && (
        <p className="fs-tip__prompt">
          <span>Last prompt</span>
          {last}
        </p>
      )}
      <span className="fs-tip__meta">
        {info.userTurns === 1 ? '1 prompt' : `${info.userTurns} prompts`}
        {at ? `, ${relativeAgeLong(at)}` : ''}
      </span>
      <span className="fs-tip__path" title={info.launchCwd}>
        {info.launchCwd}
      </span>
    </div>,
    appRoot(),
  );
}

export interface FolderRowProps {
  info: FolderSession;
  /** The section's home folder, to tell a linked worktree from a subfolder. */
  home: string | null | undefined;
  now: number;
  confirming: boolean;
  tipOpen: boolean;
  onActivate(): void;
  onMenu(anchor: DOMRect | { x: number; y: number }): void;
  onTip(rect: DOMRect | null, immediate: boolean): void;
  onConfirm(): void;
  onCancel(): void;
}

/** A discovered session. Nothing runs until the user opens it. */
export function FolderRow(p: FolderRowProps) {
  const { info } = p;
  const at = toMillis(info.lastActivity);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (p.confirming) cancelRef.current?.focus();
  }, [p.confirming]);
  const tipId = `fs-tip-${info.sessionId}`;
  const branch = branchChip(info);
  return (
    <div className="fs-item" data-fs-item={info.sessionId}>
      <button
        type="button"
        className={`row fs-row${info.hidden ? ' fs-row--hidden' : ''}`}
        data-fs-session={info.sessionId}
        data-activity={at}
        data-live={info.liveElsewhere ? 'true' : undefined}
        data-hidden={info.hidden ? 'true' : undefined}
        aria-describedby={p.tipOpen ? tipId : undefined}
        onClick={p.onActivate}
        onContextMenu={(e) => {
          e.preventDefault();
          p.onMenu({ x: e.clientX, y: e.clientY });
        }}
        onKeyDown={(e) => {
          if (!isMenuKey(e)) return;
          e.preventDefault();
          p.onMenu(e.currentTarget.getBoundingClientRect());
        }}
        onPointerEnter={(e) => p.onTip(e.currentTarget.getBoundingClientRect(), false)}
        onPointerLeave={() => p.onTip(null, true)}
        onFocus={(e) => {
          if (e.currentTarget.matches(':focus-visible'))
            p.onTip(e.currentTarget.getBoundingClientRect(), true);
        }}
        onBlur={() => p.onTip(null, true)}
      >
        <span className="dot idle" role="img" aria-label="Not running" />
        <span className="nm" data-testid="fs-name">
          {info.name}
        </span>
        {branch && <BranchChip branch={branch} />}
        {isWorktree(info, p.home) && <WorktreeGlyph info={info} />}
        {info.liveElsewhere && (
          <span className="fs-chip fs-chip--live" data-chip="live">
            Live elsewhere
          </span>
        )}
        {info.hidden && (
          <span className="fs-chip" data-chip="hidden">
            Hidden
          </span>
        )}
        {at > 0 && (
          <time
            className="fs-age"
            dateTime={new Date(at).toISOString()}
            aria-label={relativeAgeLong(at, p.now)}
          >
            {relativeAge(at, p.now)}
          </time>
        )}
      </button>
      {p.confirming && (
        <div
          className="fs-confirm"
          role="group"
          aria-label="Confirm open"
          data-testid="fs-confirm"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              p.onCancel();
            }
          }}
        >
          <p>
            This session is running in another terminal. Two processes on one session can corrupt
            it.
          </p>
          <div className="fs-confirm__acts">
            <button type="button" className="fs-btn" ref={cancelRef} onClick={p.onCancel}>
              Cancel
            </button>
            <button type="button" className="fs-btn fs-btn--pri" onClick={p.onConfirm}>
              Open anyway
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Small controlled number editor for "Older than X days". */
export function ArchiveDaysForm({ value, onSave }: { value: number; onSave(days: number): void }) {
  const [v, setV] = useState(String(value));
  const n = Number(v);
  const ok = Number.isInteger(n) && n >= 1 && n <= 3650;
  return (
    <form
      className="fs-days"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onSave(n);
      }}
    >
      <label>
        <span>Fold sessions with no activity in</span>
        <span className="fs-days__row">
          <input
            type="number"
            min={1}
            max={3650}
            value={v}
            onChange={(e) => setV(e.target.value)}
            aria-label="Days"
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
          />
          <span>days</span>
        </span>
      </label>
      <button type="submit" className="btn pri" disabled={!ok}>
        Save
      </button>
    </form>
  );
}
