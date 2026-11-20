import type { SoundName } from "@cdb/sim";

/**
 * Todo el audio es procedural (Web Audio API): no hay archivos de sonido.
 * - Música: lo-fi tranquilo de tienda, con un secuenciador que programa notas por adelantado.
 * - Efectos: un sintetizador pequeño por cada sonido del juego.
 * El navegador solo deja sonar audio después de un gesto del jugador (clic o tecla).
 */

interface Settings {
  music: number; // 0-1
  sfx: number; // 0-1
  muted: boolean;
}

const STORAGE_KEY = "cdb.audio.v1";
const MAX_VOICES = 48; // música + efectos

/** Tiempo mínimo entre dos veces el mismo efecto (para no saturar a velocidad 4x). */
const THROTTLE_MS: Partial<Record<SoundName, number>> = { scan: 90, coins: 120, door: 300, pick: 120, place: 120, missing: 250, angry: 250 };

function load(): Settings {
  try {
    return { music: 0.5, sfx: 0.7, muted: false, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") };
  } catch {
    return { music: 0.5, sfx: 0.7, muted: false };
  }
}

const midi = (n: number) => 440 * 2 ** ((n - 69) / 12);

export type SongName = "portada" | "mañana" | "tarde" | "prisa" | "noche" | "inventario";

/** Tempo, swing, acordes (un compás cada uno) y escala de la melodía de cada canción. */
const SONGS: Record<SongName, { bpm: number; swing: number; chords: number[][]; scale: number[] }> = {
  // menú principal: Dm9 – Bbmaj7 – Fmaj7 – C6, lento y amplio
  portada: { bpm: 70, swing: 0, chords: [[50, 57, 60, 64], [46, 53, 57, 62], [41, 48, 52, 57], [48, 52, 55, 57]], scale: [74, 76, 77, 81, 84, 86] },
  // G – D – Em – C (con séptimas suaves)
  mañana: { bpm: 96, swing: 0.1, chords: [[55, 59, 62, 66], [50, 54, 57, 61], [52, 55, 59, 62], [48, 52, 55, 59]], scale: [74, 76, 79, 81, 83, 86] },
  // Fmaj7 – Em7 – Dm7 – Cmaj7 a 78 BPM con swing (la canción original)
  tarde: { bpm: 78, swing: 0.18, chords: [[53, 57, 60, 64], [52, 55, 59, 62], [50, 53, 57, 60], [48, 52, 55, 59]], scale: [72, 74, 76, 79, 81, 84] },
  // Dm – Bb – C – A
  prisa: { bpm: 122, swing: 0, chords: [[50, 53, 57, 62], [46, 50, 53, 58], [48, 52, 55, 60], [45, 49, 52, 57]], scale: [74, 76, 77, 79, 81, 84] },
  // Am9 – Fmaj7 – Cmaj7 – G6
  noche: { bpm: 64, swing: 0.12, chords: [[45, 52, 55, 59], [41, 48, 52, 57], [48, 52, 55, 59], [43, 50, 52, 59]], scale: [76, 79, 81, 84, 86, 88] },
  // Cmaj7 – Am7 – Fmaj7 – G7sus
  inventario: { bpm: 74, swing: 0.08, chords: [[48, 52, 55, 59], [45, 48, 52, 55], [41, 45, 48, 52], [43, 48, 50, 53]], scale: [72, 74, 76, 79, 81] },
};

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicBus!: GainNode;
  private sfxBus!: GainNode;
  private noise!: AudioBuffer;
  private voices = 0;
  private lastPlayed = new Map<SoundName, number>();
  readonly settings: Settings = load();

  // secuenciador
  private step = 0;
  private nextNoteTime = 0;
  private timer: number | null = null;

  constructor() {
    // se desbloquea con el primer gesto del jugador
    const unlock = () => {
      this.start();
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    // al volver a la pestaña, el contexto puede haberse suspendido
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && this.ctx?.state === "suspended") void this.ctx.resume();
    });
  }

  get started(): boolean {
    return this.ctx !== null;
  }

  /** Activa el audio (llamar desde un clic del jugador). */
  unlock(): void {
    this.start();
    if (this.ctx?.state === "suspended") void this.ctx.resume();
  }

  private start(): void {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.musicBus = ctx.createGain();
    this.sfxBus = ctx.createGain();
    // un poco de compresión para que nada pique
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 3;
    this.musicBus.connect(comp);
    this.sfxBus.connect(comp);
    comp.connect(this.master);
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.applySettings();
    this.nextNoteTime = ctx.currentTime + 0.1;
    this.timer = window.setInterval(() => this.schedule(), 25);
  }

  set(partial: Partial<Settings>): void {
    Object.assign(this.settings, partial);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      /* sin almacenamiento */
    }
    this.applySettings();
  }

  private applySettings(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.settings.muted ? 0 : 1, t, 0.05);
    this.musicBus.gain.setTargetAtTime(this.settings.music * 0.32, t, 0.1);
    this.sfxBus.gain.setTargetAtTime(this.settings.sfx * 0.9, t, 0.05);
  }

  // ── efectos ───────────────────────────────────────────────

  play(name: SoundName): void {
    if (!this.ctx || this.settings.muted || this.settings.sfx === 0) return;
    const now = performance.now();
    const gap = THROTTLE_MS[name] ?? 60;
    if (now - (this.lastPlayed.get(name) ?? -1e9) < gap) return;
    if (this.voices >= MAX_VOICES) return;
    this.lastPlayed.set(name, now);
    const t = this.ctx.currentTime + 0.005;
    switch (name) {
      case "scan": // bip del lector de código de barras
        this.tone(1870, "square", t, 0.07, 0.12, 5000);
        break;
      case "cash": // ¡ka-ching!: golpe del cajón + campanita
        this.hit(t, 0.08, 0.35, 1800, 300);
        this.tone(midi(88), "triangle", t + 0.04, 0.5, 0.18);
        this.tone(midi(93), "triangle", t + 0.1, 0.6, 0.16);
        this.tone(midi(100), "sine", t + 0.1, 0.7, 0.07);
        break;
      case "coins": // monedas que caen
        for (let i = 0; i < 4; i++) this.tone(2400 + Math.random() * 1600, "sine", t + i * 0.045 + Math.random() * 0.02, 0.09, 0.08);
        break;
      case "door": // campanita de la puerta (ding-dong)
        this.tone(midi(84), "sine", t, 0.6, 0.16);
        this.tone(midi(80), "sine", t + 0.28, 0.8, 0.16);
        break;
      case "angry": // "¡hmpf!": voz grave que baja
        this.slide(260, 140, "sawtooth", t, 0.28, 0.1, 900);
        break;
      case "missing": // dos notas tristes
        this.tone(midi(64), "triangle", t, 0.18, 0.12);
        this.tone(midi(60), "triangle", t + 0.16, 0.3, 0.12);
        break;
      case "error": // buzz suave
        this.tone(110, "square", t, 0.18, 0.08, 700);
        this.tone(104, "square", t + 0.2, 0.25, 0.08, 700);
        break;
      case "pick": // caja de cartón
        this.hit(t, 0.07, 0.25, 600, 80);
        break;
      case "place": // producto al estante
        this.hit(t, 0.05, 0.18, 2200, 600);
        this.tone(midi(76), "sine", t + 0.02, 0.12, 0.06);
        break;
      case "unlock": // fanfarria corta
        [72, 76, 79, 84].forEach((n, i) => this.tone(midi(n), "triangle", t + i * 0.09, 0.35, 0.14));
        break;
      case "open": // amanece y abre la tienda
        this.cue("open");
        break;
      case "close": // 19:00: la tienda cierra (campanitas que bajan, como una canción de cuna)
        [84, 79, 76, 72, 67].forEach((n, i) => this.tone(midi(n), "sine", t + i * 0.16, 0.9, 0.11));
        this.tone(midi(48), "triangle", t + 0.8, 1.6, 0.08, 800);
        break;
      case "paused": // pausa del depurador
        this.tone(midi(79), "sine", t, 0.12, 0.12);
        this.tone(midi(72), "sine", t + 0.1, 0.22, 0.12);
        break;
    }
  }

  /** Sonidos de la intro y de la interfaz. */
  cue(name: string): void {
    if (!this.ctx || this.settings.muted || this.settings.sfx === 0) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.01;
    switch (name) {
      case "truck": {
        // motor diésel que pasa junto a la cámara y se aleja frenando (efecto Doppler simple)
        const osc = ctx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(62, t);
        osc.frequency.linearRampToValueAtTime(74, t + 1.4);
        osc.frequency.linearRampToValueAtTime(48, t + 2.4);
        osc.frequency.linearRampToValueAtTime(38, t + 6);
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.setValueAtTime(380, t);
        lp.frequency.linearRampToValueAtTime(900, t + 1.5);
        lp.frequency.linearRampToValueAtTime(300, t + 6);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.22, t + 1.3);
        g.gain.exponentialRampToValueAtTime(0.1, t + 3);
        g.gain.exponentialRampToValueAtTime(0.06, t + 5.4);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 6.6);
        osc.connect(lp).connect(g).connect(this.sfxBus);
        osc.start(t);
        this.voice(osc, t + 6.7);
        // ruido de llantas sobre el asfalto
        const src = ctx.createBufferSource();
        src.buffer = this.noise;
        src.loop = true;
        const nf = ctx.createBiquadFilter();
        nf.type = "bandpass";
        nf.frequency.value = 500;
        const ng = ctx.createGain();
        ng.gain.setValueAtTime(0.0001, t);
        ng.gain.exponentialRampToValueAtTime(0.09, t + 1.3);
        ng.gain.exponentialRampToValueAtTime(0.0001, t + 6);
        src.connect(nf).connect(ng).connect(this.sfxBus);
        src.start(t);
        this.voice(src, t + 6.1);
        break;
      }
      case "brake": // freno de aire: psssh
        this.hit(t, 0.9, 0.16, 9000, 2500);
        this.tone(880, "sine", t, 0.35, 0.025);
        break;
      case "doors": // bisagras que crujen y el golpe de las puertas
        this.slide(170, 260, "sawtooth", t, 0.55, 0.04, 1200);
        this.slide(190, 240, "sawtooth", t + 0.15, 0.5, 0.03, 1200);
        this.hit(t + 1.05, 0.18, 0.35, 380, 60);
        break;
      case "box": // caja que cae en el almacén
        this.hit(t, 0.14, 0.3, 520, 70);
        break;
      case "welcome": // campanita de bienvenida
        [72, 76, 79, 84].forEach((n, i) => this.tone(midi(n), "triangle", t + i * 0.08, 0.7, 0.12));
        this.tone(midi(96), "sine", t + 0.32, 1.2, 0.05);
        break;
      case "check": // paso de la misión completado
        this.tone(midi(79), "triangle", t, 0.18, 0.13);
        this.tone(midi(86), "triangle", t + 0.09, 0.3, 0.13);
        break;
      // ── menú principal ──
      case "ui-move": // tic suave al pasar por una opción
        this.tone(midi(91), "sine", t, 0.05, 0.035, 5000);
        this.hit(t, 0.02, 0.05, 9000, 4000);
        break;
      case "ui-select": // bip del lector + una nota que confirma
        this.tone(1870, "square", t, 0.06, 0.07, 4200);
        this.tone(midi(84), "triangle", t + 0.05, 0.22, 0.1);
        break;
      case "ui-back": // dos notas que bajan
        this.tone(midi(79), "triangle", t, 0.1, 0.08);
        this.tone(midi(72), "triangle", t + 0.07, 0.18, 0.08);
        break;
      case "ui-locked": // golpecito sordo: la opción todavía no está
        this.tone(midi(55), "square", t, 0.09, 0.05, 900);
        break;
      case "ui-start": {
        // ¡a jugar!: bip del lector, barrido de aire y un acorde grande que se abre
        this.tone(1870, "square", t, 0.09, 0.09, 4200);
        this.tone(2490, "square", t + 0.1, 0.12, 0.07, 4200);
        const src = ctx.createBufferSource();
        src.buffer = this.noise;
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.Q.value = 1.4;
        bp.frequency.setValueAtTime(300, t + 0.1);
        bp.frequency.exponentialRampToValueAtTime(7000, t + 0.9);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t + 0.1);
        g.gain.exponentialRampToValueAtTime(0.16, t + 0.6);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
        src.connect(bp).connect(g).connect(this.sfxBus);
        src.start(t + 0.1);
        this.voice(src, t + 1.15);
        [62, 69, 74, 77, 81, 86].forEach((n, i) => this.tone(midi(n), "triangle", t + 0.55 + i * 0.045, 1.6, 0.075, 3800));
        this.tone(midi(38), "sine", t + 0.55, 1.8, 0.22, 400);
        break;
      }
      case "open": // ¡a abrir la tienda!
        [67, 72, 76, 79, 84].forEach((n, i) => this.tone(midi(n), "triangle", t + i * 0.07, 0.5, 0.13));
        this.hit(t + 0.36, 0.5, 0.06, 12000, 6000);
        break;
    }
  }

  private voice(node: AudioScheduledSourceNode, end: number): void {
    this.voices++;
    node.onended = () => this.voices--;
    node.stop(end);
  }

  private tone(freq: number, type: OscillatorType, t: number, dur: number, gain: number, lpf = 6000, bus: AudioNode = this.sfxBus): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = lpf;
    osc.connect(f).connect(g).connect(bus);
    osc.start(t);
    this.voice(osc, t + dur + 0.02);
  }

  private slide(from: number, to: number, type: OscillatorType, t: number, dur: number, gain: number, lpf: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = lpf;
    osc.connect(f).connect(g).connect(this.sfxBus);
    osc.start(t);
    this.voice(osc, t + dur + 0.02);
  }

  /** Golpe de ruido filtrado (cartón, cajón, platillos). */
  private hit(t: number, dur: number, gain: number, lpf: number, hpf: number, bus: AudioNode = this.sfxBus): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const lo = ctx.createBiquadFilter();
    lo.type = "lowpass";
    lo.frequency.value = lpf;
    const hi = ctx.createBiquadFilter();
    hi.type = "highpass";
    hi.frequency.value = hpf;
    src.connect(hi).connect(lo).connect(g).connect(bus);
    src.start(t, Math.random() * 0.5);
    this.voice(src, t + dur + 0.02);
  }

  // ── música: varias canciones según la situación ─────────────

  /**
   * Canción que suena ahora. Se cambia con setMusic(); el cambio espera al próximo compás para no cortar feo.
   * - mañana: alegre, abre la tienda (Sol mayor, 96 BPM)
   * - tarde: lo-fi tranquilo de tienda (la canción original)
   * - prisa: cuando hay cola larga o la tienda está por cerrar (Re menor, 122 BPM)
   * - noche: tienda cerrada, para programar (pads lentos y campanitas, 64 BPM)
   * - inventario: la misión de la base de datos (pensativa, 74 BPM)
   */
  private song: SongName = "mañana";
  private pending: SongName | null = null;

  setMusic(name: SongName): void {
    if (name !== this.song && name !== this.pending) this.pending = name;
  }

  get music(): SongName {
    return this.pending ?? this.song;
  }

  private schedule(): void {
    const ctx = this.ctx!;
    if (this.settings.muted || this.settings.music === 0) {
      this.nextNoteTime = ctx.currentTime + 0.1;
      if (this.pending) [this.song, this.pending, this.step] = [this.pending, null, 0];
      return;
    }
    while (this.nextNoteTime < ctx.currentTime + 0.12) {
      // los cambios de canción entran al empezar un compás
      if (this.pending && this.step % 16 === 0) [this.song, this.pending, this.step] = [this.pending, null, 0];
      const def = SONGS[this.song];
      const sixteenth = 60 / def.bpm / 4;
      const swing = this.step % 2 === 1 ? sixteenth * def.swing : 0;
      this.musicStep(this.step, this.nextNoteTime + swing, sixteenth);
      this.nextNoteTime += sixteenth;
      this.step = (this.step + 1) % (16 * def.chords.length * 2);
    }
  }

  private musicStep(step: number, t: number, s16: number): void {
    const def = SONGS[this.song];
    const bar = Math.floor(step / 16) % def.chords.length;
    const pos = step % 16;
    const chord = def.chords[bar];
    const bus = this.musicBus;
    const melody = (positions: number[], chance: number, gain: number, len = 3) => {
      if (positions.includes(pos) && Math.random() < chance) {
        const n = def.scale[Math.floor(Math.random() * def.scale.length)];
        this.ep(midi(n), t, s16 * len, gain);
      }
    };

    switch (this.song) {
      case "portada": {
        // pads anchos, bajo largo, arpegio de campanitas que sube y un bombo lejano cada compás
        if (pos === 0) chord.forEach((n) => this.pad(midi(n), t, s16 * 16, 0.03));
        if (pos === 0) this.tone(midi(chord[0] - 12), "sine", t, s16 * 15, 0.22, 300, bus);
        if (pos === 0) this.kick(t);
        if (pos % 2 === 0) {
          const n = chord[(pos / 2) % 4] + 24 - (pos >= 8 ? 12 : 0);
          this.bell(midi(n), t, pos === 0 ? 0.03 : 0.018);
        }
        if (pos === 8) this.hit(t, 0.5, 0.02, 3000, 900, bus);
        if (bar % 2 === 1) melody([4, 12], 0.5, 0.035, 6);
        break;
      }
      case "mañana": {
        // piano en corcheas con acento, bajo saltarín, batería ligera y una melodía que aparece seguido
        if (pos % 4 === 0) chord.forEach((n, i) => this.ep(midi(n + 12), t + i * 0.008, s16 * 3, pos === 0 ? 0.075 : 0.045));
        if (pos === 0 || pos === 6 || pos === 8 || pos === 14) this.tone(midi(chord[0] - 12 + (pos === 14 ? 7 : 0)), "triangle", t, s16 * 2, 0.26, 600, bus);
        if (pos === 0 || pos === 8) this.kick(t);
        if (pos === 4 || pos === 12) this.hit(t, 0.12, 0.1, 5000, 1500, bus);
        if (pos % 2 === 0) this.hit(t, 0.025, 0.035, 12000, 8000, bus);
        melody([2, 3, 6, 10, 11, 14], 0.45, 0.05, 2);
        break;
      }
      case "tarde": {
        if (pos === 0 || pos === 10) chord.forEach((n, i) => this.ep(midi(n + 12), t + i * 0.012, s16 * (pos === 0 ? 9 : 5), pos === 0 ? 0.09 : 0.05));
        if (pos === 0 || pos === 7 || pos === 8) this.tone(midi(chord[0] - 12), "sine", t, s16 * (pos === 0 ? 6 : 2.5), 0.32, 400, bus);
        if (pos === 0 || pos === 9) this.kick(t);
        if (pos === 4 || pos === 12) this.hit(t, 0.16, 0.12, 4000, 1200, bus);
        if (pos % 2 === 0) this.hit(t, 0.03, pos % 4 === 2 ? 0.05 : 0.03, 12000, 7000, bus);
        if (bar % 2 === 1) melody([2, 6, 11], 0.6, 0.045);
        break;
      }
      case "prisa": {
        // bajo en corcheas, caja fuerte, hi-hat en semicorcheas y acordes cortos a contratiempo
        if (pos % 2 === 0) this.tone(midi(chord[0] - 12 + (pos % 8 === 6 ? 12 : 0)), "sawtooth", t, s16 * 1.6, 0.13, 700, bus);
        if (pos === 2 || pos === 6 || pos === 10 || pos === 14) chord.forEach((n) => this.tone(midi(n + 12), "square", t, s16 * 0.9, 0.022, 2200, bus));
        if (pos === 0 || pos === 8 || pos === 10) this.kick(t);
        if (pos === 4 || pos === 12) this.hit(t, 0.14, 0.16, 6000, 1500, bus);
        this.hit(t, 0.02, pos % 2 === 0 ? 0.04 : 0.022, 13000, 8500, bus);
        melody([0, 3, 6, 8, 11, 14], 0.5, 0.045, 1.5);
        break;
      }
      case "noche": {
        // pads largos que entran despacio, bajo suave, bombo muy de vez en cuando y campanitas con eco
        if (pos === 0) chord.forEach((n) => this.pad(midi(n), t, s16 * 16, 0.035));
        if (pos === 0 || pos === 10) this.tone(midi(chord[0] - 12), "sine", t, s16 * (pos === 0 ? 9 : 5), 0.2, 300, bus);
        if (pos === 0 && bar % 2 === 0) this.kick(t);
        if (pos === 8) this.hit(t, 0.4, 0.025, 3000, 900, bus); // escobilla
        if ([3, 7, 12].includes(pos) && Math.random() < 0.35) {
          const n = def.scale[Math.floor(Math.random() * def.scale.length)];
          this.bell(midi(n), t, 0.04);
          this.bell(midi(n), t + s16 * 3, 0.014); // eco
        }
        break;
      }
      case "inventario": {
        // arpegio que sube y baja sobre el acorde, como alguien pensando
        const arp = [0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1, 0, 2, 1, 3];
        this.tone(midi(chord[arp[pos]] + 12), "triangle", t, s16 * 1.8, pos % 4 === 0 ? 0.05 : 0.032, 2400, bus);
        if (pos === 0) this.tone(midi(chord[0] - 12), "sine", t, s16 * 14, 0.24, 350, bus);
        if (pos === 0 || pos === 10) this.kick(t);
        if (pos === 8) this.hit(t, 0.1, 0.06, 5000, 1500, bus);
        if (pos % 4 === 2) this.hit(t, 0.025, 0.025, 12000, 8000, bus);
        if (bar === 3) melody([4, 12], 0.7, 0.04, 4);
        break;
      }
    }
  }

  /** Acorde de fondo que entra despacio y se apaga largo (para la noche). */
  private pad(freq: number, t: number, dur: number, gain: number): void {
    const ctx = this.ctx!;
    for (const [mult, type, g0] of [[1, "sine", gain], [1.004, "triangle", gain * 0.5]] as const) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(freq * mult, t);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(g0, t + dur * 0.35);
      g.gain.linearRampToValueAtTime(0.0001, t + dur);
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = 1600;
      osc.connect(f).connect(g).connect(this.musicBus);
      osc.start(t);
      this.voice(osc, t + dur + 0.05);
    }
  }

  /** Campanita: seno con un armónico alto que se apaga rápido. */
  private bell(freq: number, t: number, gain: number): void {
    this.tone(freq, "sine", t, 1.4, gain, 5000, this.musicBus);
    this.tone(freq * 2.76, "sine", t, 0.35, gain * 0.3, 7000, this.musicBus);
  }

  /** Piano eléctrico simple: dos osciladores suaves con un brillo que se apaga. */
  private ep(freq: number, t: number, dur: number, gain: number): void {
    this.tone(freq, "sine", t, dur, gain, 2500, this.musicBus);
    this.tone(freq * 2.003, "triangle", t, dur * 0.4, gain * 0.25, 3000, this.musicBus);
  }

  private kick(t: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(120, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    osc.connect(g).connect(this.musicBus);
    osc.start(t);
    this.voice(osc, t + 0.27);
  }
}
