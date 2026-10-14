import { GAIN_MAX } from '../ipc.ts';

/** Percent steps of the slider. 5 keeps the arrow keys useful and 100 reachable. */
const STEP = 0.05;

/**
 * One event's own volume, 0 to 150 percent, on top of the master volume. The readout shows the
 * percent; the slider's value text says it the same way for a screen reader.
 */
export function GainSlider(props: {
  /** The accessible name, e.g. "Needs you volume". */
  label: string;
  /** 0 to 1.5 */
  value: number;
  disabled?: boolean;
  onChange(gain: number): void;
}) {
  const pct = Math.round(props.value * 100);
  return (
    <span className="gain">
      <input
        type="range"
        min={0}
        max={GAIN_MAX}
        step={STEP}
        aria-label={props.label}
        aria-valuetext={`${pct} percent`}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
      <output className="gain__out" aria-hidden="true">
        {pct}%
      </output>
    </span>
  );
}
