/**
 * Ventana "Mejoras": el árbol de lo que se compra con la plata de la caja.
 * Tres ramas (la tienda, marketing y el centro de datos); cada mejora es un nodo unido a las que necesita.
 * Abajo, la ficha de la mejora elegida con el botón Comprar.
 */
import { UNLOCKS, type UnlockDef, type UpgradeBranch, type World } from "@cdb/sim";
import type { PlaceKind } from "./store3d.js";
import type { FloatingWindow } from "./windows.js";

const BRANCHES: { id: UpgradeBranch; label: string; blurb: string }[] = [
  { id: "tienda", label: "La tienda", blurb: "Estantes y un local más grande" },
  { id: "equipo", label: "Equipo", blurb: "Más cajas y más robots" },
  { id: "marketing", label: "Marketing", blurb: "Que lleguen más clientes" },
  { id: "datos", label: "Centro de datos", blurb: "Más espacio para racks" },
];

const ICONS: Record<string, string> = {
  estante1: "🧺", estante2: "🧺", estante3: "🧺", estante4: "🧺",
  local1: "🧱", local2: "🏬",
  caja2: "🧾", caja3: "🧾", robot1: "🤖", robot2: "🤖",
  volantes: "📄", musica: "🎵", letrero: "💡", radio: "📻", redes: "📱",
  sala1: "🗄️", sala2: "🏢",
};

const money = (n: number) => "$" + Math.round(n).toLocaleString("es-CO");

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Nivel de cada mejora dentro de su rama: 0 si no necesita nada, si no 1 + el nivel más alto de lo que necesita. */
function tiers(): Map<string, number> {
  const t = new Map<string, number>();
  const of = (u: UnlockDef): number => {
    if (t.has(u.id)) return t.get(u.id)!;
    const reqs = (u.requires ?? []).map((r) => UNLOCKS.find((x) => x.id === r)!).filter((r) => r.branch === u.branch);
    const n = reqs.length ? 1 + Math.max(...reqs.map(of)) : 0;
    t.set(u.id, n);
    return n;
  };
  for (const u of UNLOCKS) of(u);
  return t;
}

type State = "owned" | "ready" | "poor" | "locked";

export class UpgradesWindow {
  private selected: string = UNLOCKS[0].id;
  private readonly tree: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly cash: HTMLElement;
  private readonly pending: HTMLElement;
  private lastKey = "";

