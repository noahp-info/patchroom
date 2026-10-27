import type { DraftComment } from '../lib/comments';
import type {
  ChatItem,
  Ipc,
  PromptAnswer,
  PromptKind,
  PromptPendingEvent,
  QuestionDef,
  ResolvedBy,
  StatuslineUpdateEvent,
} from '../ipc';

export const PAGE_SIZE = 300;

/** A permission, question or plan prompt, pending or resolved. */
export interface PromptState {
  promptId: string;
  kind: PromptKind;
  toolName: string;
  toolInput: unknown;
  toolUseId?: string;
  questions?: QuestionDef[];
  /** "Always allow" has a CLI suggestion to apply. Defaults to true when the backend omits it. */
  canAlways?: boolean;
  /** Handed to the terminal: chat no longer answers it, the TUI dialog does. */
  handedOff?: boolean;
  /** Arrival time, ms. Orders the prompt among the log rows. */
  at: number;
  resolved?: { by: ResolvedBy };
  /** The answer sent from chat, kept to describe the resolution. */
  answer?: PromptAnswer;
  /** An answer from chat is in flight. */
  sending?: boolean;
  error?: string;
}

export interface Statusline {
  text: string;
  chips: StatuslineUpdateEvent['chips'];
}

/** A line under the log about the last send: why it did not go through, or that it waits. */
export interface ChatNotice {
  kind: 'blocked' | 'mirror' | 'queued' | 'no-echo';
  text: string;
}

/**
 * A message sent while Claude was busy. Claude Code holds it as queued input and writes the
 * transcript entry only when it reads it, so chat shows it at once, below the live turn, until
 * that entry arrives. `returned`: the turn was interrupted and the text went back to Claude's
 * prompt. `ended`: the session ended first.
 */
export interface QueuedMessage {
  id: string;
  text: string;
  at: number;
  state: 'queued' | 'returned' | 'ended';
}

export interface ChatSnapshot {
  /** Highlight-to-comment lines waiting in the composer. Nothing sends before Send. */
  comments: DraftComment[];
  /** The comment whose note is being edited: its source stays in view, marked stronger. */
  activeComment: string | null;
  /** Main-log items in order. Subagent children are excluded. */
  items: ChatItem[];
  prompts: PromptState[];
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  statusline: Statusline | null;
  /** Bumps on every change, for cheap memo keys. */
  version: number;
  /** The row a search or jump landed on, highlighted until it fades. */
  hit: string | null;
  /** A scroll request: the log scrolls to `key` once, then calls `consumeFocus`. */
  focus: { key: string; nonce: number } | null;
  /** The window shows an old page: newer rows exist and arrive on `reload`. */
  detached: boolean;
  /** Only rows carrying this reaction show. */
  reactionFilter: string | null;
  notice: ChatNotice | null;
  /** Messages sent while Claude was busy, in send order, until their transcript entry lands. */
  queued: QueuedMessage[];
}

/**
 * One DM's chat: the item list (replace-by-key), prompts and status strip. Subscribers get a
 * fresh snapshot object per change. Items arrive from `chat_history` pages and `chat:items`.
 */
export class ChatModel {
  private order: string[] = [];
  private byKey = new Map<string, ChatItem>();
  private children = new Map<string, ChatItem[]>();
  private prompts: PromptState[] = [];
  /** Prompts resolved before this view held them: a late `prompt_list` must not revive them. */
  private resolvedIds = new Set<string>();
  private hasMore = false;
  private loading = false;
  private loaded = false;
  private error: string | null = null;
  private statusline: Statusline | null = null;
  private version = 0;
  private hit: string | null = null;
  private focus: { key: string; nonce: number } | null = null;
  private focusSeq = 0;
  private detached = false;
  private reactionFilter: string | null = null;
  private notice: ChatNotice | null = null;
  private noticeTimer = 0;
  private queued: QueuedMessage[] = [];
  private queuedSeq = 0;
  private hitTimer = 0;
  private snap: ChatSnapshot;
  private readonly listeners = new Set<() => void>();
  private threadListeners = new Map<string, Set<() => void>>();
  private loadingMore: Promise<void> | null = null;
  private loadGen = 0;
  private comments: DraftComment[] = [];
  private activeComment: string | null = null;
  private commentSeq = 0;
  /** The comment whose note box should take focus once it renders. */
  private focusCommentId: string | null = null;
  /** True once for the comment just added: its note box takes focus. */
  claimCommentFocus(id: string): boolean {
    if (this.focusCommentId !== id) return false;
    this.focusCommentId = null;
    return true;
  }

