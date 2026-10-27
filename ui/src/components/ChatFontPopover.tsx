import type { Prefs } from '../ipc';
import {
  areaInfo,
  effectiveFont,
  setOverride,
  type FontChoice,
  type FontPrefs,
} from '../theme/typeface';
import type { BaseId } from '../theme/types';
import { Floating, type Anchor } from './Floating';
import { FontChooser } from './FontPicker';

/**
 * "Chat font..." from a section's or a session's sidebar menu: its own chat family and size,
 * over Settings > Themes > Fonts > Chat messages. Changes apply at once; Reset drops the
 * override. A session without one follows its section's.
 */
export function ChatFontPopover({
  anchor,
  kind,
  id,
  name,
  sectionId,
  prefs,
  onSave,
  onClose,
}: {
  anchor: Anchor;
  kind: 'perSection' | 'perSession';
  id: string;
  name: string;
  /** For a session: its section, whose override it inherits. */
  sectionId?: string | null;
  prefs: Prefs | null;
  onSave(fonts: FontPrefs): void;
  onClose(): void;
}) {
  const fonts: FontPrefs = prefs?.fonts ?? {};
  const base = (prefs?.base ?? 'homeroom') as BaseId;
  const own: FontChoice = fonts[kind]?.[id] ?? {};
  const global = effectiveFont(fonts, 'chat', base);
  const fromSection = kind === 'perSession' && sectionId ? fonts.perSection?.[sectionId] : null;
  const inheritedFamily = fromSection?.family ?? global.family;
  const inheritedSize = fromSection?.size ?? global.size;
  const from = fromSection ? 'section' : 'Settings';
  const put = (patch: FontChoice) => onSave(setOverride(fonts, kind, id, { ...own, ...patch }));
  const sizes = [...new Set([...areaInfo('chat').sizes, ...(own.size ? [own.size] : [])])].sort(
    (a, b) => a - b,
  );
  const label = `Chat font for ${name}`;
  return (
    <Floating anchor={anchor} onClose={onClose} label={label} className="flist cfont">
      <div className="cfont__head">
        <span className="cfont__title">{label}</span>
        <div className="cfont__row">
          <select
            aria-label={`Chat size for ${name}`}
            data-testid="chat-font-size"
            value={own.size ? String(own.size) : ''}
            onChange={(e) => put({ size: Number(e.target.value) || undefined })}
          >
            <option value="">
              {inheritedSize} px, from {from}
            </option>
            {sizes.map((s) => (
              <option key={s} value={s}>
                {s} px
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn sec"
            data-testid="chat-font-reset"
            disabled={!own.family && !own.size}
            onClick={() => onSave(setOverride(fonts, kind, id, {}))}
          >
            Reset
          </button>
        </div>
      </div>
      <FontChooser
        label={label}
        mono={false}
        value={own.family}
        inherited={inheritedFamily}
        onPick={(family) => put({ family })}
      />
    </Floating>
  );
}
