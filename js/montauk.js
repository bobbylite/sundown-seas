// Montauk Rips: troll the rips off Montauk Point in a little toon sportfisher, fight fish on rod and reel,
// take the seas at the right angle, and keep the cockpit from filling faster than the scuppers can drain it.
import { THREE, createEngine, TAU, clamp, lerp, damp, wrap, dampAngle, smooth, rand, reduceMotion } from './engine.js';
import { createSound, bindSoundButton } from './audio.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ================================================================ geography
// Frame: +x east (the open Atlantic), +z south, -z north (Block Island Sound). Montauk Point is at the
// origin and Long Island's South Fork runs away to the west. Stylised, roughly to scale.
const LIGHTHOUSE = { x: -150, z: 14 };
const START = { x: 650, z: 520, h: 0.44 };
const RIPS = [{ x: 380, z: 60, a: 480, b: 210, k: 1 }, { x: 900, z: -520, a: 300, b: 140, k: 0.7 }];
const BUOY = { x: 520, z: -40 };

function hash2(x, z) { const h = Math.sin(x * 127.1 + z * 311.7) * 43758.5453; return h - Math.floor(h); }
function noise2(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  return lerp(lerp(hash2(ix, iz), hash2(ix + 1, iz), ux), lerp(hash2(ix, iz + 1), hash2(ix + 1, iz + 1), ux), uz);
}
function fbm2(x, z) { let s = 0, a = 0.5; for (let i = 0; i < 4; i++) { s += a * noise2(x, z); x = x * 2.03 + 1.7; z = z * 2.03 + 9.2; a *= 0.5; } return s; }

const centerZ = x => 40 * Math.sin(x * 0.0011) - 30 * Math.sin(x * 0.0004);
function halfW(x, side) {
  const back = -x;
  if (back <= 0) return 0;
  const base = (side < 0 ? 980 : 860) * Math.sqrt(1 - Math.exp(-back / 360));
  const wob = side < 0 ? 0.06 * Math.sin(x * 0.0105 + 0.7) + 0.035 * Math.sin(x * 0.041) : 0.04 * Math.sin(x * 0.0083 + 2.1) + 0.02 * Math.sin(x * 0.033 + 1);
  return base * (1 + wob * smooth(0, 300, back));
}
const northZ = x => centerZ(x) - halfW(x, -1);
const southZ = x => centerZ(x) + halfW(x, 1);
const onLand = (x, z) => x < 0 && z > northZ(x) && z < southZ(x);

// coastline polyline (north shore west->tip, then south shore tip->west), bucketed by x for fast distance queries
const COAST = [];
{
  const N = 320;
  for (let k = N; k >= 0; k--) { const x = -7200 * Math.pow(k / N, 2.2); COAST.push([x, northZ(x)]); }
  for (let k = 1; k <= N; k++) { const x = -7200 * Math.pow(k / N, 2.2); COAST.push([x, southZ(x)]); }
}
const SEG_R = 450, BUCKET = 100, BX0 = -7600;
const buckets = new Map();
for (let i = 0; i < COAST.length - 1; i++) {
  const x0 = Math.min(COAST[i][0], COAST[i + 1][0]), x1 = Math.max(COAST[i][0], COAST[i + 1][0]);
  for (let b = Math.floor((x0 - BX0) / BUCKET); b <= Math.floor((x1 - BX0) / BUCKET); b++) {
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(i);
  }
}
function coastDist(x, z) {
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
function shoreSDF(x, z) {
  if (x < -7100) return -SEG_R;
  const d = coastDist(x, z);
  return onLand(x, z) ? -d : d;
}
/** The Point rip and the reef rip to the northeast, where the ebb meets the easterly and the sea stands up. */
function ripField(x, z) {
  let r = 0;
  for (const R of RIPS) { const qx = (x - R.x) / R.a, qz = (z - R.z) / R.b; r = Math.max(r, R.k * Math.exp(-(qx * qx + qz * qz))); }
  return r;
}
const SEA_GLSL = /* glsl */`
float ripField(vec2 p) {
  vec2 a = (p - vec2(380.0, 60.0)) / vec2(480.0, 210.0);
  vec2 b = (p - vec2(900.0, -520.0)) / vec2(300.0, 140.0);
  return max(exp(-dot(a, a)), 0.7 * exp(-dot(b, b)));
}
float seaMul(vec2 p) { return 1.0 + 0.6 * ripField(p); }
float seaFoam(vec2 p) { return 0.3 * ripField(p); }
`;
/** The ebb sets east-southeast off the Point, hardest in the rips. */
function tide(x, z, out) {
  const s = (0.22 + 0.75 * ripField(x, z)) * smooth(0, 80, shoreSDF(x, z));
  out.x = s * 0.95; out.z = s * 0.3;
  return out;
}
function terrainH(x, z, d) {
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

// ================================================================ tiers
const TIERS = [
  { name: 'Deckhand', blurb: 'Big freeing ports clear the cockpit fast and the sea is moderate. Fish tire quickly.', scupper: 0.034, cap: 4.6, sea: 0.9, fish: 0.85, score: 0.8 },
  { name: 'Mate', blurb: 'Stock scuppers: a cockpit full of water takes a minute or more to clear. A fair sea.', scupper: 0.02, cap: 3.9, sea: 1.0, fish: 1.0, score: 1 },
  { name: 'Captain', blurb: 'Half-clogged scuppers and a building sea. One bad wave on the beam puts you in trouble.', scupper: 0.012, cap: 3.3, sea: 1.12, fish: 1.15, score: 1.4 },
  { name: 'Legend', blurb: 'Clogged scuppers, the biggest sea and the hardest fish. Every wave counts.', scupper: 0.007, cap: 2.8, sea: 1.25, fish: 1.3, score: 2 },
];
let tier = TIERS[1];

const SPECIES = {
  striper: { name: 'Striped Bass', lb: [14, 45], value: 1.0, power: 1.0, speed: 2.4, endurance: 1.0, jump: 0.12, bite: 1.0, sound: 0.35, depth: 14, len: 1.32 },
  bluefish: { name: 'Bluefish', lb: [6, 18], value: 0.9, power: 0.95, speed: 3.0, endurance: 0.8, jump: 0.5, bite: 1.4, sound: 0.1, depth: 8, len: 1.35, teeth: true },
  albie: { name: 'False Albacore', lb: [8, 16], value: 1.4, power: 1.15, speed: 5.2, endurance: 1.1, jump: 0.0, bite: 0.9, sound: 0.25, depth: 18, len: 1.15 },
  bluefin: { name: 'Bluefin Tuna', lb: [70, 240], value: 1.7, power: 1.5, speed: 4.6, endurance: 2.4, jump: 0.0, bite: 0.6, sound: 0.55, depth: 45, len: 1.2 },
};

// ================================================================ engine
const canvas = document.getElementById('scene');
const E = createEngine({
  canvas,
  sunDir: new THREE.Vector3(-0.93, 0.07, -0.36),
  sky: {
    horizonSun: [1.0, 0.64, 0.34], horizonAway: [0.78, 0.6, 0.68], midSun: [0.98, 0.6, 0.46], midAway: [0.5, 0.5, 0.72],
    zenith: [0.2, 0.26, 0.52], cloudSun: [1.0, 0.82, 0.52], cloudAway: [1.0, 0.64, 0.6], cloudDark: [0.44, 0.32, 0.48],
  },
  ocean: { windSpeed: 9, fetch: 150000, dir: Math.atan2(-0.34, -0.94), amp: 1.3, chop: 1.15, swell: 0.6, swellAngle: 0.45, swellLength: 110, foamBias: 2.6, foamScale: 1.8, seed: 7111 },
  water: { deep: [0.02, 0.16, 0.25], deepGain: 1.15, sss: [0.1, 0.62, 0.5] },
  shore: { fn: shoreSDF, cx: -900, cz: 0, size: 6400, res: 400 },
  seaGLSL: SEA_GLSL,
  skyline: [[-1.0, 35, 420], [-1.2, 25, 380], [-1.45, 45, 500], [-1.84, 60, 300]],
  skylineColor: [0.36, 0.3, 0.46],
  hull: [1.45, 3.9, 3.4],
  probes: 32,
  fog: { color: '#e9a27f', density: 0.00026 },
  hemi: [0xc8b0e0, 0x1f5a66],
  sunColor: 0xffb070,
});
const { scene, camera, toon, addOutline, canvasTex, addLayers, emit, Probe, Sim, L_REFLECT, L_REFRACT, SUN_YAW } = E;
const WAVE_DIR = E.waveDir; // direction the waves travel (x, z)
const PR = { center: 0, rail: 1, lure: 10, fish: 14, buoy: 15, ai: 16, school: 18 };

// ================================================================ land
const LAND_COL = {
  seabed: new THREE.Color('#c9b98d'), rockbed: new THREE.Color('#8a8190'), sand: new THREE.Color('#ecd8a6'),
  clay: new THREE.Color('#c99a62'), clayDark: new THREE.Color('#a8774a'), grass: new THREE.Color('#a9b96a'),
  scrub: new THREE.Color('#6f8f4e'), heath: new THREE.Color('#9a7f6e'),
};
{
  const NX = 360, NZ = 300;
  const xs = [], zs = [];
  for (let i = 0; i <= NX; i++) xs.push(360 - 5200 * Math.pow(i / NX, 1.7));
  for (let j = 0; j <= NZ; j++) zs.push(-1400 + 2750 * j / NZ);
  const pos = new Float32Array((NX + 1) * (NZ + 1) * 3), col = new Float32Array((NX + 1) * (NZ + 1) * 3), ds = new Float32Array((NX + 1) * (NZ + 1));
  const c = new THREE.Color();
  let p = 0;
  for (let j = 0; j <= NZ; j++) for (let i = 0; i <= NX; i++) {
    const x = xs[i], z = zs[j], d = shoreSDF(x, z), h = terrainH(x, z, d);
    const k = j * (NX + 1) + i;
    ds[k] = d;
    pos[p] = x; pos[p + 1] = h; pos[p + 2] = z;
    if (d >= 0) {
      c.copy(LAND_COL.seabed).lerp(LAND_COL.rockbed, smooth(0.55, 0.75, noise2(x * 0.03, z * 0.03)) * (1 - smooth(200, 500, -x + Math.abs(z))));
    } else {
      const s = -d;
      if (s < 9) c.copy(LAND_COL.sand);
      else if (s < 24) c.copy(LAND_COL.clay).lerp(LAND_COL.clayDark, 0.5 + 0.5 * Math.sin(h * 1.7 + noise2(x * 0.05, z * 0.05) * 2));
      else {
        c.copy(LAND_COL.grass).lerp(LAND_COL.scrub, smooth(0.45, 0.7, fbm2(x * 0.012, z * 0.012)));
        c.lerp(LAND_COL.heath, smooth(0.62, 0.8, noise2(x * 0.004 + 9, z * 0.004)) * 0.7);
      }
    }
    col[p] = c.r; col[p + 1] = c.g; col[p + 2] = c.b;
    p += 3;
  }
  const idx = [];
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
    const a = j * (NX + 1) + i, b = a + 1, cc = a + NX + 1, d = cc + 1;
    if (Math.min(ds[a], ds[b], ds[cc], ds[d]) > 240) continue;
    idx.push(a, b, cc, b, d, cc);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const land = new THREE.Mesh(g, toon('#ffffff', { vertexColors: true, rim: 0.25 }));
  land.frustumCulled = false;
  scene.add(land);
  addLayers(land, L_REFLECT, L_REFRACT);
}

// rocks around the Point, scrub on the downs, and a few shingled houses along the bluffs
{
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  const rocks = new THREE.InstancedMesh(rockGeo, toon('#857c88', { flatShading: true, rim: 0.3 }), 110);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), ps = new THREE.Vector3(), eu = new THREE.Euler();
  let n = 0;
  for (const [x, z] of COAST) {
    if (x < -420 || n >= 110) continue;
    for (let k = 0; k < 3 && n < 110; k++) {
      const ox = x + rand(-10, 16), oz = z + rand(-12, 12);
      const d = shoreSDF(ox, oz);
      if (d < -6 || d > 22) continue;
      const s = rand(1.4, 3.6);
      ps.set(ox, terrainH(ox, oz, d) + s * 0.25, oz);
      q.setFromEuler(eu.set(rand(0, 3), rand(0, 3), rand(0, 3)));
      sc.set(s, s * rand(0.6, 0.9), s * rand(0.8, 1.2));
      rocks.setMatrixAt(n++, m.compose(ps, q, sc));
    }
  }
  rocks.count = n;
  rocks.frustumCulled = false;
  scene.add(rocks);
  addLayers(rocks, L_REFLECT, L_REFRACT);

  const scrub = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), toon('#5d7c45', { rim: 0.35 }), 520);
  n = 0;
  for (let tries = 0; tries < 6000 && n < 520; tries++) {
    const x = rand(-3200, -40), z = rand(-1100, 1000);
    const d = shoreSDF(x, z);
    if (d > -30 || Math.hypot(x - LIGHTHOUSE.x, z - LIGHTHOUSE.z) < 45) continue;
    if (fbm2(x * 0.012, z * 0.012) < 0.48) continue;
    const s = rand(2, 5.5);
    ps.set(x, terrainH(x, z, d) + s * 0.3, z);
    q.identity();
    sc.set(s * rand(0.9, 1.4), s * rand(0.6, 0.9), s * rand(0.9, 1.4));
    scrub.setMatrixAt(n++, m.compose(ps, q, sc));
  }
  scrub.count = n;
  scrub.frustumCulled = false;
  scene.add(scrub);
  addLayers(scrub, L_REFLECT);

  const shingle = toon('#a29d96', { rim: 0.3 }), trim = toon('#f6f1e8'), roofMat = toon('#5b5a63');
  const roofShape = new THREE.Shape([new THREE.Vector2(-1, 0), new THREE.Vector2(1, 0), new THREE.Vector2(0, 0.75)]);
  const roofGeo = new THREE.ExtrudeGeometry(roofShape, { depth: 1, bevelEnabled: false });
  roofGeo.translate(0, 0, -0.5);
  let placed = 0;
  for (let tries = 0; tries < 400 && placed < 16; tries++) {
    const x = rand(-3400, -700), side = Math.random() < 0.65 ? 1 : -1;
    const z = side > 0 ? southZ(x) - rand(45, 140) : northZ(x) + rand(45, 140);
    const d = shoreSDF(x, z);
    if (d > -35) continue;
    const g = new THREE.Group();
    const w = rand(9, 14), dep = rand(7, 10), hgt = rand(5, 7);
    const box = new THREE.Mesh(new THREE.BoxGeometry(w, hgt, dep), shingle);
    box.position.y = hgt / 2;
    addOutline(box, 0.12);
    const roof = new THREE.Mesh(roofGeo, roofMat);
    roof.scale.set(w / 2 + 0.6, hgt * 0.75, dep + 0.8);
    roof.position.y = hgt;
    addOutline(roof, 0.12);
    const band = new THREE.Mesh(new THREE.BoxGeometry(w + 0.2, 0.4, dep + 0.2), trim);
    band.position.y = hgt - 0.2;
    g.add(box, roof, band);
    g.position.set(x, terrainH(x, z, d) - 0.5, z);
    g.rotation.y = rand(-0.3, 0.3) + (side > 0 ? 0 : Math.PI);
    scene.add(g);
    addLayers(g, L_REFLECT);
    placed++;
  }
}

