import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal as XTerm, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { Ipc } from '../ipc';
import { base64ToBytes, binaryStringToBase64, utf8ToBase64 } from './base64';
import { InputQueue } from './inputQueue';
import { CTRL_V, handleKey, shellQuotePath } from './keys';

/** iTerm2 "Dark Background" default profile colors. */
export const ITERM_THEME: ITheme = {
  background: '#000000',
  foreground: '#c7c7c7',
  cursor: '#c7c7c7',
  cursorAccent: '#000000',
  selectionBackground: '#c1deff',
  selectionForeground: '#000000',
  black: '#000000',
  red: '#c91b00',
  green: '#00c200',
  yellow: '#c7c400',
  blue: '#0225c7',
  magenta: '#c930c7',
  cyan: '#00c5c7',
  white: '#c7c7c7',
  brightBlack: '#676767',
  brightRed: '#ff6d67',
  brightGreen: '#5ff967',
  brightYellow: '#fefb67',
  brightBlue: '#6871ff',
  brightMagenta: '#ff76ff',
  brightCyan: '#5ffdff',
  brightWhite: '#ffffff',
};

const FONT_STACK = '"JetBrains Mono", Menlo, Monaco, "Courier New", monospace';
const FONT_SIZE = 13;

export interface SessionTerminalOptions {
  /** Test mode: hold the grid at this size and never fit to the container. */
  fixedGrid?: { cols: number; rows: number };
}

/**
 * One xterm.js instance bound to one session. It exists from the first byte of output, even
 * before a view mounts it, because xterm buffers writes on an unopened terminal.
 */
export class SessionTerminal {
  readonly term: XTerm;
  private readonly fit = new FitAddon();
  private readonly input: InputQueue;
  private webgl: WebglAddon | null = null;
  private host: HTMLElement | null = null;
  private observer: ResizeObserver | null = null;
  private frame = 0;
  private opened = false;
  private disposed = false;
  private lastSent = '';

  constructor(
    readonly id: string,
    private readonly ipc: Ipc,
    private readonly opts: SessionTerminalOptions = {},
  ) {
    this.input = new InputQueue((data) => ipc.sessionWrite(id, data));
    this.term = new XTerm({
      allowProposedApi: true,
      cols: opts.fixedGrid?.cols ?? 120,
      rows: opts.fixedGrid?.rows ?? 40,
      fontFamily: FONT_STACK,
      fontSize: FONT_SIZE,
      lineHeight: 1,
      fontWeightBold: '600',
      theme: ITERM_THEME,
      scrollback: 10_000,
      cursorBlink: false,
      cursorStyle: 'block',
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      drawBoldTextInBrightColors: true,
      minimumContrastRatio: 1,
      customGlyphs: true,
      scrollOnUserInput: true,
      rightClickSelectsWord: true,
      linkHandler: {
        activate: (ev, uri) => {
          if (ev.metaKey || ev.ctrlKey) window.open(uri, '_blank', 'noopener');
        },
      },
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = '11';

    this.term.onData((s) => this.input.pushText(s));
    this.term.onBinary((s) => this.input.push(binaryStringToBase64(s)));
    this.term.onResize(({ cols, rows }) => this.reportSize(cols, rows));
    this.term.attachCustomKeyEventHandler((ev) =>
      handleKey(ev, {
        send: (s) => this.input.pushText(s),
        hasSelection: () => this.term.hasSelection(),
        copySelection: () => {
          void navigator.clipboard?.writeText(this.term.getSelection()).catch(() => undefined);
        },
        selectAll: () => this.term.selectAll(),
      }),
    );
  }

  /** Feed pty bytes (base64) to the emulator. */
  writeBase64(data: string): void {
    if (this.disposed) return;
    this.term.write(base64ToBytes(data));
  }

  /** Send text as a bracketed paste when the app enabled it, like a Cmd+V in iTerm2. */
  paste(text: string): void {
    this.term.paste(text);
  }

  /** Paste dropped file paths shell-quoted, space separated, like iTerm2. */
  pastePaths(paths: string[]): void {
    this.term.paste(paths.map(shellQuotePath).join(' ') + ' ');
  }

  mount(host: HTMLElement): void {
    if (this.opened || this.disposed) return;
    this.opened = true;
    this.host = host;
    this.term.open(host);
    host.dataset.renderer = 'dom';
    this.installPasteHandler();

    if (this.opts.fixedGrid) {
      this.reportSize(this.term.cols, this.term.rows);
    } else {
      this.observer = new ResizeObserver(() => this.scheduleFit());
      this.observer.observe(host);
      this.fitNow();
    }
  }

  /** WebGL only on the visible terminal: browsers cap live GL contexts. */
  setActive(active: boolean, focus = true): void {
    if (!this.opened || this.disposed) return;
    if (active) {
      this.attachWebgl();
      this.scheduleFit();
      if (focus) this.term.focus();
    } else {
      this.detachWebgl();
    }
  }

  focus(): void {
    this.term.focus();
  }

  /** Test hook: resize the emulator and tell the backend. */
  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.observer?.disconnect();
    this.detachWebgl();
    this.term.dispose();
  }

  private attachWebgl(): void {
    if (this.webgl || !this.host) return;
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => {
        this.detachWebgl();
      });
      this.term.loadAddon(gl);
      this.webgl = gl;
      this.host.dataset.renderer = 'webgl';
    } catch {
      this.webgl = null;
      this.host.dataset.renderer = 'dom';
    }
  }

  private detachWebgl(): void {
    if (!this.webgl) return;
    try {
      this.webgl.dispose();
    } catch {
      // Already torn down with the context.
    }
    this.webgl = null;
    if (this.host) this.host.dataset.renderer = 'dom';
  }

  /** Refit the grid, after a font change. */
  refit(): void {
    this.scheduleFit();
  }

  private scheduleFit(): void {
    if (this.opts.fixedGrid) return;
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.fitNow());
  }

  private fitNow(): void {
    if (
      this.disposed ||
      !this.host ||
      this.host.clientWidth === 0 ||
      this.host.clientHeight === 0
    ) {
      return;
    }
    try {
      this.fit.fit();
    } catch {
      return;
    }
    this.reportSize(this.term.cols, this.term.rows);
  }

  private reportSize(cols: number, rows: number): void {
    const key = `${cols}x${rows}`;
    if (key === this.lastSent) return;
    this.lastSent = key;
    void this.ipc.sessionResize(this.id, cols, rows).catch(() => undefined);
  }

  /**
   * iTerm2 pastes text. When the pasteboard holds only an image it pastes nothing, and claude
   * itself reads the image from the system clipboard on Ctrl+V. Forward that byte.
   */
  private installPasteHandler(): void {
    const el = this.term.element;
    if (!el) return;
    el.addEventListener(
      'paste',
      (ev) => {
        const data = ev.clipboardData;
        if (!data) return;
        const text = data.getData('text/plain');
        if (text) return;
        const hasImage = Array.from(data.items).some(
          (i) => i.kind === 'file' && i.type.startsWith('image/'),
        );
        if (!hasImage) return;
        ev.preventDefault();
        ev.stopPropagation();
        this.input.push(utf8ToBase64(CTRL_V));
      },
      true,
    );
  }
}
