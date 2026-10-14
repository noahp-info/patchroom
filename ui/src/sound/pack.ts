import type { SoundEvent } from '../components/prefs/ipc.ts';

interface Note {
  /** Hz */
  f: number;
  /** start offset, seconds */
  at: number;
  /** length, seconds */
  len: number;
  type: OscillatorType;
  /** peak gain before the volume multiplier */
  gain: number;
  /** Hz to glide to over the note */
  to?: number;
}

/**
 * The Patchroom sound pack. Every sound is synthesized here from oscillators, so there is no
 * audio asset and nothing to license beyond this code (Apache-2.0, see LICENSE in this folder).
 */
export const PACK: Record<SoundEvent, { name: string; blurb: string; notes: Note[] }> = {
  needs: {
    name: 'Needs you',
    blurb: 'Two rising notes. Something waits on you.',
    notes: [
      { f: 659.25, at: 0, len: 0.16, type: 'sine', gain: 0.5 },
      { f: 987.77, at: 0.13, len: 0.3, type: 'sine', gain: 0.5 },
    ],
  },
  done: {
    name: 'Turn complete',
    blurb: 'A soft major arpeggio. The turn finished.',
    notes: [
      { f: 523.25, at: 0, len: 0.2, type: 'triangle', gain: 0.45 },
      { f: 659.25, at: 0.09, len: 0.2, type: 'triangle', gain: 0.45 },
      { f: 783.99, at: 0.18, len: 0.36, type: 'triangle', gain: 0.45 },
    ],
  },
  message: {
    name: 'Message',
    blurb: 'One short blip.',
    notes: [{ f: 880, at: 0, len: 0.11, type: 'sine', gain: 0.4 }],
  },
  error: {
    name: 'Error',
    blurb: 'A low falling buzz.',
    notes: [
      { f: 220, at: 0, len: 0.2, type: 'square', gain: 0.18, to: 174.61 },
      { f: 174.61, at: 0.16, len: 0.3, type: 'square', gain: 0.18, to: 130.81 },
    ],
  },
  bell: {
    name: 'Terminal bell',
    blurb: 'A clean bell ring.',
    notes: [
      { f: 1318.51, at: 0, len: 0.7, type: 'sine', gain: 0.4 },
      { f: 2637.02, at: 0, len: 0.35, type: 'sine', gain: 0.12 },
    ],
  },
};

let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    ctx = null;
  }
  return ctx;
}

/** Synthesize one pack sound at `volume` (0 to 1). Resolves false when audio is unavailable. */
export function synth(event: SoundEvent, volume: number): boolean {
  const c = context();
  if (!c) return false;
  if (c.state === 'suspended') void c.resume().catch(() => undefined);
  const t0 = c.currentTime + 0.01;
  const master = c.createGain();
  master.gain.value = Math.min(1, Math.max(0, volume)) * 0.6;
  master.connect(c.destination);
  for (const n of PACK[event].notes) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = n.type;
    const start = t0 + n.at;
    const end = start + n.len;
    osc.frequency.setValueAtTime(n.f, start);
    if (n.to) osc.frequency.linearRampToValueAtTime(n.to, end);
    // Short attack, exponential decay: no clicks at either end.
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(n.gain, start + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(g);
    g.connect(master);
    osc.start(start);
    osc.stop(end + 0.02);
  }
  return true;
}