// Montauk Point Light: an octagonal sandstone tower, white with its brown band, and the keeper's house beside it
let lighthouseBeam;
{
  const lh = new THREE.Group();
  const baseY = terrainH(LIGHTHOUSE.x, LIGHTHOUSE.z, shoreSDF(LIGHTHOUSE.x, LIGHTHOUSE.z)) - 0.5;
  lh.position.set(LIGHTHOUSE.x, baseY, LIGHTHOUSE.z);
  lh.scale.setScalar(1.7);
  const white = toon('#f6f0e4', { rim: 0.5 }), brown = toon('#7b4a32', { rim: 0.5 }), dark = toon('#2e2a33');
  const segs = [[0, 9, 4.0, 3.3, white], [9, 7, 3.3, 2.8, brown], [16, 7, 2.8, 2.4, white]];
  for (const [y, h, rb, rt, mat] of segs) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, 8), mat);
    m.position.y = y + h / 2;
    addOutline(m, 0.12);
    lh.add(m);
  }
  const deck = new THREE.Mesh(new THREE.CylinderGeometry(3.1, 3.1, 0.5, 8), dark);
  deck.position.y = 23.25;
  addOutline(deck, 0.08);
  const lantern = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.7, 2.4, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 3.6, 1.6) }));
  lantern.position.y = 24.7;
  const roof = new THREE.Mesh(new THREE.ConeGeometry(2.1, 1.6, 8), toon('#5a2f2a'));
  roof.position.y = 26.7;
  addOutline(roof, 0.08);
  const vent = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 8), dark);
  vent.position.y = 27.7;
  lh.add(deck, lantern, roof, vent);
  const house = new THREE.Group();
  const hb = new THREE.Mesh(new THREE.BoxGeometry(10, 6, 7), white);
  hb.position.y = 3;
  addOutline(hb, 0.1);
  const roofShape = new THREE.Shape([new THREE.Vector2(-1, 0), new THREE.Vector2(1, 0), new THREE.Vector2(0, 0.7)]);
  const hr = new THREE.Mesh(new THREE.ExtrudeGeometry(roofShape, { depth: 1, bevelEnabled: false }), toon('#8f3b30'));
  hr.geometry.translate(0, 0, -0.5);
  hr.scale.set(5.6, 4, 7.6);
  hr.position.y = 6;
  addOutline(hr, 0.1);
  const chim = new THREE.Mesh(new THREE.BoxGeometry(0.9, 2.2, 0.9), brown);
  chim.position.set(2.5, 8.2, 0);
  house.add(hb, hr, chim);
  house.position.set(9, 0, 2);
  lh.add(house);
  const beamGeo = new THREE.ConeGeometry(9, 160, 20, 1, true);
  beamGeo.translate(0, -80, 0);
  beamGeo.rotateZ(Math.PI / 2);
  const beamMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    vertexShader: `varying float vL; void main() { vL = length(position) / 160.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying float vL; void main() { gl_FragColor = vec4(vec3(1.0, 0.82, 0.5), (1.0 - vL) * 0.16); }`,
  });
  lighthouseBeam = new THREE.Group();
  const b1 = new THREE.Mesh(beamGeo, beamMat), b2 = new THREE.Mesh(beamGeo, beamMat);
  b2.rotation.y = Math.PI;
  lighthouseBeam.add(b1, b2);
  lighthouseBeam.position.y = 24.7;
  lh.add(lighthouseBeam);
  scene.add(lh);
  addLayers(lh, L_REFLECT);
  lighthouseBeam.traverse(o => o.layers.set(0));
}

// the bell buoy on the Point rip
const buoy = new THREE.Group();
{
  const red = toon('#d8432f', { rim: 0.6 }), dark = toon('#2e2a33');
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.9, 1.4, 12), red);
  body.position.y = 0.3;
  addOutline(body, 0.04);
  const cage = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.55, 1.8, 6, 1, true), toon('#d8432f', { side: THREE.DoubleSide, wireframe: true }));
  cage.position.y = 1.9;
  const bell = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8, 0, TAU, 0, Math.PI / 2), dark);
  bell.position.y = 1.6;
  const plate = canvasTex(128, 64, (g, w, h) => { g.fillStyle = '#d8432f'; g.fillRect(0, 0, w, h); g.fillStyle = '#fff4e4'; g.font = 'bold 44px sans-serif'; g.textAlign = 'center'; g.fillText('"2"', w / 2, 48); });
  const num = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.45), new THREE.MeshBasicMaterial({ map: plate }));
  num.position.set(0, 0.45, 0.83);
  buoy.add(body, cage, bell, num);
  scene.add(buoy);
  addLayers(buoy, L_REFLECT, L_REFRACT);
}

// ================================================================ the boat
const LOA = 7.6, STERN_Z = -3.5;
const sAt = z => clamp((z - STERN_Z) / LOA, 0, 1);
const sheerY = s => 0.82 + 0.15 * s + 0.4 * s * s;
function hullPt(s, t, side) {
  const z = STERN_Z + LOA * s;
  const bowT = Math.max(0, (s - 0.55) / 0.45);
  const halfB = 1.45 * Math.sqrt(Math.max(0, 1 - bowT * bowT)) * (s < 0.15 ? lerp(0.93, 1, s / 0.15) : 1);
  const sheer = sheerY(s);
  const keel = -0.62 + 0.5 * Math.pow(bowT, 2.2);
  const chineY = keel + 0.32 + 0.1 * bowT;
  let x, y;
  if (t < 0.4) { const u = t / 0.4; x = halfB * 0.9 * u; y = keel + (chineY - keel) * Math.pow(u, 1.3); }
  else { const u = (t - 0.4) / 0.6; x = halfB * (0.9 + 0.1 * Math.sin(u * Math.PI / 2)); y = chineY + (sheer - chineY) * u; }
  return [x * side, y, z];
}

function bean(slicker, hat) {
  const g = new THREE.Group();
  const coat = toon(slicker, { rim: 0.5 }), skin = toon('#f2c9a0'), dark = new THREE.MeshBasicMaterial({ color: 0x120a14 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.42, 6, 12), coat);
  body.position.y = 0.45;
  addOutline(body, 0.02);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), skin);
  head.position.y = 0.98;
  addOutline(head, 0.02);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.205, 16, 8, 0, TAU, 0, Math.PI / 2), toon(hat));
  cap.position.y = 1.0;
  const pom = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), toon(hat));
  pom.position.y = 1.22;
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.028, 8, 6), dark);
    eye.position.set(sx * 0.075, 0.99, 0.18);
    g.add(eye);
  }
  const arms = new THREE.Group();
  arms.position.set(0, 0.62, 0.05);
  for (const sx of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.28, 4, 8), coat);
    arm.position.set(sx * 0.21, -0.05, 0.14);
    arm.rotation.x = -1.0;
    arms.add(arm);
  }
  g.add(body, head, cap, pom, arms);
  g.userData.arms = arms;
  return g;
}

