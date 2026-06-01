/* ============================================================================
   DIM HALLS — procedural audio (WebAudio, no asset files).
   Ambient drone + air-noise bed, proximity-driven heartbeat, footsteps,
   a "peek" tell, a chase stinger, pickup/click blips, and a jump-scare sting.
   ========================================================================== */
'use strict';

const audio = (() => {
  let ctx = null, master = null;
  let droneGain = null, noiseGain = null;
  let running = false;
  let tension = 0;            // 0..1, drives heartbeat rate + volume
  let lastStep = 0;
  let hbTimer = null;

  let sfx = null, sfxReady = false;
  let menuEl = null, menuReady = false, menu = null, menuPlaying = false;
  function init() {
    // Prefer a real recorded jumpscare file if present; otherwise fall back to the synth roar.
    sfx = new Audio('assets/audio/jumpscare.mp3');
    sfx.preload = 'auto'; sfx.volume = 1.0;
    sfx.addEventListener('canplaythrough', () => { sfxReady = true; });
    sfx.addEventListener('error', () => { sfxReady = false; });
    // Title-screen music: prefer assets/audio/menu.mp3 (looped); else a synth dark-ambient theme.
    menuEl = new Audio('assets/audio/menu.mp3');
    menuEl.preload = 'auto'; menuEl.loop = true; menuEl.volume = 0.5;
    menuEl.addEventListener('canplaythrough', () => { menuReady = true; });
    menuEl.addEventListener('error', () => { menuReady = false; });
  }

  // ---- Main-screen music -------------------------------------------------
  function menuStart() {
    ensure(); if (ctx.state === 'suspended') ctx.resume();
    if (menuPlaying) return;
    if (menuReady) {
      try {
        menuEl.currentTime = 0; menuEl.volume = 0.5;
        const pr = menuEl.play();
        // If autoplay is blocked (no user gesture yet), DON'T lock menuPlaying — let the next
        // real interaction retry. Only mark playing once it actually starts.
        if (pr && pr.then) pr.then(() => { menuPlaying = true; }).catch(() => { menuPlaying = false; });
        else menuPlaying = true;
      } catch (e) { menuPlaying = false; }
      return;
    }
    // Synth fallback only makes sound once the audio context is allowed to run (post-gesture).
    if (ctx.state === 'running') { menuPlaying = true; synthMenu(); }
  }
  function menuIsPlaying() { return menuPlaying; }
  function menuStop() {
    menuPlaying = false;
    if (menuEl) { try { menuEl.pause(); } catch (e) {} }
    if (menu) {
      try { menu.g.gain.cancelScheduledValues(ctx.currentTime); menu.g.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.5); } catch (e) {}
      clearTimeout(menu.timer); const m = menu; menu = null; setTimeout(() => m.stop(), 600);
    }
  }
  // Synth fallback: a slow A-minor drone/pad with sparse eerie bell notes — ominous, loops forever.
  function synthMenu() {
    ensure(); const t = ctx.currentTime;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.3, t + 2.0); g.connect(ctx.destination);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; lp.connect(g);
    const oscs = [];
    [55, 82.41, 110, 130.81, 164.81].forEach((f, i) => {
      const o = ctx.createOscillator(); o.type = i < 2 ? 'sine' : 'triangle'; o.frequency.value = f;
      const og = ctx.createGain(); og.gain.value = [0.5, 0.4, 0.22, 0.18, 0.18][i];
      const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.07 + i * 0.02;
      const ld = ctx.createGain(); ld.gain.value = og.gain.value * 0.4; lfo.connect(ld); ld.connect(og.gain); lfo.start(t);
      o.connect(og); og.connect(lp); o.start(t); oscs.push(o, lfo);
    });
    const scale = [440, 523.25, 587.33, 659.25, 783.99];
    function note() {
      if (!menu) return;
      const f = scale[(Math.random() * scale.length) | 0] * (Math.random() < 0.5 ? 1 : 0.5);
      const tt = ctx.currentTime;
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      const ng = ctx.createGain(); ng.gain.setValueAtTime(0.0001, tt);
      ng.gain.exponentialRampToValueAtTime(0.11, tt + 0.06); ng.gain.exponentialRampToValueAtTime(0.0001, tt + 2.6);
      o.connect(ng); ng.connect(g); o.start(tt); o.stop(tt + 2.7);
      menu.timer = setTimeout(note, 2500 + Math.random() * 3500);
    }
    menu = { g, timer: null, stop: () => oscs.forEach((o) => { try { o.stop(); } catch (e) {} }) };
    menu.timer = setTimeout(note, 1500);
  }

  function ensure() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = 0.0; master.connect(ctx.destination);
  }

  function noiseBuffer(seconds, type) {
    const len = ctx.sampleRate * seconds;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      if (type === 'brown') { last = (last + 0.02 * white) / 1.02; d[i] = last * 3.5; }
      else d[i] = white;
    }
    return buf;
  }

  function start() {
    ensure();
    if (ctx.state === 'suspended') ctx.resume();
    running = true;
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.linearRampToValueAtTime(0.9, ctx.currentTime + 1.5);

    // --- low drone (two detuned saws through a lowpass) ---
    droneGain = ctx.createGain(); droneGain.gain.value = 0.12;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 220;
    [55, 55.4, 82.5].forEach((f) => {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
      o.connect(droneGain); o.start();
    });
    droneGain.connect(lp); lp.connect(master);

    // --- airy noise bed (filtered brown noise) ---
    const src = ctx.createBufferSource(); src.buffer = noiseBuffer(4, 'brown'); src.loop = true;
    const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 380; nf.Q.value = 0.6;
    noiseGain = ctx.createGain(); noiseGain.gain.value = 0.05;
    src.connect(nf); nf.connect(noiseGain); noiseGain.connect(master); src.start();

    scheduleHeartbeat();
  }

  function stop() {
    running = false;
    if (master) master.gain.linearRampToValueAtTime(0.0, ctx.currentTime + 0.6);
    if (hbTimer) { clearTimeout(hbTimer); hbTimer = null; }
  }

  /* Heartbeat: self-scheduling double-thump; rate + volume scale with tension. */
  function scheduleHeartbeat() {
    if (!running) return;
    if (tension > 0.04) {
      thump(0); thump(0.16);
    }
    const bpm = 50 + tension * 110;           // 50 → 160 bpm
    hbTimer = setTimeout(scheduleHeartbeat, (60 / bpm) * 1000);
  }
  function thump(delay) {
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(60, t); o.frequency.exponentialRampToValueAtTime(34, t + 0.16);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5 * (0.4 + tension), t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.25);
  }

  /* Called every frame by the stalker update. */
  function setTension(state, dist) {
    let prox = Math.max(0, 1 - dist / 26);    // 0 far → 1 in your face
    if (state === 'CHASE') prox = Math.max(prox, 0.85);
    else if (state === 'NOTICE') prox = Math.max(prox, 0.5);
    tension += (prox - tension) * 0.06;        // smooth
    if (droneGain) droneGain.gain.value = 0.12 + tension * 0.22;
  }

  function blip(freq, dur, type, vol, slideTo) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = type || 'square'; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol || 0.2, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.02);
  }

  function footstep(sprint) {
    if (!ctx || !running) return;
    const now = ctx.currentTime;
    const gap = sprint ? 0.30 : 0.48;
    if (now - lastStep < gap) return;
    lastStep = now;
    const src = ctx.createBufferSource(); src.buffer = noiseBuffer(0.12, 'white');
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = sprint ? 900 : 500;
    const g = ctx.createGain(); g.gain.setValueAtTime(sprint ? 0.18 : 0.10, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    src.connect(f); f.connect(g); g.connect(master); src.start(); src.stop(now + 0.13);
  }

  function peek() { blip(180, 0.5, 'sine', 0.18, 70); }         // dread tell
  function chaseStart() {                                       // dissonant panic stinger
    blip(440, 0.5, 'sawtooth', 0.16, 880);
    blip(466, 0.5, 'sawtooth', 0.14, 300);
    blip(110, 0.7, 'square', 0.12);
  }
  function pickup() { blip(660, 0.10, 'sine', 0.16, 990); setTimeout(() => blip(990, 0.12, 'sine', 0.14), 60); }
  function click() { blip(1200, 0.04, 'square', 0.08); }

  // A guttural MONSTER ROAR — built from noise + vocal formants + growl, not tonal synths.
  // Arc: a sharp wet impact → a throaty roar that rises (SHOCK) → sweeps down into a dying,
  // hopeless low groan (DESPAIR). No sawtooth buzz, no robotic distortion.
  function jumpscare() {
    // Use the recorded SFX if it loaded; otherwise the synth roar below.
    if (sfx && sfxReady) {
      try { sfx.currentTime = 0; sfx.volume = 1.0; const pr = sfx.play(); if (pr) pr.catch(() => synthRoar()); return; }
      catch (e) { /* fall through to synth */ }
    }
    synthRoar();
  }
  function synthRoar() {
    ensure(); if (ctx.state === 'suspended') ctx.resume();
    if (master) master.gain.value = 1.0;
    const t = ctx.currentTime, dur = 1.7;

    // 1) wet IMPACT — a short, low-passed crack the instant he grabs you
    const imp = ctx.createBufferSource(); imp.buffer = noiseBuffer(0.18, 'white');
    const impf = ctx.createBiquadFilter(); impf.type = 'lowpass'; impf.frequency.value = 1200;
    const ig = ctx.createGain(); ig.gain.setValueAtTime(1.0, t); ig.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    imp.connect(impf); impf.connect(ig); ig.connect(master); imp.start(t); imp.stop(t + 0.18);

    // 2) the ROAR — brown-noise breath driven through three vocal FORMANT band-passes, with a
    //    fast amplitude growl (LFO) for a guttural, flesh-and-throat texture.
    const roar = ctx.createBufferSource(); roar.buffer = noiseBuffer(2, 'brown'); roar.loop = true;
    // a master cutoff that opens on the shock then sweeps down into the despairing groan
    const sweep = ctx.createBiquadFilter(); sweep.type = 'lowpass';
    sweep.frequency.setValueAtTime(2600, t); sweep.frequency.exponentialRampToValueAtTime(260, t + dur);
    const roarGain = ctx.createGain();
    roarGain.gain.setValueAtTime(0.0001, t); roarGain.gain.exponentialRampToValueAtTime(0.9, t + 0.05);
    roarGain.gain.setValueAtTime(0.9, t + 0.9); roarGain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    // growl: LFO modulating the roar amplitude ~30 Hz, slowing slightly (the snarl loses energy)
    const growl = ctx.createOscillator(); growl.type = 'sine'; growl.frequency.setValueAtTime(34, t); growl.frequency.linearRampToValueAtTime(18, t + dur);
    const growlDepth = ctx.createGain(); growlDepth.gain.value = 0.4; growl.connect(growlDepth); growlDepth.connect(roarGain.gain);
    growl.start(t); growl.stop(t + dur);
    // formants — three resonant peaks give it a throat/voice rather than a hiss
    [[420, 9], [1100, 7], [2300, 5]].forEach(([freq, q], i) => {
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.setValueAtTime(freq, t);
      bp.frequency.exponentialRampToValueAtTime(freq * 0.5, t + dur); bp.Q.value = q;
      const fg = ctx.createGain(); fg.gain.value = [0.7, 0.5, 0.3][i];
      sweep.connect(bp); bp.connect(fg); fg.connect(roarGain);
    });
    roar.connect(sweep); roarGain.connect(master); roar.start(t); roar.stop(t + dur);

    // 3) sub-bass DROP — the body/dread under it all
    const sub = ctx.createOscillator(); sub.type = 'sine';
    sub.frequency.setValueAtTime(85, t); sub.frequency.exponentialRampToValueAtTime(26, t + 1.1);
    const subg = ctx.createGain(); subg.gain.setValueAtTime(0.9, t); subg.gain.exponentialRampToValueAtTime(0.001, t + 1.3);
    sub.connect(subg); subg.connect(master); sub.start(t); sub.stop(t + 1.3);

    setTimeout(stop, 1800);
  }

  return { init, start, stop, setTension, footstep, peek, chaseStart, pickup, click, jumpscare, menuStart, menuStop, menuIsPlaying };
})();
