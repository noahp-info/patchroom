import { GAIN_MAX } from '../components/prefs/ipc.ts';

/** Where a file sound's level sits at master 100% and event 100%: matched to the generated packs. */
export const FILE_BASE = 0.8;
/** Where the oscillator packs sit at master 100% and event 100%. */
export const SYNTH_BASE = 0.6;
/** Bundled files are leveled to peak at -2.5 dBFS (0.75) or lower. Used when a file reports none. */
export const DEFAULT_PEAK = 0.75;

/** An event gain as stored: a 0 to 1.5 multiplier, 1 when absent or not a number. */
export function eventGain(g: number | undefined): number {
  return typeof g === 'number' && Number.isFinite(g) ? Math.min(GAIN_MAX, Math.max(0, g)) : 1;
}

export interface LevelIn {
  /** The master volume, 0 to 1. */
  master: number;
  /** The event's own gain, 0 to 1.5. */
  event: number;
  /** The sound's normalizing gain (imported files). 1 for bundled sounds. */
  norm?: number;
  /** Where the sound sits at unity, `FILE_BASE` or `SYNTH_BASE`. */
  base: number;
  /** The loudest sample of the sound after its normalizing gain, linear (0 to 1]. */
  peak?: number;
}

/**
 * The gain a sound plays at: master x event x normalizing gain x base, held so the loudest
 * sample (peak x the gain, with the peak taken after normalizing) cannot pass full scale. Raising an event above 100% can never push the output
 * past that ceiling. The clamp never lowers a sound below its level at event 100%.
 */
export function effectiveGain(i: LevelIn): number {
  const master = Math.min(1, Math.max(0, i.master));
  const norm = Math.max(0, i.norm ?? 1);
  const peak = Math.min(1, Math.max(0.05, i.peak ?? DEFAULT_PEAK));
  const unity = master * norm * i.base;
  const want = unity * eventGain(i.event);
  // After its normalizing gain the sound peaks at `peak`, so master x event x base may reach 1 / peak.
  return Math.min(want, Math.max(norm / peak, unity));
}