function buildSportfisher({ hull = '#f8f4ec', boot = '#1f3b5a', bottom = '#c0392b', accent = '#1f3b5a', name = 'RIP RUNNER', crew = true, rods = true } = {}) {
  const g = new THREE.Group();
  const ref = { group: g, outriggers: [], rods: [] };
  const hullTex = canvasTex(16, 512, (c, w, h) => {
    const row = y => (1 - (y + 0.7) / 2.3) * h;
    const band = (y0, y1, col) => { c.fillStyle = col; c.fillRect(0, row(y1), w, row(y0) - row(y1)); };
    band(-0.7, 1.6, hull); band(-0.7, 0.04, bottom); band(0.04, 0.16, boot); band(0.66, 0.72, accent);
  });
  const ST = 40, SEC = 14, ring = 2 * SEC + 1;
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= ST; i++) {
    const s = i / ST;
    for (let j = 0; j < ring; j++) {
      const t = Math.abs(j - SEC) / SEC, side = j < SEC ? 1 : -1;
      const p = hullPt(s, t, side);
      pos.push(...p);
      uv.push(s, (p[1] + 0.7) / 2.3);
    }
  }
  for (let i = 0; i < ST; i++) for (let j = 0; j < ring - 1; j++) {
    const a = i * ring + j, b = a + 1, c = a + ring, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  // transom: a fan from its centre
  const ci = pos.length / 3;
  pos.push(0, 0.1, STERN_Z); uv.push(0, (0.1 + 0.7) / 2.3);
  for (let j = 0; j < ring - 1; j++) idx.push(ci, j, j + 1);
  const hg = new THREE.BufferGeometry();
  hg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  hg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  hg.setIndex(idx);
  hg.computeVertexNormals();
  const hullMesh = new THREE.Mesh(hg, toon('#ffffff', { map: hullTex, side: THREE.DoubleSide, rim: 0.6 }));
  addOutline(hullMesh, 0.04);
  g.add(hullMesh);

  // cap rail along the sheer and across the transom
  const railPts = [];
  for (let i = 0; i <= 30; i++) { const s = i / 30; const p = hullPt(s, 1, 1); railPts.push(new THREE.Vector3(p[0], p[1] + 0.02, p[2])); }
  for (let i = 29; i >= 0; i--) { const s = i / 30; const p = hullPt(s, 1, -1); railPts.push(new THREE.Vector3(p[0], p[1] + 0.02, p[2])); }
  const rail = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(railPts, true), 180, 0.06, 6, true), toon('#ffffff', { rim: 0.5 }));
  addOutline(rail, 0.02);
  g.add(rail);

  const teak = canvasTex(256, 256, (c, w, h) => {
    c.fillStyle = '#c98f5a'; c.fillRect(0, 0, w, h);
    c.strokeStyle = 'rgba(80,40,20,0.5)'; c.lineWidth = 3;
    for (let x = 0; x <= w; x += 24) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
  });
  const sole = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.08, 4.0), toon('#ffffff', { map: teak }));
  sole.position.set(0, 0.26, -1.42);
  g.add(sole);

  // foredeck follows the sheer
  {
    const outline = [];
    for (let i = 0; i <= 16; i++) { const s = lerp(0.5, 1, i / 16); const p = hullPt(s, 1, 1); outline.push(new THREE.Vector2(p[0] * 0.97, -p[2])); }
    for (let i = 16; i >= 0; i--) { const s = lerp(0.5, 1, i / 16); const p = hullPt(s, 1, -1); outline.push(new THREE.Vector2(p[0] * 0.97, -p[2])); }
    const fg = new THREE.ShapeGeometry(new THREE.Shape(outline));
    fg.rotateX(-Math.PI / 2);
    const fp = fg.attributes.position;
    for (let i = 0; i < fp.count; i++) fp.setY(i, sheerY(sAt(fp.getZ(i))) - 0.01);
    fg.computeVertexNormals();
    g.add(new THREE.Mesh(fg, toon('#efe6d6')));
  }

  // cabin house with a raked windshield, hardtop, helm
  const white = toon('#fbf7ef', { rim: 0.5 });
  const lower = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.72, 2.2), white);
  {
    const lp = lower.geometry.attributes.position;
    for (let i = 0; i < lp.count; i++) if (lp.getZ(i) > 0) lp.setX(i, lp.getX(i) * 0.9);
    lower.geometry.computeVertexNormals();
  }
  lower.position.set(0, 1.36, 1.68);
  addOutline(lower, 0.025);
  const glass = new THREE.Mesh(new THREE.BoxGeometry(2.16, 0.44, 2.0), toon('#24364f', { rim: 0.9 }));
  {
    const gp = glass.geometry.attributes.position;
    for (let i = 0; i < gp.count; i++) {
      if (gp.getY(i) > 0) { gp.setX(i, gp.getX(i) * 0.88); if (gp.getZ(i) > 0) gp.setZ(i, gp.getZ(i) - 0.5); }
      if (gp.getZ(i) > 0) gp.setX(i, gp.getX(i) * 0.9);
    }
    glass.geometry.computeVertexNormals();
  }
  glass.position.set(0, 1.94, 1.58);
  addOutline(glass, 0.02);
  const top = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.1, 3.3), white);
  top.position.set(0, 2.24, 0.8);
  addOutline(top, 0.025);
  g.add(lower, glass, top);
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1.95, 8), white);
    post.position.set(sx * 1.05, 1.25, -0.75);
    g.add(post);
    const whip = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.03, 2.6, 6), white);
    whip.position.set(sx * 1.1, 3.5, -0.7);
    whip.rotation.x = -0.18;
    g.add(whip);
  }
  const dome = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.2, 16), white);
  dome.position.set(0, 2.4, 1.6);
  addOutline(dome, 0.02);
  g.add(dome);
  const helm = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.85, 0.5), white);
  helm.position.set(0.55, 0.72, 0.38);
  addOutline(helm, 0.02);
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.025, 6, 16), toon('#2e2a33'));
  wheel.position.set(0.55, 1.2, 0.1);
  wheel.rotation.x = -0.4;
  g.add(helm, wheel);

  // name board on the transom
  const nameTex = canvasTex(512, 128, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    c.fillStyle = accent; c.textAlign = 'center';
    c.font = 'bold 60px "Grandstander", "Trebuchet MS", sans-serif'; c.fillText(name, w / 2, 62);
    c.font = 'bold 30px "Baloo 2", "Trebuchet MS", sans-serif'; c.fillText('MONTAUK, N.Y.', w / 2, 108);
  });
  const nameBoard = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.48), new THREE.MeshBasicMaterial({ map: nameTex, transparent: true }));
  nameBoard.position.set(0, 0.42, STERN_Z - 0.01);
  nameBoard.rotation.y = Math.PI;
  g.add(nameBoard);

  // fighting chair
  const chairMat = toon('#e9e2d4');
  const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.16, 0.5, 10), chairMat);
  ped.position.set(0, 0.55, -1.9);
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.12, 0.55), toon('#c98f5a'));
  seat.position.set(0, 0.84, -1.9);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.55, 0.1), toon('#c98f5a'));
  back.position.set(0, 1.12, -1.66);
  addOutline(seat, 0.015); addOutline(back, 0.015);
  g.add(ped, seat, back);

  // outriggers: long poles off the hardtop that swing out to spread the lines
  const poleMat = toon('#dfe3e8', { rim: 0.7 });
  for (const sx of [1, -1]) {
    const pivot = new THREE.Group();
    pivot.position.set(sx * 1.15, 2.3, 1.2);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.045, 7.2, 6), poleMat);
    pole.position.y = 3.6;
    pivot.add(pole);
    const spreader = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1.1, 4), poleMat);
    spreader.position.set(0, 2.4, 0);
    spreader.rotation.z = Math.PI / 2;
    pivot.add(spreader);
    const tip = new THREE.Object3D();
    tip.position.y = 7.2;
    pivot.add(tip);
    g.add(pivot);
    ref.outriggers.push({ pivot, tip, side: sx });
  }

  if (rods) {
    const holders = [
      { p: [1.33, sheerY(sAt(-0.9)), -0.9], out: 0.55, aft: 0.65 },
      { p: [-1.33, sheerY(sAt(-0.9)), -0.9], out: 0.55, aft: 0.65 },
      { p: [1.12, sheerY(0.03), -3.25], out: 0.25, aft: 0.95 },
      { p: [-1.12, sheerY(0.03), -3.25], out: 0.25, aft: 0.95 },
    ];
    const rodMat = toon('#1d1f2a', { rim: 0.6 }), reelMat = toon('#ffc35c', { rim: 0.6 });
    for (const hd of holders) {
      const root = new THREE.Group();
      root.position.set(...hd.p);
      root.rotation.set(-hd.aft, 0, -Math.sign(hd.p[0]) * hd.out, 'YXZ');
      g.add(root);
      const reel = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.12, 12), reelMat);
      reel.rotation.z = Math.PI / 2;
      reel.position.y = 0.3;
      root.add(reel);
      const segs = [];
      let parent = root;
      const SEG = 6, segLen = 2.1 / SEG;
      for (let k = 0; k < SEG; k++) {
        const sg = new THREE.Group();
        sg.position.y = k === 0 ? 0 : segLen;
        const r0 = lerp(0.03, 0.008, k / SEG), r1 = lerp(0.03, 0.008, (k + 1) / SEG);
        const piece = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, segLen, 5), rodMat);
        piece.position.y = segLen / 2;
        sg.add(piece);
        parent.add(sg);
        segs.push(sg);
        parent = sg;
      }
      const tip = new THREE.Object3D();
      tip.position.y = segLen;
      parent.add(tip);
      ref.rods.push({ root, segs, tip, holder: new THREE.Vector3(...hd.p) });
    }
  }

  // water standing in the cockpit
  const dw = new THREE.Mesh(new THREE.PlaneGeometry(2.42, 3.9), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.08, 0.32, 0.36), transparent: true, opacity: 0.72, depthWrite: false }));
  dw.rotation.x = -Math.PI / 2;
  dw.position.set(0, 0.3, -1.42);
  dw.visible = false;
  g.add(dw);
  ref.deckWater = dw;

  if (crew) {
    const cap = bean('#ffc83d', '#1f3b5a');
    cap.position.set(0.55, 0.3, -0.2);
    const mate = bean('#ff7a3d', '#e34a3a');
    mate.position.set(-0.55, 0.3, -2.3);
    mate.rotation.y = Math.PI;
    g.add(cap, mate);
    ref.captain = cap; ref.mate = mate;
  }
  addLayers(g, L_REFLECT, L_REFRACT);
  dw.layers.set(0);
  return ref;
}

const boatRef = buildSportfisher({});
const boat = boatRef.group;
scene.add(boat);

// rail sample points (boat frame) for the green-water model; w = metres of rail each one stands for
const RAIL = [
  { p: [0, sheerY(1), 4.05], w: 1.1, kind: 'bow', side: 0 },
  { p: [1.0, sheerY(0.8), 2.6], w: 1.6, kind: 'bow', side: 1 },
  { p: [-1.0, sheerY(0.8), 2.6], w: 1.6, kind: 'bow', side: -1 },
  { p: [1.42, sheerY(0.45), -0.08], w: 2.2, kind: 'beam', side: 1 },
  { p: [-1.42, sheerY(0.45), -0.08], w: 2.2, kind: 'beam', side: -1 },
  { p: [1.3, sheerY(0.12), -2.6], w: 1.8, kind: 'quarter', side: 1 },
  { p: [-1.3, sheerY(0.12), -2.6], w: 1.8, kind: 'quarter', side: -1 },
  { p: [0.6, sheerY(0), -3.5], w: 1.3, kind: 'transom', side: 0 },
  { p: [-0.6, sheerY(0), -3.5], w: 1.3, kind: 'transom', side: 0 },
].map(r => ({ ...r, v: new THREE.Vector3(...r.p), wl: new THREE.Vector3(r.p[0], 0, r.p[2]), w0: new THREE.Vector3(), wl0: new THREE.Vector3(), inflow: 0 }));
// how much of the local chop climbs the topsides, versus being pushed aside by the hull
const LOCAL_CHOP = 0.6;
const DECK_AREA = 9.4, WATERPLANE = 16;

// two other charter boats working the rips
const fleet = [
  { ref: buildSportfisher({ hull: '#e8eef2', boot: '#2a6f8f', bottom: '#2a4f6f', accent: '#2a6f8f', name: 'SEA WOLF', crew: false, rods: false }), cx: 420, cz: 120, r: 160, a: 0, sp: 0.022, y: 0, pitch: 0, roll: 0 },
  { ref: buildSportfisher({ hull: '#f3ead6', boot: '#7a2f2a', bottom: '#5a2420', accent: '#7a2f2a', name: 'SHAGWONG', crew: false, rods: false }), cx: 880, cz: -470, r: 120, a: 2, sp: -0.028, y: 0, pitch: 0, roll: 0 },
];
for (const f of fleet) {
  scene.add(f.ref.group);
  f.ref.outriggers.forEach(o => o.pivot.rotation.set(-0.35, 0, -o.side * 1.05, 'YXZ'));
}

// ================================================================ fish models
function fishTex(kind) {
  return canvasTex(256, 128, (c, w, h) => {
    const grad = c.createLinearGradient(0, 0, w, 0);
    const back = { striper: '#5b6b72', bluefish: '#2f6f7a', albie: '#3f6e5e', bluefin: '#1d2f55' }[kind];
    const belly = '#eef1f2';
    grad.addColorStop(0, belly); grad.addColorStop(0.32, belly); grad.addColorStop(0.45, back); grad.addColorStop(0.55, back); grad.addColorStop(0.68, belly); grad.addColorStop(1, belly);
    c.fillStyle = grad; c.fillRect(0, 0, w, h);
    if (kind === 'striper') { c.fillStyle = 'rgba(30,34,40,0.8)'; for (const u of [0.36, 0.4, 0.6, 0.64, 0.33, 0.67]) c.fillRect(u * w - 2, 10, 4, h - 20); }
    if (kind === 'albie') { c.strokeStyle = 'rgba(20,40,30,0.8)'; c.lineWidth = 3; for (let i = 0; i < 9; i++) { c.beginPath(); c.moveTo(0.42 * w, 20 + i * 11); c.quadraticCurveTo(0.5 * w, 14 + i * 11, 0.58 * w, 20 + i * 11); c.stroke(); } }
    if (kind === 'bluefin') { c.fillStyle = '#ffd34f'; for (let i = 0; i < 7; i++) c.fillRect(0.47 * w, 8 + i * 6, 6, 3); }
  });
}
const fishModels = {};
{
  const prof = [];
  for (let i = 0; i <= 16; i++) { const t = i / 16; prof.push(new THREE.Vector2(0.11 * Math.sin(Math.PI * Math.pow(1 - t, 0.8)) + 0.002, t - 0.5)); }
  for (const kind of Object.keys(SPECIES)) {
    const g = new THREE.Group();
    const bodyGeo = new THREE.LatheGeometry(prof, 16);
    bodyGeo.rotateX(Math.PI / 2);
    bodyGeo.scale(1, kind === 'bluefin' ? 1.25 : 1.05, 1);
    const mat = toon('#ffffff', { map: fishTex(kind), rim: 0.7 });
    const body = new THREE.Mesh(bodyGeo, mat);
    addOutline(body, 0.008);
    const finMat = toon({ striper: '#56636a', bluefish: '#2f6f7a', albie: '#3f6e5e', bluefin: '#1d2f55' }[kind], { side: THREE.DoubleSide });
    const tailShape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(0.16, -0.14), new THREE.Vector2(0.08, 0), new THREE.Vector2(0.16, 0.14)]);
    const tail = new THREE.Mesh(new THREE.ShapeGeometry(tailShape), finMat);
    tail.rotation.y = Math.PI / 2;
    tail.position.z = -0.48;
    const pivot = new THREE.Group();
    pivot.position.z = -0.45;
    tail.position.z = -0.03;
    pivot.add(tail);
    const dorsal = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(0.14, 0), new THREE.Vector2(0.02, 0.09)])), finMat);
    dorsal.rotation.y = Math.PI / 2;
    dorsal.position.set(0, 0.1, 0.08);
    g.add(body, pivot, dorsal);
    g.userData.tail = pivot;
    g.visible = false;
    scene.add(g);
    addLayers(g, L_REFLECT);
    fishModels[kind] = g;
  }
}

