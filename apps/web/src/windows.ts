/** Ventanas flotantes: se arrastran por la barra de título, cambian de tamaño por la esquina y se minimizan. */

export interface WindowOptions {
  id: string;
  title: string;
  /** Contenido extra en la barra de título (punto de color, estado...). */
  titleExtra?: HTMLElement;
  x: number;
  y: number;
  width: number;
  height: number;
  minWidth?: number;
  minHeight?: number;
  className?: string;
  open?: boolean;
}

interface Saved {
  /** Tamaño de letra de la ventana (1 = normal). */
  zoom?: number;
  x: number;
  y: number;
  width: number;
  height: number;
  open: boolean;
  minimized: boolean;
}

const STORAGE_KEY = "cdb.windows.v1";

/** Tamaños base de la escala de texto (los mismos de :root en style.css). */
const FONT_TOKENS: Record<string, number> = { "--fs-code": 21, "--fs-data": 18, "--fs-ui": 16, "--fs-sm": 14 };
const ZOOM_MIN = 0.7;
const ZOOM_MAX = 1.8;
const ZOOM_STEP = 0.1;
let zTop = 10;

/** Borde inferior de la barra superior (el letrero): las ventanas no pueden quedar debajo de él. */
export function topInset(): number {
  const bar = document.querySelector(".letrero");
  return bar ? Math.ceil(bar.getBoundingClientRect().bottom) + 6 : 56;
}

/** Borde derecho del explorador de archivos (la barra lateral): las ventanas no pueden quedar debajo de él. */
export function leftInset(): number {
  const ex = document.querySelector<HTMLElement>(".explorer");
  if (!ex) return 4;
  return Math.ceil(ex.getBoundingClientRect().right) + 6;
}

function loadAll(): Record<string, Saved> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function saveAll(all: Record<string, Saved>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* sin almacenamiento */
  }
}

export class FloatingWindow {
  readonly el: HTMLElement;
  readonly body: HTMLElement;
  readonly titleEl: HTMLElement;
  private minimized = false;
  private zoom = 1;
  onFocus?: () => void;
  onShow?: () => void;

  constructor(layer: HTMLElement, private readonly opts: WindowOptions) {
    const saved = loadAll()[opts.id];
    this.el = document.createElement("section");
    this.el.className = `win ${opts.className ?? ""}`;
    this.el.setAttribute("aria-label", opts.title);
    this.el.innerHTML = `
      <header class="win-bar">
        <span class="win-title"></span>
        <span class="win-zoom" role="group" aria-label="Tamaño de la letra">
          <button class="win-zoom-out" title="Letra y ventana más pequeñas" aria-label="Más pequeño">−</button>
          <button class="win-zoom-val" title="Volver al tamaño normal">100%</button>
          <button class="win-zoom-in" title="Letra y ventana más grandes" aria-label="Más grande">+</button>
        </span>
        <span class="win-buttons">
          <button class="win-min" title="Minimizar" aria-label="Minimizar">▁</button>
          <button class="win-close" title="Cerrar" aria-label="Cerrar">×</button>
        </span>
      </header>
      <div class="win-body"></div>
      <div class="win-resize" aria-hidden="true"></div>`;
    this.titleEl = this.el.querySelector(".win-title")!;
    this.titleEl.textContent = opts.title;
    if (opts.titleExtra) this.titleEl.prepend(opts.titleExtra);
    this.body = this.el.querySelector(".win-body")!;
    layer.append(this.el);

    const box = saved ?? { x: opts.x, y: opts.y, width: opts.width, height: opts.height, open: opts.open ?? true, minimized: false };
    if (box.height < (opts.minHeight ?? 140)) box.height = opts.height; // guardada mal por una versión anterior
    this.place(box.x, box.y, box.width, box.height);
    this.el.hidden = !box.open;
    if (box.minimized) this.setMinimized(true, false);
    this.applyZoom(saved?.zoom ?? 1);
    this.el.querySelector(".win-zoom-in")!.addEventListener("click", () => this.changeZoom(+ZOOM_STEP));
    this.el.querySelector(".win-zoom-out")!.addEventListener("click", () => this.changeZoom(-ZOOM_STEP));
    this.el.querySelector(".win-zoom-val")!.addEventListener("click", () => this.changeZoom(1 - this.zoom));

    this.el.addEventListener("pointerdown", () => this.focus());
    this.el.querySelector(".win-min")!.addEventListener("click", () => this.setMinimized(!this.minimized));
    this.el.querySelector(".win-close")!.addEventListener("click", () => this.close());
    this.el.querySelector(".win-bar")!.addEventListener("dblclick", (e) => {
      if (!(e.target as HTMLElement).closest("button")) this.setMinimized(!this.minimized);
    });
    this.drag(this.el.querySelector(".win-bar")!, (dx, dy, start) => this.place(start.x + dx, start.y + dy, start.w, start.h));
    this.drag(this.el.querySelector(".win-resize")!, (dx, dy, start) =>
      this.place(start.x, start.y, Math.max(opts.minWidth ?? 260, start.w + dx), Math.max(opts.minHeight ?? 140, start.h + dy)),
    );
    // ojo: una ventana oculta mide 0 de ancho; por eso el ancho "normal" se guarda en dataset.w (como la altura en dataset.h)
    window.addEventListener("resize", () => this.place(this.el.offsetLeft, this.el.offsetTop, this.fullWidth(), this.fullHeight(), false));
    this.focus();
  }

