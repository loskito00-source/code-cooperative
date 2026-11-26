/**
 * Panel "Jugar en línea" del menú principal: tu nombre, crear una partida, unirte con un código y la lista de
 * partidas guardadas (todas son públicas). Devuelve lo que eligió el jugador.
 */
import { loadPlayer, PLAYER_COLORS, type PlayerInfo, savePlayer } from "./player.js";
import { createPartida, listPartidas, type PartidaInfo } from "./saves.js";

export type OnlineChoice = { player: PlayerInfo; id: string; nombre: string; created: boolean };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const money = (n: number) => "$" + Math.round(n).toLocaleString("es-CO");

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "hace un momento";
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return `hace ${Math.round(s / 86400)} días`;
}

/** El color del toldo sale del código: cada tienda de la lista se distingue de un vistazo. */
const AWNINGS = ["#d94f3d", "#2e86de", "#3fa34d", "#e8a33a", "#9b6bd6", "#1fa5a0"];
function awning(code: string): string {
  let h = 0;
  for (const c of code) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AWNINGS[h % AWNINGS.length];
}

export class Lobby {
  private player = loadPlayer();
  private resolve: ((c: OnlineChoice) => void) | null = null;
  private refreshTimer = 0;

  constructor(private readonly el: HTMLElement) {
    el.querySelector(".mp-body")!.innerHTML = `
      <section class="lb-me" aria-label="Tu carnet">
        <span class="lb-avatar" aria-hidden="true"></span>
        <label class="lb-field lb-namefield"><span>Tu nombre</span><input class="lb-name" maxlength="16" placeholder="Cómo te ve tu compañero" autocomplete="nickname" /></label>
        <div class="lb-colors" role="radiogroup" aria-label="Tu color">${PLAYER_COLORS.map((c, i) => `<button class="lb-color" data-color="${c}" style="--c:${c}" role="radio" aria-label="Color ${i + 1}"></button>`).join("")}</div>
      </section>
      <div class="lb-tabs" role="tablist">
        <button class="lb-tab on" role="tab" aria-selected="true" data-tab="create">Abrir una tienda</button>
        <button class="lb-tab" role="tab" aria-selected="false" data-tab="join">Tengo un código</button>
      </div>
      <form class="lb-form lb-create" data-pane="create">
        <input class="lb-pname" maxlength="32" placeholder="Nombre de la tienda (opcional)" aria-label="Nombre de la partida nueva" />
        <button>Abrir</button>
      </form>
      <form class="lb-form lb-join" data-pane="join" hidden>
        <input class="lb-code" maxlength="4" placeholder="ABCD" autocapitalize="characters" spellcheck="false" aria-label="Código de 4 letras" />
        <button>Entrar</button>
      </form>
      <p class="lb-msg" aria-live="polite"></p>
      <div class="lb-list-head"><h3>Tiendas del barrio <span class="lb-count"></span></h3><button class="lb-refresh" title="Actualizar la lista" aria-label="Actualizar la lista">↻</button></div>
      <ul class="lb-list"><li class="lb-empty">Buscando tiendas…</li></ul>`;
    const name = el.querySelector<HTMLInputElement>(".lb-name")!;
    name.value = this.player.name;
    name.addEventListener("input", () => {
      this.player.name = name.value.trim().slice(0, 16);
      savePlayer(this.player);
      this.paintMe();
    });
    el.querySelectorAll<HTMLButtonElement>(".lb-color").forEach((b) =>
      b.addEventListener("click", () => {
        this.player.color = b.dataset.color!;
        savePlayer(this.player);
        this.paintMe();
      }),
    );
    el.querySelectorAll<HTMLButtonElement>(".lb-tab").forEach((t) => t.addEventListener("click", () => this.tab(t.dataset.tab as "create" | "join")));
    this.paintMe();
    el.querySelector(".lb-create")!.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.create();
    });
    const codeIn = el.querySelector<HTMLInputElement>(".lb-code")!;
    codeIn.addEventListener("input", () => (codeIn.value = codeIn.value.toUpperCase().replace(/[^A-Z]/g, "")));
    el.querySelector(".lb-join")!.addEventListener("submit", (e) => {
      e.preventDefault();
      const code = codeIn.value.trim().toUpperCase();
      if (!/^[A-Z]{4}$/.test(code)) return this.msg("El código son 4 letras, como ABCD.", true);
      this.choose(code, code, false);
    });
    el.querySelector(".lb-refresh")!.addEventListener("click", () => void this.refresh());
    el.querySelector(".lb-list")!.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-join]");
      if (b) this.choose(b.dataset.join!, b.dataset.name ?? b.dataset.join!, false);
    });
  }

  private tab(which: "create" | "join"): void {
    this.el.querySelectorAll<HTMLButtonElement>(".lb-tab").forEach((t) => {
      const on = t.dataset.tab === which;
      t.classList.toggle("on", on);
      t.setAttribute("aria-selected", String(on));
    });
    this.el.querySelectorAll<HTMLElement>(".lb-form").forEach((f) => (f.hidden = f.dataset.pane !== which));
    this.el.querySelector<HTMLInputElement>(which === "create" ? ".lb-pname" : ".lb-code")!.focus();
    this.msg("");
  }

  /** Muestra el panel y espera a que el jugador elija una partida. */
  open(): Promise<OnlineChoice> {
    void this.refresh();
    clearInterval(this.refreshTimer);
    this.refreshTimer = window.setInterval(() => void this.refresh(), 8000);
    setTimeout(() => (this.player.name ? null : this.el.querySelector<HTMLInputElement>(".lb-name"))?.focus(), 50);
    return new Promise((r) => (this.resolve = r));
  }

  close(): void {
    clearInterval(this.refreshTimer);
  }

  /** El carnet: inicial en el color elegido. */
  private paintMe(): void {
    const av = this.el.querySelector<HTMLElement>(".lb-avatar")!;
    av.textContent = (this.player.name.trim()[0] ?? "?").toUpperCase();
    this.el.querySelector<HTMLElement>(".lb-me")!.style.setProperty("--me", this.player.color);
    this.el.querySelectorAll<HTMLButtonElement>(".lb-color").forEach((b) => {
      const on = b.dataset.color === this.player.color;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
    });
  }

  private msg(text: string, bad = false): void {
    const m = this.el.querySelector<HTMLElement>(".lb-msg")!;
    m.textContent = text;
    m.classList.toggle("bad", bad);
  }

  private needName(): boolean {
    if (this.player.name) return false;
    this.msg("Primero escribe tu nombre: así te ve tu compañero.", true);
    this.el.querySelector<HTMLInputElement>(".lb-name")!.focus();
    return true;
  }

  private async create(): Promise<void> {
    if (this.needName()) return;
    const input = this.el.querySelector<HTMLInputElement>(".lb-pname")!;
    const nombre = input.value.trim() || `La Esquina de ${this.player.name}`;
    this.msg("Abriendo la tienda…");
    const r = await createPartida(nombre, this.player.name);
    if (!r.ok) return this.msg(r.reason, true);
    this.choose(r.id, nombre, true);
  }

  private choose(id: string, nombre: string, created: boolean): void {
    if (this.needName()) return;
    this.close();
    this.resolve?.({ player: { ...this.player }, id, nombre, created });
  }

  private async refresh(): Promise<void> {
    const ul = this.el.querySelector<HTMLElement>(".lb-list")!;
    const r = await listPartidas();
    if (!r.ok) {
      ul.innerHTML = `<li class="lb-empty bad">${esc(r.reason)}</li>`;
      return;
    }
    this.el.querySelector(".lb-count")!.textContent = r.list.length ? String(r.list.length) : "";
    ul.innerHTML = r.list.length
      ? r.list.map((p: PartidaInfo) => `<li class="lb-shop" style="--awning:${awning(p.id)}">
          <span class="lb-awning" aria-hidden="true"></span>
          <div class="lb-shop-body">
            <div class="lb-shop-main"><b>${esc(p.nombre)}</b><span class="lb-tag" title="Código para entrar">${esc(p.id)}</span></div>
            <div class="lb-shop-sub"><span>Día ${p.dia}</span><span>${money(p.plata)}</span><span>${p.jugadores.length ? esc(p.jugadores.join(" y ")) : "Nadie todavía"}</span><span>${ago(p.actualizada)}</span></div>
          </div>
          <button data-join="${esc(p.id)}" data-name="${esc(p.nombre)}">Entrar</button>
        </li>`).join("")
      : `<li class="lb-empty">El barrio está vacío. Abre la primera tienda.</li>`;
  }
}
