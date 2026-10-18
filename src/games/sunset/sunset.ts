// Sunset Skipper: a tiny toon sailboat chasing sun stars across a sunset sea.
import * as THREE from 'three';
import { createEngine } from '../../engine/engine';
import { TAU, clamp, lerp, damp, wrap, dampAngle, smooth, rand, reduceMotion } from '../../engine/math';
import { SoundBed, bindSoundButton } from '../../engine/audio';
import { createInput, createLever, blockPageZoom, createToast } from '../../ui/controls';
import type { GameContext, GameHandle } from '../types';
import hudHtml from './sunset.html?raw';
import './sunset.css';

interface Island { x: number; z: number; r: number; beam?: THREE.Object3D }
interface Star { g: THREE.Group; m: THREE.Mesh; ph: number; x: number; z: number }
interface Gull { g: THREE.Group; wR: THREE.Group; wL: THREE.Group; a: number; r: number; h: number; sp: number; ph: number }

const ISLANDS: Island[] = [
  { x: 60, z: -140, r: 18 }, { x: -120, z: -60, r: 26 }, { x: -40, z: 150, r: 14 },
  { x: 210, z: 80, r: 30 }, { x: -260, z: -290, r: 40 }, { x: 320, z: -330, r: 22 },
];
const shoreFn = (x: number, z: number): number => ISLANDS.reduce((m, I) => Math.min(m, Math.hypot(x - I.x, z - I.z) - I.r), 1e4);

// sailing performance: boat speed fraction by angle between bow and where the wind blows to
const POLAR: [number, number][] = [[0, 0.72], [30, 0.8], [60, 0.95], [90, 1.0], [110, 0.93], [130, 0.6], [145, 0.15], [155, 0], [180, 0]];
function polar(alpha: number): number {
  const deg = alpha * 180 / Math.PI;
  for (let i = 1; i < POLAR.length; i++) {
    if (deg <= POLAR[i][0]) { const [a0, v0] = POLAR[i - 1], [a1, v1] = POLAR[i]; return lerp(v0, v1, (deg - a0) / (a1 - a0)); }
  }
  return 0;
}
function pointOfSail(alpha: number): string {
  const d = alpha * 180 / Math.PI;
  if (d > 152) return 'In irons';
  if (d > 118) return 'Close hauled';
  if (d > 68) return 'Beam reach';
  if (d > 22) return 'Broad reach';
  return 'Running';
}
function hullXform(x: number, y: number, z: number): [number, number, number] {
  const bow = Math.max(z, 0), st = Math.max(-z, 0);
  return [x * 0.86 * (1 - 0.45 * bow * bow), y * 0.78 + 0.24 * bow * bow + 0.06 * st * st, z * (z > 0 ? 1.7 : 1.35)];
}

