/** Piezas de la bienvenida: franjas de cine, ventanas tipo videojuego y el panel de la misión. */

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, html = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  e.innerHTML = html;
  return e;
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Franjas negras arriba y abajo mientras pasa la cinemática. */
export function showLetterbox(onSkip: () => void): { hide: () => void; skip: () => void } {
  const box = el("div", "letterbox", `<div class="lb-top"></div><div class="lb-bottom"><button class="lb-skip">Saltar intro ▸</button></div>`);
  document.body.append(box);
  requestAnimationFrame(() => box.classList.add("on"));
  const skip = box.querySelector<HTMLButtonElement>(".lb-skip")!;
  skip.addEventListener("click", onSkip);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") onSkip();
  };
  window.addEventListener("keydown", onKey);
  return {
    skip: onSkip,
    hide: () => {
      window.removeEventListener("keydown", onKey);
      box.classList.remove("on");
      setTimeout(() => box.remove(), 600);
    },
  };
}

export interface ModalOptions {
  /** Entrega la función que la cierra desde afuera (en línea: el otro jugador presionó Continuar). */
  register?: (close: () => void) => void;
  /** Se cerró (byUser = la cerró este jugador, no el otro). */
  onClose?: (byUser: boolean) => void;
  kicker: string;
  title: string;
  /** Texto que aparece con efecto de máquina de escribir (puede tener saltos de línea). */
  letter?: string;
  signature?: string;
  /** HTML extra debajo de la carta (p. ej. los pasos de la misión). */
  html?: string;
  button: string;
  step: number;
  steps: number;
  onOpen?: () => void;
}

/** Ventana modal tipo videojuego. Se cierra con el botón o con Enter. */
export function showModal(o: ModalOptions): Promise<void> {
  return new Promise((resolve) => {
    const dots = Array.from({ length: o.steps }, (_, i) => `<span class="${i === o.step ? "on" : ""}"></span>`).join("");
    const overlay = el(
      "div",
      "gm-overlay",
      `<div class="gm" role="dialog" aria-modal="true" aria-labelledby="gm-title">
        <header class="gm-plaque"><span class="gm-kicker">${o.kicker}</span><h2 id="gm-title">${o.title}</h2></header>
        <div class="gm-paper">
          ${o.letter !== undefined ? `<p class="gm-letter"></p>` : ""}
          ${o.signature ? `<p class="gm-signature">${o.signature}</p>` : ""}
          ${o.html ?? ""}
        </div>
        <footer class="gm-foot"><span class="gm-dots" aria-hidden="true">${dots}</span><button class="gm-btn">${o.button}</button></footer>
      </div>`,
    );
    document.body.append(overlay);
    requestAnimationFrame(() => overlay.classList.add("on"));
    o.onOpen?.();

    const letter = overlay.querySelector<HTMLElement>(".gm-letter");
    const sig = overlay.querySelector<HTMLElement>(".gm-signature");
    const extra = [...overlay.querySelectorAll<HTMLElement>(".gm-paper > :not(.gm-letter):not(.gm-signature)")];
    let typing: number | null = null;
    const finish = () => {
      if (typing !== null) clearInterval(typing);
      typing = null;
      if (letter && o.letter) letter.textContent = o.letter;
      sig?.classList.add("shown");
      extra.forEach((e) => e.classList.add("shown"));
    };
    if (letter && o.letter && !reducedMotion()) {
      let i = 0;
      typing = window.setInterval(() => {
        i += 2;
        letter.textContent = o.letter!.slice(0, i);
        if (i >= o.letter!.length) finish();
      }, 22);
    } else finish();

    const btn = overlay.querySelector<HTMLButtonElement>(".gm-btn")!;
    let closed = false;
    const close = (byUser = true) => {
      if (closed) return;
      if (typing !== null && byUser) {
        finish(); // el primer clic termina de escribir; el segundo continúa
        return;
      }
      closed = true;
      if (typing !== null) clearInterval(typing);
      o.onClose?.(byUser);
      window.removeEventListener("keydown", onKey);
      overlay.classList.remove("on");
      overlay.classList.add("off");
      setTimeout(() => overlay.remove(), 320);
      resolve();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        close();
      }
    };
    btn.addEventListener("click", () => close());
    o.register?.(() => close(false));
    overlay.querySelector(".gm-paper")!.addEventListener("click", () => typing !== null && finish());
    window.addEventListener("keydown", onKey);
    setTimeout(() => btn.focus(), 50);
  });
}