// ================================================================ birds (one instanced draw for every tern and gull)
const birdT = { value: 0 };
const BIRD_MAX = 72;
const birdMesh = (() => {
  const body = new THREE.SphereGeometry(1, 10, 8).toNonIndexed();
  body.scale(0.11, 0.09, 0.3);
  const wing = side => {
    const v = [[0.05, 0.12], [0.05, -0.1], [0.85, -0.22], [0.85, -0.06]].map(([x, z]) => [x * side, 0, z]);
    const tri = side > 0 ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(tri.flatMap(i => v[i]), 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(tri.flatMap(() => [0, 1, 0]), 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(tri.flatMap(() => [0, 0]), 2));
    return g;
  };
  const parts = [body, wing(1), wing(-1)];
  for (const p of parts) {
    const pp = p.attributes.position, n = pp.count;
    const aw = new Float32Array(n), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const isWing = p !== body;
      aw[i] = isWing ? Math.abs(pp.getX(i)) / 0.85 : 0;
      const c = isWing && aw[i] > 0.7 ? 0.32 : 1;
      col[i * 3] = c; col[i * 3 + 1] = c; col[i * 3 + 2] = c * 1.05;
    }
    p.setAttribute('aWing', new THREE.BufferAttribute(aw, 1));
    p.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  const geo = mergeGeometries(parts);
  geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(new Float32Array(BIRD_MAX).map(() => rand(0, TAU)), 1));
  geo.setAttribute('aFlap', new THREE.InstancedBufferAttribute(new Float32Array(BIRD_MAX).fill(0.4), 1).setUsage(THREE.DynamicDrawUsage));
  const mat = toon('#ffffff', { side: THREE.DoubleSide, rim: 0.5, vertexColors: true });
  const base = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    base(sh, r);
    sh.uniforms.uBirdT = birdT;
    sh.vertexShader = 'attribute float aWing;\nattribute float aPhase;\nattribute float aFlap;\nuniform float uBirdT;\n' +
      sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.y += aWing * aWing * sin(uBirdT * 11.0 + aPhase) * aFlap - aWing * 0.06;');
  };
  mat.customProgramCacheKey = () => 'bird';
  const m = new THREE.InstancedMesh(geo, mat, BIRD_MAX);
  m.frustumCulled = false;
  m.count = 0;
  scene.add(m);
  addLayers(m, L_REFLECT);
  return m;
})();

// ================================================================ lines, lures and the fishing gear
const LURE_DEF = [
  { dist: 38, lat: 9.5, out: 0, col: '#ff5fa2' },
  { dist: 33, lat: -9.5, out: 1, col: '#ffd23f' },
  { dist: 18, lat: 2.4, out: -1, col: '#4fd6c0' },
  { dist: 24, lat: -2.4, out: -1, col: '#ff8a3d' },
];
const lineMat = new THREE.LineBasicMaterial({ color: new THREE.Color(1.15, 1.12, 1.08), transparent: true, opacity: 0.7 });
const LINE_PTS = 24;
const lures = LURE_DEF.map((d, i) => {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(LINE_PTS * 3), 3).setUsage(THREE.DynamicDrawUsage));
  const line = new THREE.Line(geo, lineMat);
  line.frustumCulled = false;
  line.visible = false;
  scene.add(line);
  const lure = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.22, 4, 8), toon(d.col, { rim: 0.8, emissive: d.col, emissiveIntensity: 0.25 }));
  lure.visible = false;
  scene.add(lure);
  return { ...d, i, line, lure, pos: new THREE.Vector3(), splashT: rand(0, 0.3) };
});

// ================================================================ audio
const Sound = createSound();
Sound.onInit = ctx => {
  const o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
  o1.type = 'sawtooth'; o2.type = 'square';
  o1.frequency.value = 38; o2.frequency.value = 57;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 260;
  const g = ctx.createGain(); g.gain.value = 0;
  o1.connect(lp); o2.connect(lp); lp.connect(g).connect(Sound.master);
  o1.start(); o2.start();
  Sound.engine = { o1, o2, lp, g };
};
Sound.engineUpdate = (thr, load) => {
  if (!Sound.ctx || !Sound.on || !Sound.engine) return;
  const t = Sound.ctx.currentTime, e = Sound.engine, a = Math.abs(thr);
  e.o1.frequency.setTargetAtTime(36 + a * 46 + load * 6, t, 0.25);
  e.o2.frequency.setTargetAtTime(54 + a * 70, t, 0.25);
  e.lp.frequency.setTargetAtTime(220 + a * 520, t, 0.25);
  e.g.gain.setTargetAtTime(0.05 + a * 0.09, t, 0.25);
};
const setSound = bindSoundButton(Sound, document.getElementById('sound'));

// ================================================================ state
const S = {};
let schools = [], birds = [], fight = null, landed = [], deckFish = null;
let started = false, ended = false, time = 0, camYaw = SUN_YAW, camZoom = 0, camFX = START.x, camFZ = START.z, camY = 0, planeY = 0;
let hudAcc = 0, chartAcc = 0, sprayAcc = 0, alarmT = 0, clickAcc = 0, rushT = 0;
const lines = { mode: 'in', t: 0, tangled: false, turnT: 0 };
const trail = [];
const keys = {}, touch = {};
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _e = new THREE.Euler(), _s = new THREE.Vector3();
const tideV = { x: 0, z: 0 };

function makeSchool(sp, i) {
  let x = 0, z = 0;
  for (let k = 0; k < 60; k++) {
    if (sp === 'striper') { const R = RIPS[k % 3 === 2 ? 1 : 0]; x = R.x + rand(-1, 1) * R.a * 0.7; z = R.z + rand(-1, 1) * R.b * 0.8; }
    else if (sp === 'bluefin') { x = rand(1600, 2700); z = rand(-1200, 1200); }
    else { const a = rand(-1.6, 1.6), r = sp === 'albie' ? rand(500, 1600) : rand(300, 1400); x = Math.cos(a) * r; z = Math.sin(a) * r; }
    if (shoreSDF(x, z) > (sp === 'striper' ? 40 : 100)) break;
  }
  const n = sp === 'bluefin' ? 8 : 7;
  const sc = { sp, x, z, hx: x, hz: z, r: sp === 'bluefin' ? 32 : rand(16, 28), feeding: Math.random() < 0.65, t: rand(20, 60), wander: rand(0, TAU), spotted: 0, boilT: 0, probe: PR.school + i, birds: [] };
  for (let k = 0; k < n; k++) {
    const b = { school: sc, a: rand(0, TAU), rad: rand(8, 22), hgt: rand(6, 14), sp: rand(0.5, 0.9) * (Math.random() < 0.5 ? 1 : -1), phase: 'circle', t: rand(1, 6), x, y: 10, z, dx: 0, dz: 0, scale: sp === 'bluefin' ? 1.25 : rand(0.75, 0.95), tx: 0, tz: 0 };
    sc.birds.push(b);
    birds.push(b);
  }
  return sc;
}

function reset() {
  Object.assign(S, {
    x: START.x, z: START.z, h: START.h, u: 0, v: 0, r: 0, throttle: 0, rudder: 0,
    y: 0, vy: 0, pitch: 0, vp: 0, roll: 0, vr: 0, water: 0, inRate: 0, outRate: 0, peakWater: 0,
    drag: 15, sinking: 0, swampW: 0, slamCd: 0, sea: 0, rel: 0, rip: 0, score: 0, lb: 0,
  });
  lines.mode = 'in'; lines.t = 0; lines.tangled = false; lines.turnT = 0;
  trail.length = 0;
  fight = null; landed = []; birds = [];
  if (deckFish) { deckFish.obj.visible = false; deckFish = null; }
  Object.values(fishModels).forEach(m => { m.visible = false; });
  schools = ['striper', 'striper', 'striper', 'bluefish', 'bluefish', 'albie', 'albie', 'bluefin'].map(makeSchool);
  birdMesh.count = Math.min(BIRD_MAX, birds.length + 5);
  boat.position.set(S.x, 0, S.z);
  boat.rotation.set(0, S.h, 0, 'YXZ');
  boat.visible = true;
  camFX = S.x; camFZ = S.z;
  ended = false;
  updateHudNow();
}

