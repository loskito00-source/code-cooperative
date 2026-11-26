import { describeCase, PARTS, partDef, PRODUCT_NAMES, PRODUCTS, type ProductName, SERVICES, SUPPLIER, TICKS_PER_SECOND, type World } from "@cdb/sim";
import type { FloatingWindow } from "./windows.js";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const money = (n: number) => "$" + Math.round(n).toLocaleString("es-CO");

export const SITES = {
  proveedor: { url: "elsurtidor.test", title: "El Surtidor" },
  tienda: { url: "tecnomercado.test", title: "TecnoMercado" },
  denuncias: { url: "denuncias.ciber.test", title: "Centro de Denuncias Cibernéticas" },
  foro: { url: "foro.undernet.test", title: "Foro UnderNet" },
} as const;
export type Site = keyof typeof SITES;

const KIND_LABEL: Record<string, string> = {
  placa: "Placas madre", cpu: "Procesadores", disipador: "Disipadores", ram: "Memoria RAM", ssd: "Discos", fuente: "Fuentes de poder",
  gpu: "Tarjetas gráficas", ventilador: "Ventiladores",
};
const EMOJI: Record<string, string> = { pan: "🍞", leche: "🥛", huevos: "🥚", chocolate: "🍫", queso: "🧀", miel: "🍯", aceite: "🫒", vino: "🍷" };
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

const KIND_ICON: Record<string, string> = { placa: "▦", cpu: "◼", disipador: "❄", ram: "▤", ssd: "▭", fuente: "⚡", gpu: "▣", ventilador: "✣" };

/**
 * El navegador del juego (sitios ficticios): la tienda en línea de componentes, la página para denunciar ataques y
 * el foro de hackers donde a veces alguien se delata.
 */
export class BrowserWindow {
  private site: Site = "proveedor";
  private cart: string[] = [];
  /** Cajas de cada producto en el pedido a El Surtidor. */
  private goods: Partial<Record<ProductName, number>> = {};
  private notice: { text: string; tone: "ok" | "bad" } | null = null;
  private forumUser = "";
  private openCase: number | null = null;
  private lastHtml = "";

  constructor(
    readonly win: FloatingWindow,
    private readonly world: () => World,
    private readonly onChange: () => void,
    /** Abrir un Excel de la carpeta entregas (botón "Ver Excel" de un pedido entregado). */
    private readonly onOpenFile: (filename: string) => void = () => {},
  ) {
    win.el.classList.add("browserwin");
    win.body.innerHTML = `
      <div class="br">
        <div class="br-bar">
          <div class="br-tabs" role="tablist">${(Object.keys(SITES) as Site[]).map((s) => `<button role="tab" data-site="${s}">${SITES[s].title}</button>`).join("")}</div>
          <div class="br-url"><span class="br-lock" aria-hidden="true">🔒</span><span class="br-addr"></span></div>
        </div>
        <div class="br-page"></div>
      </div>`;
    win.body.addEventListener("click", (e) => this.click(e));
    win.body.addEventListener("submit", (e) => this.submit(e));
    win.onShow = () => this.render(true);
    setInterval(() => win.isOpen && this.render(), 700);
    this.render(true);
  }

  open(site: Site): void {
    this.site = site;
    this.notice = null;
    this.win.show();
    this.render(true);
  }

  private page(): HTMLElement {
    return this.win.body.querySelector(".br-page")!;
  }

