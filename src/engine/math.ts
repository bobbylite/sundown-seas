export const TAU = Math.PI * 2;
export const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const damp = (a: number, b: number, l: number, dt: number): number => lerp(a, b, 1 - Math.exp(-l * dt));
export const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
export const dampAngle = (a: number, b: number, l: number, dt: number): number => a + wrap(b - a) * (1 - Math.exp(-l * dt));
export const smooth = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const rand = (a: number, b: number): number => a + Math.random() * (b - a);

export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function lgamma(x: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(TAU) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

export const reduceMotion = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;
/** Phones and tablets: a coarse pointer and no hover. */
export const isTouchDevice = (): boolean => matchMedia('(pointer: coarse)').matches;
