// Montauk Point, stylised and roughly to scale.
// Frame: +x east (the open Atlantic), +z south, -z north (Block Island Sound). The Point is at the origin and
// Long Island's South Fork runs away to the west. Everything here is a pure function of (x, z), so the CPU
// physics, the baked GPU distance field, the terrain mesh and the props all agree about where the water is.
import { clamp, lerp, smooth } from '../../engine/math';

export const LIGHTHOUSE = { x: -150, z: 14 } as const;
export const START = { x: 650, z: 520, h: 0.44 } as const;
export const BUOY = { x: 520, z: -40 } as const;
export interface Rip { x: number; z: number; a: number; b: number; k: number }
/** The Point rip and the reef rip to the northeast, where the ebb meets the easterly and the sea stands up. */
export const RIPS: Rip[] = [{ x: 380, z: 60, a: 480, b: 210, k: 1 }, { x: 900, z: -520, a: 300, b: 140, k: 0.7 }];

function hash2(x: number, z: number): number { const h = Math.sin(x * 127.1 + z * 311.7) * 43758.5453; return h - Math.floor(h); }
export function noise2(x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  return lerp(lerp(hash2(ix, iz), hash2(ix + 1, iz), ux), lerp(hash2(ix, iz + 1), hash2(ix + 1, iz + 1), ux), uz);
}
export function fbm2(x: number, z: number): number {
  let s = 0, a = 0.5;
  for (let i = 0; i < 4; i++) { s += a * noise2(x, z); x = x * 2.03 + 1.7; z = z * 2.03 + 9.2; a *= 0.5; }
  return s;
}

const centerZ = (x: number): number => 40 * Math.sin(x * 0.0011) - 30 * Math.sin(x * 0.0004);
function halfW(x: number, side: number): number {
  const back = -x;
  if (back <= 0) return 0;
  const base = (side < 0 ? 980 : 860) * Math.sqrt(1 - Math.exp(-back / 360));
  const wob = side < 0 ? 0.06 * Math.sin(x * 0.0105 + 0.7) + 0.035 * Math.sin(x * 0.041) : 0.04 * Math.sin(x * 0.0083 + 2.1) + 0.02 * Math.sin(x * 0.033 + 1);
  return base * (1 + wob * smooth(0, 300, back));
}
export const northZ = (x: number): number => centerZ(x) - halfW(x, -1);
export const southZ = (x: number): number => centerZ(x) + halfW(x, 1);
const onLand = (x: number, z: number): boolean => x < 0 && z > northZ(x) && z < southZ(x);

/** Coastline polyline: north shore from the far west to the tip, then the south shore back west. */
export const COAST: [number, number][] = [];
{
  const N = 320;
  for (let k = N; k >= 0; k--) { const x = -7200 * Math.pow(k / N, 2.2); COAST.push([x, northZ(x)]); }
  for (let k = 1; k <= N; k++) { const x = -7200 * Math.pow(k / N, 2.2); COAST.push([x, southZ(x)]); }
}
const SEG_R = 450, BUCKET = 100, BX0 = -7600;
const buckets = new Map<number, number[]>();
for (let i = 0; i < COAST.length - 1; i++) {
  const x0 = Math.min(COAST[i][0], COAST[i + 1][0]), x1 = Math.max(COAST[i][0], COAST[i + 1][0]);
  for (let b = Math.floor((x0 - BX0) / BUCKET); b <= Math.floor((x1 - BX0) / BUCKET); b++) {
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b)!.push(i);
  }
}
function coastDist(x: number, z: number): number {
  let best = SEG_R * SEG_R;
  for (let b = Math.floor((x - SEG_R - BX0) / BUCKET); b <= Math.floor((x + SEG_R - BX0) / BUCKET); b++) {
    const list = buckets.get(b);
    if (!list) continue;
    for (const i of list) {
      const [ax, az] = COAST[i], [bx, bz] = COAST[i + 1];
      const dx = bx - ax, dz = bz - az;
      const t = clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1), 0, 1);
      const ex = ax + dx * t - x, ez = az + dz * t - z;
      best = Math.min(best, ex * ex + ez * ez);
    }
  }
  return Math.sqrt(best);
}
/** Signed metres to the shoreline: positive over water, negative on land. */
export function shoreSDF(x: number, z: number): number {
  if (x < -7100) return -SEG_R;
  const d = coastDist(x, z);
  return onLand(x, z) ? -d : d;
}
export function ripField(x: number, z: number): number {
  let r = 0;
  for (const R of RIPS) { const qx = (x - R.x) / R.a, qz = (z - R.z) / R.b; r = Math.max(r, R.k * Math.exp(-(qx * qx + qz * qz))); }
  return r;
}
/** GPU twin of ripField: the rips make the sea bigger and foamier. */
export const SEA_GLSL = /* glsl */`
float ripField(vec2 p) {
  vec2 a = (p - vec2(380.0, 60.0)) / vec2(480.0, 210.0);
  vec2 b = (p - vec2(900.0, -520.0)) / vec2(300.0, 140.0);
  return max(exp(-dot(a, a)), 0.7 * exp(-dot(b, b)));
}
float seaMul(vec2 p) { return 1.0 + 0.6 * ripField(p); }
float seaFoam(vec2 p) { return 0.3 * ripField(p); }
`;
/** The ebb sets east-southeast off the Point, hardest in the rips. */
export function tide(x: number, z: number, out: { x: number; z: number }): { x: number; z: number } {
  const s = (0.22 + 0.75 * ripField(x, z)) * smooth(0, 80, shoreSDF(x, z));
  out.x = s * 0.95; out.z = s * 0.3;
  return out;
}
export function terrainH(x: number, z: number, d: number): number {
  if (d >= 0) {
    const h = -0.5 - d * 0.075 + (fbm2(x * 0.02, z * 0.02) - 0.5) * 2.4 * smooth(0, 60, d);
    return Math.max(h, -26);
  }
  const s = -d, back = Math.max(0, -x);
  const turtle = 11 * Math.exp(-((x - LIGHTHOUSE.x) ** 2 + (z - LIGHTHOUSE.z) ** 2) / (2 * 110 * 110));
  const bluff = lerp(6, 15 + 9 * fbm2(x * 0.0025 + 3, z * 0.0025), smooth(80, 420, back)) + turtle;
  let h = 0.2 + smooth(0, 9, s) * 1.4 + smooth(9, 22, s) * (bluff - 1.6);
  h += smooth(22, 110, s) * (fbm2(x * 0.007, z * 0.007) - 0.5) * 8;
  return h;
}
