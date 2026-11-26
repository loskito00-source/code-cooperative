import type { Workbook } from "@cdb/sim";
import type { FloatingWindow } from "./windows.js";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const colLetter = (i: number) => String.fromCharCode(65 + i);

/** Hoja de cálculo de solo lectura, con aspecto de Excel: la entrega del distribuidor y los Excel de cada pedido. */
export class SheetWindow {
  private sheetIndex = 0;

  constructor(private readonly win: FloatingWindow, private book: Workbook) {
    win.body.innerHTML = `
      <div class="xl">
        <div class="xl-bar">
          <span class="xl-file"></span>
          <span class="xl-ref">A1</span>
          <span class="xl-fx">fx</span>
          <span class="xl-value"></span>
        </div>
        <div class="xl-grid-wrap"><table class="xl-grid"></table></div>
        <div class="xl-tabs"></div>
        <p class="xl-hint">Solo lectura. Para trabajar con estos datos usa pandas en <strong>inventario.py</strong>:
          <code class="xl-read"></code></p>
      </div>`;
    win.body.querySelector(".xl-grid")!.addEventListener("click", (e) => {
      const td = (e.target as HTMLElement).closest<HTMLElement>("td[data-ref]");
      if (td) this.select(td);
    });
    win.body.querySelector(".xl-tabs")!.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-sheet]");
      if (!b) return;
      this.sheetIndex = Number(b.dataset.sheet);
      this.render();
    });
    this.render();
  }

  /** Archivo que se está mostrando. */
  get filename(): string {
    return this.book.filename;
  }

  /** Muestra otro archivo (p. ej. el Excel de un pedido que acaba de llegar). */
  setBook(book: Workbook): void {
    if (book === this.book) return;
    this.book = book;
    this.sheetIndex = 0;
    this.render();
  }

  private render(): void {
    const name = this.book.filename;
    this.win.body.querySelector(".xl-file")!.textContent = name;
    this.win.body.querySelector(".xl-read")!.textContent = `pd.read_excel("${name}")`;
    this.win.titleEl.lastChild!.textContent = name;
    const sheet = this.book.sheets[this.sheetIndex];
    const cols = sheet.columns.length;
    const head = `<tr><th class="corner"></th>${sheet.columns.map((_, j) => `<th>${colLetter(j)}</th>`).join("")}</tr>`;
    const headerRow = `<tr><th class="rown">1</th>${sheet.columns.map((c, j) => `<td class="hdr" data-ref="${colLetter(j)}1" data-v="${escapeHtml(c)}">${escapeHtml(c)}</td>`).join("")}</tr>`;
    const body = sheet.rows
      .map((r, i) => {
        const n = i + 2;
        const cells = Array.from({ length: cols }, (_, j) => {
          const v = r[j];
          const text = v === null || v === undefined ? "" : String(v);
          const num = typeof v === "number";
          // los espacios de más se ven (como en la hoja real) para que se note que hay que limpiar
          return `<td class="${num ? "num" : ""}" data-ref="${colLetter(j)}${n}" data-v="${escapeHtml(text)}">${escapeHtml(text).replace(/ /g, "&nbsp;")}</td>`;
        }).join("");
        return `<tr><th class="rown">${n}</th>${cells}</tr>`;
      })
      .join("");
    const filler = Array.from({ length: 6 }, (_, k) => `<tr><th class="rown">${sheet.rows.length + 2 + k}</th>${"<td></td>".repeat(cols)}</tr>`).join("");
    this.win.body.querySelector(".xl-grid")!.innerHTML = `<thead>${head}</thead><tbody>${headerRow}${body}${filler}</tbody>`;
    this.win.body.querySelector(".xl-tabs")!.innerHTML = this.book.sheets
      .map((s, i) => `<button data-sheet="${i}" class="${i === this.sheetIndex ? "on" : ""}">${escapeHtml(s.name)}</button>`)
      .join("");
    const first = this.win.body.querySelector<HTMLElement>("td[data-ref='A1']");
    if (first) this.select(first);
  }

  private select(td: HTMLElement): void {
    this.win.body.querySelectorAll(".xl-grid td.sel").forEach((c) => c.classList.remove("sel"));
    td.classList.add("sel");
    this.win.body.querySelector(".xl-ref")!.textContent = td.dataset.ref ?? "";
    // la barra de fórmulas muestra el valor exacto, con comillas si tiene espacios al borde
    const v = td.dataset.v ?? "";
    this.win.body.querySelector(".xl-value")!.textContent = v !== v.trim() ? `"${v}"` : v;
  }
}