// ================================================================ input
addEventListener('keydown', e => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  if (!started && e.code === 'Enter') { start(); return; }
  if (e.repeat) return;
  keys[e.code] = true;
  if (!started || ended) return;
  if (e.code === 'KeyL') toggleLines();
  if (e.code === 'KeyX') { S.throttle = 0; toast('Neutral'); }
});
addEventListener('keyup', e => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
addEventListener('wheel', e => { camZoom = clamp(camZoom + e.deltaY * 0.012, -10, 24); }, { passive: true });
document.querySelectorAll('.tbtn').forEach(b => {
  const k = b.dataset.k;
  b.addEventListener('pointerdown', e => {
    e.preventDefault();
    if (!started) start();
    if (k === 'lines') toggleLines(); else touch[k] = true;
    b.classList.add('on');
  });
  const up = () => { touch[k] = false; b.classList.remove('on'); };
  b.addEventListener('pointerup', up);
  b.addEventListener('pointercancel', up);
  b.addEventListener('pointerleave', up);
});

const tierBlurb = document.getElementById('tierBlurb');
function readTier() {
  const v = Number(document.querySelector('input[name="tier"]:checked')?.value ?? 1);
  tier = TIERS[v];
  tierBlurb.textContent = tier.blurb;
  E.U.uSeaAmp.value = tier.sea;
}
document.getElementById('tiers').addEventListener('change', readTier);
readTier();

const introEl = document.getElementById('intro'), endEl = document.getElementById('endCard');
function start() {
  if (started) return;
  readTier();
  started = true;
  introEl.classList.add('gone');
  setSound(true);
  toast('Head for the birds', 'Troll 5–8 kn through them with the spread out');
}
document.getElementById('go').addEventListener('click', start);
document.getElementById('again').addEventListener('click', () => {
  reset();
  endEl.classList.add('gone');
  introEl.classList.remove('gone');
  started = false;
});

const toastEl = document.getElementById('toast');
let toastTimer = 0;
function toast(msg, sub = '', bad = false) {
  toastEl.innerHTML = '';
  toastEl.append(msg);
  if (sub) { const s = document.createElement('small'); s.textContent = sub; toastEl.append(s); }
  toastEl.classList.toggle('bad', bad);
  toastEl.classList.add('show');
  toastTimer = sub ? 2.6 : 1.8;
}

function toggleLines() {
  if (fight) { toast('Fish on', 'Fight it first'); return; }
  if (lines.mode === 'in') { lines.mode = 'setting'; lines.tangled = false; Sound.burst(2400, 4, 0.05, 0.6, 0.6); }
  else if (lines.mode === 'out' || lines.mode === 'setting') { lines.mode = 'clearing'; }
}

// ================================================================ lures along the track through the water
function sternPos(out) {
  const ch = Math.cos(S.h), sh = Math.sin(S.h);
  return out.set(S.x + sh * STERN_Z, 0, S.z + ch * STERN_Z);
}
function trailPoint(dist, out) {
  sternPos(_v);
  let px = _v.x, pz = _v.z, ph = S.h, acc = 0;
  for (let k = trail.length - 1; k >= 0; k--) {
    const t = trail[k], seg = Math.hypot(t.x - px, t.z - pz);
    if (acc + seg >= dist) {
      const f = (dist - acc) / (seg || 1);
      out.x = lerp(px, t.x, f); out.z = lerp(pz, t.z, f); out.h = t.h;
      return out;
    }
    acc += seg; px = t.x; pz = t.z; ph = t.h;
  }
  const rest = dist - acc;
  out.x = px - Math.sin(ph) * rest; out.z = pz - Math.cos(ph) * rest; out.h = ph;
  return out;
}
const _tp = { x: 0, z: 0, h: 0 };

function linePoints(arr, a, b, sag, from = 0, to = LINE_PTS - 1) {
  for (let k = from; k <= to; k++) {
    const t = (k - from) / Math.max(1, to - from);
    arr[k * 3] = lerp(a.x, b.x, t);
    arr[k * 3 + 1] = lerp(a.y, b.y, t) - sag * 4 * t * (1 - t);
    arr[k * 3 + 2] = lerp(a.z, b.z, t);
  }
}

// ================================================================ fish fight
const LINE_BREAK = 230, SPOOL = 420;
const MOODS = {
  run: { label: 'Running!', cls: '', dur: [4, 9] },
  sound: { label: 'Sounding', cls: '', dur: [5, 10] },
  circle: { label: 'Circling the boat', cls: 'warn', dur: [4, 8] },
  thrash: { label: 'Thrashing!', cls: 'warn', dur: [2, 4] },
  dash: { label: 'Charging the boat! Reel!', cls: 'bad', dur: [1.6, 2.4] },
  tired: { label: 'Tiring', cls: '', dur: [3, 6] },
};
function pickMood(f) {
  if (f.stam < 0.22) return Math.random() < 0.8 ? 'tired' : 'run';
  const w = { run: 0.4, sound: f.sp.sound, circle: f.L < 45 ? 0.25 : 0.02, thrash: f.sp.jump > 0 ? 0.28 : 0.08, dash: 0.08 };
  let r = Math.random() * Object.values(w).reduce((a, b) => a + b, 0);
  for (const [k, v] of Object.entries(w)) { r -= v; if (r <= 0) return k; }
  return 'run';
}
function hookUp(lure, school) {
  const sp = SPECIES[school.sp];
  const lb = Math.round(lerp(sp.lb[0], sp.lb[1], Math.pow(Math.random(), 1.8)));
  const kg = lb * 0.4536;
  const rod = boatRef.rods[lure.i];
  rod.tip.getWorldPosition(_v);
  const away = new THREE.Vector2(lure.pos.x - S.x, lure.pos.z - S.z).normalize();
  fight = {
    lure, rod, school, kind: school.sp, sp, lb, kg, P0: sp.power * 9 * Math.pow(kg, 0.8) * tier.fish,
    pos: new THREE.Vector3(lure.pos.x, -1, lure.pos.z), vel: new THREE.Vector3(away.x * sp.speed * 0.8, 0, away.y * sp.speed * 0.8),
    stam: 1, mood: 'run', moodT: rand(3, 6), next: null, circle: Math.random() < 0.5 ? 1 : -1,
    L: _v.distanceTo(lure.pos) + 3, payV: 0, T: 0, slackT: 0, chafeT: 0, gaffT: 0, t: 0, wig: rand(0, TAU),
  };
  lines.mode = 'out';
  for (const l of lures) if (l !== lure) { l.line.visible = false; l.lure.visible = false; }
  lure.lure.visible = false;
  toast('FISH ON!', 'Throttle back now, then reel');
  Sound.tone([660, 880, 1320], { type: 'square', vol: 0.08, gap: 0.05, dur: 0.25 });
  Sim.splash(lure.pos.x, lure.pos.z, 1.2, 0.25);
  splashBurst(lure.pos.x, 0.1, lure.pos.z, 24, 1);
}
function endFight(msg, sub, good) {
  const f = fight;
  fight = null;
  lines.mode = 'in'; lines.t = 0;
  for (const l of lures) { l.line.visible = false; l.lure.visible = false; }
  fishModels[f.kind].visible = false;
  boatRef.rods.forEach(r => r.segs.forEach(s => s.quaternion.identity()));
  if (good) {
    const pts = Math.round(f.lb * f.sp.value * 10 * tier.score);
    S.score += pts; S.lb += f.lb;
    landed.push({ name: f.sp.name, lb: f.lb, pts });
    toast(`Gaffed! ${f.sp.name}`, `${f.lb} lb · +${pts}`);
    Sound.chime();
    const m = fishModels[f.kind];
    m.visible = true;
    deckFish = { obj: m, t: 5, kind: f.kind, len: f.sp.len * 0.3 * Math.cbrt(f.kg) };
    try { const best = Number(localStorage.getItem('montauk-best') || 0); if (S.score > best) localStorage.setItem('montauk-best', String(S.score)); } catch (e) { /* storage unavailable */ }
  } else {
    toast(msg, sub, true);
    Sound.burst(2600, 3, 0.25, 0.12);
  }
}
function updateFight(dt, reel) {
  const f = fight;
  f.t += dt;
  const sp = f.sp;
  f.moodT -= dt;
  if (f.moodT <= 1.5 && !f.next) f.next = pickMood(f);
  if (f.moodT <= 0) { f.mood = f.next || 'run'; f.next = null; const d = MOODS[f.mood].dur; f.moodT = rand(d[0], d[1]); if (f.mood === 'circle') f.circle = -f.circle; }

  const tip = f.rod.tip.getWorldPosition(_v);
  const dxh = f.pos.x - S.x, dzh = f.pos.z - S.z, dh = Math.hypot(dxh, dzh) || 1;
  const ax = dxh / dh, az = dzh / dh;
  let dx = 0, dz = 0, power = 1, depth = -4;
  switch (f.mood) {
    case 'run': dx = ax + tideV.x * 0.5 + Math.sin(f.t * 0.7 + f.wig) * 0.3; dz = az + tideV.z * 0.5 + Math.cos(f.t * 0.6 + f.wig) * 0.3; depth = -5; break;
    case 'sound': dx = ax * 0.3; dz = az * 0.3; power = 0.8; depth = -sp.depth; break;
    case 'circle': dx = -az * f.circle + ax * 0.1; dz = ax * f.circle + az * 0.1; power = 0.6; depth = -6; break;
    case 'thrash': dx = Math.sin(f.t * 5.3); dz = Math.cos(f.t * 4.1); power = 0.5; depth = 0; break;
    case 'dash': dx = -ax; dz = -az; power = 1.1; depth = -2; break;
    case 'tired': dx = -ax * 0.4 - az * 0.2; dz = -az * 0.4 + ax * 0.2; power = 0.12; depth = -1.5; break;
  }
  const dl = Math.hypot(dx, dz) || 1;
  const P = f.P0 * (0.3 + 0.7 * f.stam) * power;
  const m = f.kg * 2;
  const c = f.P0 / (sp.speed * sp.speed);
  const lx = tip.x - f.pos.x, ly = tip.y - f.pos.y, lz = tip.z - f.pos.z, D = Math.hypot(lx, ly, lz) || 1;
  const sv = Math.hypot(f.vel.x, f.vel.z);
  f.vel.x += ((P * dx / dl + f.T * lx / D) - c * f.vel.x * sv) / m * dt;
  f.vel.z += ((P * dz / dl + f.T * lz / D) - c * f.vel.z * sv) / m * dt;
  f.pos.x += (f.vel.x + tideV.x) * dt;
  f.pos.z += (f.vel.z + tideV.z) * dt;
  if (f.pos.y > 0.1) { f.vel.y -= 9.8 * dt; }
  else {
    f.vel.y = damp(f.vel.y, (depth - f.pos.y) * 0.6 + f.T * ly / D / m * 0.3, 3, dt);
    if (f.mood === 'thrash' && sp.jump > 0 && Math.random() < sp.jump * dt * 1.2) {
      f.vel.y = rand(4, 6.5);
      f.pos.y = 0.15;
      Sim.splash(f.pos.x, f.pos.z, 1.4, 0.3);
      splashBurst(f.pos.x, 0.2, f.pos.z, 30, 1.2);
      Sound.burst(700, 0.7, 0.25, 0.45, 0.5);
    }
  }
  const wasAir = f.pos.y > 0.1;
  f.pos.y = Math.min(f.pos.y + f.vel.y * dt, 3);
  if (wasAir && f.pos.y <= 0.1) { Sim.splash(f.pos.x, f.pos.z, 1.6, -0.3); splashBurst(f.pos.x, 0.1, f.pos.z, 40, 1.4); }
  if (shoreSDF(f.pos.x, f.pos.z) < 3) { f.vel.x *= -0.5; f.vel.z *= -0.5; }

  // the line: a stretchy tether with a slipping drag on the reel
  const D2 = tip.distanceTo(f.pos);
  const k = 3500 / Math.max(f.L, 8);
  f.T = Math.max(0, (D2 - f.L) * k);
  const dragN = S.drag * 4.448;
  if (f.T > dragN || f.payV > 0) {
    f.payV += (f.T - dragN) / 18 * dt;
    if (f.T < dragN) f.payV -= 2.5 * dt;
    f.payV = Math.max(0, f.payV);
  }
  f.L += f.payV * dt;
  if (reel && f.payV < 0.05) {
    const rate = 1.25 * Math.sqrt(clamp(1 - f.T / dragN, 0, 1)) + (f.T < 5 ? 0.35 : 0);
    f.L = Math.max(3, f.L - rate * dt);
  }
  if (f.payV > 0.15) {
    clickAcc += f.payV * dt * 22;
    while (clickAcc > 1) { clickAcc -= 1; Sound.burst(3200, 6, 0.05, 0.03); }
  } else if (reel) {
    clickAcc += dt * 9;
    while (clickAcc > 1) { clickAcc -= 1; Sound.burst(1800, 8, 0.025, 0.025); }
  }
  f.stam = clamp(f.stam - dt * ((f.T / f.P0) * 0.055 / sp.endurance + 0.003) + (f.T < 0.2 * f.P0 ? dt * 0.012 : 0), 0, 1);

  // what goes wrong
  if (f.T > LINE_BREAK) return endFight('Line snapped!', 'Too much tension. Ease the drag or slow the boat.');
  if (f.L > SPOOL) return endFight('Spooled!', 'It took every metre of line. Chase it with the boat.');
  f.slackT = f.T < 3 ? f.slackT + dt : Math.max(0, f.slackT - dt * 2);
  if (f.slackT > 2.6 && Math.random() < dt * 1.5) return endFight('Hook pulled', 'The line went slack. Reel when it runs at you.');
  if (sp.teeth && f.mood === 'thrash' && f.L < 25 && Math.random() < dt * 0.05) return endFight('Bit off!', 'Bluefish teeth through the leader.');
  const ch = Math.cos(S.h), sh = Math.sin(S.h);
  const fz = dxh * sh + dzh * ch;
  if (fz > 1.5 && dh < 12 && f.pos.y > -8) {
    f.chafeT += dt;
    if (f.chafeT > 1.8) return endFight('Chafed off on the hull', 'Keep the fish astern of the boat.');
  } else f.chafeT = Math.max(0, f.chafeT - dt);
  const gaffable = f.L < 8 && f.stam < 0.25 && dh < 10 && fz < 0.5;
  f.gaffT = gaffable ? f.gaffT + dt : 0;
  if (f.gaffT > 1.2) return endFight('', '', true);
  f.gaffReady = gaffable;
}

function splashBurst(x, y, z, n, size) {
  for (let i = 0; i < n; i++) {
    const a = rand(0, TAU), s = rand(0.6, 2.6) * size;
    emit(x + Math.cos(a) * 0.3, y, z + Math.sin(a) * 0.3, Math.cos(a) * s, rand(2, 4.5) * size, Math.sin(a) * s, rand(0.5, 1.0), rand(0.2, 0.42) * size, 1, 0.97, 0.94);
  }
}

// ================================================================ main update
function update(dt) {
  time += dt;
  birdT.value = time;
  const PH = Probe.heights, P = Probe.pts;
  const ch = Math.cos(S.h), sh = Math.sin(S.h);
  tide(S.x, S.z, tideV);

  // ---- helm
  let steer = 0, thrIn = 0, reel = false;
  if (started && !ended && !S.sinking) {
    steer = ((keys.KeyA || keys.ArrowLeft || touch.left) ? 1 : 0) - ((keys.KeyD || keys.ArrowRight || touch.right) ? 1 : 0);
    thrIn = ((keys.KeyW || keys.ArrowUp || touch.up) ? 1 : 0) - ((keys.KeyS || keys.ArrowDown || touch.down) ? 1 : 0);
    reel = !!(keys.Space || keys.KeyR || touch.reel);
    if (keys.KeyQ) S.drag = clamp(S.drag - dt * 8, 4, 40);
    if (keys.KeyE) S.drag = clamp(S.drag + dt * 8, 4, 40);
  }
  S.throttle = clamp(S.throttle + thrIn * dt * 0.35, -0.5, 1);
  if (Math.abs(S.throttle) < 0.012 && thrIn === 0) S.throttle = 0;
  S.rudder = damp(S.rudder, steer, 4, dt);

  // ---- the sea around the hull: which way it's running and how steep it is right here
  const fx = -WAVE_DIR.x, fz = -WAVE_DIR.y;
  const wlx = fx * ch - fz * sh, wlz = fx * sh + fz * ch;
  S.rel = Math.atan2(wlx, wlz);
  S.rip = ripField(S.x, S.z);
  S.sea = damp(S.sea, 0.9 * tier.sea * (1 + 0.6 * S.rip), 1, dt);
  const headness = Math.pow(Math.max(0, Math.cos(S.rel)), 3);
  const beamness = Math.pow(Math.abs(Math.sin(S.rel)), 4);
  const followness = Math.pow(Math.max(0, -Math.cos(S.rel)), 3);
  const weather = Math.sign(wlx);

  // ---- propulsion and steering
  const mass = 4600 + S.water * 1000;
  const thrust = S.throttle >= 0 ? S.throttle * 15500 : S.throttle * 5000;
  const resist = (140 * S.u + 100 * S.u * Math.abs(S.u)) * (S.u < 0 ? 2.2 : 1) + headness * S.sea * 260 * S.u;
  S.u += (thrust - resist) / mass * dt * (S.sinking ? 0.2 : 1);
  const flow = Math.abs(S.u) + 3 * Math.max(0, S.throttle);
  const eff = clamp(flow / 5, 0.12, 1.2) * (S.u < -0.2 ? -1 : 1);
  S.r = damp(S.r, S.rudder * 0.5 * eff, 2.5, dt);
  S.h = wrap(S.h + S.r * dt);
  S.v = damp(S.v, -S.u * S.r * 0.12, 1.5, dt);
  S.x += (sh * S.u + ch * S.v + tideV.x - 0.12) * dt;
  S.z += (ch * S.u - sh * S.v + tideV.z) * dt;
  const sd = shoreSDF(S.x, S.z);
  if (sd < 6) {
    const e = 2, gx = shoreSDF(S.x + e, S.z) - shoreSDF(S.x - e, S.z), gz = shoreSDF(S.x, S.z + e) - shoreSDF(S.x, S.z - e), gl = Math.hypot(gx, gz) || 1;
    S.x += gx / gl * (6 - sd); S.z += gz / gl * (6 - sd);
    if (Math.abs(S.u) > 1.5) { toast('Aground!', 'Mind the rocks off the Point', true); Sound.burst(160, 1, 0.4, 0.4); }
    S.u *= 0.2;
  }
  const off = Math.max(S.x - 3300, Math.abs(S.z) - 2600, -S.x - 4000);
  if (off > 0) { S.x -= Math.sign(S.x - 650) * off * dt; S.z -= Math.sign(S.z) * Math.max(0, Math.abs(S.z) - 2600) * dt; }

  // ---- heave, pitch, roll as damped springs toward the water under the hull
  const hc = PH[PR.center];
  const hBow = (PH[1] + PH[2] + PH[3]) / 3, hStern = (PH[8] + PH[9]) / 2;
  const hPort = (PH[2] + PH[4] + PH[6]) / 3, hStbd = (PH[3] + PH[5] + PH[7]) / 3;
  const draft = -S.water / WATERPLANE - S.sinking * 1.2;
  const heaveT = (hc * 2 + hBow + hStern + hPort + hStbd) / 6 + draft;
  const plane = smooth(4, 10, S.u);
  const slosh = Math.sin(time * 2.3) * S.water * 0.012;
  const pitchT = -Math.atan2(hBow - hStern, 6.5) - 0.07 * plane - S.sinking * 0.45;
  const rollT = Math.atan2(hPort - hStbd, 2.6) * 0.9 + S.rudder * S.u * 0.012 + slosh;
  S.vy += (36 * (heaveT - S.y) - 7 * S.vy) * dt; S.y += S.vy * dt;
  S.vp += (30 * (pitchT - S.pitch) - 7 * S.vp) * dt; S.pitch += S.vp * dt;
  S.vr += (14 * (rollT - S.roll) - 3.2 * S.vr) * dt; S.roll += S.vr * dt;
  boat.position.set(S.x, S.y, S.z);
  boat.rotation.set(S.pitch, S.h, S.roll, 'YXZ');
  boat.updateMatrixWorld();

  // ---- green water over the rail, and the scuppers draining it
  let inflow = 0;
  const sea = S.sea;
  const bowVel = S.vy - S.vp * 3.8;
  S.slamCd -= dt;
  for (let i = 0; i < RAIL.length; i++) {
    const R = RAIL[i];
    R.w0.copy(R.v).applyMatrix4(boat.matrixWorld);
    R.wl0.copy(R.wl).applyMatrix4(boat.matrixWorld);
    P[PR.rail + i].set(R.w0.x, R.w0.z);
    const sea_i = R.wl0.y + LOCAL_CHOP * (PH[PR.rail + i] - R.wl0.y);
    R.seaLevel = sea_i;
    const free = R.w0.y - sea_i;
    let runup = 0;
    if (R.kind === 'bow') runup = headness * (0.3 * sea + 0.01 * S.u * Math.max(0, S.u)) * (R.side === 0 ? 1 : 0.85) + beamness * 0.3 * sea * (R.side === weather ? 1 : 0);
    else if (R.kind === 'beam') runup = beamness * 0.54 * sea * (R.side === weather ? 1 : 0.25);
    else if (R.kind === 'quarter') runup = beamness * 0.36 * sea * (R.side === weather ? 1 : 0.25) + followness * 0.35 * sea * (1 - smooth(4, 8, S.u));
    else runup = followness * 0.45 * sea * (1 - smooth(4, 8, S.u)) + 0.045 * Math.max(0, -S.u) ** 2;
    const H = clamp(runup - free, 0, 0.6);
    R.inflow = 1.7 * R.w * Math.pow(H, 1.5);
    inflow += R.inflow;
    if (R.inflow > 0.02 && Math.random() < dt * 30) {
      emit(R.w0.x, R.w0.y + 0.1, R.w0.z, rand(-1, 1) - sh * 1.5, rand(1, 2.5), rand(-1, 1) - ch * 1.5, rand(0.4, 0.8), rand(0.3, 0.5), 0.9, 0.97, 1);
    }
  }
  // slams: the bow falling hard into a sea at speed
  if (S.slamCd <= 0 && bowVel < -2.2 && S.u > 4 && RAIL[0].w0.y - PH[PR.rail] < 0.9) {
    S.slamCd = 0.8;
    const burst = clamp((-bowVel - 2) * 0.04 * (0.5 + headness), 0, 0.15);
    S.water += burst;
    S.u *= 0.9;
    Sound.burst(120, 0.8, 0.5, 0.35);
    Sound.burst(900, 0.6, 0.25, 0.5, 0.4);
    _v.copy(RAIL[0].w0);
    for (let k = 0; k < 40; k++) emit(_v.x + rand(-1, 1), _v.y, _v.z + rand(-1, 1), sh * S.u * 0.4 + rand(-3, 3), rand(3, 7), ch * S.u * 0.4 + rand(-3, 3), rand(0.6, 1.2), rand(0.3, 0.6), 1, 0.97, 0.94);
    if (fight) fight.T += 70;
  }
  // scuppers: an orifice draining the cockpit; flap valves stop the sea coming back in
  const level = S.water / DECK_AREA;
  _v.set(0, 0.3, STERN_Z + 0.1).applyMatrix4(boat.matrixWorld);
  const outside = (RAIL[7].seaLevel + RAIL[8].seaLevel) / 2;
  const head = clamp(_v.y + level - outside, 0, level);
  let outflow = 0.6 * tier.scupper * Math.sqrt(2 * 9.81 * head);
  if (level > 0.55) outflow += 1.7 * 2.4 * Math.pow(level - 0.55, 1.5);
  outflow = Math.min(outflow, S.water / Math.max(dt, 1e-3));
  if (S.sinking) { inflow = 0; outflow = 0; }
  S.water = S.sinking ? damp(S.water, tier.cap * 1.25, 1.5, dt) : Math.max(0, S.water + (inflow - outflow) * dt);
  S.inRate = damp(S.inRate, inflow, 6, dt);
  S.outRate = damp(S.outRate, outflow, 6, dt);
  S.peakWater = Math.max(S.peakWater, S.water);
  if (outflow > 0.004 && Math.random() < dt * 20) {
    for (const sx of [-1, 1]) {
      _w.set(sx * 1.2, 0.3, STERN_Z).applyMatrix4(boat.matrixWorld);
      emit(_w.x, _w.y, _w.z, -sh * 1.2 + ch * sx * 0.6, rand(0.2, 0.8), -ch * 1.2 - sh * sx * 0.6, rand(0.4, 0.7), 0.22 + outflow * 3, 0.8, 0.95, 1);
    }
  }
  if (inflow > 0.05) { rushT -= dt; if (rushT <= 0) { rushT = 0.35; Sound.burst(500, 0.5, clamp(inflow * 0.6, 0.05, 0.35), 0.6, 0.6); } }
  const dw = boatRef.deckWater;
  dw.visible = S.water > 0.01;
  dw.position.y = 0.3 + Math.min(level, 0.6) + 0.01;
  dw.rotation.set(-Math.PI / 2 - S.pitch * 0.7 + Math.sin(time * 2.3) * 0.02 * Math.min(1, S.water), S.roll * 0.7, 0, 'XYZ');
  if (!S.sinking && S.water > tier.cap) {
    S.sinking = 0.001;
    S.swampW = S.water;
    toast('Swamped!', 'She is going down by the stern', true);
    Sound.burst(200, 0.6, 0.6, 2.5, 0.3);
  }
  if (S.sinking) {
    S.sinking = Math.min(1.6, S.sinking + dt * 0.3);
    S.throttle = damp(S.throttle, 0, 2, dt);
    if (Math.random() < dt * 40) emit(S.x + rand(-2, 2), S.y + 0.2, S.z + rand(-2, 2), 0, rand(0.5, 2), 0, rand(0.5, 1), rand(0.2, 0.4), 0.9, 0.97, 1, 1);
    if (S.sinking > 1.4 && !ended) { boat.visible = false; gameOver(); }
  }
  alarmT -= dt;
  if (S.water > tier.cap * 0.6 && !S.sinking && alarmT <= 0) { alarmT = 0.9; Sound.tone([1046], { type: 'square', vol: 0.07, dur: 0.18 }); }

  // ---- spray off the bow when she's running
  sprayAcc += dt * Math.max(0, S.u - 4) * (6 + sea * 8);
  while (sprayAcc > 1) {
    sprayAcc -= 1;
    const side = Math.random() < 0.5 ? 1 : -1;
    _w.set(side * 0.9, 0.2, 2.8).applyMatrix4(boat.matrixWorld);
    const outv = rand(2, 4);
    emit(_w.x, _w.y, _w.z, ch * side * outv + sh * S.u * 0.3, rand(1.5, 3.5), -sh * side * outv + ch * S.u * 0.3, rand(0.5, 0.9), rand(0.2, 0.42), 1, 0.97, 0.94);
  }

  // ---- outriggers and the spread
  const lead = 0.6;
  sternPos(_v);
  const lastT = trail[trail.length - 1];
  if (!lastT || Math.hypot(_v.x - lastT.x, _v.z - lastT.z) > lead) { trail.push({ x: _v.x, z: _v.z, h: S.h }); if (trail.length > 160) trail.shift(); }
  if (lines.mode === 'setting') { lines.t = Math.min(1, lines.t + dt / 4); if (lines.t >= 1) { lines.mode = 'out'; toast('Lines set', 'Troll 5–8 kn through the birds'); } }
  if (lines.mode === 'clearing') { lines.t = Math.max(0, lines.t - dt / 3); if (lines.t <= 0) { lines.mode = 'in'; lines.tangled = false; } }
  const deploy = smooth(0, 0.6, lines.t);
  boatRef.outriggers.forEach(o => o.pivot.rotation.set(lerp(-0.45, -0.35, deploy), 0, -o.side * lerp(0.15, 1.05, deploy), 'YXZ'));
  const kn = S.u * 1.944;
  const lureState = kn < 4.5 ? 'sink' : kn > 8.5 ? 'skip' : 'swim';
  const fishing = (lines.mode === 'out' || lines.mode === 'setting') && !fight;
  if (fishing && !lines.tangled) {
    lines.turnT = Math.abs(S.r) > 0.28 && S.u > 1.5 ? lines.turnT + dt : Math.max(0, lines.turnT - dt);
    if (lines.turnT > 1.8) { lines.tangled = true; toast('Lines tangled!', 'Too sharp a turn. Clear them with L and reset', true); }
  }
  for (const l of lures) {
    const active = (fishing || lines.mode === 'clearing') && lines.t > 0.02;
    l.line.visible = active || (fight && fight.lure === l);
    l.lure.visible = active;
    if (!active) continue;
    trailPoint(l.dist * lines.t, _tp);
    const lat = l.lat * lines.t;
    l.pos.set(_tp.x + Math.cos(_tp.h) * lat, 0, _tp.z - Math.sin(_tp.h) * lat);
    P[PR.lure + l.i].set(l.pos.x, l.pos.z);
    const sink = lureState === 'sink' ? 0.8 : 0;
    l.pos.y = PH[PR.lure + l.i] + (lureState === 'skip' ? 0.15 + Math.abs(Math.sin(time * 9 + l.i)) * 0.25 : -0.05) - sink;
    l.lure.position.copy(l.pos);
    l.lure.rotation.set(Math.PI / 2, _tp.h, 0, 'YXZ');
    l.splashT -= dt;
    if (l.splashT <= 0 && lureState !== 'sink') {
      l.splashT = lureState === 'skip' ? 0.08 : 0.22;
      emit(l.pos.x, l.pos.y + 0.05, l.pos.z, rand(-0.3, 0.3), rand(0.4, 1.2), rand(-0.3, 0.3), 0.4, lureState === 'skip' ? 0.3 : 0.18, 1, 0.98, 0.95, 4);
    }
    const rodTip = boatRef.rods[l.i].tip.getWorldPosition(_w);
    const arr = l.line.geometry.attributes.position.array;
    if (l.out >= 0) {
      const oTip = boatRef.outriggers[l.out].tip.getWorldPosition(_s);
      linePoints(arr, rodTip, oTip, 0.3, 0, 6);
      linePoints(arr, oTip, l.pos, l.dist * 0.05, 6, LINE_PTS - 1);
    } else linePoints(arr, rodTip, l.pos, l.dist * 0.04);
    l.line.geometry.attributes.position.needsUpdate = true;
  }
  if (fight) {
    for (const l of lures) l.line.visible = l === fight.lure;
  }

  // ---- the strike
  if (fishing && !lines.tangled && lines.mode === 'out' && lureState === 'swim') {
    const q = 1 - Math.abs(kn - 6.5) / 2.2;
    outer: for (const sc of schools) {
      for (const l of lures) {
        if (Math.hypot(l.pos.x - sc.x, l.pos.z - sc.z) > sc.r + 6) continue;
        const p = (sc.feeding ? 0.55 : 0.05) * SPECIES[sc.sp].bite * clamp(q, 0.2, 1);
        if (Math.random() < p * dt) { hookUp(l, sc); break outer; }
      }
    }
  }

  // ---- the fight
  if (fight) {
    updateFight(dt, reel);
    if (fight) {
      const f = fight;
      P[PR.fish].set(f.pos.x, f.pos.z);
      const tip = f.rod.tip.getWorldPosition(_v);
      const arr = f.lure.line.geometry.attributes.position.array;
      const entry = _w.set(f.pos.x, Math.max(f.pos.y, PH[PR.fish] - 0.1), f.pos.z);
      linePoints(arr, tip, entry, clamp(8 / (f.T + 4), 0, 2.5));
      f.lure.line.geometry.attributes.position.needsUpdate = true;
      f.lure.line.visible = true;
      // bend the rod toward the fish
      const rod = f.rod;
      rod.root.updateMatrixWorld();
      _s.copy(entry).sub(tip).normalize();
      _q.copy(rod.root.getWorldQuaternion(new THREE.Quaternion())).invert();
      _s.applyQuaternion(_q);
      const axis = new THREE.Vector3(0, 1, 0).cross(_s);
      const al = axis.length();
      const bend = clamp(f.T / 160, 0, 1.25) * clamp(Math.acos(clamp(_s.y, -1, 1)) / 1.2, 0, 1);
      if (al > 1e-4) { axis.divideScalar(al); for (const sg of rod.segs) sg.quaternion.setFromAxisAngle(axis, bend / rod.segs.length); }
      // the fish itself, when it's near the surface
      const fm = fishModels[f.kind];
      fm.visible = f.pos.y > -2.6;
      const len = f.sp.len * 0.3 * Math.cbrt(f.kg);
      fm.scale.setScalar(len);
      fm.position.set(f.pos.x, Math.max(f.pos.y, PH[PR.fish] - 0.5 * len), f.pos.z);
      fm.rotation.set(-clamp(f.vel.y * 0.15, -0.8, 0.8), Math.atan2(f.vel.x, f.vel.z), Math.sin(time * 9) * 0.15 * (f.mood === 'thrash' ? 3 : 1), 'YXZ');
      fm.userData.tail.rotation.y = Math.sin(time * (f.mood === 'tired' ? 4 : 12)) * 0.5;
    }
  }
  // crew: the mate goes to the hooked rod and leans into it
  if (boatRef.mate) {
    const mate = boatRef.mate;
    const target = fight ? fight.rod.holder.clone().multiplyScalar(0.72) : _v.set(-0.55, 0, -2.3);
    mate.position.x = damp(mate.position.x, target.x, 3, dt);
    mate.position.z = damp(mate.position.z, target.z, 3, dt);
    mate.position.y = 0.3 + (fight && reel ? Math.abs(Math.sin(time * 9)) * 0.05 : 0);
    mate.rotation.x = fight ? -0.25 : 0;
    mate.userData.arms.rotation.x = fight && reel ? Math.sin(time * 12) * 0.5 : 0;
    boatRef.captain.rotation.y = S.rudder * 0.3;
  }
  if (deckFish) {
    deckFish.t -= dt;
    _v.set(0.2, 0.42, -1.2).applyMatrix4(boat.matrixWorld);
    deckFish.obj.position.copy(_v);
    deckFish.obj.scale.setScalar(deckFish.len);
    deckFish.obj.rotation.set(0, S.h + 1.2, Math.PI / 2 + Math.sin(time * 14) * 0.25 * (deckFish.t > 2 ? 1 : 0.2), 'YXZ');
    if (deckFish.t <= 0) { deckFish.obj.visible = false; deckFish = null; }
  }

  // ---- schools, birds, boils
  let bi = 0;
  schools.forEach((sc, si) => {
    sc.t -= dt;
    if (sc.t <= 0) { sc.feeding = !sc.feeding; sc.t = sc.feeding ? rand(35, 80) : rand(25, 60); }
    sc.wander += rand(-0.5, 0.5) * dt;
    const spd = sc.sp === 'albie' ? 1.6 : 0.35;
    tide(sc.x, sc.z, _tp);
    const hx = sc.hx - sc.x, hz = sc.hz - sc.z, hd = Math.hypot(hx, hz);
    const pull = smooth(250, 450, hd);
    sc.x += ((Math.cos(sc.wander) * (1 - pull) + hx / (hd || 1) * pull) * spd + _tp.x * 0.5) * dt;
    sc.z += ((Math.sin(sc.wander) * (1 - pull) + hz / (hd || 1) * pull) * spd + _tp.z * 0.5) * dt;
    const bd = Math.hypot(sc.x - S.x, sc.z - S.z);
    if (sc.feeding && bd < 45 && S.u > 8) { sc.feeding = false; sc.t = 50; toast('Spooked them', 'Ease off near a school'); }
    if (sc.feeding && bd < 950) sc.spotted = 60;
    sc.spotted = Math.max(0, sc.spotted - dt);
    P[sc.probe].set(sc.x, sc.z);
    const wy = PH[sc.probe];
    if (sc.feeding) {
      sc.boilT -= dt;
      if (sc.boilT <= 0) {
        sc.boilT = rand(0.15, 0.5);
        const a = rand(0, TAU), r = rand(0, sc.r);
        const bx = sc.x + Math.cos(a) * r, bz = sc.z + Math.sin(a) * r;
        if (Math.hypot(bx - camera.position.x, bz - camera.position.z) < 900) splashBurst(bx, wy, bz, sc.sp === 'bluefin' ? 18 : 9, sc.sp === 'bluefin' ? 1.3 : 0.8);
        if (Math.hypot(bx - S.x, bz - S.z) < 40) Sim.splash(bx, bz, 1, 0.15);
      }
    }
    for (const b of sc.birds) {
      b.t -= dt;
      if (!sc.feeding) {
        b.phase = 'rest';
        b.x = damp(b.x, sc.x + Math.cos(b.a) * b.rad * 0.6, 0.5, dt);
        b.z = damp(b.z, sc.z + Math.sin(b.a) * b.rad * 0.6, 0.5, dt);
        b.y = damp(b.y, wy + 0.08, 1.5, dt);
        b.flap = 0;
      } else {
        if (b.phase === 'rest') { b.phase = 'climb'; b.t = 1.5; }
        if (b.phase === 'circle') {
          b.a += b.sp * dt;
          b.x = damp(b.x, sc.x + Math.cos(b.a) * b.rad, 2, dt);
          b.z = damp(b.z, sc.z + Math.sin(b.a) * b.rad, 2, dt);
          b.y = damp(b.y, wy + b.hgt, 2, dt);
          b.flap = 0.35;
          if (b.t <= 0) { b.phase = 'dive'; b.t = 0.7; const a = rand(0, TAU), r = rand(0, sc.r); b.tx = sc.x + Math.cos(a) * r; b.tz = sc.z + Math.sin(a) * r; }
        } else if (b.phase === 'dive') {
          b.x = damp(b.x, b.tx, 4, dt); b.z = damp(b.z, b.tz, 4, dt);
          b.y = damp(b.y, wy - 0.3, 5, dt);
          b.flap = 0;
          if (b.t <= 0 || b.y < wy + 0.1) {
            b.phase = 'climb'; b.t = 1.4;
            if (Math.hypot(b.x - camera.position.x, b.z - camera.position.z) < 700) splashBurst(b.x, wy, b.z, 6, 0.5);
          }
        } else if (b.phase === 'climb') {
          b.y = damp(b.y, wy + b.hgt, 1.5, dt);
          b.a += b.sp * dt;
          b.x = damp(b.x, sc.x + Math.cos(b.a) * b.rad, 1, dt);
          b.z = damp(b.z, sc.z + Math.sin(b.a) * b.rad, 1, dt);
          b.flap = 0.55;
          if (b.t <= 0) { b.phase = 'circle'; b.t = rand(2, 7); }
        }
      }
      setBird(bi++, b);
    }
  });
  // a few gulls hanging off the stern looking for scraps
  for (let k = 0; k < 5; k++) {
    const a = time * (0.3 + k * 0.05) + k * 1.3, rad = 7 + k * 1.5;
    _tp.x = S.x + sh * 4 + Math.cos(a) * rad; _tp.z = S.z + ch * 4 + Math.sin(a) * rad;
    setBird(bi++, { x: _tp.x, y: 10 + k * 0.8 + Math.sin(a * 1.7) * 1.2, z: _tp.z, a, sp: 1, flap: 0.4, scale: 0.9, phase: 'circle' });
  }
  birdMesh.count = bi;
  birdMesh.instanceMatrix.needsUpdate = true;
  birdMesh.geometry.attributes.aFlap.needsUpdate = true;

  // ---- the fleet and the buoy
  for (const [i, f] of fleet.entries()) {
    f.a += f.sp * dt;
    const x = f.cx + Math.cos(f.a) * f.r, z = f.cz + Math.sin(f.a) * f.r;
    const hdg = Math.atan2(-Math.sin(f.a) * Math.sign(f.sp), Math.cos(f.a) * Math.sign(f.sp));
    P[PR.ai + i].set(x, z);
    f.y = damp(f.y, PH[PR.ai + i], 3, dt);
    f.ref.group.position.set(x, f.y, z);
    f.ref.group.rotation.set(Math.sin(time * 0.9 + i) * 0.04, hdg, Math.sin(time * 0.7 + i * 2) * 0.05, 'YXZ');
  }
  P[PR.buoy].set(BUOY.x, BUOY.z);
  buoy.position.set(BUOY.x, PH[PR.buoy] - 0.2, BUOY.z);
  buoy.rotation.set(Math.sin(time * 1.3) * 0.12, 0, Math.cos(time * 1.1) * 0.1);
  P[PR.center].set(S.x, S.z);
  lighthouseBeam.rotation.y = time * 0.5;

  // ---- camera: behind the boat toward the sunset, swinging with the heading, backing off for a fight
  const diff = wrap(S.h - SUN_YAW);
  camYaw = dampAngle(camYaw, SUN_YAW + 0.55 * Math.sin(diff), 1.1, dt);
  const ldx = Math.sin(camYaw), ldz = Math.cos(camYaw);
  const fx2 = fight ? lerp(S.x, fight.pos.x, 0.3) : S.x, fz2 = fight ? lerp(S.z, fight.pos.z, 0.3) : S.z;
  camFX = damp(camFX, fx2, 3, dt);
  camFZ = damp(camFZ, fz2, 3, dt);
  camY = damp(camY, S.y, 1.5, dt);
  planeY = damp(planeY, S.y - draft, 3, dt);
  const portrait = clamp((0.9 - camera.aspect) / 0.45, 0, 1);
  const dist = (24 + camZoom + (fight ? clamp(fight.L * 0.12, 0, 9) : 0)) * (1 + portrait * 0.35), el = 0.6;
  camera.position.set(camFX - ldx * dist * Math.cos(el), camY * 0.4 + dist * Math.sin(el) + 1, camFZ - ldz * dist * Math.cos(el));
  camera.lookAt(camFX + ldx * 16, camY * 0.4 + 1 + portrait * 2, camFZ + ldz * 16);
  E.setFov(55 + portrait * 10 + (reduceMotion ? 0 : Math.max(0, S.u) * 0.3));

  Sound.engineUpdate(S.throttle, S.sea);
  Sound.wind(0.03 + Math.abs(S.u) * 0.01, 420 + Math.abs(S.u) * 60);
  if (toastTimer > 0) { toastTimer -= dt; if (toastTimer <= 0) toastEl.classList.remove('show'); }
  hudAcc += dt;
  if (hudAcc > 0.1) { hudAcc = 0; updateHudNow(lureState, kn); }
  chartAcc += dt;
  if (chartAcc > 0.25) { chartAcc = 0; drawChart(); }
}

function setBird(i, b) {
  if (i >= BIRD_MAX) return;
  const dx = Math.cos(b.a + Math.PI / 2 * Math.sign(b.sp || 1)), dz = Math.sin(b.a + Math.PI / 2 * Math.sign(b.sp || 1));
  const yaw = b.phase === 'rest' ? b.a : Math.atan2(dx, dz);
  const pitch = b.phase === 'dive' ? 1.1 : b.phase === 'climb' ? -0.4 : 0;
  const bank = b.phase === 'circle' ? -0.35 * Math.sign(b.sp || 1) : 0;
  _q.setFromEuler(_e.set(pitch, yaw, bank, 'YXZ'));
  _s.setScalar(b.scale || 1);
  _v.set(b.x, b.y, b.z);
  birdMesh.setMatrixAt(i, _m.compose(_v, _q, _s));
  birdMesh.geometry.attributes.aFlap.array[i] = b.flap ?? 0.4;
}

function gameOver() {
  ended = true;
  document.getElementById('endTitle').textContent = 'Swamped off the Point';
  document.getElementById('endText').textContent = `She had ${Math.round(S.swampW * 1000).toLocaleString()} litres on deck, more than the scuppers could clear. Take the seas about 45° off the bow and ease off before the next one.`;
  document.getElementById('endCount').textContent = landed.length;
  document.getElementById('endLb').textContent = S.lb;
  document.getElementById('endScore').textContent = S.score;
  const log = document.getElementById('endLog');
  log.innerHTML = '';
  for (const c of landed) { const li = document.createElement('li'); li.innerHTML = `<span></span><span></span>`; li.children[0].textContent = c.name; li.children[1].textContent = `${c.lb} lb · ${c.pts}`; log.append(li); }
  if (!landed.length) { const li = document.createElement('li'); li.textContent = 'No fish this time.'; log.append(li); }
  endEl.classList.remove('gone');
}

// ================================================================ HUD
const $ = id => document.getElementById(id);
const el = {
  speed: $('speed'), thr: $('thr'), thrFill: $('thrFill'), thrBar: $('thrBar'), seaLabel: $('seaLabel'), waveArrow: $('waveArrow'),
  waterPanel: $('waterPanel'), waterL: $('waterL'), waterFill: $('waterFill'), inRate: $('inRate'), outRate: $('outRate'),
  lineState: $('lineState'), fight: $('fight'), mood: $('mood'), lineOut: $('lineOut'), dragLb: $('dragLb'), tensionFill: $('tensionFill'),
  dragMark: $('dragMark'), sweet: $('sweetZone'), danger: $('dangerZone'), stamFill: $('stamFill'), species: $('species'),
  fishCount: $('fishCount'), totalLb: $('totalLb'), score: $('score'),
};
{
  const arc = (a0, a1, r0, r1) => {
    const p = (a, r) => `${(Math.sin(a) * r).toFixed(2)},${(-Math.cos(a) * r).toFixed(2)}`;
    return `M${p(a0, r1)} A${r1},${r1} 0 0 1 ${p(a1, r1)} L${p(a1, r0)} A${r0},${r0} 0 0 0 ${p(a0, r0)}Z`;
  };
  const d = x => x * Math.PI / 180;
  $('dialGood').setAttribute('d', arc(d(25), d(65), 30, 46) + arc(d(-65), d(-25), 30, 46));
  $('dialOk').setAttribute('d', arc(d(115), d(150), 30, 46) + arc(d(-150), d(-115), 30, 46));
}
function updateHudNow(lureState = 'swim', kn = 0) {
  el.speed.textContent = (S.u * 1.944).toFixed(1);
  el.thr.textContent = S.throttle < 0 ? `astern ${Math.round(-S.throttle * 100)}%` : `${Math.round(S.throttle * 100)}%`;
  el.thrFill.style.transform = `scaleX(${Math.abs(S.throttle)})`;
  el.thrBar.classList.toggle('astern', S.throttle < 0);
  const relDeg = S.rel * 180 / Math.PI, a = Math.abs(relDeg);
  el.waveArrow.setAttribute('transform', `rotate(${(-relDeg).toFixed(1)})`);
  let label = 'Quartering · clean', cls = 'good';
  if (S.sea < 1.0 && !(a < 25 && S.u > 7)) { label = 'Easy sea'; cls = 'good'; }
  else if (a < 25) { label = S.u > 4 ? 'Head-on · stuffing the bow' : 'Head-on · ease into it'; cls = S.u > 4 ? 'bad' : 'warn'; }
  else if (a < 65) { label = 'Bow quartering · clean'; cls = 'good'; }
  else if (a < 115) { label = 'Beam-on · she\'ll roll'; cls = 'bad'; }
  else if (a < 150) { label = 'Stern quartering'; cls = S.u > 4 ? 'good' : 'warn'; }
  else { label = S.u > 5 ? 'Following sea · running with it' : 'Following sea · watch the transom'; cls = S.u > 5 ? 'warn' : 'bad'; }
  el.seaLabel.textContent = S.rip > 0.3 && S.sea >= 1.0 ? `In the rip · ${label}` : label;
  el.seaLabel.className = `sea-label ${cls}`;
  const frac = S.water / tier.cap;
  el.waterL.textContent = `${Math.round(S.water * 1000).toLocaleString()} L`;
  el.waterFill.style.transform = `scaleX(${clamp(frac, 0, 1)})`;
  el.waterPanel.classList.toggle('warn', frac > 0.35 && frac <= 0.65);
  el.waterPanel.classList.toggle('bad', frac > 0.65);
  el.inRate.textContent = `in ${Math.round(S.inRate * 1000).toLocaleString()} L/s`;
  el.inRate.classList.toggle('hot', S.inRate > S.outRate + 0.01);
  el.outRate.textContent = `scuppers ${Math.round(S.outRate * 1000).toLocaleString()} L/s`;
  el.fishCount.textContent = landed.length;
  el.totalLb.textContent = S.lb;
  el.score.textContent = S.score;

  el.fight.hidden = !fight;
  if (fight) {
    const f = fight;
    el.lineState.hidden = true;
    const ann = f.next ? MOODS[f.next] : MOODS[f.mood];
    let mood = f.next ? `${ann.label.replace('!', '')} coming…` : ann.label;
    let mcls = ann.cls;
    if (f.gaffReady) { mood = 'Gaff ready · hold her astern'; mcls = ''; }
    else if (f.chafeT > 0.3) { mood = 'Line on the hull! Turn the boat'; mcls = 'bad'; }
    else if (f.slackT > 1) { mood = 'Slack line! Reel!'; mcls = 'bad'; }
    else if (f.payV > 1.5 && S.u > 3) { mood = 'Throttle back!'; mcls = 'bad'; }
    el.mood.textContent = mood;
    el.mood.className = `mood ${mcls}`;
    el.lineOut.textContent = Math.round(f.L);
    el.dragLb.textContent = Math.round(S.drag);
    const max = LINE_BREAK;
    el.tensionFill.style.transform = `scaleX(${clamp(f.T / max, 0, 1)})`;
    const dragN = S.drag * 4.448;
    el.dragMark.style.left = `${clamp(dragN / max, 0, 1) * 100}%`;
    el.sweet.style.left = `${clamp(f.P0 * 0.35 / max, 0, 1) * 100}%`;
    el.sweet.style.width = `${clamp(f.P0 * 0.75 / max, 0, 1) * 100}%`;
    el.danger.style.width = `${(1 - 190 / max) * 100}%`;
    el.stamFill.style.transform = `scaleX(${f.stam})`;
    el.species.textContent = f.pos.y > -3 || f.L < 20 ? f.sp.name : 'Something big…';
  } else {
    el.lineState.hidden = false;
    let txt = 'Lines in · press L to set the spread', c = '';
    if (lines.mode === 'setting') txt = 'Setting the spread…';
    else if (lines.mode === 'clearing') txt = 'Clearing lines…';
    else if (lines.mode === 'out') {
      if (lines.tangled) { txt = 'Lines tangled · L to clear them'; c = 'warn'; }
      else if (lureState === 'sink') { txt = `${kn.toFixed(1)} kn · too slow, the lures are sinking`; c = 'warn'; }
      else if (lureState === 'skip') { txt = `${kn.toFixed(1)} kn · too fast, the lures are skipping`; c = 'warn'; }
      else { txt = `${kn.toFixed(1)} kn · lures swimming. Find the birds`; c = 'good'; }
    }
    el.lineState.textContent = txt;
    el.lineState.className = `line-state ${c}`;
  }
}

// chart: coast, rips, birds you've spotted, the fleet and you
const chart = $('chart'), cx2 = chart.getContext('2d');
const CH = { x0: -1500, x1: 2700, z0: -1450, z1: 1450 };
const cpx = x => (x - CH.x0) / (CH.x1 - CH.x0) * chart.width, cpz = z => (z - CH.z0) / (CH.z1 - CH.z0) * chart.height;
function drawChart() {
  const c = cx2, W = chart.width, H = chart.height;
  c.fillStyle = '#1b3a52'; c.fillRect(0, 0, W, H);
  c.fillStyle = 'rgba(255,255,255,0.06)';
  for (const R of RIPS) { c.beginPath(); c.ellipse(cpx(R.x), cpz(R.z), R.a / (CH.x1 - CH.x0) * W, R.b / (CH.z1 - CH.z0) * H, 0, 0, TAU); c.fill(); }
  c.fillStyle = '#d7c08a';
  c.beginPath();
  COAST.forEach(([x, z], i) => (i ? c.lineTo(cpx(x), cpz(z)) : c.moveTo(cpx(x), cpz(z))));
  c.closePath(); c.fill();
  c.fillStyle = '#ffc35c';
  c.beginPath(); c.arc(cpx(LIGHTHOUSE.x), cpz(LIGHTHOUSE.z), 4, 0, TAU); c.fill();
  c.fillStyle = '#ef5b3f';
  c.beginPath(); c.arc(cpx(BUOY.x), cpz(BUOY.z), 3, 0, TAU); c.fill();
  c.strokeStyle = '#fff4e4'; c.lineWidth = 2;
  for (const sc of schools) {
    if (sc.spotted <= 0) continue;
    const x = cpx(sc.x), y = cpz(sc.z);
    for (const o of [-6, 0, 6]) { c.beginPath(); c.moveTo(x + o - 3, y - 1); c.lineTo(x + o, y + 2); c.lineTo(x + o + 3, y - 1); c.stroke(); }
  }
  c.fillStyle = 'rgba(255,244,228,0.7)';
  for (const f of fleet) { const p = f.ref.group.position; c.beginPath(); c.arc(cpx(p.x), cpz(p.z), 2.5, 0, TAU); c.fill(); }
  c.save();
  c.translate(cpx(S.x), cpz(S.z));
  c.rotate(-S.h + Math.PI);
  c.fillStyle = '#ff7a3d'; c.strokeStyle = '#13213a'; c.lineWidth = 1.5;
  c.beginPath(); c.moveTo(0, -9); c.lineTo(6, 7); c.lineTo(-6, 7); c.closePath(); c.fill(); c.stroke();
  c.restore();
  c.fillStyle = 'rgba(255,244,228,0.75)'; c.font = '600 15px "Baloo 2", sans-serif';
  c.fillText('Montauk Pt.', cpx(-1350), cpz(120));
  c.fillText('Block Island Sound', cpx(-200), cpz(-1250));
  c.fillText('Atlantic', cpx(1500), cpz(1250));
}

// ================================================================ loop
reset();
const clock = new THREE.Clock();
function frame() {
  requestAnimationFrame(frame);
  const raw = clock.getDelta();
  const dt = clamp(raw, 1e-4, 0.05);
  update(dt);
  if (!Number.isFinite(S.x + S.z + S.h + S.u + S.y + S.water + S.pitch + S.roll)) {
    Object.assign(S, { x: Number.isFinite(S.x) ? S.x : START.x, z: Number.isFinite(S.z) ? S.z : START.z, h: Number.isFinite(S.h) ? S.h : START.h, u: 0, v: 0, r: 0, y: 0, vy: 0, pitch: 0, vp: 0, roll: 0, vr: 0, water: Number.isFinite(S.water) ? S.water : 0 });
  }
  E.render({ dt, rawDt: raw, time, boatX: S.x, boatZ: S.z, heading: S.h, speed: Math.max(0, S.u), planeY, focusX: S.x, focusZ: S.z });
}
frame();