  /**
   * @param onBought se llama después de cada compra (la web refresca y, si son estantes, entra al modo colocar).
   * @param onPlace el jugador quiere colocar ahora los estantes que tiene pendientes.
   */
  constructor(
    private readonly win: FloatingWindow,
    private readonly world: () => World,
    private readonly onBought: (def: UnlockDef) => void,
    private readonly onPlace: (kind: PlaceKind) => void,
  ) {
    const t = tiers();
    win.body.innerHTML = `<div class="upg">
        <header class="upg-head">
          <span class="upg-cash">En caja <b></b></span>
          <span class="upg-pending" hidden></span>
        </header>
        <div class="upg-tree">${BRANCHES.map((b) => {
          const nodes = UNLOCKS.filter((u) => u.branch === b.id);
          const depth = Math.max(...nodes.map((u) => t.get(u.id)!)) + 1;
          const rows = Array.from({ length: depth }, (_, i) => nodes.filter((u) => t.get(u.id) === i));
          return `<section class="upg-branch" data-branch="${b.id}">
              <h3>${b.label}</h3><p class="upg-blurb">${b.blurb}</p>
              <div class="upg-rows"><svg class="upg-lines" aria-hidden="true"></svg>${rows
                .map((row) => `<div class="upg-row">${row.map((u) => this.nodeHtml(u)).join("")}</div>`)
                .join("")}</div>
            </section>`;
        }).join("")}</div>
        <footer class="upg-detail" aria-live="polite"></footer>
      </div>`;
    this.tree = win.body.querySelector(".upg-tree")!;
    this.detail = win.body.querySelector(".upg-detail")!;
    this.cash = win.body.querySelector(".upg-cash b")!;
    this.pending = win.body.querySelector(".upg-pending")!;

    this.tree.addEventListener("click", (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>("[data-node]")?.dataset.node;
      if (!id) return;
      this.selected = id;
      this.update(true);
    });
    this.tree.addEventListener("dblclick", (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>("[data-node]")?.dataset.node;
      if (id) this.buy(id);
    });
    this.detail.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".upg-buy")) this.buy(this.selected);
    });
    this.pending.addEventListener("click", (e) => {
      const kind = (e.target as HTMLElement).closest<HTMLElement>("[data-place]")?.dataset.place as PlaceKind | undefined;
      if (kind) this.onPlace(kind);
    });
    new ResizeObserver(() => this.drawLines()).observe(this.tree);
    win.onShow = () => this.update(true);
    this.update(true);
  }

  private nodeHtml(u: UnlockDef): string {
    return `<button class="upg-node" data-node="${u.id}">
        <span class="upg-icon" aria-hidden="true">${ICONS[u.id] ?? "★"}</span>
        <span class="upg-name">${esc(u.label)}</span>
        <span class="upg-price"></span>
      </button>`;
  }

  private state(u: UnlockDef): State {
    const w = this.world();
    if (w.unlocked.has(u.id)) return "owned";
    if ((u.requires ?? []).some((r) => !w.unlocked.has(r))) return "locked";
    return w.money >= u.cost ? "ready" : "poor";
  }

  private buy(id: string): void {
    const w = this.world();
    const r = w.buy(id);
    if (!r.ok) return;
    this.onBought(UNLOCKS.find((u) => u.id === id)!);
    this.update(true);
  }

  /** Refresca estados, precios y la ficha. Barato si nada cambió (se llama cada medio segundo). */
  update(force = false): void {
    const w = this.world();
    const key = `${w.money}|${[...w.unlocked].join()}|${w.shelvesToPlace}|${w.registersToPlace}|${this.selected}`;
    if (!force && key === this.lastKey) return;
    this.lastKey = key;
    this.cash.textContent = money(w.money);
    const parts: string[] = [];
    const n = w.shelvesToPlace;
    const r = w.registersToPlace;
    if (n) parts.push(`${n === 1 ? "1 estante" : `${n} estantes`} sin colocar <button data-place="shelf">Colocar</button>`);
    if (r) parts.push(`${r === 1 ? "1 caja" : `${r} cajas`} sin colocar <button data-place="register">Colocar</button>`);
    this.pending.hidden = parts.length === 0;
    this.pending.innerHTML = parts.join(`<span class="upg-sep"></span>`);
    for (const u of UNLOCKS) {
      const el = this.tree.querySelector<HTMLElement>(`[data-node="${u.id}"]`)!;
      const st = this.state(u);
      el.dataset.state = st;
      el.classList.toggle("sel", u.id === this.selected);
      el.setAttribute("aria-pressed", String(u.id === this.selected));
      const price = el.querySelector(".upg-price")!;
      const text = st === "owned" ? "✓ Comprado" : st === "locked" ? `🔒 ${money(u.cost)}` : money(u.cost);
      if (price.textContent !== text) price.textContent = text;
    }
    this.renderDetail();
    this.drawLines();
  }

  private renderDetail(): void {
    const w = this.world();
    const u = UNLOCKS.find((x) => x.id === this.selected)!;
    const st = this.state(u);
    const branch = BRANCHES.find((b) => b.id === u.branch)!;
    const missing = (u.requires ?? []).filter((r) => !w.unlocked.has(r)).map((r) => UNLOCKS.find((x) => x.id === r)!.label);
    const note =
      st === "owned" ? "Ya es tuyo."
      : st === "locked" ? `Primero compra ${missing.join(" y ")}.`
      : st === "poor" ? `Te faltan ${money(u.cost - w.money)}.`
      : u.shelves ? "Al comprarlo eliges en la tienda dónde va cada estante."
      : u.registers ? "Al comprarla eliges en la tienda dónde va. Llega con su robot cajero; el código se lo escribes tú."
      : u.stockers ? "Llega al almacén con su propia ventana de código."
      : "";
    this.detail.dataset.branch = u.branch;
    this.detail.innerHTML = `<span class="upg-dicon" aria-hidden="true">${ICONS[u.id] ?? "★"}</span>
      <div class="upg-dtext">
        <h4>${esc(u.label)} <small>${branch.label}</small></h4>
        <p>${esc(u.description)}</p>
        ${note ? `<p class="upg-note ${st}">${esc(note)}</p>` : ""}
      </div>
      <button class="upg-buy" ${st === "ready" ? "" : "disabled"}>${st === "owned" ? "Comprado" : `Comprar por ${money(u.cost)}`}</button>`;
  }

  /** Une cada mejora con las que necesita (de la misma rama) con una curva. */
  private drawLines(): void {
    if (!this.win.isOpen) return;
    const w = this.world();
    for (const branch of this.tree.querySelectorAll<HTMLElement>(".upg-branch")) {
      const rows = branch.querySelector<HTMLElement>(".upg-rows")!;
      const svg = rows.querySelector("svg")!;
      const box = rows.getBoundingClientRect();
      svg.setAttribute("width", String(box.width));
      svg.setAttribute("height", String(box.height));
      const center = (id: string, edge: "top" | "bottom") => {
        const r = rows.querySelector(`[data-node="${id}"]`)!.getBoundingClientRect();
        return { x: r.left - box.left + r.width / 2, y: (edge === "top" ? r.top : r.bottom) - box.top };
      };
      const paths: string[] = [];
      for (const u of UNLOCKS.filter((x) => x.branch === branch.dataset.branch)) {
        for (const req of u.requires ?? []) {
          const def = UNLOCKS.find((x) => x.id === req)!;
          if (def.branch !== u.branch) continue;
          const a = center(req, "bottom");
          const b = center(u.id, "top");
          const my = (a.y + b.y) / 2;
          const lit = w.unlocked.has(req);
          paths.push(`<path class="${lit ? "lit" : ""}" d="M${a.x},${a.y} C${a.x},${my} ${b.x},${my} ${b.x},${b.y}"/>`);
        }
      }
      svg.innerHTML = paths.join("");
    }
  }
}
