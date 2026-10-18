// Shared WebAudio bed: ocean wash, wind, chimes and noise bursts. Games add their own voices via onInit.
export interface ToneOptions { type?: OscillatorType; gap?: number; vol?: number; dur?: number }

type AudioCtor = typeof AudioContext;

export class SoundBed {
  ctx: AudioContext | null = null;
  on = false;
  master: GainNode | null = null;
  noise: AudioBuffer | null = null;
  onInit?: (ctx: AudioContext, master: GainNode) => void;
  private windBp: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;

  init(): void {
    if (this.ctx) return;
    const AC: AudioCtor | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    const master = (this.master = ctx.createGain());
    master.gain.value = 0;
    master.connect(ctx.destination);
    const buf = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
    const sea = ctx.createBufferSource();
    sea.buffer = buf; sea.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 380;
    const seaGain = ctx.createGain();
    seaGain.gain.value = 0.28;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.12;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 0.14;
    lfo.connect(lfoG).connect(seaGain.gain);
    sea.connect(lp).connect(seaGain).connect(master);
    sea.start(); lfo.start();
    const ws = ctx.createBufferSource();
    ws.buffer = buf; ws.loop = true; ws.playbackRate.value = 0.6;
    this.windBp = ctx.createBiquadFilter();
    this.windBp.type = 'bandpass'; this.windBp.frequency.value = 600; this.windBp.Q.value = 0.7;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    ws.connect(this.windBp).connect(this.windGain).connect(master);
    ws.start();
    this.onInit?.(ctx, master);
  }

  set(on: boolean): void {
    this.on = on;
    if (on) { this.init(); void this.ctx?.resume(); }
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(on ? 0.7 : 0, this.ctx.currentTime, 0.15);
  }

  /** Pause the context while the page is hidden; iOS also needs this to resume cleanly. */
  suspend(hidden: boolean): void {
    if (!this.ctx) return;
    if (hidden) void this.ctx.suspend();
    else if (this.on) void this.ctx.resume();
  }

  get live(): boolean { return !!this.ctx && this.on; }

  wind(level: number, pitch: number): void {
    if (!this.live || !this.windGain || !this.windBp) return;
    const t = this.ctx!.currentTime;
    if (!Number.isFinite(level) || !Number.isFinite(pitch)) return;
    this.windGain.gain.setTargetAtTime(level, t, 0.4);
    this.windBp.frequency.setTargetAtTime(pitch, t, 0.4);
  }

  tone(freqs: number[], { type = 'triangle', gap = 0.07, vol = 0.18, dur = 0.6 }: ToneOptions = {}): void {
    if (!this.live) return;
    const ctx = this.ctx!, t = ctx.currentTime;
    freqs.forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.value = f;
      g.gain.setValueAtTime(0, t + i * gap);
      g.gain.linearRampToValueAtTime(vol, t + i * gap + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * gap + dur);
      o.connect(g).connect(this.master!);
      o.start(t + i * gap); o.stop(t + i * gap + dur + 0.1);
    });
  }

  chime(): void { this.tone([880, 1108.7, 1318.5, 1760]); }

  burst(freq: number, q: number, vol: number, dur: number, sweep = 0): void {
    if (!this.live || !this.noise) return;
    const ctx = this.ctx!, t = ctx.currentTime;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (sweep) f.frequency.exponentialRampToValueAtTime(freq * sweep, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f).connect(g).connect(this.master!);
    s.start(t, Math.random() * 2);
    s.stop(t + dur + 0.05);
  }

  dispose(): void {
    if (this.ctx) void this.ctx.close();
    this.ctx = null;
    this.master = null;
  }
}

/** Wire a "Sound: on/off" toggle button to a sound bed; returns a setter. */
export function bindSoundButton(sound: SoundBed, btn: HTMLButtonElement, signal: AbortSignal): (on: boolean) => void {
  const set = (on: boolean): void => {
    sound.set(on);
    btn.textContent = on ? 'Sound: on' : 'Sound: off';
    btn.setAttribute('aria-pressed', String(on));
  };
  btn.addEventListener('click', () => set(!sound.on), { signal });
  document.addEventListener('visibilitychange', () => sound.suspend(document.hidden), { signal });
  return set;
}
