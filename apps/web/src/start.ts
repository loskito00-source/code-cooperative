// Menú principal. El HTML está en index.html (para que se vea desde el primer cuadro, antes que la barra del juego);
// aquí se le da vida: progreso de carga, teclado, cursor, paneles, sonido, polvo en el aire y la salida al juego.
import type { AudioEngine } from "./audio.js";
import { Lobby, type OnlineChoice } from "./online/lobby.js";

type Panel = "how" | "options" | "credits" | "online";

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export class MainMenu {
  private readonly el = document.getElementById("menu")!;
  private readonly items = [...this.el.querySelectorAll<HTMLButtonElement>(".menu-item")];
  private readonly cursor = this.el.querySelector<HTMLElement>(".menu-cursor")!;
  private readonly play = this.el.querySelector<HTMLButtonElement>('[data-action="play"]')!;
  private readonly playSub = this.play.querySelector<HTMLElement>(".mi-sub")!;
  private panel: Panel | null = null;
  private ready = false;
  private leaving = false;
  private resolveEnter!: () => void;
  /** Se cumple cuando el jugador entra a la tienda (y la animación de salida ya tapó el menú). */
  readonly entered = new Promise<void>((r) => (this.resolveEnter = r));
  private dustStop: (() => void) | null = null;
  private readonly online = this.el.querySelector<HTMLButtonElement>('[data-action="online"]')!;
  private lobby: Lobby | null = null;
  /** Lo que eligió en "Jugar en línea" (null = partida local). */
  onlineChoice: OnlineChoice | null = null;

  constructor(private readonly audio: AudioEngine) {
    this.el.classList.add("live");
    for (const b of this.items) {
      b.addEventListener("pointerenter", () => this.focusItem(b));
      b.addEventListener("focus", () => this.moveCursor(b));
      b.addEventListener("click", () => this.activate(b));
    }
    for (const back of this.el.querySelectorAll<HTMLButtonElement>(".mp-back")) back.addEventListener("click", () => this.closePanel());
    this.el.addEventListener("keydown", (e) => this.onKey(e));
    // el primer gesto desbloquea el audio: arranca la música de la portada
    const wake = () => {
      audio.unlock();
      audio.setMusic("portada");
    };
    this.el.addEventListener("pointerdown", wake);
    this.el.addEventListener("keydown", wake);
    audio.setMusic("portada");
    this.bindOptions();
    this.dustStop = startDust(this.el.querySelector<HTMLCanvasElement>(".menu-dust")!);
    // el cursor se ubica cuando las fuentes ya midieron los botones
    void document.fonts.ready.then(() => this.moveCursor(document.activeElement instanceof HTMLButtonElement && this.items.includes(document.activeElement) ? document.activeElement : this.items[0]));
    this.items[0].focus({ preventScroll: true });
    window.addEventListener("resize", () => this.moveCursor(this.current()));
  }

  /** Progreso de carga de los modelos 3D (0 a 1). */
  setProgress(f: number): void {
    if (this.ready) return;
    this.play.style.setProperty("--p", String(f));
    this.playSub.textContent = `Armando la tienda… ${Math.round(f * 100)}%`;
  }

  /** La tienda 3D ya está detrás del menú: se puede entrar. */
  setReady(): void {
    this.ready = true;
    this.play.style.setProperty("--p", "1");
    this.play.removeAttribute("aria-disabled");
    this.online.removeAttribute("aria-disabled");
    this.playSub.textContent = "Partida nueva. Empieza cuando llega el camión del distribuidor.";
    this.el.classList.add("scene-ready");
  }

  fail(message: string): void {
    this.playSub.textContent = message;
    this.play.classList.add("failed");
  }

  private current(): HTMLButtonElement {
    const a = document.activeElement;
    return a instanceof HTMLButtonElement && this.items.includes(a) ? a : this.items[0];
  }

  private focusItem(b: HTMLButtonElement): void {
    if (this.panel || this.leaving || document.activeElement === b) return;
    b.focus({ preventScroll: true });
    this.audio.cue("ui-move");
  }

  /** El cursor amarillo se desliza hasta la opción elegida (uno solo, que viaja: no aparece y desaparece). */
  private moveCursor(b: HTMLButtonElement): void {
    for (const it of this.items) it.classList.toggle("on", it === b);
    this.cursor.style.transform = `translateY(${b.offsetTop}px)`;
    this.cursor.style.height = `${b.offsetHeight}px`;
    this.cursor.classList.add("shown");
  }

  private onKey(e: KeyboardEvent): void {
    if (this.leaving) return;
    if (e.key === "Escape" && this.panel) {
      e.preventDefault();
      this.closePanel();
      return;
    }
    if (this.panel) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const i = this.items.indexOf(this.current());
      const next = this.items[(i + (e.key === "ArrowDown" ? 1 : -1) + this.items.length) % this.items.length];
      this.focusItem(next);
    }
  }

  private activate(b: HTMLButtonElement): void {
    if (this.leaving || this.panel) return;
    const action = b.dataset.action;
    if (b.getAttribute("aria-disabled") === "true") {
      this.audio.cue("ui-locked");
      b.classList.remove("nope");
      void b.offsetWidth; // reinicia la animación
      b.classList.add("nope");
      return;
    }
    if (action === "play") this.enter();
    else this.openPanel(action as Panel);
  }

  private openPanel(name: Panel): void {
    this.audio.cue("ui-select");
    this.panel = name;
    const p = this.el.querySelector<HTMLElement>(`.menu-panel[data-panel="${name}"]`)!;
    p.hidden = false;
    this.el.classList.add("panel-open");
    if (name === "options") this.renderOptions();
    if (name === "online") {
      this.lobby ??= new Lobby(p);
      void this.lobby.open().then((choice) => {
        this.onlineChoice = choice;
        this.panel = null;
        p.hidden = true;
        this.el.classList.remove("panel-open");
        this.enter();
      });
    }
    p.classList.add("in"); // es una animación con @keyframes: no hace falta esperar un cuadro
    (p.querySelector<HTMLElement>("input, .mp-back"))!.focus({ preventScroll: true });
  }

  private closePanel(): void {
    if (!this.panel) return;
    this.audio.cue("ui-back");
    const name = this.panel;
    if (name === "online") this.lobby?.close();
    this.panel = null;
    const p = this.el.querySelector<HTMLElement>(`.menu-panel[data-panel="${name}"]`)!;
    p.classList.remove("in");
    this.el.classList.remove("panel-open");
    setTimeout(() => {
      if (!p.classList.contains("in")) p.hidden = true;
    }, 260);
    this.el.querySelector<HTMLButtonElement>(`[data-action="${name}"]`)!.focus({ preventScroll: true });
  }

  private bindOptions(): void {
    for (const input of this.el.querySelectorAll<HTMLInputElement>("[data-setting]")) {
      input.addEventListener("input", () => {
        const key = input.dataset.setting as "music" | "sfx" | "muted";
        if (key === "muted") this.audio.set({ muted: input.checked });
        else this.audio.set({ [key]: Number(input.value) / 100 });
        if (key === "sfx") this.audio.cue("ui-move");
        this.renderOptions();
      });
    }
  }

  private renderOptions(): void {
    const s = this.audio.settings;
    for (const input of this.el.querySelectorAll<HTMLInputElement>("[data-setting]")) {
      const key = input.dataset.setting as "music" | "sfx" | "muted";
      if (key === "muted") input.checked = s.muted;
      else {
        input.value = String(Math.round(s[key] * 100));
        input.style.setProperty("--v", `${input.value}%`);
        (input.nextElementSibling as HTMLOutputElement).textContent = `${input.value}%`;
      }
    }
  }

  /** Entra directo a una partida en línea (al recargar con #partida=ABCD en la dirección). */
  joinNow(choice: OnlineChoice): void {
    if (this.leaving) return;
    this.onlineChoice = choice;
    this.enter();
  }

  /** Salida: el láser del lector barre la pantalla, el menú se va y el juego queda detrás. */
  private enter(): void {
    this.leaving = true;
    this.audio.unlock();
    this.audio.cue("ui-start");
    this.el.classList.add("leaving");
    const quick = reducedMotion();
    setTimeout(() => this.resolveEnter(), quick ? 150 : 900);
    setTimeout(() => {
      this.dustStop?.();
      this.el.remove();
      document.body.classList.remove("menu-open");
    }, quick ? 400 : 1500);
  }
}