export interface ObjectiveItem {
  label: string;
  done: boolean;
}

/** Panel fijo con la misión actual, sus pasos y el botón para abrir la tienda. */
export class ObjectivesPanel {
  readonly el: HTMLElement;
  private onOpen: () => void;
  private lastDone = new Set<number>();

  constructor(title: string, onOpen: () => void, onSkip?: () => void, button = "Abrir la tienda ▸") {
    this.onOpen = onOpen;
    this.el = el(
      "aside",
      "mission",
      `<div class="mission-head"><span class="mission-kicker">Misión</span><h3>${title}</h3></div>
       <ol class="mission-list"></ol>
       <p class="mission-hint" hidden></p>
       <button class="mission-btn" disabled>${button}</button>
       ${onSkip ? `<button class="mission-skip" type="button">Saltar ⏭</button>` : ""}`,
    );
    this.el.querySelector(".mission-btn")!.addEventListener("click", () => this.onOpen());
    // Saltar pide confirmación con un segundo clic (sin diálogos del navegador)
    const skip = this.el.querySelector<HTMLButtonElement>(".mission-skip");
    let armed: number | null = null;
    skip?.addEventListener("click", () => {
      if (armed === null) {
        skip.textContent = "¿Seguro? Clic otra vez para saltar";
        skip.classList.add("armed");
        armed = window.setTimeout(() => {
          armed = null;
          skip.textContent = "Saltar ⏭";
          skip.classList.remove("armed");
        }, 4000);
        return;
      }
      clearTimeout(armed);
      skip.disabled = true;
      skip.textContent = "Saltando…";
      onSkip!();
    });
    document.body.append(this.el);
  }

  /** Actualiza los pasos; devuelve los índices que se acaban de completar (para el sonido). */
  update(items: ObjectiveItem[], hint: string | null): number[] {
    const newly: number[] = [];
    items.forEach((it, i) => {
      if (it.done && !this.lastDone.has(i)) newly.push(i);
    });
    this.lastDone = new Set(items.flatMap((it, i) => (it.done ? [i] : [])));
    this.el.querySelector(".mission-list")!.innerHTML = items
      .map((it, i) => `<li class="${it.done ? "done" : ""} ${newly.includes(i) ? "just" : ""}"><span class="tick" aria-hidden="true">${it.done ? "✓" : i + 1}</span><span>${it.label}</span></li>`)
      .join("");
    const h = this.el.querySelector<HTMLElement>(".mission-hint")!;
    h.hidden = !hint;
    h.innerHTML = hint ?? "";
    const all = items.every((it) => it.done);
    const btn = this.el.querySelector<HTMLButtonElement>(".mission-btn")!;
    btn.disabled = !all;
    btn.classList.toggle("ready", all);
    return newly;
  }

  remove(): void {
    this.el.classList.add("off");
    setTimeout(() => this.el.remove(), 400);
  }
}

/** Cómo le fue a la tienda en el día que acaba de terminar (lo da World.lastDay). */
export interface DayReport {
  day: number;
  sales: number;
  revenue: number;
  ok: number;
  lost: number;
}

const pesos = (n: number) => "$" + Math.round(n).toLocaleString("es-CO");

