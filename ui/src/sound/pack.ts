import generated from '../../../plugins/sounds/generated-packs.json';
import { DEFAULT_PACK, type SoundEvent } from '../components/prefs/ipc.ts';
import { effectiveGain, SYNTH_BASE } from './gain.ts';

export interface Note {
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
  /** Low-pass cutoff in Hz. Absent: no filter. */
  lp?: number;
}

/** What each event means, in the words the Sounds pane uses. */
export const EVENT_INFO: Record<SoundEvent, { name: string; blurb: string }> = {
  needs: { name: 'Needs you', blurb: 'Something waits on you.' },
  done: { name: 'Turn complete', blurb: 'The turn finished.' },
  message: { name: 'Message', blurb: 'A new message arrived.' },
  error: { name: 'Error', blurb: 'Something failed.' },
  bell: { name: 'Terminal bell', blurb: 'A terminal rang its bell.' },
  decision: { name: 'Decision', blurb: 'A choice needs your answer. Arrives in a later release.' },
  due: { name: 'Due', blurb: 'A reminder came due. Arrives in a later release.' },
  session: { name: 'Session start', blurb: 'A session began. Arrives in a later release.' },
};

interface GeneratedPack {
  id: string;
  name: string;
  notes: Record<string, Note[]>;
}

/**
 * The generated packs. Every sound is synthesized from oscillators, so there is no audio asset
 * and nothing to license beyond this code (Apache-2.0, see LICENSE in this folder). The note
 * tables live in plugins/sounds/generated-packs.json, shared with the Rust side.
 */
export const GENERATED: Record<string, GeneratedPack> = Object.fromEntries(
  (generated.packs as unknown as GeneratedPack[]).map((p) => [p.id, p]),
);

export const isGenerated = (packId: string): boolean => packId in GENERATED;

/** The default pack's notes by event, as `PACK` was before packs existed. */
export const PACK: Record<SoundEvent, { name: string; blurb: string; notes: Note[] }> =
  Object.fromEntries(
    (Object.keys(EVENT_INFO) as SoundEvent[]).map((e) => [
      e,
      { ...EVENT_INFO[e], notes: GENERATED[DEFAULT_PACK].notes[e] ?? [] },
    ]),
  ) as Record<SoundEvent, { name: string; blurb: string; notes: Note[] }>;

let ctx: AudioContext | null = null;

/** One note's amplitude at `t` seconds after the sound starts: 8 ms attack, exponential decay. */
function envelope(n: Note, t: number): number {
  const x = t - n.at;
  if (x < 0 || x > n.len) return 0;
  if (x <= 0.008) return (n.gain * x) / 0.008;
  const k = Math.min(1, (x - 0.008) / Math.max(0.001, n.len - 0.008));
  return n.gain * Math.pow(0.0001 / n.gain, k);
}

/**
 * The loudest the notes get at gain 1. Peaks add, which is the worst case for oscillators that
 * line up, and each note decays on its own envelope.
 */
const peaks = new WeakMap<Note[], number>();

export function notesPeak(notes: Note[]): number {
  const known = peaks.get(notes);
  if (known !== undefined) return known;
  const end = Math.max(0, ...notes.map((n) => n.at + n.len));
  let peak = 0;
  for (let t = 0; t <= end; t += 0.002) {
    peak = Math.max(
      peak,
      notes.reduce((sum, n) => sum + envelope(n, t), 0),
    );
  }
  peaks.set(notes, peak);
  return peak;
}

/** The shared audio context, or null where Web Audio is missing. */
export function context(): AudioContext | null {
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

/**
 * Synthesize one generated-pack sound at the master `volume` (0 to 1) and the event's `gain`
 * (0 to 1.5). The master gain node carries the product, held below clipping. Returns false when
 * audio is unavailable or the pack is not generated.
 */
export function synth(
  event: SoundEvent,
  volume: number,
  packId: string = DEFAULT_PACK,
  gain = 1,
): boolean {
  const notes = (GENERATED[packId] ?? GENERATED[DEFAULT_PACK]).notes[event];
  const c = context();
  if (!c || !notes) return false;
  if (c.state === 'suspended') void c.resume().catch(() => undefined);
  const t0 = c.currentTime + 0.01;
  const master = c.createGain();
  master.gain.value = effectiveGain({
    master: volume,
    event: gain,
    base: SYNTH_BASE,
    peak: notesPeak(notes),
  });
  master.connect(c.destination);
  for (const n of notes) {
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
    if (n.lp) {
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(n.lp, start);
      g.connect(lp);
      lp.connect(master);
    } else {
      g.connect(master);
    }
    osc.start(start);
    osc.stop(end + 0.02);
  }
  return true;
}