  /** UI state that survives the view unmounting. */
  scroll: { top: number; atBottom: boolean } = { top: 0, atBottom: true };
  readonly expanded = new Set<string>();
  draft = '';
  /** Called with every batch of items this chat applies (the store notes artifacts). */
  itemsHook: ((items: ChatItem[]) => void) | null = null;
  /** Called with the new text whenever the composer text changes (the store persists it). */
  draftHook: ((text: string) => void) | null = null;
  private draftDirty = false;
  private draftLoaded = false;
  setDraft(text: string): void {
    if (text === this.draft) return;
    this.draft = text;
    this.draftDirty = true;
    this.draftHook?.(text);
  }
  /** Fill the composer from the stored draft, unless the user already typed. */
  async loadDraft(): Promise<void> {
    if (this.draftLoaded) return;
    this.draftLoaded = true;
    try {
      const { body } = await this.ipc.draftGet(this.id);
      if (body && !this.draftDirty && this.draft === '') {
        this.draft = body;
        for (const fn of this.draftListeners) fn();
      }
    } catch {
      // No stored draft is the same as an empty one.
    }
  }
  setScroll(s: { top: number; atBottom: boolean }): void {
    this.scroll = s;
  }
  /** Expand or collapse a row. Returns nothing; callers re-render themselves. */
  toggleExpanded(key: string): void {
    if (!this.expanded.delete(key)) this.expanded.add(key);
  }
  private draftListeners = new Set<() => void>();
  /** The composer text was set from outside (a file drop). */
  onDraft(fn: () => void): () => void {
    this.draftListeners.add(fn);
    return () => this.draftListeners.delete(fn);
  }
  // ---- highlight-to-comment ----------------------------------------------------------------

  /** Add a comment line for a highlighted quote. Returns its id. */
  addComment(key: string | null, quote: string, at?: number, len?: number): string {
    this.commentSeq += 1;
    const id = `c${this.commentSeq}`;
    this.comments = [...this.comments, { id, key, quote, text: '', at, len }];
    this.focusCommentId = id;
    this.commit();
    return id;
  }
  /** A comment on a quote from the side-pane page; `link` jumps back to it. */
  addLinkedComment(quote: string, link: string): string {
    const id = this.addComment(null, quote);
    this.comments = this.comments.map((c) => (c.id === id ? { ...c, link } : c));
    this.commit();
    return id;
  }
  /** A screenshot line: the saved crop and the steer typed in the note box. */
  addShot(image: { path: string; src: string }, note: string): string {
    this.commentSeq += 1;
    const id = `c${this.commentSeq}`;
    this.comments = [...this.comments, { id, key: null, quote: '', text: note, image }];
    this.commit();
    return id;
  }
  updateComment(id: string, text: string): void {
    this.comments = this.comments.map((c) => (c.id === id ? { ...c, text } : c));
    this.commit();
  }
  /** The note box of `id` took focus (or none has it): keep its source in view. */
  setActiveComment(id: string | null): void {
    if (this.activeComment === id) return;
    this.activeComment = id;
    const key = id ? this.comments.find((c) => c.id === id)?.key : null;
    if (key && this.byKey.has(key)) this.focusKey(key);
    else this.commit();
  }
  removeComment(id: string): void {
    if (this.activeComment === id) this.activeComment = null;
    this.comments = this.comments.filter((c) => c.id !== id);
    this.commit();
  }
  /** Take every comment line out (they are being sent). */
  takeComments(): DraftComment[] {
    const out = this.comments;
    if (out.length === 0) return out;
    this.comments = [];
    this.activeComment = null;
    this.commit();
    return out;
  }
  /** Put comment lines back ahead of any added since (a send was refused). */
  restoreComments(list: DraftComment[]): void {
    if (list.length === 0) return;
    this.comments = [...list, ...this.comments];
    this.commit();
  }
  /** Scroll to a row and mark it, as a search hit does. */
  jumpTo(key: string): void {
    if (this.byKey.has(key)) this.setHit(key);
  }