/**
 * Panel de la noche: la tienda está cerrada, cuenta regresiva hasta que amanezca y un botón "¡Listo!" por jugador.
 * La tienda abre cuando votan todos o cuando se acaba el tiempo (eso lo decide World).
 * La primera noche es la preparación después de la misión; las siguientes muestran el resumen del día.
 */
export class NightPanel {
  readonly el: HTMLElement;
  private readonly clock: HTMLElement;
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly count: HTMLElement;
  private lastKey = "";

  /** Va en la barra superior (el letrero), entre el sonido y las ventanas, para no tapar la tienda. */
  constructor(
    players: { id: string; label: string; mine?: boolean }[],
    opts: { day: number; totalMs: number; report: DayReport | null },
    onVote: (player: string, ready: boolean) => void,
  ) {
    const r = opts.report;
    const report = r
      ? `Día ${r.day}: ${r.sales} ventas, ${pesos(r.revenue)}${r.lost ? `, ${r.lost} se fueron sin comprar` : ""}${r.sales > r.ok ? `, ${r.sales - r.ok} cobros mal` : ""}.`
      : "";
    this.el = el(
      "div",
      "nightbar",
      `<div class="nb-time" title="La tienda está cerrada: aprovechen para programar. Mañana es el día ${opts.day}.${report ? " " + report : ""}">
         <span class="nb-kicker">🌙 Abre en</span><strong class="nb-clock">10:00</strong>
       </div>
       <div class="nb-votes" role="group" aria-label="Votos para abrir ya"></div>
       <span class="nb-count" aria-live="polite"></span>`,
    );
    this.clock = this.el.querySelector(".nb-clock")!;
    this.count = this.el.querySelector(".nb-count")!;
    const votes = this.el.querySelector(".nb-votes")!;
    for (const p of players) {
      const b = document.createElement("button");
      b.className = "nb-vote";
      b.dataset.label = p.label;
      b.addEventListener("click", () => onVote(p.id, !b.classList.contains("on")));
      if (p.mine === false) {
        b.disabled = true; // en línea cada uno vota por sí mismo
        b.classList.add("theirs");
      }
      votes.append(b);
      this.buttons.set(p.id, b);
    }
    const bar = document.querySelector(".letrero");
    const dock = bar?.querySelector(".dock") ?? null;
    if (bar) bar.insertBefore(this.el, dock);
    else document.body.append(this.el);
    this.update(opts.totalMs, []);
  }

  update(remainingMs: number, votes: string[]): void {
    const secs = Math.ceil(remainingMs / 1000);
    const text = `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
    if (this.clock.textContent !== text) this.clock.textContent = text;
    this.el.classList.toggle("hurry", secs <= 60);
    const key = votes.join(",");
    if (key === this.lastKey && this.count.textContent) return;
    this.lastKey = key;
    for (const [id, b] of this.buttons) {
      const on = votes.includes(id);
      b.classList.toggle("on", on);
      const short = (b.dataset.label ?? "").replace("Jugador ", "J");
      b.innerHTML = on ? `✓ ${short}` : `${short} ¡Listo!`;
      b.title = on ? `${b.dataset.label} está listo. Clic para cancelar el voto` : `${b.dataset.label}: vota para abrir la tienda antes de que amanezca`;
    }
    const n = votes.length;
    const total = this.buttons.size;
    this.count.textContent = n === 0 ? "" : n < total ? `${n}/${total}` : "¡Abren!";
  }

  /** Amaneció y abrió la tienda: un momento de "¡Abierto!" y se va. */
  opened(_reason: "votos" | "tiempo", day: number): void {
    this.el.classList.add("done");
    this.el.querySelector(".nb-kicker")!.textContent = "☀️ ¡Abierto!";
    this.clock.textContent = `Día ${day}`;
    this.el.querySelector(".nb-votes")!.innerHTML = "";
    this.count.textContent = "";
    setTimeout(() => {
      this.el.classList.add("off");
      setTimeout(() => this.el.remove(), 400);
    }, 2500);
  }
}
