// Keyboard + touch input shared by the games: held keys, hold-to-press buttons and vertical levers.
import { clamp } from '../engine/math';

export interface Input {
  /** True while a keyboard key (KeyboardEvent.code) or a touch button with that id is held. */
  held(...ids: string[]): boolean;
  keys: Record<string, boolean>;
  touch: Record<string, boolean>;
}

const BLOCK_SCROLL = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

/**
 * Track held keys and wire every `[data-k]` button under `root` as a hold button.
 * `onPress` fires on key-down (no repeats) and on touch press, with the key code or the button id.
 */
export function createInput(root: HTMLElement, signal: AbortSignal, onPress: (id: string) => void): Input {
  const keys: Record<string, boolean> = {};
  const touch: Record<string, boolean> = {};
  addEventListener('keydown', e => {
    if (BLOCK_SCROLL.has(e.code)) e.preventDefault();
    if (e.repeat) return;
    keys[e.code] = true;
    onPress(e.code);
  }, { signal });
  addEventListener('keyup', e => { keys[e.code] = false; }, { signal });
  addEventListener('blur', () => {
    for (const k in keys) keys[k] = false;
    for (const k in touch) touch[k] = false;
  }, { signal });
  root.querySelectorAll<HTMLButtonElement>('[data-k]').forEach(b => {
    const k = b.dataset.k!;
    const up = (): void => { touch[k] = false; b.classList.remove('on'); };
    b.addEventListener('pointerdown', e => {
      e.preventDefault();
      b.setPointerCapture(e.pointerId);
      touch[k] = true;
      b.classList.add('on');
      onPress(k);
    }, { signal });
    b.addEventListener('pointerup', up, { signal });
    b.addEventListener('pointercancel', up, { signal });
    b.addEventListener('lostpointercapture', up, { signal });
    b.addEventListener('contextmenu', e => e.preventDefault(), { signal });
  });
  return {
    keys, touch,
    held: (...ids) => ids.some(id => keys[id] || touch[id]),
  };
}

const PAD = 18;

export interface Lever {
  /** Reflect a value driven elsewhere (keyboard); ignored while a finger is on the lever. */
  set(v: number): void;
  readonly active: boolean;
}

/**
 * A vertical lever (throttle, sail). Drag anywhere on the track; it snaps to `detent` when close.
 * Markup: .lever > .lever-track > (.lever-fill, .lever-mark?, .lever-knob)
 */
export function createLever(el: HTMLElement, opts: { min: number; max: number; detent?: number; format: (v: number) => string }, signal: AbortSignal, onChange: (v: number) => void): Lever {
  const track = el.querySelector<HTMLElement>('.lever-track')!;
  const fill = el.querySelector<HTMLElement>('.lever-fill')!;
  const knob = el.querySelector<HTMLElement>('.lever-knob')!;
  const mark = el.querySelector<HTMLElement>('.lever-mark');
  const { min, max, detent } = opts;
  const frac = (v: number): number => (v - min) / (max - min);
  let active = false;
  let value = detent ?? min;
  // positions run between the knob's half-height insets so the knob never clips at either end
  const at = (f: number): string => `calc(${PAD}px + ${(1 - f).toFixed(4)} * (100% - ${PAD * 2}px))`;
  const atBottom = (f: number): string => `calc(${PAD}px + ${f.toFixed(4)} * (100% - ${PAD * 2}px))`;
  if (mark && detent !== undefined) mark.style.top = at(frac(detent));
  const draw = (v: number): void => {
    const f = frac(v), base = frac(detent ?? min);
    knob.style.top = at(f);
    knob.textContent = opts.format(v);
    fill.style.top = at(Math.max(f, base));
    fill.style.bottom = atBottom(Math.min(f, base));
    el.setAttribute('aria-valuenow', String(Math.round(v * 100)));
    el.setAttribute('aria-valuetext', opts.format(v));
  };
  const fromPointer = (e: PointerEvent): void => {
    const r = track.getBoundingClientRect();
    let v = min + (1 - clamp((e.clientY - r.top - PAD) / (r.height - PAD * 2), 0, 1)) * (max - min);
    if (detent !== undefined && Math.abs(v - detent) < (max - min) * 0.04) v = detent;
    value = v;
    draw(v);
    onChange(v);
  };
  el.addEventListener('pointerdown', e => { e.preventDefault(); el.setPointerCapture(e.pointerId); active = true; fromPointer(e); }, { signal });
  el.addEventListener('pointermove', e => { if (active) fromPointer(e); }, { signal });
  const end = (): void => { active = false; };
  el.addEventListener('pointerup', end, { signal });
  el.addEventListener('pointercancel', end, { signal });
  el.addEventListener('lostpointercapture', end, { signal });
  el.addEventListener('keydown', e => {
    const step = (max - min) * 0.05;
    if (e.key === 'ArrowUp') value = clamp(value + step, min, max);
    else if (e.key === 'ArrowDown') value = clamp(value - step, min, max);
    else return;
    e.preventDefault();
    e.stopPropagation();
    draw(value);
    onChange(value);
  }, { signal });
  draw(value);
  return {
    set(v: number) { if (active || Math.abs(v - value) < 1e-4) return; value = v; draw(v); },
    get active() { return active; },
  };
}

/** Stop iOS Safari's pinch and double-tap zoom while a game is on screen. */
export function blockPageZoom(signal: AbortSignal): void {
  const stop = (e: Event): void => e.preventDefault();
  document.addEventListener('gesturestart', stop, { signal });
  document.addEventListener('gesturechange', stop, { signal });
  document.addEventListener('dblclick', stop, { signal });
  document.addEventListener('touchmove', e => { if (e.touches.length > 1) e.preventDefault(); }, { signal, passive: false });
}

/** A toast that pops a headline with an optional sub-line, then hides itself. */
export function createToast(el: HTMLElement): { show(msg: string, sub?: string, bad?: boolean): void; tick(dt: number): void } {
  let timer = 0;
  return {
    show(msg, sub = '', bad = false) {
      el.replaceChildren(msg);
      if (sub) { const s = document.createElement('small'); s.textContent = sub; el.append(s); }
      el.classList.toggle('bad', bad);
      el.classList.add('show');
      timer = sub ? 2.6 : 1.8;
    },
    tick(dt) {
      if (timer <= 0) return;
      timer -= dt;
      if (timer <= 0) el.classList.remove('show');
    },
  };
}