  insertIntoDraft(text: string): void {
    this.setDraft(this.draft + text);
    for (const fn of this.draftListeners) fn();
  }

  constructor(
    readonly id: string,
    private readonly ipc: Ipc,
  ) {
    this.snap = this.build();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): ChatSnapshot => this.snap;

  private build(): ChatSnapshot {
    const items: ChatItem[] = [];
    for (const k of this.order) {
      const it = this.byKey.get(k);
      if (it) items.push(it);
    }
    return {
      comments: this.comments,
      activeComment: this.activeComment,
      items,
      prompts: this.prompts,
      hasMore: this.hasMore,
      loading: this.loading,
      loaded: this.loaded,
      error: this.error,
      statusline: this.statusline,
      version: this.version,
      hit: this.hit,
      focus: this.focus,
      detached: this.detached,
      reactionFilter: this.reactionFilter,
      notice: this.notice,
      queued: this.queued,
    };
  }

  private commit(): void {
    this.version += 1;
    this.snap = this.build();
    for (const fn of this.listeners) fn();
  }

  // ---- items -----------------------------------------------------------------------------

  /** New or updated items. The same key replaces the earlier item in place. */
  apply(items: ChatItem[]): void {
    this.itemsHook?.(items);
    let touched = false;
    for (const it of items) {
      if (it.parentToolUseId) {
        this.applyChild(it);
        continue;
      }
      // A window parked on an old page keeps its rows; newer ones arrive on `reload`.
      if (!this.byKey.has(it.key) && !this.detached) this.order.push(it.key);
      if (this.detached && !this.order.includes(it.key)) continue;
      this.byKey.set(it.key, it);
      touched = true;
    }
    // The message the send was waiting on arrived.
    if (this.notice?.kind === 'no-echo' && items.some((i) => i.kind === 'user')) {
      this.notice = null;
      touched = true;
    }
    // A queued message turns into the real one in the same commit: no duplicate, no flicker.
    if (this.queued.length && this.matchQueued(items)) touched = true;
    if (touched) this.commit();
  }

  private applyChild(it: ChatItem): void {
    const pid = it.parentToolUseId!;
    const list = this.children.get(pid) ?? [];
    const i = list.findIndex((x) => x.key === it.key);
    if (i >= 0) list[i] = it;
    else list.push(it);
    this.children.set(pid, list);
    for (const fn of this.threadListeners.get(pid) ?? []) fn();
  }

  /** Drop everything and load the newest page again. */
  async reload(): Promise<void> {
    this.loadGen += 1;
    this.order = [];
    this.byKey.clear();
    this.children.clear();
    this.hasMore = false;
    this.loaded = false;
    this.loading = false;
    this.loadingMore = null;
    this.expanded.clear();
    this.scroll = { top: 0, atBottom: true };
    this.detached = false;
    this.hit = null;
    this.focus = null;
    this.commit();
    await this.ensureLoaded();
  }

  // ---- jump to a message -----------------------------------------------------------------

