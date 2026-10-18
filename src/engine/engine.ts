// Shared ocean renderer for Sunset Skipper and Montauk Rips.
// GPU FFT ocean (3 cascades), interactive ripple sim, GPU height probes, sky, planar reflection,
// refraction with absorption + caustics, toon helpers, particles, wind trails and post-processing.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { TAU, clamp, wrap, smooth, rand, mulberry32, lgamma, isTouchDevice } from './math';

export type RGB = [number, number, number];

export interface SkyPalette {
  horizonSun: RGB; horizonAway: RGB; midSun: RGB; midAway: RGB; zenith: RGB;
  cloudSun: RGB; cloudAway: RGB; cloudDark: RGB;
}
export interface OceanParams {
  windSpeed: number; fetch: number; dir: number; amp: number; chop: number;
  swell: number; swellAngle: number; swellLength: number; foamBias: number; foamScale: number; seed: number;
}
export interface WaterParams { deep: RGB; deepGain: number; sss: RGB }
export interface ShoreField {
  /** Signed metres to the nearest shore: positive over water, negative on land. */
  fn: (x: number, z: number) => number;
  cx: number; cz: number; size: number; res: number;
}
export interface EngineOptions {
  canvas: HTMLCanvasElement;
  sunDir: THREE.Vector3;
  shore: ShoreField;
  sky?: Partial<SkyPalette>;
  ocean?: Partial<OceanParams>;
  water?: Partial<WaterParams>;
  /** GLSL defining `float seaMul(vec2 p)` and `float seaFoam(vec2 p)`. */
  seaGLSL?: string;
  /** Distant peaks: [azimuth offset from the sun, height, radius]. */
  skyline?: RGB[];
  skylineColor?: RGB;
  /** Boat footprint for the wake sim: [half beam, bow length, stern length] in metres. */
  hull?: RGB;
  probes?: number;
  fog?: { color: string; density: number };
  hemi?: [number, number];
  sunColor?: number;
  exposure?: number;
  fov?: number;
}
export interface RenderState {
  dt: number; rawDt?: number; time: number;
  boatX: number; boatZ: number; heading: number; speed: number;
  planeY: number; focusX: number; focusZ: number;
}
export interface ToonOptions extends THREE.MeshToonMaterialParameters { rim?: number; transl?: number }

const SKY_DEFAULT: SkyPalette = {
  horizonSun: [1.0, 0.6, 0.3], horizonAway: [0.86, 0.5, 0.62], midSun: [0.92, 0.5, 0.52], midAway: [0.5, 0.38, 0.66],
  zenith: [0.16, 0.18, 0.45], cloudSun: [1.0, 0.8, 0.48], cloudAway: [1.0, 0.55, 0.58], cloudDark: [0.46, 0.28, 0.48],
};
const OCEAN_DEFAULT: OceanParams = {
  windSpeed: 7.5, fetch: 80000, dir: 0, amp: 1, chop: 1.1, swell: 0.45, swellAngle: 0.55, swellLength: 95,
  foamBias: 2.62, foamScale: 1.7, seed: 20261017,
};
const WATER_DEFAULT: WaterParams = { deep: [0.02, 0.17, 0.33], deepGain: 1.15, sss: [0.08, 0.62, 0.56] };
const v3 = (a: RGB): string => `vec3(${a.map(n => n.toFixed(4)).join(', ')})`;
type TexUniform = { value: THREE.Texture | null };
const texU = (t: THREE.Texture | null = null): TexUniform => ({ value: t });

export type Engine = ReturnType<typeof createEngine>;