  render(force = false): void {
    // no redibujar mientras el jugador escribe en un formulario
    const active = document.activeElement;
    if (!force && active && this.win.body.contains(active) && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
    this.win.body.querySelectorAll<HTMLElement>("[data-site]").forEach((b) => b.classList.toggle("on", b.dataset.site === this.site));
    this.win.body.querySelector(".br-addr")!.textContent = `https://${SITES[this.site].url}/`;
    const html = this.site === "proveedor" ? this.supplier() : this.site === "tienda" ? this.shop() : this.site === "denuncias" ? this.police() : this.forum();
    if (html === this.lastHtml && !force) return;
    this.lastHtml = html;
    const page = this.page();
    const scroll = page.scrollTop;
    page.innerHTML = html;
    page.scrollTop = scroll;
  }

  private noticeHtml(): string {
    return this.notice ? `<p class="br-notice ${this.notice.tone}">${this.notice.text}</p>` : "";
  }

  // ── Distribuidora El Surtidor (mercancía para el supermercado) ──

  private supplier(): string {
    const w = this.world();
    const units = SUPPLIER.caseUnits;
    const lines = PRODUCT_NAMES.filter((p) => (this.goods[p] ?? 0) > 0).map((p) => ({ product: p, cases: this.goods[p]! }));
    const total = lines.reduce((s, l) => s + l.cases * units * PRODUCTS[l.product].cost, 0);
    const card = (p: ProductName) => {
      const d = PRODUCTS[p];
      const n = this.goods[p] ?? 0;
      const profit = (d.price - d.cost) * units;
      const stars = Math.round(d.demand * 2);
      return `
        <article class="pv-card${d.basic ? "" : " premium"}${n ? " picked" : ""}">
          ${d.basic ? "" : `<span class="pv-ribbon">Se vende ${d.demand >= 2 ? "el doble" : "mucho mejor"}</span>`}
          <div class="pv-emoji" aria-hidden="true">${EMOJI[p] ?? "📦"}</div>
          <div class="pv-info">
            <h4>${cap(p)} <span class="pv-code">${d.code}</span></h4>
            <p>${esc(d.blurb)}</p>
            <div class="pv-demand" title="Qué tanto lo piden los clientes"><span class="pv-stars">${"★".repeat(stars)}<span>${"★".repeat(Math.max(0, 5 - stars))}</span></span> demanda</div>
          </div>
          <dl class="pv-nums">
            <div><dt>Caja de ${units}</dt><dd><b>${money(d.cost * units)}</b></dd></div>
            <div><dt>Se vende a</dt><dd>${money(d.price)} c/u</dd></div>
            <div><dt>Ganas por caja</dt><dd class="pv-profit">+${money(profit)}</dd></div>
          </dl>
          <div class="pv-qty" role="group" aria-label="Cajas de ${p}">
            <button data-goods="${p}" data-delta="-1" ${n ? "" : "disabled"} aria-label="Una caja menos">−</button>
            <output>${n}</output>
            <button data-goods="${p}" data-delta="1" ${n >= SUPPLIER.maxCases ? "disabled" : ""} aria-label="Una caja más">+</button>
          </div>
        </article>`;
    };
    const transit = w.goodsInTransit();
    const done = w.goodsOrders.filter((o) => o.file).reverse();
    const lineText = (o: { lines: { product: ProductName; cases: number }[] }) => o.lines.map((l) => `${EMOJI[l.product]} ${l.cases}× ${l.product}`).join(" · ");
    return `
      <div class="pv">
        <header class="pv-head">
          <div class="pv-logo" aria-hidden="true">ES</div>
          <div><h2>${SUPPLIER.name}</h2><p>Mayorista del barrio · cajas de ${units} unidades · el repartidor llega en 1 minuto con el Excel del pedido</p></div>
        </header>
        ${this.noticeHtml()}
        <div class="pv-layout">
          <div class="pv-catalog">
            <h3 class="pv-sec">Premium <small>más caros, pero dejan más, los piden más y atraen clientes</small></h3>
            ${PRODUCT_NAMES.filter((p) => !PRODUCTS[p].basic).map(card).join("")}
            <h3 class="pv-sec">Básicos <small>a precio mayorista (el proveedor del barrio cobra más)</small></h3>
            ${PRODUCT_NAMES.filter((p) => PRODUCTS[p].basic).map(card).join("")}
          </div>
          <aside class="pv-side">
            <section class="pv-box">
              <h3>Tu pedido</h3>
              ${lines.length ? `<ul class="pv-lines">${lines.map((l) => `<li><span>${EMOJI[l.product]} ${l.cases} caja${l.cases === 1 ? "" : "s"} de ${l.product}</span><b>${money(l.cases * units * PRODUCTS[l.product].cost)}</b></li>`).join("")}</ul>` : `<p class="pv-empty">Elige cuántas cajas quieres con + y −.</p>`}
              <p class="pv-total"><span>Total</span><b>${money(total)}</b></p>
              <p class="pv-cash">En caja: ${money(w.money)}</p>
              <button class="pv-pay" data-goods-pay ${!lines.length || total > w.money ? "disabled" : ""}>${total > w.money ? "No alcanza el dinero" : "Hacer pedido"}</button>
            </section>
            ${transit.length ? `<section class="pv-box"><h3>🚚 En camino</h3>${transit.map((o) => {
              const s = Math.max(0, Math.ceil((o.arriveTick - w.tick) / TICKS_PER_SECOND));
              return `<div class="pv-order"><div class="pv-order-top"><b>Pedido #${o.id}</b><span class="pv-eta">llega en ${s} s</span></div><p>${lineText(o)}</p></div>`;
            }).join("")}</section>` : ""}
            ${done.length ? `<section class="pv-box"><h3>Entregados</h3>${done.slice(0, 6).map((o) => `
              <div class="pv-order"><div class="pv-order-top"><b>Pedido #${o.id}</b><button class="pv-file" data-open-file="${esc(o.file!)}">📄 ${esc(o.file!)}</button></div><p>${lineText(o)}</p></div>`).join("")}
              <p class="pv-note">La mercancía entra al almacén cuando migras el Excel a tu tabla de inventario (pandas + <code>cursor.execute</code>). Siempre trae las mismas columnas que la primera entrega.</p></section>` : ""}
          </aside>
        </div>
      </div>`;
  }

  // ── TecnoMercado ──

  private shop(): string {
    const w = this.world();
    const total = this.cart.reduce((s, id) => s + (PARTS.find((p) => p.id === id)?.price ?? SERVICES.find((x) => x.id === id)!.price), 0);
    const kinds = [...new Set(PARTS.map((p) => p.kind))];
    const card = (id: string, name: string, price: number, blurb: string, icon: string, owned = false) => `
      <article class="sh-card">
        <div class="sh-icon" aria-hidden="true">${icon}</div>
        <div class="sh-info"><h4>${esc(name)}</h4><p>${esc(blurb)}</p></div>
        <div class="sh-buy"><b>${money(price)}</b><button data-add="${id}" ${owned ? "disabled" : ""}>${owned ? (id === "rack" ? "Sala llena" : "Ya lo tienes") : "Agregar"}</button></div>
      </article>`;
    const pending = w.orders.flatMap((o) => o.items);
    const stock = w.parts.map((p) => partDef(p.def).name);
    return `
      <div class="sh">
        <header class="sh-head"><h2>TecnoMercado</h2><p>Componentes para servidores · entrega a la mañana siguiente en el camión</p></header>
        ${this.noticeHtml()}
        <div class="sh-layout">
          <div class="sh-catalog">
            ${kinds.map((k) => `<h3>${KIND_LABEL[k]}</h3>${PARTS.filter((p) => p.kind === k).map((p) => card(p.id, p.name, p.price, p.blurb, KIND_ICON[k])).join("")}`).join("")}
            <h3>Para la sala de servidores</h3>
            ${SERVICES.map((s) => {
              if (s.id === "rack") {
                const total = w.racksOwned + pending.filter((x) => x === "rack").length + this.cart.filter((x) => x === "rack").length;
                return card(s.id, `${s.name} (tienes ${w.racksOwned} de 3)`, s.price, s.blurb, "🗄", total >= 3);
              }
              return card(s.id, s.name, s.price, s.blurb, s.id === "aire" ? "❄" : "🛡", w.services.has(s.id) || pending.includes(s.id));
            }).join("")}
            <p class="sh-note">Cada servidor necesita su propio gabinete de rack. Los cables de poder y de red vienen incluidos.</p>
          </div>
          <aside class="sh-cart">
            <h3>Carrito</h3>
            ${this.cart.length ? `<ul>${this.cart.map((id, i) => `<li><span>${esc(PARTS.find((p) => p.id === id)?.name ?? SERVICES.find((s) => s.id === id)!.name)}</span><button data-remove="${i}" aria-label="Quitar">×</button></li>`).join("")}</ul>` : `<p class="sh-empty">Vacío</p>`}
            <p class="sh-total">Total <b>${money(total)}</b></p>
            <p class="sh-cash">En caja: ${money(w.money)}</p>
            <button class="sh-pay" data-pay ${!this.cart.length || total > w.money ? "disabled" : ""}>Comprar</button>
            ${pending.length ? `<h3>En camino</h3><ul class="sh-list">${pending.map((id) => `<li>${esc(PARTS.find((p) => p.id === id)?.name ?? SERVICES.find((s) => s.id === id)!.name)}</li>`).join("")}</ul>` : ""}
            ${stock.length ? `<h3>En tu almacén</h3><ul class="sh-list">${stock.map((n) => `<li>${esc(n)}</li>`).join("")}</ul><p class="sh-note">Móntalas en el cuarto de servidores (clic en un puesto vacío del rack).</p>` : ""}
          </aside>
        </div>
      </div>`;
  }

  // ── Centro de Denuncias ──

  private police(): string {
    const w = this.world();
    const cases = [...w.security.cases].reverse();
    const status: Record<string, string> = { abierto: "Abierto", resuelto: "Resuelto ✓", fallido: "Cerrado sin culpable", vencido: "Vencido" };
    const body = cases.length
      ? cases.map((c) => {
          const d = describeCase(c, w.server(c.serverId)?.hostname ?? c.serverId);
          const open = c.status === "abierto";
          const shown = w.shownHints(c);
          const expanded = this.openCase === c.id || (this.openCase === null && open && cases.find((x) => x.status === "abierto") === c);
          return `
            <article class="dc-case ${c.status} ${expanded ? "open" : ""}">
              <button class="dc-head" data-case="${c.id}" aria-expanded="${expanded}"><span>${esc(d.title)}</span><span class="dc-status">${status[c.status]}</span></button>
              ${expanded ? `
                <div class="dc-body">
                  ${d.lines.map((l) => `<p>${esc(l)}</p>`).join("")}
                  ${open ? `<p class="dc-meta">Recompensa: hasta <b>${money(c.bounty * (1 + 0.25))}</b> · intentos: <b>${c.attempts}</b> · vence el día ${c.expiresDay}</p>` : ""}
                  ${shown.length ? `<div class="dc-hints"><h4>Pistas del técnico</h4>${shown.map((h) => `<p>💡 ${esc(h)}</p>`).join("")}</div>` : ""}
                  ${open ? `
                    <button class="dc-hint" data-hint="${c.id}">Pedir una pista (−20% de la recompensa)</button>
                    <form class="dc-form" data-report="${c.id}">
                      <label>IP del atacante <input name="ip" placeholder="203.0.113.45" required pattern="\\d+\\.\\d+\\.\\d+\\.\\d+" autocomplete="off" /></label>
                      <label>Evidencia (opcional: pega la línea del log, +25%) <textarea name="evidence" rows="2"></textarea></label>
                      <button type="submit">Denunciar</button>
                    </form>` : ""}
                </div>` : ""}
            </article>`;
        }).join("")
      : `<p class="dc-empty">No hay casos. Cuando ataquen tus servidores, aparecerán aquí.</p>`;
    return `
      <div class="dc">
        <header class="dc-head-page"><h2>Centro de Denuncias Cibernéticas</h2><p>Sitio ficticio del juego. Denuncia con la IP <b>real</b> del atacante: si es correcta, recibes un bug bounty. Acusar a un inocente tiene consecuencias.</p></header>
        ${this.noticeHtml()}
        ${body}
      </div>`;
  }

  // ── Foro UnderNet ──

  private forum(): string {
    const sec = this.world().security;
    const user = this.forumUser;
    const posts = user ? sec.forum.filter((p) => p.user === user) : sec.forum.slice(-12).reverse();
    return `
      <div class="fo">
        <header class="fo-head"><h2>UnderNet</h2><p>foro de "seguridad" · ficticio</p></header>
        <form class="fo-search" data-forum><input name="u" placeholder="Buscar usuario…" value="${esc(user)}" autocomplete="off" /><button>Buscar</button>${user ? `<button type="button" data-forum-home>Volver</button>` : ""}</form>
        ${user ? (posts.length ? `<div class="fo-profile"><h3>${esc(user)}</h3><p>Mensajes: ${posts.length} · Última conexión desde: <code>${esc(sec.profiles[user] ?? "(oculta)")}</code></p></div>` : `<p>No hay ningún usuario "${esc(user)}".</p>`) : ""}
        ${posts.map((p) => `<article class="fo-post"><button class="fo-user" data-user="${esc(p.user)}">${esc(p.user)}</button><span class="fo-day">día ${p.day || 1}</span><p>${esc(p.text)}</p></article>`).join("")}
      </div>`;
  }

  // ── eventos ──

  private click(e: Event): void {
    const t = e.target as HTMLElement;
    const btn = t.closest<HTMLElement>("button");
    if (!btn) return;
    const w = this.world();
    if (btn.dataset.site) {
      this.site = btn.dataset.site as Site;
      this.notice = null;
    } else if (btn.dataset.goods) {
      const p = btn.dataset.goods as ProductName;
      this.goods[p] = Math.max(0, Math.min(SUPPLIER.maxCases, (this.goods[p] ?? 0) + Number(btn.dataset.delta)));
      this.notice = null;
    } else if (btn.hasAttribute("data-goods-pay")) {
      const lines = PRODUCT_NAMES.filter((p) => (this.goods[p] ?? 0) > 0).map((p) => ({ product: p, cases: this.goods[p]! }));
      const r = w.orderGoods(lines);
      this.notice = r.ok
        ? { text: `✓ Pedido #${r.order.id} por ${money(r.order.total)}. El repartidor llega en 1 minuto con <b>pedido_${r.order.id}.xlsx</b>.`, tone: "ok" }
        : { text: `No se pudo: ${r.reason}.`, tone: "bad" };
      if (r.ok) this.goods = {};
      this.onChange();
    } else if (btn.dataset.openFile) {
      this.onOpenFile(btn.dataset.openFile);
      return;
    } else if (btn.dataset.add) {
      this.cart.push(btn.dataset.add);
      this.notice = null;
    } else if (btn.dataset.remove) {
      this.cart.splice(Number(btn.dataset.remove), 1);
    } else if (btn.hasAttribute("data-pay")) {
      const r = w.order(this.cart);
      this.notice = r.ok ? { text: `✓ Compra hecha por ${money(r.total)}. Llega mañana en el camión.`, tone: "ok" } : { text: `No se pudo: ${r.reason}.`, tone: "bad" };
      if (r.ok) this.cart = [];
      this.onChange();
    } else if (btn.dataset.case) {
      const id = Number(btn.dataset.case);
      this.openCase = this.openCase === id ? -1 : id;
    } else if (btn.dataset.hint) {
      const h = w.hint(Number(btn.dataset.hint));
      this.notice = h ? null : { text: "Ya no hay más pistas para este caso.", tone: "bad" };
    } else if (btn.dataset.user) {
      this.forumUser = btn.dataset.user;
    } else if (btn.hasAttribute("data-forum-home")) {
      this.forumUser = "";
    } else return;
    this.render(true);
  }

  private submit(e: Event): void {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const data = new FormData(form);
    if (form.dataset.forum !== undefined) {
      this.forumUser = String(data.get("u") ?? "").trim();
    } else if (form.dataset.report) {
      const r = this.world().report(Number(form.dataset.report), String(data.get("ip") ?? ""), String(data.get("evidence") ?? ""));
      this.notice = { text: `<b>${esc(r.title)}</b> ${esc(r.message)}`, tone: r.ok ? "ok" : "bad" };
      this.onChange();
    }
    (document.activeElement as HTMLElement | null)?.blur();
    this.render(true);
  }
}