  /**
   * Open the DM at one item: load the page that holds it if needed, scroll to it and highlight
   * it. The window then sits on an older page until `reload`.
   */
  async openAt(itemKey: string): Promise<void> {
    await this.ensureLoaded();
    if (!this.byKey.has(itemKey)) {
      try {
        const { before } = await this.ipc.chatLocate(this.id, itemKey);
        const page = await this.ipc.chatHistory(this.id, before ?? undefined, PAGE_SIZE);
        this.loadGen += 1;
        this.loadingMore = null;
        this.byKey = new Map();
        this.children.clear();
        const main: string[] = [];
        for (const it of page.items) {
          if (it.parentToolUseId) this.applyChild(it);
          else {
            this.byKey.set(it.key, it);
            main.push(it.key);
          }
        }
        this.order = main;
        this.hasMore = page.hasMore;
        this.detached = before !== null;
      } catch (err) {
        this.error = `Could not open that message: ${String(err)}`;
        this.commit();
        return;
      }
    }
    this.setHit(itemKey);
  }

  /** Scroll to a row that is already in the window (a prompt row, say). */
  focusKey(key: string): void {
    this.focusSeq += 1;
    this.focus = { key, nonce: this.focusSeq };
    this.commit();
  }

  private setHit(key: string): void {
    window.clearTimeout(this.hitTimer);
    this.hit = key;
    this.focusSeq += 1;
    this.focus = { key, nonce: this.focusSeq };
    this.hitTimer = window.setTimeout(() => {
      this.hit = null;
      this.commit();
    }, 12_000);
    this.commit();
  }

  /** The log scrolled to the requested row. */
  consumeFocus(nonce: number): void {
    if (this.focus?.nonce !== nonce) return;
    this.focus = null;
    this.commit();
  }

  /** Show a send notice. `ttl` ms clears it again; omit it to hold it until cleared. */
  setNotice(notice: ChatNotice | null, ttl?: number): void {
    window.clearTimeout(this.noticeTimer);
    if (this.notice?.kind === notice?.kind && this.notice?.text === notice?.text && !ttl) return;
    this.notice = notice;
    if (notice && ttl) this.noticeTimer = window.setTimeout(() => this.setNotice(null), ttl);
    this.commit();
  }
  clearNotice(kind?: ChatNotice['kind']): void {
    if (this.notice && (!kind || this.notice.kind === kind)) this.setNotice(null);
  }

  // ---- queued messages ---------------------------------------------------------------------

  /** A send that Claude queued: show it now, at the bottom. */
  addQueued(text: string): QueuedMessage {
    this.queuedSeq += 1;
    const q: QueuedMessage = { id: `q${this.queuedSeq}`, text, at: Date.now(), state: 'queued' };
    this.queued = [...this.queued, q];
    this.commit();
    return q;
  }

  /**
   * The turn was interrupted (`returned`: still-waiting messages went back to Claude's prompt)
   * or the session ended (`ended`: every bubble left).
   */
  markQueued(state: 'returned' | 'ended'): void {
    const hit = (q: QueuedMessage) =>
      state === 'ended' ? q.state !== 'ended' : q.state === 'queued';
    if (!this.queued.some(hit)) return;
    this.queued = this.queued.map((q) => (hit(q) ? { ...q, state } : q));
    this.commit();
  }

  /** Back to waiting (Retry pressed Enter on the returned text). */
  requeue(id: string): void {
    this.queued = this.queued.map((q) => (q.id === id ? { ...q, state: 'queued' } : q));
    this.commit();
  }

  removeQueued(id: string): void {
    const next = this.queued.filter((q) => q.id !== id);
    if (next.length === this.queued.length) return;
    this.queued = next;
    this.commit();
  }

  /** Messages still waiting for Claude to read them. */
  pendingQueued(): QueuedMessage[] {
    return this.queued.filter((q) => q.state === 'queued');
  }

