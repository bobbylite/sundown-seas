// Shared WebAudio bed: ocean wash, wind, chimes and noise bursts. Games add their own voices on top.
export function createSound() {
  const S = {
    ctx: null, on: false, master: null, noise: null,
    init() {
      if (this.ctx) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = this.ctx = new AC();
      this.master = ctx.createGain(); this.master.gain.value = 0; this.master.connect(ctx.destination);
      const buf = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.noise = buf;
      const sea = ctx.createBufferSource(); sea.buffer = buf; sea.loop = true;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 380;
      const seaGain = ctx.createGain(); seaGain.gain.value = 0.28;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.12;
      const lfoG = ctx.createGain(); lfoG.gain.value = 0.14;
      lfo.connect(lfoG).connect(seaGain.gain);
      sea.connect(lp).connect(seaGain).connect(this.master);
      sea.start(); lfo.start();
      const ws = ctx.createBufferSource(); ws.buffer = buf; ws.loop = true; ws.playbackRate.value = 0.6;
      this.windBp = ctx.createBiquadFilter(); this.windBp.type = 'bandpass'; this.windBp.frequency.value = 600; this.windBp.Q.value = 0.7;
      this.windGain = ctx.createGain(); this.windGain.gain.value = 0;
      ws.connect(this.windBp).connect(this.windGain).connect(this.master);
      ws.start();
      this.onInit?.(ctx);
    },
    set(on) {
      this.on = on;
      if (on) { this.init(); this.ctx?.resume(); }
      if (this.ctx) this.master.gain.setTargetAtTime(on ? 0.7 : 0, this.ctx.currentTime, 0.15);
    },
    wind(level, pitch) {
      if (!this.ctx || !this.on) return;
      const t = this.ctx.currentTime;
      this.windGain.gain.setTargetAtTime(level, t, 0.4);
      this.windBp.frequency.setTargetAtTime(pitch, t, 0.4);
    },
    tone(freqs, { type = 'triangle', gap = 0.07, vol = 0.18, dur = 0.6 } = {}) {
      if (!this.ctx || !this.on) return;
      const t = this.ctx.currentTime;
      freqs.forEach((f, i) => {
        const o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.type = type; o.frequency.value = f;
        g.gain.setValueAtTime(0, t + i * gap);
        g.gain.linearRampToValueAtTime(vol, t + i * gap + 0.01);
        g.gain.exponentialRampToValueAtTime(0.001, t + i * gap + dur);
        o.connect(g).connect(this.master);
        o.start(t + i * gap); o.stop(t + i * gap + dur + 0.1);
      });
    },
    chime() { this.tone([880, 1108.7, 1318.5, 1760]); },
    burst(freq, q, vol, dur, sweep = 0) {
      if (!this.ctx || !this.on) return;
      const t = this.ctx.currentTime;
      const s = this.ctx.createBufferSource(); s.buffer = this.noise;
      const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
      if (sweep) f.frequency.exponentialRampToValueAtTime(freq * sweep, t + dur);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.03); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      s.connect(f).connect(g).connect(this.master);
      s.start(t, Math.random() * 2); s.stop(t + dur + 0.05);
    },
  };
  return S;
}

/** Wire a "Sound: on/off" toggle button to a sound bed. */
export function bindSoundButton(sound, btn) {
  const set = on => { sound.set(on); btn.textContent = on ? 'Sound: on' : 'Sound: off'; };
  btn.addEventListener('click', () => set(!sound.on));
  return set;
}