/** Polvo flotando en la luz: partículas lentas y tibias. Devuelve una función para detenerlo. */
function startDust(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx || reducedMotion()) return () => {};
  const dpr = Math.min(window.devicePixelRatio, 2);
  let w = 0;
  let h = 0;
  const fit = () => {
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  fit();
  window.addEventListener("resize", fit);
  const motes = Array.from({ length: 70 }, () => ({
    x: Math.random(),
    y: Math.random(),
    r: 0.6 + Math.random() * 2.2,
    s: 0.004 + Math.random() * 0.012,
    a: 0.15 + Math.random() * 0.45,
    p: Math.random() * Math.PI * 2,
  }));
  let raf = 0;
  let last = performance.now();
  const tick = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    ctx.clearRect(0, 0, w, h);
    for (const m of motes) {
      m.y -= m.s * dt;
      m.x += Math.sin(now / 2400 + m.p) * 0.0025 * dt;
      if (m.y < -0.02) {
        m.y = 1.02;
        m.x = Math.random();
      }
      const twinkle = 0.65 + 0.35 * Math.sin(now / 900 + m.p * 3);
      ctx.beginPath();
      ctx.fillStyle = `rgba(255, 220, 150, ${m.a * twinkle})`;
      ctx.arc(m.x * w, m.y * h, m.r, 0, Math.PI * 2);
      ctx.fill();
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", fit);
  };
}