  /**
   * Drop queued messages whose transcript entry arrived. Main-log user entries only (a
   * subagent's prompt is not the person's message). First match first: each entry takes the
   * oldest queued message it holds, and Claude Code may join several queued messages into one
   * entry, so an entry can take more than one, in order.
   */
  private matchQueued(items: ChatItem[]): boolean {
    let changed = false;
    for (const it of items) {
      if (it.kind !== 'user' || it.parentToolUseId || !this.queued.length) continue;
      const body = norm(it.text);
      let from = 0;
      const left: QueuedMessage[] = [];
      for (const q of this.queued) {
        const t = norm(q.text);
        const at = t ? body.indexOf(t, from) : -1;
        if (at >= 0) {
          from = at + t.length;
          changed = true;
        } else left.push(q);
      }
      this.queued = left;
    }
    return changed;
  }

  /** Main-log user messages held so far, to tell whether a send produced one. */
  userItemKeys(): Set<string> {
    const out = new Set<string>();
    for (const [k, it] of this.byKey) if (it.kind === 'user') out.add(k);
    return out;
  }
  /** Main-log items held so far. */
  itemCount(): number {
    return this.byKey.size;
  }

  setReactionFilter(emoji: string | null): void {
    if (this.reactionFilter === emoji) return;
    this.reactionFilter = emoji;
    this.commit();
  }

  private loadPromise: Promise<void> | null = null;

  /** Load the newest page once. Items that arrived meanwhile win over the page's copies. */
  ensureLoaded(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (this.loadPromise) return this.loadPromise;
    const gen = this.loadGen;
    this.loading = true;
    this.error = null;
    this.commit();
    this.loadPromise = this.ipc
      .chatHistory(this.id, undefined, PAGE_SIZE)
      .then((page) => {
        if (gen !== this.loadGen) return;
        const main = page.items.filter((i) => !i.parentToolUseId);
        for (const it of page.items) if (it.parentToolUseId) this.applyChild(it);
        const incoming = new Set(main.map((i) => i.key));
        const live = this.order.filter((k) => !incoming.has(k));
        for (const it of main) if (!this.byKey.has(it.key)) this.byKey.set(it.key, it);
        this.order = [...main.map((i) => i.key), ...live];
        this.hasMore = page.hasMore;
        this.loaded = true;
        this.loading = false;
        // Prompts announced before this view existed (a reloaded webview) catch up here.
        void this.ipc.promptList(this.id).then(
          (list) => {
            if (gen === this.loadGen) for (const e of list) this.addPrompt(e);
          },
          () => undefined,
        );
      })
      .catch((err: unknown) => {
        if (gen !== this.loadGen) return;
        this.loading = false;
        this.error = `Could not load the conversation: ${String(err)}`;
      })
      .finally(() => {
        if (gen === this.loadGen) {
          this.loadPromise = null;
          this.commit();
        }
      });
    return this.loadPromise;
  }

  /** Older page, prepended. */
  loadOlder(): Promise<void> {
    if (!this.loaded || !this.hasMore) return Promise.resolve();
    if (this.loadingMore) return this.loadingMore;
    const first = this.order[0];
    const gen = this.loadGen;
    this.loading = true;
    this.commit();
    this.loadingMore = this.ipc
      .chatHistory(this.id, first, PAGE_SIZE)
      .then((page) => {
        if (gen !== this.loadGen) return;
        const older: string[] = [];
        for (const it of page.items) {
          if (it.parentToolUseId) {
            this.applyChild(it);
            continue;
          }
          if (this.byKey.has(it.key)) continue;
          this.byKey.set(it.key, it);
          older.push(it.key);
        }
        this.order = [...older, ...this.order];
        this.hasMore = page.hasMore && page.items.length > 0;
      })
      .catch((err: unknown) => {
        this.error = `Could not load older messages: ${String(err)}`;
        this.hasMore = false;
      })
      .finally(() => {
        this.loading = false;
        this.loadingMore = null;
        this.commit();
      });
    return this.loadingMore;
  }

  // ---- subagent threads ------------------------------------------------------------------

  threadItems(toolUseId: string): ChatItem[] {
    return this.children.get(toolUseId) ?? [];
  }