export function createEngine(o: EngineOptions) {
  const mobile = isTouchDevice();
  const canvas = o.canvas;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, mobile ? 1.5 : 1.75));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = o.exposure ?? 0.95;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const FLOAT_OK = renderer.extensions.has('EXT_color_buffer_float');
  const SIM_TYPE = FLOAT_OK ? THREE.FloatType : THREE.HalfFloatType;
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(d: T): T => { disposables.push(d); return d; };

  const scene = new THREE.Scene();
  if (o.fog) scene.fog = new THREE.FogExp2(new THREE.Color(o.fog.color), o.fog.density);
  const camera = new THREE.PerspectiveCamera(o.fov ?? 58, 1, 0.2, 6000);

  const SUN_DIR = o.sunDir.clone().normalize();
  const SUN_YAW = Math.atan2(SUN_DIR.x, SUN_DIR.z);
  const L_REFLECT = 1, L_REFRACT = 2;
  const addLayers = (obj: THREE.Object3D, ...ls: number[]): void => obj.traverse(c => ls.forEach(l => c.layers.enable(l)));

  // ---------------------------------------------------------------- full-screen GPU passes
  const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const fsQuad = new THREE.Mesh(track(new THREE.PlaneGeometry(2, 2)));
  fsQuad.frustumCulled = false;
  const fsScene = new THREE.Scene();
  fsScene.add(fsQuad);
  const FS_VERT = 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }';
  const passMat = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial =>
    track(new THREE.ShaderMaterial({ uniforms, vertexShader: FS_VERT, fragmentShader, depthTest: false, depthWrite: false }));
  const runPass = (mat: THREE.Material, target: THREE.WebGLRenderTarget | null): void => {
    fsQuad.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(fsScene, fsCam);
  };
  const dataRT = (w: number, h: number, type: THREE.TextureDataType, extra: THREE.RenderTargetOptions = {}): THREE.WebGLRenderTarget =>
    track(new THREE.WebGLRenderTarget(w, h, {
      type, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false, ...extra,
    }));

  // ---------------------------------------------------------------- configuration
  const OC: OceanParams = { ...OCEAN_DEFAULT, ...o.ocean };
  const SKY: SkyPalette = { ...SKY_DEFAULT, ...o.sky };
  const WATER: WaterParams = { ...WATER_DEFAULT, ...o.water };
  const HULL: RGB = o.hull ?? [0.9, 1.65, 1.35];
  const FFT_N = 256, LOG_N = 8;
  const CASCADE_L: RGB = [250, 37, 7];
  const CUTS = [TAU / CASCADE_L[1] * 6, TAU / CASCADE_L[2] * 6];
  const SIM_N = 512, SIM_SIZE = 96, SIM_TX = SIM_SIZE / SIM_N, SIM_DT = 1 / 120, SIM_C = 4.2;

  // shoreline distance field, baked once
  const SH = o.shore;
  const shoreTex = (() => {
    const R = SH.res, data = new Uint16Array(R * R);
    for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
      const x = SH.cx + ((i + 0.5) / R - 0.5) * SH.size, z = SH.cz + ((j + 0.5) / R - 0.5) * SH.size;
      data[j * R + i] = THREE.DataUtils.toHalfFloat(clamp(SH.fn(x, z), -30000, 30000));
    }
    const t = new THREE.DataTexture(data, R, R, THREE.RedFormat, THREE.HalfFloatType);
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return track(t);
  })();

  const reflRT = track(new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType }));
  const opaqueRT = track(new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(1, 1) }));
  const foamRT = track(new THREE.WebGLRenderTarget(512, 512, {
    depthBuffer: false, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true, anisotropy: 8,
  }));

  const U = {
    uTime: { value: 0 },
    uSunDir: { value: SUN_DIR },
    uCamPos: { value: new THREE.Vector3() },
    uL: { value: new THREE.Vector3(...CASCADE_L) },
    uDisp0: texU(), uDisp1: texU(), uDisp2: texU(),
    uDer0: texU(), uDer1: texU(), uDer2: texU(),
    uSim: texU(),
    uSimRect: { value: new THREE.Vector4(0, 0, SIM_SIZE, 0) },
    uShore: texU(shoreTex),
    uShoreRect: { value: new THREE.Vector4(SH.cx, SH.cz, SH.size, 0) },
    uSeaAmp: { value: 1 },
    uFoamBias: { value: OC.foamBias },
    uFoamScale: { value: OC.foamScale },
    uRefl: texU(reflRT.texture),
    uOpaque: texU(opaqueRT.texture),
    uDepth: texU(opaqueRT.depthTexture),
    uFoamTex: texU(foamRT.texture),
    uReflMatrix: { value: new THREE.Matrix4() },
    uPlaneY: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uNearFar: { value: new THREE.Vector2(camera.near, camera.far) },
    uWaveDir: { value: new THREE.Vector2(Math.cos(OC.dir), Math.sin(OC.dir)) },
  };

  const SKY_GLSL = /* glsl */`
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uCamPos;
vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return s;
}
vec3 skyColor(vec3 d, bool withSun) {
  float yy = max(d.y, 0.0);
  vec2 hz = normalize(d.xz + vec2(1e-5));
  vec2 sz = normalize(uSunDir.xz);
  float az = clamp(dot(hz, sz) * 0.5 + 0.5, 0.0, 1.0);
  vec3 horizon = mix(srgb(${v3(SKY.horizonAway)}), srgb(${v3(SKY.horizonSun)}), az * az);
  vec3 midSky = mix(srgb(${v3(SKY.midAway)}), srgb(${v3(SKY.midSun)}), az * az * az);
  vec3 zenith = srgb(${v3(SKY.zenith)});
  vec3 c = mix(horizon, midSky, smoothstep(0.0, 0.12, yy));
  c = mix(c, zenith, smoothstep(0.1, 0.6, yy));
  float sa = max(dot(d, uSunDir), 0.0);
  c += srgb(vec3(1.0, 0.52, 0.22)) * pow(sa, 6.0) * 0.38;
  c += srgb(vec3(1.0, 0.75, 0.45)) * pow(sa, 60.0) * 0.75;
  if (withSun) c += vec3(7.0, 4.2, 2.0) * smoothstep(0.99955, 0.9998, sa);
  return c;
}
`;

  const OCEAN_GLSL = /* glsl */`
uniform vec3 uL;
uniform sampler2D uDisp0, uDisp1, uDisp2;
uniform sampler2D uSim;
uniform vec4 uSimRect;
uniform sampler2D uShore;
uniform vec4 uShoreRect;
uniform float uSeaAmp;
float shoreDist(vec2 p) { return texture(uShore, (p - uShoreRect.xy) / uShoreRect.z + 0.5).r; }
${o.seaGLSL || 'float seaMul(vec2 p) { return 1.0; }\nfloat seaFoam(vec2 p) { return 0.0; }'}
float shoreAtten(vec2 p) { return mix(0.18, 1.0, smoothstep(-3.0, 30.0, shoreDist(p))) * seaMul(p) * uSeaAmp; }
float simEdge(vec2 uv) {
  return smoothstep(0.0, 0.12, uv.x) * smoothstep(1.0, 0.88, uv.x) * smoothstep(0.0, 0.12, uv.y) * smoothstep(1.0, 0.88, uv.y);
}
`;

  // ---------------------------------------------------------------- FFT ocean
  // Three cascades (250 m, 37 m, 7 m tiles) are evolved in time and inverse-FFT'd together
  // in one 512x768 float texture: left half = displacement spectra, right half = derivative spectra.
  const Ocean = (() => {
    const N = FFT_N, g = 9.81;
    const h0Data = new Float32Array(N * N * 3 * 4);
    {
      const rng = mulberry32(OC.seed);
      const gauss = (): number => { let u = 0; while (u === 0) u = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * rng()); };
      const { windSpeed: U10, fetch: F } = OC;
      const alpha = 0.076 * Math.pow(U10 * U10 / (F * g), 0.22);
      const wp = 22 * Math.pow(g * g / (U10 * F), 1 / 3);
      const swellWp = Math.sqrt(g * TAU / OC.swellLength);
      const jonswap = (w: number, a: number, p: number, gam: number): number => {
        const sig = w <= p ? 0.07 : 0.09;
        const r = Math.exp(-((w - p) ** 2) / (2 * sig * sig * p * p));
        return a * g * g / w ** 5 * Math.exp(-1.25 * (p / w) ** 4) * gam ** r;
      };
      const spread = (th: number, s: number): number =>
        Math.exp(lgamma(s + 1) - lgamma(s + 0.5)) / (2 * Math.sqrt(Math.PI)) * Math.pow(Math.abs(Math.cos(th / 2)), 2 * s);
      for (let c = 0; c < 3; c++) {
        const dk = TAU / CASCADE_L[c];
        const kmin = c === 0 ? 0 : CUTS[c - 1], kmax = c === 2 ? 1e9 : CUTS[c];
        const h = new Float32Array(N * N * 2);
        for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
          if (i === N / 2 || j === N / 2) continue;
          const nx = i < N / 2 ? i : i - N, nz = j < N / 2 ? j : j - N;
          const kx = nx * dk, kz = nz * dk, k = Math.hypot(kx, kz);
          if (k < 1e-6 || k < kmin || k >= kmax) continue;
          const w = Math.sqrt(g * k), dwdk = g / (2 * w), th = Math.atan2(kz, kx);
          const r = w / wp;
          const s = Math.max(2, r <= 1 ? 6.97 * Math.pow(r, 4.06) : 9.77 * Math.pow(r, -2.5));
          let S = jonswap(w, alpha, wp, 3.3) * (0.92 * spread(wrap(th - OC.dir), s) + 0.08 / TAU);
          S += OC.swell * jonswap(w, 0.0035, swellWp, 6) * spread(wrap(th - OC.dir - OC.swellAngle), 22);
          S *= dwdk / k;
          const amp = Math.sqrt(Math.max(S, 0) * dk * dk) * 0.5 * OC.amp;
          h[(j * N + i) * 2] = gauss() * amp;
          h[(j * N + i) * 2 + 1] = gauss() * amp;
        }
        for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
          const q = (j * N + i) * 2, m = (((N - j) % N) * N + ((N - i) % N)) * 2, t = ((c * N + j) * N + i) * 4;
          h0Data[t] = h[q]; h0Data[t + 1] = h[q + 1]; h0Data[t + 2] = h[m]; h0Data[t + 3] = -h[m + 1];
        }
      }
    }
    const h0Tex = track(new THREE.DataTexture(h0Data, N, 3 * N, THREE.RGBAFormat, THREE.FloatType));
    h0Tex.minFilter = h0Tex.magFilter = THREE.NearestFilter;
    h0Tex.needsUpdate = true;

    const fftType = FLOAT_OK ? THREE.FloatType : THREE.HalfFloatType;
    let fa = dataRT(2 * N, 3 * N, fftType), fb = dataRT(2 * N, 3 * N, fftType);

    const CMUL = 'vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }\n';
    const specMat = passMat(CMUL + /* glsl */`
      uniform sampler2D uH0;
      uniform vec3 uL;
      uniform float uT;
      void main() {
        ivec2 id = ivec2(gl_FragCoord.xy);
        int N = ${N};
        int side = id.x / N;
        int lx = id.x - side * N;
        int c = id.y / N;
        int ly = id.y - c * N;
        float L = c == 0 ? uL.x : (c == 1 ? uL.y : uL.z);
        vec4 h0 = texelFetch(uH0, ivec2(lx, id.y), 0);
        vec2 n = vec2(lx, ly);
        n -= float(N) * step(float(N) * 0.5, n);
        vec2 k = 6.2831853 * n / L;
        float kl = length(k);
        float W0 = 6.2831853 / 200.0;
        float w = floor(sqrt(9.81 * kl) / W0) * W0;
        float ph = w * uT;
        vec2 e = vec2(cos(ph), -sin(ph));
        vec2 hk = cmul(h0.xy, e) + cmul(h0.zw, vec2(e.x, -e.y));
        float ik = kl > 1e-6 ? 1.0 / kl : 0.0;
        vec2 ih = vec2(-hk.y, hk.x);
        vec2 dx = ih * k.x * ik, dz = ih * k.y * ik, dy = hk;
        vec2 dyx = ih * k.x, dyz = ih * k.y;
        vec2 dxx = -hk * k.x * k.x * ik, dzz = -hk * k.y * k.y * ik, dxz = -hk * k.x * k.y * ik;
        vec4 A = vec4(dx.x - dz.y, dx.y + dz.x, dy.x - dxz.y, dy.y + dxz.x);
        vec4 B = vec4(dyx.x - dyz.y, dyx.y + dyz.x, dxx.x - dzz.y, dxx.y + dzz.x);
        gl_FragColor = side == 0 ? A : B;
      }`, { uH0: { value: h0Tex }, uL: U.uL, uT: { value: 0 } });

    // Stockham radix-2 inverse FFT, one stage per pass, rows then columns
    const bflyMat = passMat(CMUL + /* glsl */`
      uniform sampler2D uIn;
      uniform float uSub;
      uniform int uHoriz;
      void main() {
        ivec2 id = ivec2(gl_FragCoord.xy);
        int N = ${N};
        int idx = uHoriz == 1 ? id.x % N : id.y % N;
        float fi = float(idx);
        float hs = uSub * 0.5;
        int ev = int(floor(fi / uSub) * hs + mod(fi, hs));
        ivec2 pe = uHoriz == 1 ? ivec2(id.x - idx + ev, id.y) : ivec2(id.x, id.y - idx + ev);
        ivec2 po = uHoriz == 1 ? pe + ivec2(N / 2, 0) : pe + ivec2(0, N / 2);
        vec4 E = texelFetch(uIn, pe, 0), O = texelFetch(uIn, po, 0);
        float ang = 6.2831853 * fi / uSub;
        vec2 w = vec2(cos(ang), sin(ang));
        gl_FragColor = vec4(E.xy + cmul(w, O.xy), E.zw + cmul(w, O.zw));
      }`, { uIn: texU(), uSub: { value: 2 }, uHoriz: { value: 1 } });

    const mergedRT = (): THREE.WebGLRenderTarget => track(new THREE.WebGLRenderTarget(N, N, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true, anisotropy: 8,
    }));
    const disp = [0, 1, 2].map(() => [mergedRT(), mergedRT()]);
    const deriv = [0, 1, 2].map(() => mergedRT());

    const dispMat = passMat(/* glsl */`
      uniform sampler2D uFFT, uPrev;
      uniform float uC, uChop, uDt, uInit;
      void main() {
        ivec2 id = ivec2(gl_FragCoord.xy);
        int N = ${N};
        int row = int(uC) * N + id.y;
        vec4 A = texelFetch(uFFT, ivec2(id.x, row), 0);
        vec4 B = texelFetch(uFFT, ivec2(N + id.x, row), 0);
        float J = (1.0 + uChop * B.z) * (1.0 + uChop * B.w) - uChop * uChop * A.w * A.w;
        if (isnan(J) || isinf(J)) J = 1.0;
        float prev = texelFetch(uPrev, id, 0).w;
        if (isnan(prev) || isinf(prev)) prev = J;
        float turb = uInit > 0.5 ? J : clamp(min(J, prev + uDt * 0.5 / max(J, 0.5)), -4.0, 4.0);
        gl_FragColor = vec4(uChop * A.x, A.z, uChop * A.y, turb);
      }`, { uFFT: texU(), uPrev: texU(), uC: { value: 0 }, uChop: { value: OC.chop }, uDt: { value: 0 }, uInit: { value: 1 } });
    const derMat = passMat(/* glsl */`
      uniform sampler2D uFFT;
      uniform float uC, uChop;
      void main() {
        ivec2 id = ivec2(gl_FragCoord.xy);
        int N = ${N};
        vec4 B = texelFetch(uFFT, ivec2(N + id.x, int(uC) * N + id.y), 0);
        gl_FragColor = vec4(B.x, B.y, uChop * B.z, uChop * B.w);
      }`, { uFFT: texU(), uC: { value: 0 }, uChop: { value: OC.chop } });

    let ping = 0, first = true;
    function step(time: number, dt: number): void {
      specMat.uniforms.uT.value = time % 200;
      runPass(specMat, fa);
      for (const horiz of [1, 0]) {
        for (let s = 0; s < LOG_N; s++) {
          bflyMat.uniforms.uIn.value = fa.texture;
          bflyMat.uniforms.uSub.value = 2 << s;
          bflyMat.uniforms.uHoriz.value = horiz;
          runPass(bflyMat, fb);
          [fa, fb] = [fb, fa];
        }
      }
      ping ^= 1;
      for (let c = 0; c < 3; c++) {
        dispMat.uniforms.uFFT.value = fa.texture;
        dispMat.uniforms.uPrev.value = disp[c][ping ^ 1].texture;
        dispMat.uniforms.uC.value = c;
        dispMat.uniforms.uDt.value = dt;
        dispMat.uniforms.uInit.value = first ? 1 : 0;
        runPass(dispMat, disp[c][ping]);
        derMat.uniforms.uFFT.value = fa.texture;
        derMat.uniforms.uC.value = c;
        runPass(derMat, deriv[c]);
      }
      first = false;
      U.uDisp0.value = disp[0][ping].texture; U.uDisp1.value = disp[1][ping].texture; U.uDisp2.value = disp[2][ping].texture;
      U.uDer0.value = deriv[0].texture; U.uDer1.value = deriv[1].texture; U.uDer2.value = deriv[2].texture;
    }
    return { step };
  })();

  // ---------------------------------------------------------------- interactive ripple sim (wake, splashes)
  const Sim = (() => {
    let a = dataRT(SIM_N, SIM_N, SIM_TYPE), b = dataRT(SIM_N, SIM_N, SIM_TYPE);
    const out = track(new THREE.WebGLRenderTarget(SIM_N, SIM_N, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false }));
    const stepMat = passMat(/* glsl */`
      uniform sampler2D uPrev;
      uniform vec2 uShift;
      uniform float uC2, uDamp, uDt;
      uniform vec4 uBoat;
      uniform vec4 uSplash;
      uniform vec3 uHull;
      const int N = ${SIM_N};
      const float SIZE = ${SIM_SIZE.toFixed(1)};
      float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
      vec4 F(ivec2 p) {
        if (p.x < 0 || p.y < 0 || p.x >= N || p.y >= N) return vec4(0.0);
        return texelFetch(uPrev, p, 0);
      }
      void main() {
        ivec2 id = ivec2(gl_FragCoord.xy);
        ivec2 s = id + ivec2(uShift);
        vec4 c = F(s);
        float l = F(s + ivec2(-1, 0)).r, r = F(s + ivec2(1, 0)).r, d = F(s + ivec2(0, -1)).r, u = F(s + ivec2(0, 1)).r;
        float lap = l + r + d + u - 4.0 * c.r;
        float h = (2.0 * c.r - c.g + uC2 * lap) * uDamp + 0.03 * lap;
        float tx = SIZE / float(N);
        vec2 p = (vec2(id) + 0.5) * tx - SIZE * 0.5;
        vec2 rel = p - uBoat.xy;
        float ch = cos(uBoat.z), sh = sin(uBoat.z);
        float lz = dot(rel, vec2(sh, ch)), lx = dot(rel, vec2(ch, -sh));
        float e = length(vec2(lx / uHull.x, lz / (lz > 0.0 ? uHull.y : uHull.z)));
        float spd = uBoat.w;
        float hull = 1.0 - smoothstep(0.5, 1.0, e);
        h = mix(h, -0.05 - 0.008 * spd, hull * 0.12);
        float ring = smoothstep(1.45, 1.0, e) * smoothstep(0.85, 1.0, e);
        float sd = length(p - uSplash.xy);
        h += uSplash.w * (1.0 - smoothstep(0.0, uSplash.z, sd));
        vec2 q = abs(vec2(id) + 0.5 - float(N) * 0.5) / (float(N) * 0.5);
        h *= mix(0.96, 1.0, 1.0 - smoothstep(0.82, 1.0, max(q.x, q.y)));
        float grad = length(vec2(r - l, u - d)) / (2.0 * tx);
        float foam = c.b * exp(-uDt * 0.55);
        foam += smoothstep(0.12, 0.45, grad) * uDt * 3.0;
        foam += ring * smoothstep(0.6, 5.0, spd) * uDt * 2.2 * (0.5 + hash(p * 3.7 + uDt * floor(uBoat.x * 9.0)));
        foam += (1.0 - smoothstep(0.0, uSplash.z * 1.7, sd)) * step(0.0001, abs(uSplash.w)) * 0.9;
        h = clamp(h, -0.8, 0.8);
        gl_FragColor = vec4(h, c.r, clamp(foam, 0.0, 1.0), 1.0);
      }`, {
      uPrev: texU(), uShift: { value: new THREE.Vector2() }, uC2: { value: (SIM_C * SIM_DT / SIM_TX) ** 2 },
      uDamp: { value: 0.9965 }, uDt: { value: SIM_DT }, uBoat: { value: new THREE.Vector4() }, uSplash: { value: new THREE.Vector4(0, 0, 1, 0) },
      uHull: { value: new THREE.Vector3(...HULL) },
    });
    const outMat = passMat(/* glsl */`
      uniform sampler2D uState;
      const int N = ${SIM_N};
      float H(ivec2 p) { return texelFetch(uState, clamp(p, ivec2(0), ivec2(N - 1)), 0).r; }
      void main() {
        ivec2 id = ivec2(gl_FragCoord.xy);
        vec4 c = texelFetch(uState, id, 0);
        float tx = ${SIM_SIZE.toFixed(1)} / float(N);
        vec2 g = vec2(H(id + ivec2(1, 0)) - H(id - ivec2(1, 0)), H(id + ivec2(0, 1)) - H(id - ivec2(0, 1))) / (2.0 * tx);
        gl_FragColor = vec4(c.r, g, c.b);
      }`, { uState: texU() });

    let cx = 0, cz = 0, acc = 0, shx = 0, shz = 0;
    const splashes: [number, number, number, number][] = [];
    function splash(x: number, z: number, radius: number, strength: number): void {
      if (splashes.length < 16) splashes.push([x, z, radius, strength]);
    }
    function step(dt: number, boatX: number, boatZ: number, heading: number, speed: number): void {
      const ncx = Math.round(boatX / SIM_TX) * SIM_TX, ncz = Math.round(boatZ / SIM_TX) * SIM_TX;
      shx += Math.round((ncx - cx) / SIM_TX); shz += Math.round((ncz - cz) / SIM_TX);
      cx = ncx; cz = ncz;
      acc = Math.min(acc + dt, SIM_DT * 4);
      const su = stepMat.uniforms;
      while (acc >= SIM_DT) {
        acc -= SIM_DT;
        su.uPrev.value = a.texture;
        su.uShift.value.set(shx, shz);
        shx = shz = 0;
        su.uBoat.value.set(boatX - cx, boatZ - cz, heading, speed);
        const sp = splashes.shift();
        if (sp) su.uSplash.value.set(sp[0] - cx, sp[1] - cz, sp[2], sp[3]); else su.uSplash.value.set(0, 0, 1, 0);
        runPass(stepMat, b);
        [a, b] = [b, a];
      }
      outMat.uniforms.uState.value = a.texture;
      runPass(outMat, out);
      U.uSim.value = out.texture;
      U.uSimRect.value.set(cx, cz, SIM_SIZE, 0);
    }
    return { step, splash };
  })();

  // ---------------------------------------------------------------- GPU height probes (async readback, a frame or two late)
  const Probe = (() => {
    const COUNT = o.probes ?? 16;
    const rt = dataRT(COUNT, 1, FLOAT_OK ? THREE.FloatType : THREE.HalfFloatType);
    const pts = Array.from({ length: COUNT }, () => new THREE.Vector2());
    const mat = passMat(OCEAN_GLSL + /* glsl */`
      uniform vec2 uProbe[${COUNT}];
      vec3 dispAt(vec2 p) {
        return (textureLod(uDisp0, p / uL.x, 0.0).xyz + textureLod(uDisp1, p / uL.y, 0.0).xyz + textureLod(uDisp2, p / uL.z, 0.0).xyz) * shoreAtten(p);
      }
      void main() {
        vec2 t = uProbe[int(gl_FragCoord.x)];
        vec2 b = t;
        for (int k = 0; k < 4; k++) b = t - dispAt(b).xz;
        gl_FragColor = vec4(dispAt(b).y, 0.0, 0.0, 1.0);
      }`, { ...U, uProbe: { value: pts } });
    const heights = new Float32Array(COUNT);
    const buf = new Float32Array(COUNT * 4);
    const pbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, buf.byteLength, gl.STREAM_READ);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    let fence: WebGLSync | null = null, broken = false;
    function poll(): void {
      if (!fence) return;
      if (gl.getSyncParameter(fence, gl.SYNC_STATUS) !== gl.SIGNALED) return;
      gl.deleteSync(fence);
      fence = null;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, buf);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      for (let i = 0; i < COUNT; i++) if (Number.isFinite(buf[i * 4])) heights[i] = buf[i * 4];
    }
    function kick(): void {
      if (fence || broken) return;
      runPass(mat, rt);
      try {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
        gl.readPixels(0, 0, COUNT, 1, gl.RGBA, gl.FLOAT, 0);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
      } catch {
        broken = true;
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      }
    }
    function release(): void {
      if (fence) gl.deleteSync(fence);
      gl.deleteBuffer(pbo);
    }
    return { pts, heights, poll, kick, release, count: COUNT };
  })();

  // ---------------------------------------------------------------- procedural foam texture (tileable bubble lace)
  runPass(passMat(/* glsl */`
    vec2 h2(vec2 p) { p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
    vec2 vor(vec2 x, float P) {
      vec2 n = floor(x), f = fract(x);
      float F1 = 8.0, F2 = 8.0;
      for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
        vec2 g = vec2(i, j);
        vec2 r = g + h2(mod(n + g, P)) - f;
        float d = dot(r, r);
        if (d < F1) { F2 = F1; F1 = d; } else if (d < F2) F2 = d;
      }
      return vec2(sqrt(F1), sqrt(F2));
    }
    void main() {
      vec2 uv = gl_FragCoord.xy / 512.0;
      vec2 a = vor(uv * 6.0, 6.0), b = vor(uv * 13.0 + 0.5, 13.0), c = vor(uv * 29.0, 29.0), d = vor(uv * 3.0 + 0.3, 3.0);
      float lace = 1.0 - smoothstep(0.0, 0.16, a.y - a.x);
      float lace2 = 1.0 - smoothstep(0.0, 0.12, b.y - b.x);
      float bub = smoothstep(0.12, 0.5, c.x);
      float blob = 1.0 - smoothstep(0.0, 0.9, d.x);
      float v = clamp(lace * 0.8 + lace2 * 0.55 + blob * 0.35, 0.0, 1.0) * mix(0.7, 1.0, bub);
      gl_FragColor = vec4(v, blob, 0.0, 1.0);
    }`, {}), foamRT);
  renderer.setRenderTarget(null);

  // ---------------------------------------------------------------- sky
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(4000, 48, 24),
    new THREE.ShaderMaterial({
      uniforms: U,
      side: THREE.BackSide,
      depthWrite: false,
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: SKY_GLSL + /* glsl */`
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          vec3 col = skyColor(d, true);
          if (d.y > 0.0) {
            vec2 uv = d.xz / (d.y + 0.06);
            float n = fbm(uv * 0.9 + vec2(uTime * 0.006, 0.0));
            float n2 = fbm(vec2(uv.x * 0.35, uv.y * 1.6) + 7.3 + uTime * 0.004);
            float m = n * 0.65 + n2 * 0.5;
            float cov = smoothstep(0.62, 0.78, m);
            float core = smoothstep(0.74, 0.98, m);
            float hfade = smoothstep(0.004, 0.045, d.y) * (1.0 - smoothstep(0.35, 0.7, d.y));
            float ts = max(dot(d, uSunDir), 0.0);
            vec3 litC = mix(srgb(${v3(SKY.cloudAway)}), srgb(${v3(SKY.cloudSun)}), pow(ts, 4.0)) * (1.0 + 2.5 * pow(ts, 14.0));
            vec3 darkC = srgb(${v3(SKY.cloudDark)});
            col = mix(col, mix(litC, darkC, core * 0.75), cov * hfade * 0.92);
          }
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }),
  );
  sky.renderOrder = -2;
  sky.frustumCulled = false;
  scene.add(sky);

  // distant hazy skyline that rides with the camera
  const skyline = new THREE.Group();
  if (o.skyline && o.skyline.length) {
    const mat = new THREE.ShaderMaterial({
      uniforms: U,
      vertexShader: /* glsl */`
        varying vec3 vW;
        void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: SKY_GLSL + /* glsl */`
        varying vec3 vW;
        void main() {
          vec3 d = normalize(vW - uCamPos);
          vec3 hz = skyColor(normalize(vec3(d.x, 0.0, d.z)), false);
          float h = clamp(vW.y / 200.0, 0.0, 1.0);
          vec3 sil = srgb(${v3(o.skylineColor ?? [0.34, 0.2, 0.42])});
          gl_FragColor = vec4(mix(hz, sil, 0.35 + 0.3 * h), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    for (const [off, h, r] of o.skyline) {
      const geo = new THREE.ConeGeometry(r, h, 9, 3);
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const y = p.getY(i);
        if (y < h / 2 - 1) { p.setX(i, p.getX(i) * rand(0.8, 1.2)); p.setZ(i, p.getZ(i) * rand(0.8, 1.2)); p.setY(i, y + rand(-0.12, 0.12) * h); }
      }
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, mat);
      const az = SUN_YAW + off, R = 2300;
      m.position.set(Math.sin(az) * R, h / 2 - 12, Math.cos(az) * R);
      m.scale.set(1.6, 1, 1);
      m.rotation.y = az;
      skyline.add(m);
    }
    addLayers(skyline, L_REFLECT);
  }
  scene.add(skyline);

  // ---------------------------------------------------------------- water surface
  function makeWaterGeo(N: number, R = 3000): THREE.BufferGeometry {
    const coords = new Float32Array(N + 1), spacing = new Float32Array(N + 1);
    for (let i = 0; i <= N; i++) {
      const u = i / N * 2 - 1, au = Math.abs(u);
      coords[i] = Math.sign(u) * R * (0.02 * au + 0.98 * au ** 5);
      spacing[i] = R * (0.02 + 4.9 * au ** 4) * 2 / N;
    }
    const pos = new Float32Array((N + 1) * (N + 1) * 3), sp = new Float32Array((N + 1) * (N + 1));
    let p = 0, q = 0;
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
      pos[p++] = coords[i]; pos[p++] = 0; pos[p++] = coords[j];
      sp[q++] = Math.max(spacing[i], spacing[j]);
    }
    const idx = new Uint32Array(N * N * 6);
    q = 0;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1;
      idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = d;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSpacing', new THREE.BufferAttribute(sp, 1));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    return geo;
  }

  const waterMat = new THREE.ShaderMaterial({
    uniforms: U,
    side: THREE.DoubleSide,
    vertexShader: SKY_GLSL + OCEAN_GLSL + /* glsl */`
      attribute float aSpacing;
      varying vec3 vWorld;
      varying vec2 vBase;
      varying float vViewZ;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vec2 base = wp.xz;
        float lk = aSpacing * ${FFT_N}.0;
        vec3 d = textureLod(uDisp0, base / uL.x, max(log2(lk / uL.x), 0.0)).xyz
               + textureLod(uDisp1, base / uL.y, max(log2(lk / uL.y), 0.0)).xyz
               + textureLod(uDisp2, base / uL.z, max(log2(lk / uL.z), 0.0)).xyz;
        d *= shoreAtten(base);
        vec2 suv = (base - uSimRect.xy) / uSimRect.z + 0.5;
        float simH = textureLod(uSim, suv, 0.0).r * simEdge(suv);
        wp.xyz = vec3(base.x + d.x, d.y + simH, base.y + d.z);
        vWorld = wp.xyz;
        vBase = base;
        vec4 mv = viewMatrix * wp;
        vViewZ = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: SKY_GLSL + OCEAN_GLSL + /* glsl */`
      uniform sampler2D uDer0, uDer1, uDer2, uFoamTex, uRefl, uOpaque, uDepth;
      uniform mat4 uReflMatrix;
      uniform float uPlaneY, uFoamBias, uFoamScale;
      uniform vec2 uRes, uNearFar, uWaveDir;
      varying vec3 vWorld;
      varying vec2 vBase;
      varying float vViewZ;

      float D_GGX(float NoH, float a) { float a2 = a * a; float f = (NoH * a2 - NoH) * NoH + 1.0; return a2 / (3.14159265 * f * f); }
      float V_SmithGGX(float NoV, float NoL, float a) {
        float a2 = a * a;
        float gvv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
        float glv = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
        return 0.5 / max(gvv + glv, 1e-5);
      }
      vec2 hash22(vec2 p) { p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
      float causticLayer(vec2 p, float t) {
        vec2 n = floor(p), f = fract(p);
        float F1 = 8.0, F2 = 8.0;
        for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
          vec2 g = vec2(i, j);
          vec2 o = 0.5 + 0.45 * sin(t + 6.2831 * hash22(n + g));
          vec2 r = g + o - f;
          float d = dot(r, r);
          if (d < F1) { F2 = F1; F1 = d; } else if (d < F2) F2 = d;
        }
        return sqrt(F2) - sqrt(F1);
      }
      float caustics(vec2 p, float t) {
        float a = causticLayer(p * 0.55, t * 0.9);
        float b = causticLayer(p * 0.75 + 4.1, -t * 0.7 + 1.3);
        return pow(1.0 - smoothstep(0.0, 0.22, a), 3.0) + 0.7 * pow(1.0 - smoothstep(0.0, 0.22, b), 3.0);
      }
      float linDepth(float d) {
        float z = d * 2.0 - 1.0;
        return 2.0 * uNearFar.x * uNearFar.y / (uNearFar.y + uNearFar.x - z * (uNearFar.y - uNearFar.x));
      }

      void main() {
        vec3 toCam = uCamPos - vWorld;
        float dist = length(toCam);
        vec3 V = toCam / dist;

        // ---- surface: three FFT cascades + the interactive ripple sim
        vec2 uv0 = vBase / uL.x, uv1 = vBase / uL.y, uv2 = vBase / uL.z;
        float ia = shoreAtten(vBase);
        vec4 der = (texture(uDer0, uv0) + texture(uDer1, uv1) + texture(uDer2, uv2)) * ia;
        float turb = texture(uDisp0, uv0).w + texture(uDisp1, uv1).w + texture(uDisp2, uv2).w;
        vec2 suv = (vBase - uSimRect.xy) / uSimRect.z + 0.5;
        vec4 sim = texture(uSim, suv) * simEdge(suv);
        vec2 slope = vec2(der.x / max(1.0 + der.z, 0.25), der.y / max(1.0 + der.w, 0.25)) + sim.yz;
        vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));
        float nv = dot(N, V);
        if (nv < 0.04) N = normalize(N + V * (0.04 - nv));

        // ---- lighting terms
        vec3 L = uSunDir;
        vec3 sunRad = srgb(vec3(1.0, 0.72, 0.5)) * 7.0;
        vec3 skyAmb = srgb(vec3(0.62, 0.52, 0.72)) * 0.9;
        float NoV = clamp(dot(N, V), 1e-3, 1.0);
        float NoL = clamp(dot(N, L), 0.0, 1.0);
        vec3 Hv = normalize(L + V);
        float NoH = clamp(dot(N, Hv), 0.0, 1.0);
        float VoH = clamp(dot(V, Hv), 0.0, 1.0);
        float rough = mix(0.05, 0.16, smoothstep(25.0, 1400.0, dist));
        float Fs = 0.02 + 0.98 * pow(1.0 - VoH, 5.0);
        vec3 sunSpec = srgb(vec3(1.0, 0.78, 0.58)) * 4.0 * min(D_GGX(NoH, rough) * V_SmithGGX(NoV, NoL, rough) * Fs * NoL, 9.0);
        float F = 0.02 + 0.98 * pow(1.0 - NoV, 5.0);
        F *= mix(1.0, 0.8, smoothstep(0.05, 0.2, rough));

        // ---- light scattered inside the water: deep body + subsurface glow through backlit crests
        vec3 deep = srgb(${v3(WATER.deep)}) * ${WATER.deepGain.toFixed(3)};
        vec3 sssC = srgb(${v3(WATER.sss)});
        float hgt = max(vWorld.y + 0.45, 0.0);
        float back = pow(max(dot(L, -V), 0.0), 4.0) * pow(clamp(0.5 - 0.5 * dot(L, N), 0.0, 1.0), 3.0);
        vec3 body = deep + sssC * sunRad * (1.1 * hgt * back + 0.02 * NoV * NoV + 0.01 * NoL);

        // ---- refraction: what's under the surface (hulls, sandy shallows) with absorption + caustics
        vec2 sUV = gl_FragCoord.xy / uRes;
        vec2 rUV = sUV + N.xz * 0.035 * clamp(6.0 / vViewZ, 0.2, 1.0);
        float sceneZ = linDepth(texture(uDepth, rUV).r);
        if (sceneZ < vViewZ) { rUV = sUV; sceneZ = linDepth(texture(uDepth, rUV).r); }
        vec4 opq = texture(uOpaque, rUV);
        float hasObj = opq.a * step(vViewZ, sceneZ);
        float pathLen = max(sceneZ - vViewZ, 0.0) * dist / vViewZ;
        vec3 bed = uCamPos - V * (sceneZ * dist / vViewZ);
        float below = max(vWorld.y - bed.y, 0.0);
        vec3 T = exp(-vec3(0.42, 0.085, 0.065) * (pathLen + below));
        vec3 objCol = opq.rgb + caustics(bed.xz, uTime * 1.3) * sunRad * 0.05 * exp(-below * 0.3) * smoothstep(0.0, 0.3, below);
        vec3 refr = mix(body, objCol * T + body * (1.0 - T), hasObj);

        // ---- reflection: analytic sky + real-time planar reflection of boats, land, skyline
        vec3 R = reflect(-V, N);
        vec3 skyR = skyColor(vec3(R.x, abs(R.y), R.z), false);
        vec4 rc = uReflMatrix * vec4(vWorld.x, uPlaneY, vWorld.z, 1.0);
        vec4 pr = texture(uRefl, rc.xy / rc.w + N.xz * 0.05);
        vec3 refl = mix(skyR, pr.rgb, pr.a);

        vec3 col = mix(refr, refl, F);

        // ---- foam: persistent whitecaps from the FFT jacobian, wake + splash foam from the sim, surf on the shore
        float sdist = shoreDist(vBase);
        float band = smoothstep(0.5, 0.95, sin(sdist * 1.1 - uTime * 1.6 + vnoise(vBase * 0.04) * 6.0));
        float shore = smoothstep(8.0, 0.0, sdist) * band * 0.8 + smoothstep(1.5, -0.5, sdist);
        float cov = clamp((uFoamBias + seaFoam(vBase) - turb) * uFoamScale, 0.0, 1.0) * clamp(ia, 0.0, 1.0);
        cov = max(cov, sim.w * 0.85);
        cov = max(cov, shore);
        vec2 fp = vec2(dot(vBase, uWaveDir), dot(vBase, vec2(-uWaveDir.y, uWaveDir.x)));
        float ft = texture(uFoamTex, fp * vec2(0.05, 0.11)).r * 0.5 + texture(uFoamTex, vBase * 0.21 + 0.37).r * 0.3 + texture(uFoamTex, fp * vec2(0.55, 0.9) + uTime * 0.01).r * 0.2;
        float foam = clamp((cov * 1.5 - (1.0 - ft)) * 2.2, 0.0, 1.0);
        col += sssC * cov * 0.6 * (skyAmb * 0.3 + sunRad * 0.04);
        col += sunSpec * (1.0 - pr.a) * (1.0 - foam);
        vec3 foamCol = vec3(0.9) * (skyAmb * 0.95 + sunRad * 0.16 * clamp(dot(N, L) * 0.6 + 0.4, 0.0, 1.0))
                     + sunRad * 0.08 * pow(max(dot(L, -V), 0.0), 6.0);
        col = mix(col, foamCol, foam);

        // ---- aerial perspective into the horizon
        vec3 vd = -V;
        vec3 fogC = skyColor(normalize(vec3(vd.x, 0.0, vd.z)), false);
        float fog = max(1.0 - exp(-pow(dist / 1500.0, 1.5)), smoothstep(2000.0, 2800.0, dist));
        col = mix(col, fogC, fog);
        if (any(isnan(col)) || any(isinf(col))) col = fogC;

        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const waterMesh = new THREE.Mesh(makeWaterGeo(mobile ? 288 : 384), waterMat);
  waterMesh.frustumCulled = false;
  scene.add(waterMesh);

  // ---------------------------------------------------------------- lights + toon materials
  const hemi = new THREE.HemisphereLight(o.hemi?.[0] ?? 0xcaa2e0, o.hemi?.[1] ?? 0x1d6274, 1.0);
  const sunLight = new THREE.DirectionalLight(o.sunColor ?? 0xffb27a, 2.6);
  sunLight.position.copy(SUN_DIR).multiplyScalar(100);
  const fillLight = new THREE.DirectionalLight(0xa9c0ff, 1.0);
  fillLight.position.set(-SUN_DIR.x * 0.3, 0.8, -SUN_DIR.z);
  for (const l of [hemi, sunLight, fillLight]) { l.layers.enableAll(); scene.add(l); }

  const gradTex = track(new THREE.DataTexture(new Uint8Array([80, 155, 220, 255]), 4, 1, THREE.RedFormat));
  gradTex.minFilter = gradTex.magFilter = THREE.NearestFilter;
  gradTex.needsUpdate = true;

  const sunView = new THREE.Vector3();
  function toon(color: THREE.ColorRepresentation, { rim = 0.55, transl = 0, ...rest }: ToonOptions = {}): THREE.MeshToonMaterial {
    const m = new THREE.MeshToonMaterial({ color, gradientMap: gradTex, ...rest });
    m.onBeforeCompile = sh => {
      sh.uniforms.uSunView = { value: sunView };
      sh.fragmentShader = 'uniform vec3 uSunView;\n' + sh.fragmentShader.replace('#include <opaque_fragment>', `
        {
          vec3 vd = normalize(vViewPosition);
          float ndv = 1.0 - clamp(dot(normal, vd), 0.0, 1.0);
          float sside = clamp(dot(normal, uSunView) * 0.5 + 0.5, 0.0, 1.0);
          outgoingLight += vec3(1.0, 0.6, 0.32) * pow(ndv, 3.0) * sside * ${rim.toFixed(3)};
          ${transl > 0 ? `outgoingLight += diffuseColor.rgb * vec3(1.0, 0.72, 0.5) * pow(clamp(dot(-vd, uSunView), 0.0, 1.0), 2.0) * ${transl.toFixed(3)};` : ''}
        }
        #include <opaque_fragment>`);
    };
    m.customProgramCacheKey = () => `toon-${rim}-${transl}-${!!rest.vertexColors}`;
    return m;
  }
  const outlineMats = new Map<string, THREE.ShaderMaterial>();
  function addOutline(mesh: THREE.Mesh, th = 0.03): THREE.Mesh {
    const key = th.toFixed(4);
    let mat = outlineMats.get(key);
    if (!mat) {
      mat = new THREE.ShaderMaterial({
        uniforms: { uT: { value: th } },
        side: THREE.BackSide,
        vertexShader: 'uniform float uT; void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position + normal * uT, 1.0); }',
        fragmentShader: 'void main() { gl_FragColor = vec4(0.08, 0.035, 0.11, 1.0); }',
      });
      outlineMats.set(key, mat);
    }
    const ol = new THREE.Mesh(mesh.geometry, mat);
    ol.raycast = () => {};
    mesh.add(ol);
    return ol;
  }
  function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d')!, w, h);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }

  // ---------------------------------------------------------------- wind lines (curly Wind Waker trails)
  const WL_MAX = 14, WL_SEG = 44;
  const wlGeo = new THREE.BufferGeometry();
  const wlPos = new Float32Array(WL_MAX * WL_SEG * 2 * 3);
  const wlT = new Float32Array(WL_MAX * WL_SEG * 2);
  const wlA = new Float32Array(WL_MAX * WL_SEG * 2);
  wlGeo.setAttribute('position', new THREE.BufferAttribute(wlPos, 3).setUsage(THREE.DynamicDrawUsage));
  wlGeo.setAttribute('aT', new THREE.BufferAttribute(wlT, 1));
  wlGeo.setAttribute('aA', new THREE.BufferAttribute(wlA, 1).setUsage(THREE.DynamicDrawUsage));
  {
    const idx: number[] = [];
    for (let l = 0; l < WL_MAX; l++) for (let k = 0; k < WL_SEG - 1; k++) {
      const a = (l * WL_SEG + k) * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    wlGeo.setIndex(idx);
    for (let l = 0; l < WL_MAX; l++) for (let k = 0; k < WL_SEG; k++) {
      const t = 1 - k / (WL_SEG - 1);
      wlT[(l * WL_SEG + k) * 2] = t; wlT[(l * WL_SEG + k) * 2 + 1] = t;
    }
  }
  const windLinesMesh = new THREE.Mesh(wlGeo, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: `attribute float aT; attribute float aA; varying float vT; varying float vA;
      void main() { vT = aT; vA = aA; gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying float vT; varying float vA;
      void main() { float a = smoothstep(0.0, 0.55, vT) * smoothstep(1.0, 0.88, vT) * vA; gl_FragColor = vec4(1.5, 1.45, 1.4, a * 0.8); }`,
  }));
  windLinesMesh.frustumCulled = false;
  scene.add(windLinesMesh);
  interface WindLine {
    alive: boolean; age: number; life: number; ox: number; oy: number; oz: number; dx: number; dz: number;
    v: number; loop: boolean; t0: number; T: number; R: number; amp: number; ph: number; wid: number;
  }
  const wlines: WindLine[] = Array.from({ length: WL_MAX }, () => ({ alive: false, age: 0, life: 0, ox: 0, oy: 0, oz: 0, dx: 0, dz: 0, v: 0, loop: false, t0: 0, T: 1, R: 0, amp: 0, ph: 0, wid: 0 }));
  const _tan = new THREE.Vector3(), _side = new THREE.Vector3(), _toCam = new THREE.Vector3();
  const wlPts = Array.from({ length: WL_SEG }, () => new THREE.Vector3());
  function spawnWindLine(ox: number, oy: number, oz: number, dx: number, dz: number, burst = false): void {
    const L = wlines.find(l => !l.alive);
    if (!L) return;
    Object.assign(L, {
      alive: true, age: 0, life: rand(3.0, 4.4), ox, oy, oz, dx, dz,
      v: burst ? rand(10, 14) : rand(7, 10), loop: Math.random() < 0.6, t0: rand(0.7, 1.6), T: rand(0.8, 1.0),
      R: rand(1.5, 2.1), amp: rand(0.3, 0.8), ph: rand(0, TAU), wid: rand(0.07, 0.11),
    });
  }
  function wlPoint(L: WindLine, tau: number, out: THREE.Vector3): THREE.Vector3 {
    let fwd = L.v * tau, up = 0;
    if (L.loop && tau > L.t0 && tau < L.t0 + L.T) {
      const s = (tau - L.t0) / L.T, om = TAU * s, e = Math.pow(Math.sin(Math.PI * s), 0.5);
      fwd -= e * L.R * Math.sin(om) * 1.6;
      up = e * L.R * (1 - Math.cos(om)) * 0.55;
    }
    const side = L.amp * Math.sin(tau * 1.7 + L.ph);
    return out.set(L.ox + L.dx * fwd + L.dz * side, L.oy + up + 0.25 * Math.sin(tau * 2.3 + L.ph), L.oz + L.dz * fwd - L.dx * side);
  }
  function updateWindLines(dt: number): void {
    for (let l = 0; l < WL_MAX; l++) {
      const L = wlines[l];
      const base = l * WL_SEG * 2;
      if (!L.alive) { for (let k = 0; k < WL_SEG * 2; k++) wlA[base + k] = 0; continue; }
      L.age += dt;
      if (L.age > L.life) { L.alive = false; continue; }
      const alpha = smooth(0, 0.4, L.age) * (1 - smooth(L.life - 0.9, L.life, L.age));
      for (let k = 0; k < WL_SEG; k++) wlPoint(L, Math.max(0, L.age - k * 0.034), wlPts[k]);
      for (let k = 0; k < WL_SEG; k++) {
        const pk = wlPts[k];
        _tan.subVectors(wlPts[Math.max(0, k - 1)], wlPts[Math.min(WL_SEG - 1, k + 1)]);
        if (_tan.lengthSq() < 1e-6) _tan.set(L.dx, 0, L.dz);
        _toCam.subVectors(camera.position, pk);
        _side.crossVectors(_tan, _toCam).normalize();
        const t = 1 - k / (WL_SEG - 1);
        const w = L.wid * Math.pow(Math.sin(Math.PI * clamp(t, 0.02, 0.98)), 0.6);
        const i = (base + k * 2) * 3;
        wlPos[i] = pk.x + _side.x * w; wlPos[i + 1] = pk.y + _side.y * w; wlPos[i + 2] = pk.z + _side.z * w;
        wlPos[i + 3] = pk.x - _side.x * w; wlPos[i + 4] = pk.y - _side.y * w; wlPos[i + 5] = pk.z - _side.z * w;
        wlA[base + k * 2] = alpha; wlA[base + k * 2 + 1] = alpha;
      }
    }
    wlGeo.attributes.position.needsUpdate = true;
    wlGeo.attributes.aA.needsUpdate = true;
  }

  // ---------------------------------------------------------------- particles (spray, splashes, sparkles)
  const P_MAX = mobile ? 600 : 900;
  const pGeo = new THREE.BufferGeometry();
  const pPos = new Float32Array(P_MAX * 3), pCol = new Float32Array(P_MAX * 3), pSize = new Float32Array(P_MAX), pAlpha = new Float32Array(P_MAX);
  const pVel = new Float32Array(P_MAX * 3), pLife = new Float32Array(P_MAX), pMax = new Float32Array(P_MAX), pGrav = new Float32Array(P_MAX);
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3).setUsage(THREE.DynamicDrawUsage));
  pGeo.setAttribute('aColor', new THREE.BufferAttribute(pCol, 3).setUsage(THREE.DynamicDrawUsage));
  pGeo.setAttribute('aSize', new THREE.BufferAttribute(pSize, 1).setUsage(THREE.DynamicDrawUsage));
  pGeo.setAttribute('aAlpha', new THREE.BufferAttribute(pAlpha, 1).setUsage(THREE.DynamicDrawUsage));
  const pMat = new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 400 } },
    transparent: true, depthWrite: false,
    vertexShader: `attribute float aSize; attribute float aAlpha; attribute vec3 aColor; uniform float uScale;
      varying float vA; varying vec3 vC;
      void main() { vA = aAlpha; vC = aColor; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = aSize * uScale / -mv.z; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `varying float vA; varying vec3 vC;
      void main() { float d = length(gl_PointCoord - 0.5); gl_FragColor = vec4(vC, smoothstep(0.5, 0.15, d) * vA); }`,
  });
  const particles = new THREE.Points(pGeo, pMat);
  particles.frustumCulled = false;
  scene.add(particles);
  let pNext = 0;
  function emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, r: number, g: number, b: number, grav = 9.8): void {
    const i = pNext; pNext = (pNext + 1) % P_MAX;
    pPos[i * 3] = x; pPos[i * 3 + 1] = y; pPos[i * 3 + 2] = z;
    pVel[i * 3] = vx; pVel[i * 3 + 1] = vy; pVel[i * 3 + 2] = vz;
    pCol[i * 3] = r; pCol[i * 3 + 1] = g; pCol[i * 3 + 2] = b;
    pLife[i] = life; pMax[i] = life; pSize[i] = size; pGrav[i] = grav;
  }
  function updateParticles(dt: number): void {
    for (let i = 0; i < P_MAX; i++) {
      if (pLife[i] <= 0) { pAlpha[i] = 0; continue; }
      pLife[i] -= dt;
      pVel[i * 3 + 1] -= pGrav[i] * dt;
      pPos[i * 3] += pVel[i * 3] * dt; pPos[i * 3 + 1] += pVel[i * 3 + 1] * dt; pPos[i * 3 + 2] += pVel[i * 3 + 2] * dt;
      const k = clamp(pLife[i] / pMax[i], 0, 1);
      pAlpha[i] = Math.min(1, k * 2.5) * 0.9;
    }
    for (const n of ['position', 'aColor', 'aSize', 'aAlpha']) pGeo.attributes[n].needsUpdate = true;
  }

  // ---------------------------------------------------------------- planar reflection camera (oblique near plane at the waterline)
  const reflCam = new THREE.PerspectiveCamera();
  reflCam.layers.set(L_REFLECT);
  const _rPos = new THREE.Vector3(), _rView = new THREE.Vector3(), _rLook = new THREE.Vector3(), _rTarget = new THREE.Vector3();
  const _rRot = new THREE.Matrix4(), _rPlane = new THREE.Plane(), _rClip = new THREE.Vector4(), _rQ = new THREE.Vector4();
  const UP = new THREE.Vector3(0, 1, 0);
  function renderReflection(planeY: number): void {
    _rPos.set(camera.position.x, planeY, camera.position.z);
    _rView.subVectors(_rPos, camera.position);
    if (_rView.dot(UP) > 0) return;
    _rView.reflect(UP).negate().add(_rPos);
    _rRot.extractRotation(camera.matrixWorld);
    _rLook.set(0, 0, -1).applyMatrix4(_rRot).add(camera.position);
    _rTarget.subVectors(_rPos, _rLook).reflect(UP).negate().add(_rPos);
    reflCam.position.copy(_rView);
    reflCam.up.set(0, 1, 0).applyMatrix4(_rRot).reflect(UP);
    reflCam.lookAt(_rTarget);
    reflCam.far = camera.far;
    reflCam.updateMatrixWorld();
    reflCam.projectionMatrix.copy(camera.projectionMatrix);
    U.uReflMatrix.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(reflCam.projectionMatrix).multiply(reflCam.matrixWorldInverse);
    _rPlane.setFromNormalAndCoplanarPoint(UP, _rPos).applyMatrix4(reflCam.matrixWorldInverse);
    _rClip.set(_rPlane.normal.x, _rPlane.normal.y, _rPlane.normal.z, _rPlane.constant);
    const e = reflCam.projectionMatrix.elements;
    _rQ.set((Math.sign(_rClip.x) + e[8]) / e[0], (Math.sign(_rClip.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14]);
    _rClip.multiplyScalar(2 / _rClip.dot(_rQ));
    e[2] = _rClip.x; e[6] = _rClip.y; e[10] = _rClip.z + 1; e[14] = _rClip.w;
    renderer.setRenderTarget(reflRT);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, reflCam);
  }
  function renderRefractionSource(): void {
    camera.layers.set(L_REFRACT);
    renderer.setRenderTarget(opaqueRT);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
    camera.layers.set(0);
  }

  // ---------------------------------------------------------------- post processing
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: mobile ? 0 : 4 }));
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.36, 0.5, 1.0);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const _dbs = new THREE.Vector2();
  const updatePointScale = (): void => { pMat.uniforms.uScale.value = U.uRes.value.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))); };
  function resize(): void {
    const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight;
    renderer.setSize(w, h, false);
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(w, h);
    bloom.setSize(w / 2, h / 2);
    renderer.getDrawingBufferSize(_dbs);
    opaqueRT.setSize(_dbs.x, _dbs.y);
    reflRT.setSize(Math.ceil(_dbs.x / 2), Math.ceil(_dbs.y / 2));
    U.uRes.value.copy(_dbs);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    updatePointScale();
  }
  const resizeObs = new ResizeObserver(() => resize());
  resizeObs.observe(canvas);
  resize();
  function setFov(fov: number): void {
    if (Math.abs(camera.fov - fov) < 0.01) return;
    camera.fov = fov;
    camera.updateProjectionMatrix();
    updatePointScale();
  }

  // Drop render resolution a step at a time if the GPU can't hold ~48 fps.
  let perfAcc = 0, perfFrames = 0, pixelRatio = renderer.getPixelRatio();
  function watchPerf(raw: number): void {
    if (raw > 0.25) return;
    perfAcc += raw; perfFrames++;
    if (perfAcc < 2.5) return;
    const ms = perfAcc / perfFrames * 1000;
    perfAcc = perfFrames = 0;
    if (ms > 21 && pixelRatio > 0.75) {
      pixelRatio = Math.max(0.75, pixelRatio - 0.25);
      renderer.setPixelRatio(pixelRatio);
      resize();
    }
  }

  /** Call once per frame after the game has placed its camera. */
  function render(st: RenderState): void {
    if (st.rawDt !== undefined) watchPerf(st.rawDt);
    U.uTime.value = st.time;
    camera.updateMatrixWorld();
    sunView.copy(SUN_DIR).transformDirection(camera.matrixWorldInverse);
    U.uCamPos.value.copy(camera.position);
    U.uPlaneY.value = st.planeY;
    waterMesh.position.set(Math.round(st.focusX), 0, Math.round(st.focusZ));
    sky.position.copy(camera.position);
    skyline.position.set(camera.position.x, 0, camera.position.z);
    updateWindLines(st.dt);
    updateParticles(st.dt);
    Ocean.step(st.time, st.dt);
    Sim.step(st.dt, st.boatX, st.boatZ, st.heading, st.speed);
    Probe.poll();
    Probe.kick();
    renderReflection(st.planeY);
    renderRefractionSource();
    renderer.setClearColor(0x000000, 1);
    renderer.setRenderTarget(null);
    composer.render();
  }

  /** Free every GPU resource and the WebGL context itself. */
  function dispose(): void {
    resizeObs.disconnect();
    Probe.release();
    const mats = new Set<THREE.Material>();
    scene.traverse(obj => {
      const m = obj as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const list = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
      list.forEach(x => mats.add(x));
    });
    for (const m of mats) {
      for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
      m.dispose();
    }
    outlineMats.forEach(m => m.dispose());
    disposables.forEach(d => d.dispose());
    bloom.dispose();
    composer.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  }

  return {
    renderer, scene, camera, U, SUN_DIR, SUN_YAW, sunView, L_REFLECT, L_REFRACT, mobile,
    toon, addOutline, canvasTex, addLayers, emit, spawnWindLine, Probe, Sim, render, setFov, resize, dispose,
    waveDir: new THREE.Vector2(Math.cos(OC.dir), Math.sin(OC.dir)),
  };
}
