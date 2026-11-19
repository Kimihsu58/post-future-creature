// ============================================================================
// audio.js — Web Audio 程序合成音效（零音檔、離線可用）
// ----------------------------------------------------------------------------
//   生物叫聲：SFX.roar（嘶吼）/ SFX.bite（咬擊）/ SFX.swallow（吞食爆響）
//   扭塑膠聲：SFX.twist（噼啪爆裂＋高 Q 啾鳴＝stick-slip 扭擠）/ SFX.evolve（進化＝扭＋吼）
//   掛載點：leviathan.js startHunt、walker.js eatenBy/吞完、sketch.js 進食數增加
//   自動播放政策：第一次 pointerdown/keydown 解鎖 AudioContext；🔇 按鈕/M 鍵靜音
// ============================================================================
const SFX = {
  ctx: null,
  master: null,
  comp: null,
  noiseBuf: null,
  muted: (typeof localStorage !== "undefined" && localStorage.getItem("sfxMuted") === "1"),
  // 除錯計數：各音效被呼叫次數（CDP 驗證「事件真的有觸發音效」用）
  counts: { roar: 0, bite: 0, twist: 0, swallow: 0, evolve: 0 },

  // ---- 基礎：惰性建立 AudioContext（瀏覽器要求使用者互動後才能出聲） ----
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      // 2 秒白噪音 buffer（所有氣聲/爆裂聲的原料，只做一次）
      const n = Math.floor(this.ctx.sampleRate * 2);
      this.noiseBuf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      // master → 壓限器 → 喇叭（嘶吼多層疊加時不破音）
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.9;
      this.comp = this.ctx.createDynamicsCompressor();
      this.comp.threshold.value = -18;
      this.comp.ratio.value = 4;
      this.comp.knee.value = 12;
      this.master.connect(this.comp);
      this.comp.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
    return this.ctx;
  },

  unlock() { this.ensure(); },

  setMuted(m) {
    this.muted = !!m;
    try { localStorage.setItem("sfxMuted", this.muted ? "1" : "0"); } catch (e) {}
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.9;
  },
  toggle() { this.setMuted(!this.muted); return this.muted; },

  // 失真曲線（tanh 軟削波 → 嘶吼的「沙」感）
  _curve(k) {
    const n = 2048, c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(x * k);
    }
    return c;
  },

  // ---- 單發「爆裂」：短噪音經帶通 → 扭塑膠的噼啪/骨節聲 ----
  _pop(t, amp, fLo = 1400, fHi = 6500) {
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const bp = c.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = fLo + Math.random() * (fHi - fLo);
    bp.Q.value = 2 + Math.random() * 5;
    const g = c.createGain();
    const dur = 0.01 + Math.random() * 0.035;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(amp, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.03);
  },

  // ---- 連續「扭」：高 Q 帶通噪音的頻率階梯＋格狀顫音 = 塑料受扭的啾鳴(stick-slip) ----
  _creak(t0, dur) {
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const bp = c.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 14;
    const g = c.createGain();
    const steps = 14;
    bp.frequency.setValueAtTime(400 + Math.random() * 200, t0);
    g.gain.setValueAtTime(0.0001, t0);
    for (let i = 1; i <= steps; i++) {
      const tt = t0 + (dur * i) / steps;
      bp.frequency.exponentialRampToValueAtTime(350 + Math.random() * 1600, tt);
      // 一格一格的扭：音量跳到峰值再落下（模擬 stick-slip）
      g.gain.linearRampToValueAtTime(0.05 + Math.random() * 0.22, t0 + (dur * (i - 0.4)) / steps);
      g.gain.linearRampToValueAtTime(0.02, tt);
    }
    g.gain.linearRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t0, Math.random() * 1.5);
    src.stop(t0 + dur + 0.05);
  },

  // ---- 低鳴底層：給扭動「質量感」（身體/大件塑膠的低頻呻吟） ----
  _groan(t0, dur, f0 = 68, f1 = 46, amp = 0.14) {
    const c = this.ctx;
    const o = c.createOscillator();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 320;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(amp, t0 + dur * 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(lp).connect(g).connect(this.master);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  },

  // ==========================================================================
  // 生物叫聲：多層嘶吼 = 鋸齒波主聲(下滑) + 氣聲帶通 + 次低音 + 震音抖動
  // ==========================================================================
  roar({ dur = 1.1, f0 = 150, f1 = 55, amp = 0.5, when = 0 } = {}) {
    this.counts.roar++;
    const c = this.ensure();
    if (!c || this.muted) return;
    const t = c.currentTime + when;
    const out = c.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(amp, t + 0.05);
    out.gain.setValueAtTime(amp, t + dur * 0.55);          // 維持
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur); // 收尾
    // 嘶吼抖動（振幅 LFO ≈ 13~21Hz → 「呼嚕」顆粒感）
    const lfo = c.createOscillator();
    lfo.frequency.value = 13 + Math.random() * 8;
    const lfoG = c.createGain();
    lfoG.gain.value = amp * 0.3;
    lfo.connect(lfoG).connect(out.gain);
    // 軸削波 → 低通掃頻（高頻隨時間悶掉 = 張嘴到閉嘴）
    const ws = c.createWaveShaper();
    ws.curve = this._curve(4);
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(2400, t);
    lp.frequency.exponentialRampToValueAtTime(500, t + dur);
    const osc = c.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.85);
    const vib = c.createOscillator();
    vib.frequency.value = 7;
    const vibG = c.createGain();
    vibG.gain.value = 18;                                  // ±18 cents 音高顫動
    vib.connect(vibG).connect(osc.detune);
    osc.connect(lp).connect(ws).connect(out);
    // 氣聲層
    const nz = c.createBufferSource();
    nz.buffer = this.noiseBuf;
    nz.loop = true;
    const bp = c.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 0.8;
    bp.frequency.setValueAtTime(900, t);
    bp.frequency.exponentialRampToValueAtTime(260, t + dur);
    const ng = c.createGain();
    ng.gain.value = amp * 0.5;
    nz.connect(bp).connect(ng).connect(out);
    // 次低音層（胸腔共鳴）
    const sub = c.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(f0 * 0.5, t);
    sub.frequency.exponentialRampToValueAtTime(f1 * 0.5, t + dur * 0.85);
    const sg = c.createGain();
    sg.gain.value = 0.6;
    sub.connect(sg).connect(out);
    out.connect(this.master);
    for (const n of [osc, vib, nz, sub, lfo]) {
      n.start(t, n === nz ? Math.random() * 1.5 : 0);
      n.stop(t + dur + 0.06);
    }
  },

  // 咬擊：短促尖銳的嘶吼（內部呼叫 roar → roar 計數也會 +1）
  bite() { this.counts.bite++; this.roar({ dur: 0.5, f0: 210, f1: 90, amp: 0.45 }); },

  // ==========================================================================
  // 扭塑膠聲：密集噼啪 _pop + 連續啾鳴 _creak + 低鳴 _groan
  // ==========================================================================
  twist({ dur = 1.2, when = 0 } = {}) {
    this.counts.twist++;
    const c = this.ensure();
    if (!c || this.muted) return;
    const t = c.currentTime + when;
    const n = Math.round(dur * 22);
    for (let i = 0; i < n; i++) {
      this._pop(t + Math.random() * dur, 0.12 + Math.random() * 0.4);
    }
    this._creak(t, dur);
    this._groan(t, dur);
  },

  // 吞食完成：一陣密集爆裂＋低鳴「咕」（獵物被擠碎的收尾）
  swallow() {
    this.counts.swallow++;
    const c = this.ensure();
    if (!c || this.muted) return;
    const t = c.currentTime;
    for (let i = 0; i < 18; i++) this._pop(t + Math.random() * 0.4, 0.2 + Math.random() * 0.35);
    const o = c.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.3);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.4);
  },

  // 進化（人形化 +1）：1.7 秒身體重組的扭擠，1 秒後接一聲嘶吼
  evolve() {
    this.counts.evolve++;
    this.twist({ dur: 1.7 });
    this.roar({ dur: 1.2, f0: 120, f1: 45, amp: 0.5, when: 1.0 });
  },
};

// 瀏覽器自動播放政策：第一次互動解鎖 AudioContext（之後所有呼叫才能出聲）
if (typeof window !== "undefined") {
  const un = () => SFX.unlock();
  window.addEventListener("pointerdown", un, { passive: true });
  window.addEventListener("keydown", un);
  window.SFX = SFX;   // 明確掛到 window：leviathan.js/walker.js 的 `if (window.SFX)` 才看得到
}