  subscribeThread(toolUseId: string, fn: () => void): () => void {
    let set = this.threadListeners.get(toolUseId);
    if (!set) this.threadListeners.set(toolUseId, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  /** Fetch a subagent's items, merging with any that streamed in. */
  loadThread(toolUseId: string): Promise<void> {
    const inflight = this.threadLoads.get(toolUseId);
    if (inflight) return inflight;
    const p = this.ipc
      .chatThread(this.id, toolUseId)
      .then(({ items }) => {
        const have = this.children.get(toolUseId) ?? [];
        const keys = new Set(items.map((i) => i.key));
        this.children.set(toolUseId, [...items, ...have.filter((i) => !keys.has(i.key))]);
        for (const fn of this.threadListeners.get(toolUseId) ?? []) fn();
      })
      .finally(() => this.threadLoads.delete(toolUseId));
    this.threadLoads.set(toolUseId, p);
    return p;
  }
  private readonly threadLoads = new Map<string, Promise<void>>();

  // ---- prompts ---------------------------------------------------------------------------

  /** A repeat with the same promptId replaces the open prompt's fields (e.g. a late toolUseId). */
  addPrompt(e: PromptPendingEvent): void {
    if (this.resolvedIds.has(e.promptId)) return;
    const prev = this.prompts.find((p) => p.promptId === e.promptId);
    if (prev) {
      if (prev.resolved) return;
      this.patchPrompt(e.promptId, {
        kind: e.kind,
        toolName: e.toolName,
        toolInput: e.toolInput,
        toolUseId: e.toolUseId ?? prev.toolUseId,
        questions: e.questions ?? prev.questions,
        canAlways: e.canAlways,
      });
      return;
    }
    this.prompts = [
      ...this.prompts,
      {
        promptId: e.promptId,
        kind: e.kind,
        toolName: e.toolName,
        toolInput: e.toolInput,
        toolUseId: e.toolUseId,
        questions: e.questions,
        canAlways: e.canAlways,
        at: Date.now(),
      },
    ];
    this.commit();
  }

  resolvePrompt(promptId: string, by: ResolvedBy): void {
    this.resolvedIds.add(promptId);
    let found = false;
    this.prompts = this.prompts.map((p) => {
      if (p.promptId !== promptId) return p;
      found = true;
      return { ...p, sending: false, error: undefined, resolved: { by } };
    });
    if (found) this.commit();
  }

  /** Answer from chat. The prompt resolves when `prompt:resolved` arrives. */
  async answer(promptId: string, answer: PromptAnswer): Promise<void> {
    this.patchPrompt(promptId, { sending: true, error: undefined, answer });
    try {
      await this.ipc.promptAnswer(this.id, promptId, answer);
      this.patchPrompt(promptId, { sending: false });
    } catch (err) {
      this.patchPrompt(promptId, {
        sending: false,
        answer: undefined,
        error: `Could not send the answer: ${String(err)}`,
      });
    }
  }

  /** "Answer in terminal": the hook lets go and the TUI dialog is the answerer. */
  async handoff(promptId: string): Promise<void> {
    this.patchPrompt(promptId, { handedOff: true, error: undefined });
    try {
      await this.ipc.promptAnswer(this.id, promptId, { kind: 'terminal' });
    } catch (err) {
      this.patchPrompt(promptId, {
        handedOff: false,
        error: `Could not hand this to the terminal: ${String(err)}`,
      });
    }
  }

  private patchPrompt(promptId: string, patch: Partial<PromptState>): void {
    this.prompts = this.prompts.map((p) => (p.promptId === promptId ? { ...p, ...patch } : p));
    this.commit();
  }

  // ---- status strip ----------------------------------------------------------------------

  setStatusline(e: StatuslineUpdateEvent): void {
    this.statusline = { text: e.text, chips: e.chips };
    this.commit();
  }
}

/** Whitespace-insensitive text, for matching a queued message to its transcript entry. */
function norm(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