  private drag(handle: HTMLElement, move: (dx: number, dy: number, start: { x: number; y: number; w: number; h: number }) => void): void {
    handle.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest("button") || e.button !== 0) return;
      e.preventDefault();
      const start = { x: this.el.offsetLeft, y: this.el.offsetTop, w: this.el.offsetWidth, h: this.fullHeight() };
      const sx = e.clientX;
      const sy = e.clientY;
      handle.setPointerCapture(e.pointerId);
      const onMove = (ev: PointerEvent) => move(ev.clientX - sx, ev.clientY - sy, start);
      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        this.save();
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
    });
  }

  /** Coloca la ventana sin dejarla salir de la pantalla. */
  private place(x: number, y: number, w: number, h: number, save = false): void {
    const maxW = window.innerWidth;
    const maxH = window.innerHeight;
    w = Math.min(w, maxW - 8);
    h = Math.min(h, maxH - 60);
    const top = topInset();
    const left = leftInset();
    x = Math.max(left, Math.min(x, maxW - 80));
    w = Math.min(w, maxW - left - 4);
    y = Math.max(top, Math.min(y, maxH - 40));
    h = Math.min(h, maxH - top - 6);
    w = Math.max(w, this.opts.minWidth ?? 200);
    Object.assign(this.el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px` });
    this.el.dataset.w = String(w);
    this.el.dataset.h = String(h);
    if (!this.minimized) this.el.style.height = `${h}px`;
    if (save) this.save();
  }

  /** Ancho normal de la ventana (aunque ahora esté oculta y mida 0). */
  private fullWidth(): number {
    return Number(this.el.dataset.w) || this.opts.width;
  }

  /** Altura de la ventana abierta (aunque ahora esté minimizada y mida solo la barra). */
  private fullHeight(): number {
    return Number(this.el.dataset.h) || this.opts.height;
  }

  private save(): void {
    const all = loadAll();
    all[this.opts.id] = {
      x: this.el.offsetLeft,
      y: this.el.offsetTop,
      width: this.fullWidth(),
      height: this.fullHeight(),
      open: !this.el.hidden,
      minimized: this.minimized,
      zoom: this.zoom,
    };
    saveAll(all);
  }

  /** Cambia el tamaño de la letra y escala la ventana en la misma proporción. */
  private changeZoom(delta: number): void {
    const next = Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.zoom + delta)) * 10) / 10;
    if (next === this.zoom) return;
    const ratio = next / this.zoom;
    this.applyZoom(next);
    this.place(this.el.offsetLeft, this.el.offsetTop, this.fullWidth() * ratio, this.fullHeight() * ratio, true);
  }

  private applyZoom(z: number): void {
    this.zoom = z;
    for (const [token, px] of Object.entries(FONT_TOKENS)) this.el.style.setProperty(token, `${Math.round(px * z * 10) / 10}px`);
    this.el.querySelector(".win-zoom-val")!.textContent = `${Math.round(z * 100)}%`;
    (this.el.querySelector(".win-zoom-out") as HTMLButtonElement).disabled = z <= ZOOM_MIN;
    (this.el.querySelector(".win-zoom-in") as HTMLButtonElement).disabled = z >= ZOOM_MAX;
  }

  /** Mueve y cambia el tamaño de la ventana (y lo guarda). */
  setBox(x: number, y: number, w: number, h: number): void {
    if (this.minimized) this.setMinimized(false, false);
    this.place(x, y, w, h, true);
  }

  setMinimized(min: boolean, save = true): void {
    this.minimized = min;
    this.el.classList.toggle("minimized", min);
    this.el.style.height = min ? "" : `${this.el.dataset.h}px`;
    if (!min) this.onShow?.();
    if (save) this.save();
  }

  focus(): void {
    this.el.style.zIndex = String(++zTop);
    document.querySelectorAll(".win.focused").forEach((w) => w !== this.el && w.classList.remove("focused"));
    this.el.classList.add("focused");
    this.onFocus?.();
  }

  /** Abre (o trae al frente) la ventana. */
  show(): void {
    const wasHidden = this.el.hidden;
    this.el.hidden = false;
    if (this.minimized) this.setMinimized(false);
    this.focus();
    if (wasHidden) {
      this.onShow?.();
      this.save();
    }
  }

  close(): void {
    this.el.hidden = true;
    this.save();
  }

  toggle(): void {
    if (this.el.hidden || this.minimized) this.show();
    else this.close();
  }

  get isOpen(): boolean {
    return !this.el.hidden && !this.minimized;
  }
}
