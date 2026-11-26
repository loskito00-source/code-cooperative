import { type CallContext, HostObject, PyBuiltin, PyDict, PyError, PyList, type Value, pyRepr, pyStr } from "@cdb/interpreter";
import { type Sheet, type Workbook } from "./delivery.js";

/**
 * "pandas" del juego: a propósito tiene solo dos comandos. Lo demás (quitar repetidos, saltar la fila TOTAL,
 * limpiar textos) lo hace el jugador con Python normal, y sube los datos con cursor.execute("INSERT ...").
 *   hoja = pd.read_excel("entrega_distribuidor.xlsx")   # print(hoja) la muestra con letras y números de fila
 *   filas = hoja.select("A1", "G6")                      # o hoja.select("A1:G6"), o hoja.select("A1", hoja.last_cell)
 *   # -> [{"Código": "P-001", "Producto": "Pan ", ...}, ...]   un diccionario por fila
 * Las claves de cada diccionario son los encabezados de la fila 1. Si el rango incluye la fila 1, esa fila no se
 * devuelve como dato (son los encabezados).
 */

const colLetter = (i: number): string => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** "C3" -> { col: 2, row: 3 } (row empieza en 1, como en Excel). */
function parseRef(ref: string, line: number): { col: number; row: number } {
  const m = /^\s*([A-Za-z]+)\s*(\d+)\s*$/.exec(ref);
  if (!m || Number(m[2]) < 1) throw new PyError(`'${ref}' no es una celda. Escríbela como en Excel: letra de columna y número de fila, p. ej. "A1" o "C3"`, line);
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(m[2]) };
}

function cellText(v: Value): string {
  return v === null ? "" : pyStr(v);
}

/** Tabla de texto con letras de columna arriba y números de fila a la izquierda, como la hoja de cálculo. */
function renderSheet(sheet: Sheet): string {
  const grid = [sheet.columns as Value[], ...sheet.rows.map((r) => r as Value[])];
  const letters = sheet.columns.map((_, j) => colLetter(j));
  const widths = letters.map((l, j) => Math.max(l.length, ...grid.map((r) => cellText(r[j] ?? null).length)));
  const nw = String(grid.length).length;
  const lines = [" ".repeat(nw) + " | " + letters.map((l, j) => l.padEnd(widths[j])).join(" | ")];
  grid.forEach((r, i) => lines.push(String(i + 1).padStart(nw) + " | " + r.map((v, j) => cellText(v ?? null).padEnd(widths[j])).join(" | ")));
  return lines.join("\n");
}

function makeSheet(book: Workbook, sheet: Sheet): HostObject {
  const nRows = sheet.rows.length + 1; // + encabezados
  const nCols = sheet.columns.length;
  const last = `${colLetter(nCols - 1)}${nRows}`;

  const select = (args: Value[], _kw: Record<string, Value>, ctx: CallContext): Value => {
    let refs: string[];
    if (args.length === 1 && typeof args[0] === "string" && args[0].includes(":")) refs = args[0].split(":");
    else if (args.length === 2 && typeof args[0] === "string" && typeof args[1] === "string") refs = [args[0], args[1]];
    else throw new PyError(`usa hoja.select("A1", "${last}") con la primera y la última celda del rango`, ctx.line);
    const [a, b] = refs.map((r) => parseRef(r, ctx.line));
    const c0 = Math.min(a.col, b.col), c1 = Math.max(a.col, b.col);
    const r0 = Math.min(a.row, b.row), r1 = Math.max(a.row, b.row);
    if (c1 >= nCols || r1 > nRows) {
      throw new PyError(`el rango ${refs.join(":").toUpperCase()} se sale de la hoja: los datos van de A1 a ${last}`, ctx.line);
    }
    const out: Value[] = [];
    for (let row = Math.max(r0, 2); row <= r1; row++) {
      const d = new PyDict();
      for (let c = c0; c <= c1; c++) d.set(sheet.columns[c], sheet.rows[row - 2][c] ?? null, ctx.line);
      out.push(d);
    }
    return new PyList(out);
  };

  return new HostObject(
    "hoja",
    { select: new PyBuiltin("select", select) },
    undefined,
    {
      // last_cell: la última celda con datos (p. ej. "G6"). Los Excel de los pedidos tienen las mismas columnas pero
      // distinto número de filas: con hoja.select("A1", hoja.last_cell) el mismo script sirve para todos.
      getAttr: (attr) => (attr === "name" ? sheet.name : attr === "file" ? book.filename : attr === "last_cell" ? last : undefined),
      attrNames: () => ["name", "file", "last_cell"],
      repr: () => `${book.filename} (hoja "${sheet.name}", de A1 a ${last})\n${renderSheet(sheet)}`,
    },
  );
}

export function makePandas(files: Workbook[]): HostObject {
  return new HostObject(
    "módulo",
    {
      read_excel: new PyBuiltin("read_excel", (args, kw, ctx) => {
        const path = args[0] ?? kw.io ?? null;
        if (typeof path !== "string") throw new PyError('pd.read_excel() necesita el nombre del archivo, p. ej. pd.read_excel("entrega_distribuidor.xlsx")', ctx.line);
        const book = files.find((f) => f.filename === path);
        if (!book) throw new PyError(`el archivo '${path}' no existe. Archivos: ${files.map((f) => `'${f.filename}'`).join(", ")}`, ctx.line);
        const sheetArg = kw.sheet_name ?? args[1] ?? 0;
        const sheet = typeof sheetArg === "number" ? book.sheets[sheetArg] : book.sheets.find((s) => s.name === sheetArg);
        if (!sheet) throw new PyError(`la hoja ${pyRepr(sheetArg)} no existe. Hojas: ${book.sheets.map((s) => `'${s.name}'`).join(", ")}`, ctx.line);
        return makeSheet(book, sheet);
      }),
    },
    "<módulo pandas>",
  );
}