export function mount({ root, exit }: GameContext): GameHandle {
  root.classList.add('game', 'sunset');
  root.innerHTML = hudHtml;
  const $ = <T extends Element = HTMLElement>(sel: string): T => root.querySelector<T>(sel)!;
  const ac = new AbortController();
  const signal = ac.signal;
  blockPageZoom(signal);

  const canvas = $<HTMLCanvasElement>('canvas.scene');
  const E = createEngine({
    canvas,
    sunDir: new THREE.Vector3(0.0, 0.075, -1),
    ocean: { windSpeed: 7.5, fetch: 80000, dir: Math.atan2(0.94, 0.34), amp: 1.15, chop: 1.1, swell: 0.45 },
    shore: { fn: shoreFn, cx: 0, cz: 0, size: 1600, res: 512 },
    skyline: [[-0.55, 160, 260], [-0.38, 110, 200], [-0.26, 70, 160], [0.24, 90, 180], [0.36, 200, 300], [0.52, 120, 220], [1.6, 60, 260], [-1.9, 80, 300], [2.6, 70, 240]],
    hull: [0.9, 1.65, 1.35],
    probes: 16,
  });
  const { scene, camera, toon, addOutline, canvasTex, addLayers, emit, spawnWindLine, Probe, Sim, L_REFLECT, L_REFRACT, SUN_YAW } = E;

  // ---------------------------------------------------------------- the boat
  const WOOD = toon('#a8693b');
  const CREAM = toon('#fff1d6');
  const GOLD = toon('#ffc947', { emissive: '#5a3000' });

  const boat = new THREE.Group();
  scene.add(boat);
  let rig!: THREE.Group, boom!: THREE.Mesh, pennant!: THREE.Mesh;
  let sailGeo!: THREE.PlaneGeometry, sailBase!: Float32Array, pennantBase!: Float32Array;
  {
    const hullTex = canvasTex(8, 256, (g, w, h) => {
      g.fillStyle = '#e8473a'; g.fillRect(0, 0, w, h * 0.46);
      g.fillStyle = '#ffd05a'; g.fillRect(0, h * 0.46, w, h * 0.07);
      g.fillStyle = '#fff1dc'; g.fillRect(0, h * 0.53, w, h);
      g.fillStyle = '#c23a30'; g.fillRect(0, h * 0.06, w, 3);
    });
    const hullGeo = new THREE.SphereGeometry(1, 40, 20, 0, TAU, Math.PI / 2, Math.PI / 2);
    const p = hullGeo.attributes.position;
    for (let i = 0; i < p.count; i++) p.setXYZ(i, ...hullXform(p.getX(i), p.getY(i), p.getZ(i)));
    hullGeo.computeVertexNormals();
    const hull = new THREE.Mesh(hullGeo, toon('#ffffff', { map: hullTex, side: THREE.DoubleSide, rim: 0.7 }));
    addOutline(hull, 0.035);
    boat.add(hull);

    const ring: THREE.Vector3[] = [];
    for (let i = 0; i < 72; i++) {
      const a = i / 72 * TAU;
      ring.push(new THREE.Vector3(...hullXform(Math.cos(a), 0, Math.sin(a))));
    }
    const deckTex = canvasTex(256, 256, (g, w, h) => {
      g.fillStyle = '#c98a52'; g.fillRect(0, 0, w, h);
      g.strokeStyle = 'rgba(90,45,20,0.45)'; g.lineWidth = 3;
      for (let x = 0; x <= w; x += 32) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    });
    const deckGeo = new THREE.ShapeGeometry(new THREE.Shape(ring.map(v => new THREE.Vector2(v.x * 0.96, -v.z * 0.96))));
    deckGeo.rotateX(-Math.PI / 2);
    const uv = deckGeo.attributes.uv, dp = deckGeo.attributes.position;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, dp.getX(i) * 0.5 + 0.5, dp.getZ(i) * 0.3 + 0.5);
    const deck = new THREE.Mesh(deckGeo, toon('#ffffff', { map: deckTex }));
    deck.position.y = 0.03;
    boat.add(deck);
    const rimCurve = new THREE.CatmullRomCurve3(ring.map(v => new THREE.Vector3(v.x, v.y + 0.03, v.z)), true);
    const rimMesh = new THREE.Mesh(new THREE.TubeGeometry(rimCurve, 120, 0.075, 8, true), CREAM);
    addOutline(rimMesh, 0.025);
    boat.add(rimMesh);

    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), GOLD);
    knob.position.set(0, 0.3, 1.72);
    addOutline(knob, 0.02);
    boat.add(knob);

    const eyeWhite = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.95, 0.92, 0.86), polygonOffset: true, polygonOffsetFactor: -2 });
    const eyeDark = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.03, 0.02, 0.05), polygonOffset: true, polygonOffsetFactor: -3 });
    const eyeShine = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.4, 1.4, 1.4), polygonOffset: true, polygonOffsetFactor: -4 });
    for (const sx of [1, -1]) {
      const n = new THREE.Vector3(sx * 0.66, -0.3, 0.69).normalize();
      const f = (v: THREE.Vector3): THREE.Vector3 => new THREE.Vector3(...hullXform(v.x, v.y, v.z));
      const p0 = f(n);
      const t1 = new THREE.Vector3(0, 1, 0).sub(n.clone().multiplyScalar(n.y)).normalize();
      const t2 = new THREE.Vector3().crossVectors(n, t1);
      const a1 = f(n.clone().addScaledVector(t1, 0.01).normalize()).sub(p0);
      const a2 = f(n.clone().addScaledVector(t2, 0.01).normalize()).sub(p0);
      const nrm = new THREE.Vector3().crossVectors(a1, a2).normalize();
      if (nrm.dot(new THREE.Vector3(p0.x, 0, p0.z)) < 0) nrm.negate();
      const eye = new THREE.Group();
      eye.position.copy(p0).addScaledVector(nrm, 0.012);
      eye.lookAt(eye.position.clone().add(nrm));
      const ring2 = new THREE.Mesh(new THREE.CircleGeometry(0.215, 28), eyeDark);
      const white = new THREE.Mesh(new THREE.CircleGeometry(0.185, 28), eyeWhite);
      white.position.z = 0.003;
      const pupil = new THREE.Mesh(new THREE.CircleGeometry(0.11, 24), eyeDark);
      pupil.position.set(sx > 0 ? -0.045 : 0.045, -0.01, 0.006);
      const shine = new THREE.Mesh(new THREE.CircleGeometry(0.035, 12), eyeShine);
      shine.position.set(pupil.position.x + 0.035, 0.035, 0.009);
      eye.add(ring2, white, pupil, shine);
      boat.add(eye);
    }

    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.09, 3.65, 10), WOOD);
    mast.position.set(0, 1.82, 0.25);
    addOutline(mast, 0.025);
    boat.add(mast);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12), GOLD);
    cap.position.set(0, 3.68, 0.25);
    addOutline(cap, 0.02);
    boat.add(cap);

    const pg = new THREE.PlaneGeometry(0.75, 0.3, 10, 1);
    pg.translate(0.375, 0, 0);
    const pp = pg.attributes.position;
    for (let i = 0; i < pp.count; i++) pp.setY(i, pp.getY(i) * (1 - pp.getX(i) / 0.75 * 0.92));
    pennantBase = Float32Array.from(pp.array);
    pennant = new THREE.Mesh(pg, toon('#ff7559', { side: THREE.DoubleSide }));
    pennant.position.set(0, 3.5, 0.25);
    boat.add(pennant);

    rig = new THREE.Group();
    rig.position.set(0, 0, 0.25);
    boat.add(rig);
    const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 2.8, 8), WOOD);
    yard.rotation.z = Math.PI / 2;
    yard.position.set(0, 3.22, 0.1);
    addOutline(yard, 0.022);
    rig.add(yard);
    boom = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.7, 8), WOOD);
    boom.rotation.z = Math.PI / 2;
    boom.position.set(0, 0.95, 0.1);
    addOutline(boom, 0.022);
    rig.add(boom);

    const sailTex = canvasTex(512, 512, (g, w, h) => {
      g.fillStyle = '#fff4e0'; g.fillRect(0, 0, w, h);
      g.strokeStyle = 'rgba(170,120,80,0.28)'; g.lineWidth = 3;
      for (let i = 1; i < 6; i++) { g.beginPath(); g.moveTo(i * w / 6, 0); g.lineTo(i * w / 6, h); g.stroke(); }
      g.fillStyle = '#ff6f59'; g.fillRect(0, h - 70, w, 70); g.fillRect(0, 0, w, 22);
      g.save();
      g.translate(w / 2, h * 0.47);
      g.fillStyle = '#ffbe3d';
      for (let i = 0; i < 12; i++) { g.rotate(TAU / 12); g.beginPath(); g.moveTo(-14, -96); g.lineTo(0, -132); g.lineTo(14, -96); g.fill(); }
      g.beginPath(); g.arc(0, 0, 88, 0, TAU); g.fill();
      g.beginPath(); g.arc(0, 0, 88, 0, TAU); g.clip();
      g.strokeStyle = '#ff6f59'; g.lineWidth = 15; g.lineCap = 'round';
      for (let k = 0; k < 3; k++) {
        g.beginPath();
        const y = 14 + k * 30;
        for (let x = -100; x <= 100; x += 4) g.lineTo(x, y + Math.sin(x * 0.07 + k) * 8);
        g.stroke();
      }
      g.restore();
    });
    sailGeo = new THREE.PlaneGeometry(2.55, 2.25, 18, 16);
    sailBase = Float32Array.from(sailGeo.attributes.position.array);
    const sail = new THREE.Mesh(sailGeo, toon('#ffffff', { map: sailTex, side: THREE.DoubleSide, transl: 0.55, rim: 0.3 }));
    sail.position.z = 0.14;
    sail.frustumCulled = false;
    rig.add(sail);

    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.7, 6), WOOD);
    post.position.set(0, 0.35, -1.18);
    boat.add(post);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.11, 14, 10), new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 1.9, 0.7) }));
    lamp.position.set(0, 0.78, -1.18);
    boat.add(lamp);
    const lampCap = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.12, 8), toon('#3a2a3e'));
    lampCap.position.set(0, 0.93, -1.18);
    boat.add(lampCap);
    const lampLight = new THREE.PointLight(0xffa040, 2.0, 5, 2);
    lampLight.position.copy(lamp.position);
    boat.add(lampLight);

    const crate = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.36, 0.42), toon('#d39a5c'));
    crate.position.set(0.32, 0.21, -0.55);
    crate.rotation.y = 0.3;
    addOutline(crate, 0.02);
    boat.add(crate);
  }
  addLayers(boat, L_REFLECT, L_REFRACT);

  function updateSail(fill: number, luff: number, amount: number, t: number): void {
    const p = sailGeo.attributes.position, a = p.array as Float32Array;
    const W = 2.55, H = 2.25, top = 3.18;
    const h = H * (0.12 + 0.88 * amount);
    for (let i = 0; i < p.count; i++) {
      const bx = sailBase[i * 3], by = sailBase[i * 3 + 1];
      const u = bx / (W / 2), v = (by + H / 2) / H;
      const edge = 1 - u * u;
      const bulge = fill * 0.55 * edge * Math.pow(Math.sin(Math.PI * v), 0.8) * amount;
      const ripple = Math.abs(fill) * 0.025 * Math.sin(t * 5 + u * 2 + v * 3) * edge;
      const flap = luff * 0.13 * Math.sin(t * 17 + u * 3.5 + v * 5) * edge * (0.3 + v);
      a[i * 3] = bx * (1 - Math.abs(bulge) * 0.06);
      a[i * 3 + 1] = top - (1 - v) * h;
      a[i * 3 + 2] = bulge + ripple + flap;
    }
    p.needsUpdate = true;
    sailGeo.computeVertexNormals();
    boom.position.y = top - h - 0.02;
  }

  // ---------------------------------------------------------------- islands
  {
    const sandMat = toon('#f3d9a4', { rim: 0.35 });
    const grassMat = toon('#7cc85a', { rim: 0.35 });
    const hillMat = toon('#5aa648', { rim: 0.35 });
    const rockMat = toon('#8d7fa6', { rim: 0.3 });
    const trunkMat = toon('#9b6a42');
    const leafMat = toon('#4fae4a', { side: THREE.DoubleSide, rim: 0.4 });
    const nutMat = toon('#6b4426');
    const leafGeo = new THREE.PlaneGeometry(3.4, 1.0, 8, 2);
    leafGeo.rotateX(-Math.PI / 2);
    leafGeo.translate(1.7, 0, 0);
    {
      const p = leafGeo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i);
        p.setY(i, 0.35 * x - 0.13 * x * x);
        p.setZ(i, p.getZ(i) * (1 - (x / 3.4) * 0.85) * (x < 0.3 ? x / 0.3 : 1));
      }
      leafGeo.computeVertexNormals();
    }
    const palm = (h: number, lean: number): THREE.Group => {
      const g = new THREE.Group();
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 6; i++) { const s = i / 6; pts.push(new THREE.Vector3(Math.sin(s * 1.3) * lean, s * h, 0)); }
      const curve = new THREE.CatmullRomCurve3(pts);
      const trunk = new THREE.Mesh(new THREE.TubeGeometry(curve, 12, 0.26, 7, false), trunkMat);
      addOutline(trunk, 0.05);
      g.add(trunk);
      const top = curve.getPoint(1);
      for (let i = 0; i < 7; i++) {
        const leaf = new THREE.Mesh(leafGeo, leafMat);
        leaf.position.copy(top);
        leaf.rotation.set(0, i / 7 * TAU + rand(-0.2, 0.2), rand(-0.15, 0.1));
        g.add(leaf);
      }
      for (let i = 0; i < 3; i++) {
        const nut = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), nutMat);
        nut.position.copy(top).add(new THREE.Vector3(Math.cos(i * 2.1) * 0.3, -0.3, Math.sin(i * 2.1) * 0.3));
        g.add(nut);
      }
      return g;
    };
    ISLANDS.forEach((I, idx) => {
      const g = new THREE.Group();
      g.position.set(I.x, 0, I.z);
      // sand mound reaches well below the waterline so the shallows show a sandy bottom through the water
      const sand = new THREE.Mesh(new THREE.SphereGeometry(I.r * 1.35, 48, 20), sandMat);
      sand.scale.set(1, 0.16, 1);
      sand.position.y = -I.r * 0.16 * 1.35 * 0.72;
      addOutline(sand, 0.04);
      g.add(sand);
      const gr = I.r * 0.72;
      const grass = new THREE.Mesh(new THREE.SphereGeometry(gr, 36, 14), grassMat);
      grass.scale.set(1, 0.24, 1);
      grass.position.y = -0.6;
      addOutline(grass, 0.04);
      g.add(grass);
      const sandTop = sand.position.y;
      const surfY = (d: number): number => d < gr ? -0.6 + 0.24 * gr * Math.sqrt(1 - (d / gr) ** 2) : sandTop + 0.16 * I.r * 1.35 * Math.sqrt(Math.max(0, 1 - (d / (I.r * 1.35)) ** 2));
      if (I.r > 20) {
        const hill = new THREE.Mesh(new THREE.SphereGeometry(I.r * 0.36, 24, 12), hillMat);
        hill.scale.set(1, 1.05, 1);
        hill.position.set(I.r * 0.12, -I.r * 0.08, -I.r * 0.1);
        addOutline(hill, 0.05);
        g.add(hill);
      }
      for (let i = 0; i < 4; i++) {
        const a = rand(0, TAU), d = I.r * rand(0.85, 1.15);
        const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(rand(0.8, 1.8), 0), rockMat);
        rock.position.set(Math.cos(a) * d, surfY(d) + rand(-0.6, 0.2), Math.sin(a) * d);
        rock.rotation.set(rand(0, 3), rand(0, 3), 0);
        addOutline(rock, 0.06);
        g.add(rock);
      }
      const n = Math.max(2, Math.round(I.r / 6));
      for (let i = 0; i < n; i++) {
        const a = i / n * TAU + rand(-0.4, 0.4), d = I.r * rand(0.4, 0.75);
        const pl = palm(rand(5, 8), rand(0.8, 2.2));
        pl.position.set(Math.cos(a) * d, surfY(d) - 0.2, Math.sin(a) * d);
        pl.rotation.y = -a + rand(-0.5, 0.5);
        g.add(pl);
      }
      let beam: THREE.Mesh | null = null;
      if (idx === 3) {
        const lh = new THREE.Group();
        lh.position.set(-I.r * 0.35, surfY(I.r * 0.35) - 0.3, I.r * 0.2);
        ['#fff1dc', '#e8473a', '#fff1dc', '#e8473a'].forEach((c, k) => {
          const seg = new THREE.Mesh(new THREE.CylinderGeometry(1.5 - (k + 1) * 0.18, 1.5 - k * 0.18, 2.4, 16), toon(c));
          seg.position.y = 1.2 + k * 2.4;
          addOutline(seg, 0.06);
          lh.add(seg);
        });
        const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.75, 16, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 3.4, 1.4) }));
        lamp.position.y = 10.4;
        lh.add(lamp);
        const roof = new THREE.Mesh(new THREE.ConeGeometry(1.1, 1.2, 16), toon('#3a2a3e'));
        roof.position.y = 11.6;
        addOutline(roof, 0.05);
        lh.add(roof);
        const beamGeo = new THREE.ConeGeometry(5, 60, 20, 1, true);
        beamGeo.translate(0, -30, 0);
        beamGeo.rotateZ(Math.PI / 2);
        beam = new THREE.Mesh(beamGeo, new THREE.ShaderMaterial({
          transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
          vertexShader: 'varying float vL; void main() { vL = length(position) / 60.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
          fragmentShader: 'varying float vL; void main() { gl_FragColor = vec4(vec3(1.0, 0.8, 0.45), (1.0 - vL) * 0.22); }',
        }));
        beam.position.y = 10.4;
        lh.add(beam);
        g.add(lh);
      }
      scene.add(g);
      addLayers(g, L_REFLECT, L_REFRACT);
      if (beam) { beam.layers.set(0); I.beam = beam; }
    });
  }
  const lighthouseBeam = ISLANDS[3].beam;

  // ---------------------------------------------------------------- sun stars (collectibles)
  const starShape = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const a = i / 10 * TAU + Math.PI / 2, r = i % 2 ? 0.25 : 0.6;
    if (i) starShape.lineTo(Math.cos(a) * r, Math.sin(a) * r); else starShape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  const starGeo = new THREE.ExtrudeGeometry(starShape, { depth: 0.16, bevelEnabled: true, bevelSize: 0.06, bevelThickness: 0.06, bevelSegments: 2 });
  starGeo.center();
  const starMat = toon('#ffd34f', { emissive: '#ff9a1f', emissiveIntensity: 0.9, rim: 0.8 });
  const beamMat = new THREE.ShaderMaterial({
    uniforms: { uTime: E.U.uTime }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    vertexShader: 'varying float vY; varying float vD; void main() { vY = uv.y; vec4 mv = modelViewMatrix * vec4(position, 1.0); vD = -mv.z; gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'uniform float uTime; varying float vY; varying float vD; void main() { gl_FragColor = vec4(vec3(1.0, 0.75, 0.3), pow(1.0 - vY, 2.0) * 0.18 * (0.75 + 0.25 * sin(uTime * 3.0)) * smoothstep(14.0, 40.0, vD)); }',
  });
  const beamGeo = new THREE.CylinderGeometry(0.2, 0.5, 22, 12, 1, true);
  beamGeo.translate(0, 13, 0);
  const stars: Star[] = [];
  for (let i = 0; i < 10; i++) {
    const g = new THREE.Group();
    const m = new THREE.Mesh(starGeo, starMat);
    addOutline(m, 0.035);
    addLayers(m, L_REFLECT);
    const b = new THREE.Mesh(beamGeo, beamMat);
    g.add(m, b);
    scene.add(g);
    stars.push({ g, m, ph: rand(0, TAU), x: 0, z: 0 });
  }

  // ---------------------------------------------------------------- gulls
  const gulls: Gull[] = [];
  {
    const white = toon('#fbf6ee', { rim: 0.6 });
    const grey = toon('#9b98ad');
    const beakMat = toon('#ffad3b');
    for (let i = 0; i < 4; i++) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), white);
      body.scale.set(0.17, 0.15, 0.42);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), white);
      head.position.set(0, 0.06, 0.38);
      const beak = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.14, 6), beakMat);
      beak.rotation.x = Math.PI / 2;
      beak.position.set(0, 0.04, 0.53);
      const wg = new THREE.BoxGeometry(0.95, 0.03, 0.28);
      const wR = new THREE.Group(), wL = new THREE.Group();
      const mR = new THREE.Mesh(wg, white); mR.position.x = 0.47;
      const mL = new THREE.Mesh(wg, white); mL.position.x = -0.47;
      const tR = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.035, 0.24), grey); tR.position.x = 0.85;
      const tL = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.035, 0.24), grey); tL.position.x = -0.85;
      wR.add(mR, tR); wL.add(mL, tL);
      g.add(body, head, beak, wR, wL);
      g.scale.setScalar(1.15);
      scene.add(g);
      gulls.push({ g, wR, wL, a: rand(0, TAU), r: rand(8, 15), h: rand(7, 11), sp: rand(0.25, 0.4) * (Math.random() < 0.5 ? 1 : -1), ph: rand(0, TAU) });
    }
  }

  // ---------------------------------------------------------------- audio + state
  const Sound = new SoundBed();
  const setSound = bindSoundButton(Sound, $<HTMLButtonElement>('#sound'), signal);
  const S = {
    x: 0, z: 0, h: Math.PI, speed: 3.5, sail: 1, rudder: 0, pitch: 0, roll: 0, y: 0,
    hopY: 0, hopV: 0, phi: 0, bill: 0.8, stars: 0, windBase: Math.PI / 2, windTarget: Math.PI / 2, windCd: 0,
  };
  let started = false, time = 0, camYaw = SUN_YAW, camDist = 15, camFX = 0, camFZ = 0, camY = 0, planeY = 0;
  let spawnAcc = 0, sprayAcc = 0, hudAcc = 0;
  const windTo = new THREE.Vector3();
  const toast = createToast($('#toast'));

  function placeStar(s: Star, near: boolean): void {
    for (let tries = 0; tries < 30; tries++) {
      const a = near ? S.h + rand(-0.5, 0.5) : rand(0, TAU);
      const r = near ? rand(30, 45) : rand(45, 170);
      const x = S.x + Math.sin(a) * r, z = S.z + Math.cos(a) * r;
      if (ISLANDS.every(I => Math.hypot(x - I.x, z - I.z) > I.r * 1.35 + 8)) { s.x = x; s.z = z; return; }
    }
  }
  stars.forEach((s, i) => placeStar(s, i === 0));

  // ---------------------------------------------------------------- input
  const input = createInput(root, signal, id => {
    if (!started) { if (id === 'Enter') start(); return; }
    if (id === 'Space' || id === 'hop') hop();
    if (id === 'KeyE' || id === 'wind') callWind();
    if (id === 'Escape') exit();
  });
  const sailLever = createLever($('#sailLever'), { min: 0, max: 1, format: v => `${Math.round(v * 100)}` }, signal, v => { S.sail = v; });
  canvas.addEventListener('wheel', e => { camDist = clamp(camDist + e.deltaY * 0.01, 9, 32); }, { passive: true, signal });
  $('#menuBtn').addEventListener('click', () => exit(), { signal });
  $('#introMenu').addEventListener('click', () => exit(), { signal });

  const introEl = $('#intro');
  function start(): void {
    if (started) return;
    started = true;
    introEl.classList.add('gone');
    setSound(true);
  }
  $('#go').addEventListener('click', start, { signal });

  function hop(): void {
    if (!started || S.hopY > 0.02) return;
    S.hopV = 5.2;
    Sound.burst(900, 0.8, 0.12, 0.25, 0.5);
    Sim.splash(S.x, S.z, 1.6, 0.12);
  }
  function callWind(): void {
    if (!started || S.windCd > 0) return;
    S.windCd = 6;
    S.windTarget = S.h;
    toast.show('The wind follows you');
    Sound.burst(400, 1.2, 0.35, 1.6, 4);
    const dx = Math.sin(S.h), dz = Math.cos(S.h);
    for (let i = 0; i < 8; i++) spawnWindLine(S.x - dx * rand(6, 14) + dz * rand(-6, 6), rand(1.5, 4.5), S.z - dz * rand(6, 14) - dx * rand(-6, 6), dx, dz, true);
  }

  const el = {
    speed: $('#speed'), pos: $('#pos'), stars: $('#stars'), sailPct: $('#sailPct'), sailFill: $('#sailFill'),
    wind: $<SVGGElement>('#windArrow'), star: $<SVGGElement>('#starMark'), nogo: $<SVGPathElement>('#nogo'),
  };

  // ---------------------------------------------------------------- main update
  function update(dt: number): void {
    time += dt;
    const PH = Probe.heights;

    S.windBase = dampAngle(S.windBase, S.windTarget, 0.8, dt);
    const wa = S.windBase + 0.35 * Math.sin(time * 0.021) + 0.15 * Math.sin(time * 0.053 + 1.3);
    windTo.set(Math.sin(wa), 0, Math.cos(wa));
    const windStr = 0.84 + 0.1 * Math.sin(time * 0.07) + 0.06 * Math.sin(time * 0.31 + 2);
    S.windCd = Math.max(0, S.windCd - dt);

    let steer = 0, sailIn = 0;
    if (started) {
      steer = (input.held('KeyA', 'ArrowLeft', 'left') ? 1 : 0) - (input.held('KeyD', 'ArrowRight', 'right') ? 1 : 0);
      sailIn = (input.held('KeyW', 'ArrowUp') ? 1 : 0) - (input.held('KeyS', 'ArrowDown') ? 1 : 0);
    }
    S.rudder = damp(S.rudder, steer, 5, dt);
    S.sail = clamp(S.sail + sailIn * dt * 0.7, 0, 1);

    const ch = Math.cos(S.h), sh = Math.sin(S.h);
    const lx = windTo.x * ch - windTo.z * sh, lz = windTo.x * sh + windTo.z * ch;
    const as = Math.atan2(lx, lz), alpha = Math.abs(as);
    const luff = smooth(2.25, 2.7, alpha);
    const fill = S.sail * windStr * (1 - luff);
    const target = 7.4 * polar(alpha) * S.sail * windStr;
    S.speed = damp(S.speed, target, target > S.speed ? 0.45 : 0.7, dt);
    S.speed *= 1 - Math.abs(S.rudder) * dt * 0.06;
    S.h = wrap(S.h + S.rudder * (0.5 + 0.09 * S.speed) * dt);
    S.x += (sh * S.speed + windTo.x * 0.3 * fill) * dt;
    S.z += (ch * S.speed + windTo.z * 0.3 * fill) * dt;

    for (const I of ISLANDS) {
      const dx = S.x - I.x, dz = S.z - I.z, d = Math.hypot(dx, dz), min = I.r * 1.05 + 1.6;
      if (d < min) { S.x = I.x + dx / d * min; S.z = I.z + dz / d * min; S.speed *= 0.9; }
    }

    // float on the FFT swell (heights read back from the GPU)
    const [hc, hb, hs, hp, hst] = PH;
    S.y = damp(S.y, (hc * 2 + hb + hs + hp + hst) / 6, 8, dt);
    const pitchT = -Math.atan2(hb - hs, 2.6) * 0.85 - S.speed * 0.012;
    const rollT = Math.atan2(hp - hst, 1.6) * 0.7 - Math.sin(as) * fill * 0.2 + S.rudder * S.speed * 0.014;
    S.pitch = damp(S.pitch, pitchT, 6, dt);
    S.roll = damp(S.roll, rollT, 4, dt);
    const P = Probe.pts;
    P[0].set(S.x, S.z);
    P[1].set(S.x + sh * 1.4, S.z + ch * 1.4);
    P[2].set(S.x - sh * 1.2, S.z - ch * 1.2);
    P[3].set(S.x + ch * 0.8, S.z - sh * 0.8);
    P[4].set(S.x - ch * 0.8, S.z + sh * 0.8);

    if (S.hopY > 0 || S.hopV > 0) {
      S.hopV -= 16 * dt;
      S.hopY += S.hopV * dt;
      if (S.hopY <= 0) {
        if (S.hopV < -3) {
          Sound.burst(700, 0.6, 0.3, 0.5, 0.4);
          Sim.splash(S.x, S.z, 2.2, -0.35);
          for (let i = 0; i < 50; i++) {
            const a = rand(0, TAU), sp = rand(1.5, 4.5);
            emit(S.x + Math.cos(a) * 1.2, S.y + 0.1, S.z + Math.sin(a) * 1.6, Math.cos(a) * sp, rand(2.5, 5.5), Math.sin(a) * sp, rand(0.6, 1.1), rand(0.25, 0.5), 1, 0.97, 0.93);
          }
        }
        S.hopY = 0; S.hopV = 0;
      }
    }
    const hopTilt = S.hopY > 0 ? -S.hopV * 0.03 : 0;
    boat.position.set(S.x, S.y + 0.36 + S.hopY, S.z);
    boat.rotation.set(S.pitch + hopTilt, S.h, S.roll, 'YXZ');

    S.phi = damp(S.phi, clamp(as * 0.5, -1.2, 1.2), 3, dt);
    rig.rotation.y = S.phi;
    const billSign = Math.cos(as - S.phi) >= 0 ? 1 : -1;
    S.bill = damp(S.bill, billSign * fill, 3, dt);
    updateSail(S.bill, Math.max(luff, 0.15 * (1 - S.sail)) * S.sail, S.sail, time);

    pennant.rotation.y = Math.atan2(-lz, lx);
    {
      const p = pennant.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = pennantBase[i * 3];
        p.setZ(i, Math.sin(time * 11 - x * 7) * 0.07 * x * (0.5 + windStr));
      }
      p.needsUpdate = true;
    }

    sprayAcc += dt * Math.max(0, S.speed - 1.8) * 10;
    while (sprayAcc > 1) {
      sprayAcc -= 1;
      const side = Math.random() < 0.5 ? 1 : -1;
      const bx = S.x + sh * 1.35 + ch * side * 0.45, bz = S.z + ch * 1.35 - sh * side * 0.45;
      const out = rand(1.2, 2.4);
      emit(bx, S.y + 0.05, bz, ch * side * out + sh * S.speed * 0.5, rand(1.5, 3.2), -sh * side * out + ch * S.speed * 0.5, rand(0.5, 0.9), rand(0.16, 0.34), 1, 0.97, 0.94);
    }

    // camera: hangs behind the boat looking toward the sunset, swinging left/right with your heading
    const diff = wrap(S.h - SUN_YAW);
    camYaw = dampAngle(camYaw, SUN_YAW + 0.55 * Math.sin(diff), 1.1, dt);
    const ldx = Math.sin(camYaw), ldz = Math.cos(camYaw);
    camFX = damp(camFX, S.x, 4, dt);
    camFZ = damp(camFZ, S.z, 4, dt);
    camY = damp(camY, S.y, 1.5, dt);
    planeY = damp(planeY, S.y, 3, dt);
    const portrait = clamp((0.9 - camera.aspect) / 0.45, 0, 1);
    const dist = camDist * (1 + portrait * 0.35), el2 = 0.7;
    camera.position.set(camFX - ldx * dist * Math.cos(el2), camY * 0.4 + dist * Math.sin(el2) + 1, camFZ - ldz * dist * Math.cos(el2));
    camera.lookAt(camFX + ldx * 13, camY * 0.4 + 0.5 + portrait * 2, camFZ + ldz * 13);
    E.setFov(56 + portrait * 10 + (reduceMotion() ? 0 : S.speed * 0.45));

    spawnAcc += dt;
    if (spawnAcc > 0.4) {
      spawnAcc = 0;
      const f = rand(-4, 26), s2 = rand(-16, 16), back = rand(8, 16);
      spawnWindLine(S.x + ldx * f + ldz * s2 - windTo.x * back, rand(1.2, 4.8), S.z + ldz * f - ldx * s2 - windTo.z * back, windTo.x, windTo.z);
    }

    let nearest: Star | null = null, nd = Infinity;
    stars.forEach((s, i) => {
      const d = Math.hypot(s.x - S.x, s.z - S.z);
      if (d > 260) { placeStar(s, false); return; }
      P[5 + i].set(s.x, s.z);
      s.g.position.set(s.x, PH[5 + i] + 1.0 + Math.sin(time * 2 + s.ph) * 0.18, s.z);
      s.m.rotation.y = time * 1.8 + s.ph;
      if (d < 2.8 + S.hopY) {
        S.stars++;
        Sound.chime();
        toast.show(S.stars % 5 === 0 ? `${S.stars} sun stars!` : 'Sun star!');
        Sim.splash(s.x, s.z, 1.2, 0.18);
        for (let k = 0; k < 36; k++) {
          const a = rand(0, TAU), up = rand(1, 5);
          emit(s.g.position.x, s.g.position.y, s.g.position.z, Math.cos(a) * rand(1, 3.5), up, Math.sin(a) * rand(1, 3.5), rand(0.6, 1.2), rand(0.2, 0.4), 3.0, 1.9, 0.6, 3);
        }
        placeStar(s, false);
      } else if (d < nd) { nd = d; nearest = s; }
    });

    for (const G of gulls) {
      G.a += G.sp * dt;
      const cx = S.x + ldx * 18, cz = S.z + ldz * 18;
      const x = cx + Math.cos(G.a) * G.r, z = cz + Math.sin(G.a) * G.r, y = G.h + Math.sin(G.a * 1.7 + G.ph) * 1.2;
      const nx = cx + Math.cos(G.a + G.sp * 0.2) * G.r, nz = cz + Math.sin(G.a + G.sp * 0.2) * G.r;
      G.g.position.set(x, y, z);
      G.g.lookAt(nx, y, nz);
      G.g.rotateZ(-Math.sign(G.sp) * 0.35);
      const flap = Math.sin(time * 4 + G.ph) > -0.2 ? Math.sin(time * 9 + G.ph) * 0.55 : 0.1;
      G.wR.rotation.z = flap; G.wL.rotation.z = -flap;
    }

    if (lighthouseBeam) lighthouseBeam.rotation.y = time * 0.6;
    Sound.wind(0.03 + 0.1 * fill + S.speed * 0.012, 450 + S.speed * 90);
    toast.tick(dt);

    hudAcc += dt;
    if (hudAcc > 0.1) {
      hudAcc = 0;
      el.speed.textContent = (S.speed * 1.944).toFixed(1);
      el.pos.textContent = pointOfSail(alpha);
      el.stars.textContent = String(S.stars);
      el.sailPct.textContent = `${Math.round(S.sail * 100)}%`;
      el.sailFill.style.transform = `scaleX(${S.sail})`;
      sailLever.set(S.sail);
      el.wind.setAttribute('transform', `rotate(${(-as * 180 / Math.PI).toFixed(1)})`);
      const into = -as + Math.PI;
      const a0 = into - 0.5, a1 = into + 0.5, R = 43;
      el.nogo.setAttribute('d', `M${(Math.sin(a0) * R).toFixed(1)},${(-Math.cos(a0) * R).toFixed(1)} A${R},${R} 0 0 1 ${(Math.sin(a1) * R).toFixed(1)},${(-Math.cos(a1) * R).toFixed(1)}`);
      const n = nearest as Star | null;
      if (n) {
        const dx = n.x - S.x, dz = n.z - S.z;
        const slx = dx * ch - dz * sh, slz = dx * sh + dz * ch;
        el.star.setAttribute('transform', `rotate(${(Math.atan2(-slx, slz) * 180 / Math.PI).toFixed(1)})`);
      }
    }
  }

  // Timer (not the deprecated Clock): also pauses cleanly while the tab is hidden
  const timer = new THREE.Timer();
  timer.connect(document);
  let raf = 0, booted = false;
  function frame(now?: number): void {
    raf = requestAnimationFrame(frame);
    timer.update(now);
    const raw = timer.getDelta();
    const dt = clamp(raw, 1e-4, 0.05);
    update(dt);
    E.render({ dt, rawDt: raw, time, boatX: S.x, boatZ: S.z, heading: S.h, speed: S.speed, planeY, focusX: S.x, focusZ: S.z });
    if (!booted) { booted = true; $('#boot').classList.add('gone'); }
  }
  frame();

  return {
    dispose() {
      cancelAnimationFrame(raf);
      timer.dispose();
      ac.abort();
      Sound.dispose();
      E.dispose();
      root.replaceChildren();
    },
  };
}
