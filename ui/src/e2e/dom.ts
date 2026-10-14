// Real DOM events for the e2e runner. Each helper dispatches the same events a user's hands would
// raise on the real control, so the app's own handlers run. Nothing here calls app code directly.

const EVT = { bubbles: true, cancelable: true, composed: true } as const;

function pointer(el: Element, type: string): void {
  const r = el.getBoundingClientRect();
  const init = { ...EVT, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
  el.dispatchEvent(new PointerEvent(type, { ...init, pointerId: 1, pointerType: 'mouse' }));
}

/** pointerdown, mousedown, pointerup, mouseup, click: a full mouse click on `el`. */
export function click(el: Element): void {
  if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) {
    if (el.disabled) throw new Error(`click: ${describe(el)} is disabled`);
  }
  pointer(el, 'pointerdown');
  el.dispatchEvent(new MouseEvent('mousedown', EVT));
  pointer(el, 'pointerup');
  el.dispatchEvent(new MouseEvent('mouseup', EVT));
  el.dispatchEvent(new MouseEvent('click', { ...EVT, button: 0 }));
}

export function describe(el: Element): string {
  const id = el.id ? `#${el.id}` : '';
  const cls =
    typeof el.className === 'string' && el.className ? `.${el.className.split(' ')[0]}` : '';
  const label = el.getAttribute('aria-label');
  return `<${el.tagName.toLowerCase()}${id}${cls}${label ? ` aria-label="${label}"` : ''}>`;
}

/** Set a controlled input's value the way typing does, so React sees the change. */
export function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const set = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
  if (!set) throw new Error('no native value setter');
  set.call(el, value);
}

interface KeySpec {
  key: string;
  code: string;
  keyCode: number;
}

const NAMED: Record<string, KeySpec> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  ' ': { key: ' ', code: 'Space', keyCode: 32 },
};

export function keySpec(key: string): KeySpec {
  const named = NAMED[key];
  if (named) return named;
  if (key.length !== 1) throw new Error(`unknown key ${key}`);
  const up = key.toUpperCase();
  if (/[0-9]/.test(key)) return { key, code: `Digit${key}`, keyCode: key.charCodeAt(0) };
  if (/[a-z]/i.test(key)) return { key, code: `Key${up}`, keyCode: up.charCodeAt(0) };
  return { key, code: '', keyCode: key.charCodeAt(0) };
}

export interface Mods {
  meta?: boolean;
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
}

/** keydown then keyup on `target`. Returns false when a handler called preventDefault. */
export function press(target: EventTarget, key: string, mods: Mods = {}): boolean {
  const k = keySpec(key);
  const init: KeyboardEventInit = {
    ...EVT,
    key: k.key,
    code: k.code,
    metaKey: mods.meta ?? false,
    shiftKey: mods.shift ?? false,
    ctrlKey: mods.ctrl ?? false,
    altKey: mods.alt ?? false,
  };
  // keyCode is read-only on the constructor's init in some engines; define it on the event.
  const down = new KeyboardEvent('keydown', init);
  Object.defineProperty(down, 'keyCode', { get: () => k.keyCode });
  Object.defineProperty(down, 'which', { get: () => k.keyCode });
  const notCancelled = target.dispatchEvent(down);
  const up = new KeyboardEvent('keyup', init);
  Object.defineProperty(up, 'keyCode', { get: () => k.keyCode });
  target.dispatchEvent(up);
  return notCancelled;
}

/** Type `text` into a controlled input or textarea, one character per input event. */
export function typeInto(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  // preventScroll: the browser would otherwise scroll the log to reveal the field, which is a
  // real scroll away from the bottom. The runner types where a user already is looking.
  el.focus({ preventScroll: true });
  for (const ch of text) {
    if (ch === '\n') {
      press(el, 'Enter', { shift: true });
      setValue(el, el.value + '\n');
      el.dispatchEvent(
        new InputEvent('input', { ...EVT, inputType: 'insertLineBreak', data: null }),
      );
      continue;
    }
    press(el, ch);
    setValue(el, el.value + ch);
    el.dispatchEvent(new InputEvent('input', { ...EVT, inputType: 'insertText', data: ch }));
  }
}

/** Visible text of an element, whitespace collapsed. */
export function textOf(el: Element | null): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}
