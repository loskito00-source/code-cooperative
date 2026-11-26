import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { type GameDB, type QueryError, type QueryResult, type SavedQuery, type TableInfo } from "@cdb/db";
import { basicSetup } from "codemirror";
import { chalk } from "./editor.js";
import type { FloatingWindow } from "./windows.js";

const STORAGE_KEY = "cdb.queries.v1";

/** Las consultas las crea el jugador: no viene ninguna de fábrica. */
function loadQueries(): SavedQuery[] {
  try {
    const saved: SavedQuery[] = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    // versiones anteriores traían consultas de ejemplo (id "ej-..."): se quitan
    return saved.filter((q) => !q.id.startsWith("ej-"));
  } catch {
    return [];
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** ¿La consulta solo lee? (para volver a correrla sola cuando cambien los datos) */
function isReadOnly(sql: string): boolean {
  const clean = sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const parts = clean.split(";").map((p) => p.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((p) => /^(SELECT|SHOW|EXPLAIN|VALUES|TABLE)\b/i.test(p) && !/\bINTO\b/i.test(p));
}

function formatCell(v: unknown): { html: string; num: boolean } {
  if (v === null || v === undefined) return { html: '<span class="null">NULL</span>', num: false };
  if (v instanceof Date) return { html: v.toISOString().replace("T", " ").slice(0, 19), num: false };
  if (Array.isArray(v)) return { html: escapeHtml(`{${v.map((x) => String(x)).join(", ")}}`), num: false };
  if (typeof v === "number" || typeof v === "bigint") return { html: String(v), num: true };
  if (typeof v === "boolean") return { html: v ? "true" : "false", num: false };
  if (typeof v === "object") return { html: escapeHtml(JSON.stringify(v)), num: false };
  return { html: escapeHtml(String(v)), num: false };
}

/** Ventana "Base de datos": editor SQL, tablas, consultas guardadas y resultados. */
export class SqlWindow {
  private readonly view: EditorView;
  private readonly sqlConfig = new Compartment();
  private queries = loadQueries();
  /** Consulta guardada que se está editando (null = nueva). */
  private currentId: string | null = null;
  private tables: TableInfo[] = [];
  private confirmDelete: string | null = null;
  private running = false;
  /** Última consulta de solo lectura que se mostró: se vuelve a correr sola cuando cambian los datos. */
  private lastRead: string | null = null;
  private refreshTimer: number | null = null;
  private lastRefresh = 0;

  private readonly $ = <T extends HTMLElement>(sel: string) => this.win.body.querySelector(sel) as T;

  constructor(private readonly win: FloatingWindow, private readonly db: GameDB) {
    win.body.innerHTML = `
      <div class="db">
        <aside class="db-side">
          <div class="db-side-head"><span>Consultas guardadas</span><button class="db-new" title="Empezar una consulta nueva">+ Nueva</button></div>
          <ul class="db-saved"></ul>
          <div class="db-tables"><p class="db-loading">Arrancando PostgreSQL…</p></div>
        </aside>
        <div class="db-main">
          <div class="code-tools">
            <button class="btn-run db-run">▶ Ejecutar</button>
            <input class="db-name" placeholder="Nombre de la consulta" aria-label="Nombre de la consulta" />
            <button class="btn-stop db-save">💾 Guardar</button>
            <span class="run-status db-status">Ctrl+Enter para ejecutar</span>
          </div>
          <div class="editor db-editor"></div>
          <div class="db-results"><p class="db-hint">Tu base de datos (PostgreSQL) empieza vacía: tú decides qué tablas tiene. Por ejemplo:<br><code>CREATE TABLE productos (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, nombre TEXT NOT NULL);</code></p></div>
        </div>
      </div>`;

    this.view = new EditorView({
      parent: this.$(".db-editor"),
      state: EditorState.create({
        doc: "",
        extensions: [
          basicSetup,
          this.sqlConfig.of(sql({ dialect: PostgreSQL, upperCaseKeywords: true })),
          syntaxHighlighting(chalk),
          Prec.highest(keymap.of([{ key: "Mod-Enter", run: () => (void this.run(), true) }])),
          keymap.of([indentWithTab]),
        ],
      }),
    });

    this.$(".db-run").addEventListener("click", () => void this.run());
    this.$(".db-save").addEventListener("click", () => this.save());
    this.$(".db-new").addEventListener("click", () => this.newQuery());
    this.$<HTMLInputElement>(".db-name").addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.save();
    });
    this.$(".db-saved").addEventListener("click", (e) => this.onSavedClick(e));
    this.$(".db-tables").addEventListener("click", (e) => this.onTableClick(e));
    this.renderSaved();
    win.onShow = () => this.refreshSoon();
  }

  /**
   * Cambiaron los datos (lo hizo este jugador, el otro o un robot): refresca la lista de tablas y, si la ventana está
   * abierta, vuelve a correr la última consulta de lectura para que el resultado esté al día. Como máximo ~1 vez por
   * segundo (un robot puede hacer muchos INSERT seguidos).
   */
  refreshSoon(): void {
    if (this.refreshTimer !== null) return;
    const wait = Math.max(0, 900 - (performance.now() - this.lastRefresh));
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      this.lastRefresh = performance.now();
      void this.refresh();
    }, wait);
  }

  private async refresh(): Promise<void> {
    if (!this.db.ready) return;
    await this.init().catch(() => undefined);
    if (!this.win.isOpen || this.running || !this.lastRead) return;
    const text = this.lastRead;
    const res = await this.db.run(text).catch(() => null);
    // si mientras tanto el jugador corrió otra cosa, no se le pisa el resultado
    if (res && res.ok && this.lastRead === text && !this.running) this.renderResult(res);
  }

  /** Llamar cuando la base esté lista: carga tablas y el autocompletado de columnas. */
  async init(): Promise<void> {
    this.tables = await this.db.tables();
    const schema = Object.fromEntries(this.tables.map((t) => [t.name, t.columns.map((c) => c.name)]));
    this.view.dispatch({ effects: this.sqlConfig.reconfigure(sql({ dialect: PostgreSQL, upperCaseKeywords: true, schema })) });
    this.renderTables();
  }

  // ── ejecutar ────────────────────────────────────────────────

  async run(text = this.view.state.doc.toString()): Promise<void> {
    if (this.running || !text.trim()) return;
    this.running = true;
    const status = this.$(".db-status");
    status.textContent = this.db.ready ? "Consultando…" : "Esperando a que arranque PostgreSQL…";
    try {
      const res = await this.db.run(text);
      this.renderResult(res);
      this.lastRead = res.ok && res.columns.length > 0 && isReadOnly(text) ? text : null;
      if (res.ok && /\b(CREATE|DROP|ALTER)\b/i.test(text)) await this.init();
    } finally {
      this.running = false;
    }
  }

  private renderResult(res: QueryResult | QueryError): void {
    const box = this.$(".db-results");
    const status = this.$(".db-status");
    if (!res.ok) {
      status.textContent = `error · ${res.ms} ms`;
      box.innerHTML = `<div class="db-error"><strong>${escapeHtml(res.message)}</strong>${
        res.message !== res.detail ? `<div class="db-detail">PostgreSQL: ${escapeHtml(res.detail)}</div>` : ""
      }</div>`;
      return;
    }
    const more = res.rowCount > res.rows.length ? ` (mostrando ${res.rows.length})` : "";
    status.textContent = `${res.rowCount} fila${res.rowCount === 1 ? "" : "s"}${more} · ${res.ms} ms`;
    if (res.columns.length === 0) {
      box.innerHTML = `<p class="db-hint">${escapeHtml(res.note ?? "Sin resultados.")}</p>`;
      return;
    }
    if (res.rows.length === 0) {
      box.innerHTML = `<table><thead><tr>${res.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead></table><p class="db-hint">La consulta no encontró filas.</p>`;
      return;
    }
    const body = res.rows
      .map((row) => `<tr>${row.map((v) => {
        const f = formatCell(v);
        return `<td class="${f.num ? "num" : ""}">${f.html}</td>`;
      }).join("")}</tr>`)
      .join("");
    box.innerHTML = `<table><thead><tr>${res.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table>`;
  }

  // ── consultas guardadas ─────────────────────────────────────

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.queries));
    } catch {
      /* sin almacenamiento */
    }
  }

  private setDoc(text: string): void {
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text } });
  }

  private save(): void {
    const nameEl = this.$<HTMLInputElement>(".db-name");
    const name = nameEl.value.trim();
    const text = this.view.state.doc.toString();
    if (!name) {
      nameEl.focus();
      nameEl.classList.add("need");
      this.$(".db-status").textContent = "Ponle un nombre a la consulta para guardarla";
      return;
    }
    nameEl.classList.remove("need");
    const existing = this.queries.find((q) => q.id === this.currentId);
    if (existing) {
      existing.name = name;
      existing.sql = text;
    } else {
      const q = { id: `q-${Date.now().toString(36)}`, name, sql: text };
      this.queries.unshift(q);
      this.currentId = q.id;
    }
    this.persist();
    this.renderSaved();
    this.$(".db-status").textContent = `Guardada: ${name}`;
  }

  private newQuery(): void {
    this.currentId = null;
    this.$<HTMLInputElement>(".db-name").value = "";
    this.setDoc("SELECT ");
    this.view.focus();
    this.view.dispatch({ selection: { anchor: this.view.state.doc.length } });
    this.renderSaved();
  }

  private onSavedClick(e: Event): void {
    const target = e.target as HTMLElement;
    const li = target.closest<HTMLElement>("[data-id]");
    if (!li) return;
    const id = li.dataset.id!;
    if (target.closest(".db-del")) {
      if (this.confirmDelete !== id) {
        this.confirmDelete = id;
        this.renderSaved();
        return;
      }
      this.queries = this.queries.filter((q) => q.id !== id);
      if (this.currentId === id) this.currentId = null;
      this.confirmDelete = null;
      this.persist();
      this.renderSaved();
      return;
    }
    const q = this.queries.find((x) => x.id === id);
    if (!q) return;
    this.confirmDelete = null;
    this.currentId = q.id;
    this.$<HTMLInputElement>(".db-name").value = q.name;
    this.setDoc(q.sql);
    this.renderSaved();
    void this.run(q.sql);
  }

  private renderSaved(): void {
    this.$(".db-saved").innerHTML = this.queries.length
      ? this.queries
          .map((q) => {
            const confirm = this.confirmDelete === q.id;
            return `<li data-id="${q.id}" class="${q.id === this.currentId ? "on" : ""}" title="Clic para ejecutar">
              <span class="db-qname">▶ ${escapeHtml(q.name)}</span>
              <button class="db-del ${confirm ? "confirm" : ""}" title="Borrar">${confirm ? "¿Borrar?" : "×"}</button></li>`;
          })
          .join("")
      : `<li class="db-empty">Todavía no tienes consultas guardadas. Escribe una, ponle un nombre arriba y presiona 💾 Guardar.</li>`;
  }

  // ── tablas ──────────────────────────────────────────────────

  private confirmReset = false;

  private renderTables(): void {
    const item = (t: TableInfo) => {
      const doc = undefined as { description: string; columns: Record<string, string> } | undefined;
      const cols = t.columns
        .map((c) => `<li title="${escapeHtml(doc?.columns[c.name] ?? "")}"><span>${c.name}</span><em>${c.type.replace("timestamp with time zone", "timestamptz")}</em></li>`)
        .join("");
      const full = t.name;
      return `<li class="db-table" data-table="${full}">
        <div class="db-tname"><button class="db-expand" aria-label="Ver columnas">▸</button><span title="${escapeHtml(doc?.description ?? "")}">${t.name}</span>
        <button class="db-peek" title="Ver las primeras filas">ver</button></div>
        <ul class="db-cols" hidden>${cols}</ul></li>`;
    };
    const mine = this.tables;
    this.$(".db-tables").innerHTML = `
      <div class="db-side-head"><span>Tus tablas</span>${mine.length ? `<button class="db-reset ${this.confirmReset ? "confirm" : ""}" title="Borrar todas tus tablas">${this.confirmReset ? "¿Borrar todo?" : "Borrar todo"}</button>` : ""}</div>
      <ul>${mine.length ? mine.map(item).join("") : `<li class="db-empty">Tu base de datos está vacía. Diseña tus tablas con <code>CREATE TABLE</code>.</li>`}</ul>`;
  }

  private onTableClick(e: Event): void {
    const target = e.target as HTMLElement;
    if (target.closest(".db-reset")) {
      if (!this.confirmReset) {
        this.confirmReset = true;
        this.renderTables();
        return;
      }
      this.confirmReset = false;
      void this.db.resetPlayerSchema().then(() => this.init());
      this.$(".db-status").textContent = "Se borraron tus tablas";
      return;
    }
    const li = target.closest<HTMLElement>("[data-table]");
    if (!li) return;
    const name = li.dataset.table!;
    if (target.closest(".db-peek")) {
      const text = `SELECT *\nFROM ${name}\nORDER BY 1\nLIMIT 50;`;
      this.currentId = null;
      this.$<HTMLInputElement>(".db-name").value = "";
      this.setDoc(text);
      this.renderSaved();
      void this.run(text);
      return;
    }
    if (target.closest(".db-tname")) {
      const cols = li.querySelector<HTMLElement>(".db-cols")!;
      cols.hidden = !cols.hidden;
      li.querySelector(".db-expand")!.textContent = cols.hidden ? "▸" : "▾";
    }
  }
}
