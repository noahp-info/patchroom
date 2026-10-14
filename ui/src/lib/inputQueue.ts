import { utf8ToBase64 } from './base64';

/**
 * Keeps keyboard bytes in order. Tauri may run concurrent invokes on different threads, so
 * firing one `session_write` per keystroke can reorder them. This sends one at a time and
 * merges whatever queued up meanwhile.
 */
export class InputQueue {
  private pending: string[] = [];
  private flushing = false;

  constructor(private readonly write: (base64: string) => Promise<void>) {}

  push(base64: string): void {
    this.pending.push(base64);
    void this.pump();
  }

  pushText(text: string): void {
    this.push(utf8ToBase64(text));
  }

  private async pump(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.pending.length > 0) {
        const batch = this.pending;
        this.pending = [];
        // Base64 pieces are only safe to join when each is a multiple of 3 bytes, so decode,
        // concatenate bytes, and re-encode.
        const merged = batch.length === 1 ? batch[0] : mergeBase64(batch);
        try {
          await this.write(merged);
        } catch {
          // The session is gone; drop the input rather than loop.
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}

function mergeBase64(parts: string[]): string {
  let bin = '';
  for (const p of parts) bin += atob(p);
  return btoa(bin);
}
