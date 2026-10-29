import type { DictationEvent, Ipc } from '../ipc';
import type { DictationErrorCode, SettingsPane } from '../lib/dictation';

/**
 * The one dictation run in the app. A composer starts it for its DM (the owner) and receives
 * the words; any other composer only sees that a run is going. Transcripts pass through here
 * in memory and are never stored, logged or sent anywhere but the owner's draft.
 */
export type DictationPhase = 'idle' | 'starting' | 'listening' | 'stopping';

export interface DictationSnapshot {
  phase: DictationPhase;
  owner: string | null;
  /** The last error, for the composer of `owner`, until the next start or a dismiss. */
  error: { owner: string; code: DictationErrorCode | string; language: string } | null;
  /** A one-line note after a run (stopped by silence). */
  notice: { owner: string; text: string } | null;
}

export interface DictationHandlers {
  /** The utterance so far (`final` false) or settled (`final` true). */
  onWords(heard: string, final: boolean): void;
  /** The run is over. `heard` says whether any words came. */
  onEnd(reason: string, heard: boolean): void;
}

const IDLE: DictationSnapshot = { phase: 'idle', owner: null, error: null, notice: null };

export class DictationController {
  private snap: DictationSnapshot = IDLE;
  private readonly listeners = new Set<() => void>();
  /** Run id from `dictation_start`; 0 until it answers. */
  private sid = 0;
  private handlers: DictationHandlers | null = null;
  private silenceSecs = 0;
  private heard = false;
  /** Stop was asked before `dictation_start` answered. */
  private stopEarly = false;
  /** Events that beat the `dictation_start` answer (a missing helper reports at once). */
  private early: DictationEvent[] = [];
  private listening: Promise<unknown> | null = null;

  constructor(private readonly ipc: Ipc) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    this.listening ??= this.ipc.on('dictation:event', (e) => this.onEvent(e)).catch(() => null);
    return () => void this.listeners.delete(fn);
  };

  getSnapshot = (): DictationSnapshot => this.snap;

  private set(patch: Partial<DictationSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const l of this.listeners) l();
  }

  /** Start a run for `owner`. A run for another DM is stopped first. Nothing sends, ever. */
  async start(
    owner: string,
    opts: { locale: string; silenceSecs: number },
    handlers: DictationHandlers,
  ): Promise<void> {
    if (this.snap.phase !== 'idle') this.stop();
    this.listening ??= this.ipc.on('dictation:event', (e) => this.onEvent(e)).catch(() => null);
    await this.listening;
    this.handlers = handlers;
    this.sid = 0;
    this.heard = false;
    this.stopEarly = false;
    this.early = [];
    this.silenceSecs = opts.silenceSecs;
    this.set({ phase: 'starting', owner, error: null, notice: null });
    try {
      const { sid } = await this.ipc.dictationStart(opts.locale, opts.silenceSecs);
      this.sid = sid;
      const early = this.early.filter((e) => e.sid === sid);
      this.early = [];
      for (const e of early) this.onEvent(e);
      if (this.stopEarly && this.snap.owner === owner && this.snap.phase !== 'idle') {
        this.set({ phase: 'stopping' });
        void this.ipc.dictationStop(sid).catch(() => undefined);
      }
    } catch {
      this.finish('error', { owner, code: 'helper_missing', language: '' });
    }
  }

  /** The person stopped (button, Esc, Enter, window blur, the DM left the screen). */
  stop(): void {
    const { phase } = this.snap;
    if (phase === 'idle' || phase === 'stopping') return;
    if (!this.sid) {
      this.stopEarly = true;
      return;
    }
    this.set({ phase: 'stopping' });
    void this.ipc.dictationStop(this.sid).catch(() => undefined);
  }

  dismiss(owner: string): void {
    if (this.snap.error?.owner === owner || this.snap.notice?.owner === owner)
      this.set({ error: null, notice: null });
  }

  openSettings(pane: SettingsPane): void {
    void this.ipc.dictationOpenSettings(pane).catch(() => undefined);
  }

  private finish(reason: string, error: DictationSnapshot['error'] = this.snap.error): void {
    const owner = this.snap.owner;
    const h = this.handlers;
    this.handlers = null;
    this.sid = 0;
    const notice =
      reason === 'silence' && owner
        ? { owner, text: `Dictation stopped after ${this.silenceSecs} seconds of silence.` }
        : null;
    this.set({ phase: 'idle', owner: null, error, notice });
    h?.onEnd(reason, this.heard);
  }

  private onEvent(e: DictationEvent): void {
    if (this.snap.phase === 'idle') return;
    if (!this.sid) {
      if (this.snap.phase === 'starting') this.early.push(e);
      return;
    }
    if (e.sid !== this.sid) return;
    switch (e.type) {
      case 'ready':
        if (this.snap.phase === 'starting') this.set({ phase: 'listening' });
        if (this.stopEarly) this.stop();
        break;
      case 'partial':
      case 'final':
        if (e.text) this.heard = true;
        this.handlers?.onWords(e.text ?? '', e.type === 'final');
        break;
      case 'error':
        if (this.snap.owner)
          this.set({
            error: {
              owner: this.snap.owner,
              code: e.code ?? 'unknown',
              language: e.language ?? '',
            },
          });
        break;
      case 'ended':
        this.finish(e.reason ?? 'exited');
        break;
      default:
        break;
    }
  }
}

const controllers = new WeakMap<Ipc, DictationController>();

/** The app's dictation controller for this backend. */
export function getDictation(ipc: Ipc): DictationController {
  let c = controllers.get(ipc);
  if (!c) {
    c = new DictationController(ipc);
    controllers.set(ipc, c);
  }
  return c;
}
