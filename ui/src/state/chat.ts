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

export interface ChatSnapshot {
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
  private hasMore = false;
  private loading = false;
  private loaded = false;
  private error: string | null = null;
  private statusline: Statusline | null = null;
  private version = 0;
  private snap: ChatSnapshot;
  private readonly listeners = new Set<() => void>();
  private threadListeners = new Map<string, Set<() => void>>();
  private loadingMore: Promise<void> | null = null;
  private loadGen = 0;

  /** UI state that survives the view unmounting. */
  scroll: { top: number; atBottom: boolean } = { top: 0, atBottom: true };
  readonly expanded = new Set<string>();
  draft = '';
  setDraft(text: string): void {
    this.draft = text;
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
  insertIntoDraft(text: string): void {
    this.draft += text;
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
      items,
      prompts: this.prompts,
      hasMore: this.hasMore,
      loading: this.loading,
      loaded: this.loaded,
      error: this.error,
      statusline: this.statusline,
      version: this.version,
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
    let touched = false;
    for (const it of items) {
      if (it.parentToolUseId) {
        this.applyChild(it);
        continue;
      }
      if (!this.byKey.has(it.key)) this.order.push(it.key);
      this.byKey.set(it.key, it);
      touched = true;
    }
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
    this.commit();
    await this.ensureLoaded();
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

  addPrompt(e: PromptPendingEvent): void {
    if (this.prompts.some((p) => p.promptId === e.promptId)) return;
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
