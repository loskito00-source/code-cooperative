import {
  Action,
  type CallContext,
  HostObject,
  PyBuiltin,
  PyDict,
  PyError,
  PyList,
  PyTuple,
  type Value,
  pyRepr,
  pyStr,
} from "@cdb/interpreter";
import { type Cell, type Workbook } from "./delivery.js";
import { fromJS, type SqlAdapter, SQL_TICKS, toJS } from "./sqlapi.js";

/**
 * pandas en versión sencilla. Lo justo para leer la hoja del distribuidor, limpiarla y subirla a la base:
 *   df = pd.read_excel("entrega_distribuidor.xlsx")
 *   df = df.rename(columns={"Producto": "nombre"})
 *   df["nombre"] = df["nombre"].str.strip().str.lower()
 *   df = df[df["nombre"] != "total"].drop_duplicates()
 *   df.to_sql("productos", db)
 * Diferencia con pandas: el índice siempre es 0, 1, 2... (se renumera después de cada operación).
 */

type Row = Value[];

const isMissing = (v: Value) => v === null || (typeof v === "number" && Number.isNaN(v));

function fn(name: string, impl: (args: Value[], kw: Record<string, Value>, ctx: CallContext) => ReturnType<PyBuiltin["fn"]>) {
  return new PyBuiltin(name, impl);
}

function needStr(v: Value, what: string, line: number): string {
  if (typeof v !== "string") throw new PyError(`${what} debe ser texto, no ${pyRepr(v)}`, line);
  return v;
}

function strList(v: Value, what: string, line: number): string[] {
  if (typeof v === "string") return [v];
  if (v instanceof PyList || v instanceof PyTuple) return v.items.map((x) => needStr(x, what, line));
  throw new PyError(`${what} debe ser un texto o una lista de textos`, line);
}

function cellText(v: Value): string {
  if (v === null) return "None";
  if (typeof v === "number" && Number.isNaN(v)) return "NaN";
  return pyStr(v);
}

function dtypeOf(values: Value[]): string {
  const present = values.filter((v) => !isMissing(v));
  if (present.length && present.every((v) => typeof v === "number" && Number.isInteger(v))) return "int64";
  if (present.length && present.every((v) => typeof v === "number")) return "float64";
  if (present.length && present.every((v) => typeof v === "boolean")) return "bool";
  return "object";
}

/** Tabla de texto como la que imprime pandas (con índice a la izquierda). */
function renderTable(columns: string[], rows: Row[]): string {
  if (columns.length === 0) return "DataFrame vacío\nColumnas: []\nÍndice: []";
  const MAX = 30;
  const shown: (Row | null)[] = rows.length > MAX ? [...rows.slice(0, 15), null, ...rows.slice(-5)] : rows;
  const idx = rows.length > MAX ? [...rows.slice(0, 15).map((_, i) => String(i)), "...", ...rows.slice(-5).map((_, i) => String(rows.length - 5 + i))] : rows.map((_, i) => String(i));
  const cells = shown.map((r) => (r ? r.map(cellText) : columns.map(() => "...")));
  const widths = columns.map((c, j) => Math.max(c.length, ...cells.map((r) => r[j].length)));
  const iw = Math.max(0, ...idx.map((s) => s.length));
  const pad = (s: string, w: number) => " ".repeat(Math.max(0, w - s.length)) + s;
  const lines = [" ".repeat(iw) + "  " + columns.map((c, j) => pad(c, widths[j])).join("  ")];
  cells.forEach((r, i) => lines.push(pad(idx[i], iw) + "  " + r.map((c, j) => pad(c, widths[j])).join("  ")));
  if (rows.length > MAX) lines.push(`\n[${rows.length} filas x ${columns.length} columnas]`);
  return lines.join("\n");
}

function elementwise(op: string, a: Value, b: Value, line: number): Value {
  if (isMissing(a) || isMissing(b)) return op === "==" ? false : op === "!=" ? true : ["<", ">", "<=", ">="].includes(op) ? false : null;
  const num = (v: Value) => (typeof v === "boolean" ? (v ? 1 : 0) : v);
  const x = num(a);
  const y = num(b);
  switch (op) {
    case "==": return a === b || (typeof x === "number" && x === y);
    case "!=": return !(a === b || (typeof x === "number" && x === y));
    case "&": return Boolean(a) && Boolean(b);
    case "|": return Boolean(a) || Boolean(b);
  }
  if (op === "+" && typeof a === "string" && typeof b === "string") return a + b;
  if (["<", ">", "<=", ">="].includes(op)) {
    if (typeof x !== typeof y) throw new PyError(`no se puede comparar ${pyRepr(a)} con ${pyRepr(b)}`, line);
    const xs = x as number | string;
    const ys = y as number | string;
    return op === "<" ? xs < ys : op === ">" ? xs > ys : op === "<=" ? xs <= ys : xs >= ys;
  }
  if (typeof x !== "number" || typeof y !== "number") throw new PyError(`no se puede operar ${pyRepr(a)} ${op} ${pyRepr(b)}`, line);
  switch (op) {
    case "+": return x + y;
    case "-": return x - y;
    case "*": return x * y;
    case "/": return y === 0 ? NaN : x / y;
    case "//": return y === 0 ? NaN : Math.floor(x / y);
    case "%": return y === 0 ? NaN : x - y * Math.floor(x / y);
    case "**": return x ** y;
  }
  throw new PyError(`operación '${op}' no soportada en una columna`, line);
}

// ── Series ───────────────────────────────────────────────────

export function isSeries(v: Value): v is HostObject {
  return v instanceof HostObject && v.typeName === "Series";
}
export function isDataFrame(v: Value): v is HostObject {
  return v instanceof HostObject && v.typeName === "DataFrame";
}
/** Valores de cada Series (para combinar columnas y filtros sin pasar por Python). */
const SERIES = new WeakMap<HostObject, Value[]>();
const seriesValues = (s: HostObject): Value[] => SERIES.get(s) ?? [];

export function makeSeries(name: string | null, values: Value[]): HostObject {
  const vals = values;
  const mapStr = (f: (s: string, args: Value[], line: number) => Value) =>
    (args: Value[], _kw: Record<string, Value>, ctx: CallContext) =>
      makeSeries(name, vals.map((v) => (typeof v === "string" ? f(v, args, ctx.line) : v)));
  const strAccessor = new HostObject("str", {
    lower: fn("lower", mapStr((s) => s.toLowerCase())),
    upper: fn("upper", mapStr((s) => s.toUpperCase())),
    strip: fn("strip", mapStr((s) => s.trim())),
    title: fn("title", mapStr((s) => s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase()))),
    capitalize: fn("capitalize", mapStr((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())),
    replace: fn("replace", mapStr((s, a, line) => s.split(needStr(a[0], "el texto a reemplazar", line)).join(needStr(a[1], "el texto nuevo", line)))),
    contains: fn("contains", (args, _kw, ctx) => {
      const sub = needStr(args[0], "lo que buscas", ctx.line).toLowerCase();
      return makeSeries(name, vals.map((v) => (typeof v === "string" ? v.toLowerCase().includes(sub) : false)));
    }),
    len: fn("len", () => makeSeries(name, vals.map((v) => (typeof v === "string" ? v.length : null)))),
  });

  const nums = (fnName: string, line: number) => {
    const present = vals.filter((v) => !isMissing(v));
    if (present.some((v) => typeof v !== "number")) throw new PyError(`${fnName}() necesita una columna de números`, line);
    return present as number[];
  };

  const castTo = (t: Value, line: number) => {
    const kind = t instanceof PyBuiltin ? t.name : typeof t === "string" ? t : "";
    const conv = kind.startsWith("int") ? (v: Value) => (isMissing(v) ? null : Math.trunc(Number(v)))
      : kind.startsWith("float") ? (v: Value) => (isMissing(v) ? null : Number(v))
      : kind === "str" ? (v: Value) => (v === null ? null : pyStr(v))
      : null;
    if (!conv) throw new PyError("astype() acepta int, float o str", line);
    return makeSeries(name, vals.map((v) => {
      const r = conv(v);
      if (typeof r === "number" && Number.isNaN(r)) throw new PyError(`no se puede convertir ${pyRepr(v)} a número`, line);
      return r;
    }));
  };

  const self: HostObject = new HostObject(
    "Series",
    {
      tolist: fn("tolist", () => new PyList([...vals])),
      sum: fn("sum", (_a, _k, ctx) => nums("sum", ctx.line).reduce((a, b) => a + b, 0)),
      mean: fn("mean", (_a, _k, ctx) => {
        const n = nums("mean", ctx.line);
        return n.length ? n.reduce((a, b) => a + b, 0) / n.length : NaN;
      }),
      min: fn("min", (_a, _k, ctx) => Math.min(...nums("min", ctx.line))),
      max: fn("max", (_a, _k, ctx) => Math.max(...nums("max", ctx.line))),
      count: fn("count", () => vals.filter((v) => !isMissing(v)).length),
      unique: fn("unique", () => {
        const seen: Value[] = [];
        for (const v of vals) if (!seen.some((s) => s === v)) seen.push(v);
        return new PyList(seen);
      }),
      nunique: fn("nunique", () => new Set(vals.filter((v) => !isMissing(v)).map((v) => pyRepr(v))).size),
      isna: fn("isna", () => makeSeries(name, vals.map(isMissing))),
      notna: fn("notna", () => makeSeries(name, vals.map((v) => !isMissing(v)))),
      fillna: fn("fillna", (args) => makeSeries(name, vals.map((v) => (isMissing(v) ? args[0] : v)))),
      astype: fn("astype", (args, _kw, ctx) => castTo(args[0], ctx.line)),
      round: fn("round", (args) => {
        const d = typeof args[0] === "number" ? args[0] : 0;
        return makeSeries(name, vals.map((v) => (typeof v === "number" ? Math.round(v * 10 ** d) / 10 ** d : v)));
      }),
      value_counts: fn("value_counts", () => {
        const d = new PyDict();
        for (const v of vals) if (!isMissing(v)) d.set(v, ((d.get(v, 0) as number) ?? 0) + 1, 0);
        return d;
      }),
      apply: fn("apply", function* (args, _kw, ctx) {
        const out: Value[] = [];
        for (const v of vals) out.push(yield* ctx.call(args[0], [v]));
        return makeSeries(name, out);
      }),
      head: fn("head", (args) => makeSeries(name, vals.slice(0, typeof args[0] === "number" ? args[0] : 5))),
    },
    undefined,
    {
      getAttr: (attr) => {
        if (attr === "str") return strAccessor;
        if (attr === "name") return name;
        if (attr === "size") return vals.length;
        if (attr === "dtype") return dtypeOf(vals);
        return undefined;
      },
      attrNames: () => ["str", "name", "size", "dtype"],
      getItem: (k, line) => {
        if (isSeries(k)) {
          const mask = seriesValues(k);
          if (mask.length !== vals.length) throw new PyError("el filtro tiene otro largo que la columna", line);
          return makeSeries(name, vals.filter((_, i) => mask[i] === true));
        }
        if (typeof k !== "number" || !Number.isInteger(k)) throw new PyError("una columna se indexa con un número de fila", line);
        const i = k < 0 ? vals.length + k : k;
        if (i < 0 || i >= vals.length) throw new PyError(`la fila ${k} no existe (la columna tiene ${vals.length})`, line);
        return vals[i];
      },
      len: () => vals.length,
      iter: () => [...vals],
      repr: () => {
        const iw = String(Math.max(0, vals.length - 1)).length;
        const lines = vals.slice(0, 30).map((v, i) => String(i).padEnd(iw) + "    " + cellText(v));
        if (vals.length > 30) lines.push("...");
        lines.push(`Name: ${name ?? "None"}, dtype: ${dtypeOf(vals)}`);
        return lines.join("\n");
      },
      binop: (op, other, reflected, line) => {
        const otherVals = isSeries(other) ? seriesValues(other) : null;
        if (otherVals && otherVals.length !== vals.length) throw new PyError("las dos columnas tienen distinto largo", line);
        return makeSeries(name, vals.map((v, i) => {
          const o = otherVals ? otherVals[i] : other;
          return reflected ? elementwise(op, o, v, line) : elementwise(op, v, o, line);
        }));
      },
      compare: (op, other, line) => {
        const otherVals = isSeries(other) ? seriesValues(other) : null;
        return makeSeries(name, vals.map((v, i) => elementwise(op, v, otherVals ? otherVals[i] : other, line)));
      },
    },
  );
  SERIES.set(self, vals);
  return self;
}

// ── DataFrame ────────────────────────────────────────────────

export function makeDataFrame(columns: string[], rows: Row[], getAdapter: () => SqlAdapter | undefined): HostObject {
  const st = { columns: [...columns], rows: rows.map((r) => [...r]) };
  const df = (c: string[], r: Row[]) => makeDataFrame(c, r, getAdapter);
  const colIndex = (c: Value, line: number) => {
    const name = needStr(c, "el nombre de la columna", line);
    const i = st.columns.indexOf(name);
    if (i < 0) {
      const close = st.columns.find((x) => x.toLowerCase().trim() === name.toLowerCase().trim());
      throw new PyError(`la columna '${name}' no existe${close ? `. ¿Quisiste decir '${close}'?` : `. Columnas: ${st.columns.join(", ")}`}`, line);
    }
    return i;
  };
  const rowDict = (r: Row) => {
    const d = new PyDict();
    st.columns.forEach((c, j) => d.set(c, r[j], 0));
    return d;
  };
  const valuesOf = (v: Value, line: number): Value[] => {
    if (isSeries(v)) return seriesValues(v);
    if (v instanceof PyList) return v.items;
    return st.rows.map(() => v);
  };

  const self: HostObject = new HostObject(
    "DataFrame",
    {
      head: fn("head", (args) => df(st.columns, st.rows.slice(0, typeof args[0] === "number" ? args[0] : 5))),
      tail: fn("tail", (args) => df(st.columns, st.rows.slice(-(typeof args[0] === "number" ? args[0] : 5)))),
      copy: fn("copy", () => df(st.columns, st.rows)),
      rename: fn("rename", (args, kw, ctx) => {
        const map = kw.columns ?? args[0];
        if (!(map instanceof PyDict)) throw new PyError('rename() necesita columns={"viejo": "nuevo"}', ctx.line);
        for (const k of map.keys()) colIndex(k, ctx.line);
        return df(st.columns.map((c) => (map.has(c, 0) ? needStr(map.get(c, 0)!, "el nombre nuevo", ctx.line) : c)), st.rows);
      }),
      drop: fn("drop", (args, kw, ctx) => {
        const drop = strList(kw.columns ?? args[0], "las columnas a borrar", ctx.line).map((c) => colIndex(c, ctx.line));
        const keep = st.columns.map((_, j) => j).filter((j) => !drop.includes(j));
        return df(keep.map((j) => st.columns[j]), st.rows.map((r) => keep.map((j) => r[j])));
      }),
      dropna: fn("dropna", () => df(st.columns, st.rows.filter((r) => !r.some(isMissing)))),
      fillna: fn("fillna", (args) => df(st.columns, st.rows.map((r) => r.map((v) => (isMissing(v) ? args[0] : v))))),
      drop_duplicates: fn("drop_duplicates", (args, kw, ctx) => {
        const subset = kw.subset ?? args[0];
        const cols = subset === undefined || subset === null ? st.columns.map((_, j) => j) : strList(subset, "subset", ctx.line).map((c) => colIndex(c, ctx.line));
        const seen = new Set<string>();
        return df(st.columns, st.rows.filter((r) => {
          const key = cols.map((j) => pyRepr(r[j])).join("\u0000");
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }));
      }),
      sort_values: fn("sort_values", (args, kw, ctx) => {
        const j = colIndex(kw.by ?? args[0], ctx.line);
        const asc = kw.ascending === undefined ? true : kw.ascending !== false;
        const sorted = [...st.rows].sort((a, b) => {
          const x = a[j];
          const y = b[j];
          if (isMissing(x)) return 1;
          if (isMissing(y)) return -1;
          const c = (x as number | string) < (y as number | string) ? -1 : (x as number | string) > (y as number | string) ? 1 : 0;
          return asc ? c : -c;
        });
        return df(st.columns, sorted);
      }),
      reset_index: fn("reset_index", () => df(st.columns, st.rows)),
      to_dict: fn("to_dict", (args, kw) => {
        const orient = kw.orient ?? args[0] ?? "records";
        if (orient === "list") {
          const d = new PyDict();
          st.columns.forEach((c, j) => d.set(c, new PyList(st.rows.map((r) => r[j])), 0));
          return d;
        }
        return new PyList(st.rows.map(rowDict));
      }),
      iterrows: fn("iterrows", () => new PyList(st.rows.map((r, i) => new PyTuple([i, rowDict(r)])))),
      to_sql: fn("to_sql", (args, kw, ctx) => {
        const table = needStr(kw.name ?? args[0], "el nombre de la tabla", ctx.line);
        const ifExists = kw.if_exists ?? "append";
        if (ifExists !== "append" && ifExists !== "replace") {
          throw new PyError("if_exists puede ser 'append' (agregar filas) o 'replace' (borrar las filas de la tabla y volver a cargar)", ctx.line);
        }
        const adapter = getAdapter();
        if (!adapter) throw new PyError("la base de datos todavía está arrancando; intenta de nuevo en unos segundos", ctx.line);
        const q = (id: string) => id.split(".").map((p) => `"${p.replace(/"/g, '""')}"`).join(".");
        const cols = st.columns.map(q).join(", ");
        const rowsJs = st.rows.map((r) => r.map((v) => toJS(isMissing(v) ? null : v, ctx.line)));
        const promise = (async () => {
          if (ifExists === "replace") await adapter.query(`DELETE FROM ${q(table)}`, []);
          for (let start = 0; start < rowsJs.length; start += 200) {
            const chunk = rowsJs.slice(start, start + 200);
            const params: unknown[] = [];
            const tuples = chunk.map((r) => `(${r.map((v) => (params.push(v), `$${params.length}`)).join(", ")})`);
            await adapter.query(`INSERT INTO ${q(table)} (${cols}) VALUES ${tuples.join(", ")}`, params);
          }
          return rowsJs.length;
        })().catch((e: Error) => {
          const msg = e.message ?? String(e);
          const hint = /no existe/.test(msg) && /tabla/i.test(msg) ? " (to_sql no crea tablas: primero diséñala con CREATE TABLE en la Base de datos)" : "";
          throw new PyError(`to_sql: ${msg}${hint}`, ctx.line);
        });
        return Action.async(SQL_TICKS, promise);
      }),
    },
    undefined,
    {
      getAttr: (attr) => {
        if (attr === "columns") return new PyList([...st.columns]);
        if (attr === "shape") return new PyTuple([st.rows.length, st.columns.length]);
        if (attr === "empty") return st.rows.length === 0;
        if (attr === "dtypes") {
          const d = new PyDict();
          st.columns.forEach((c, j) => d.set(c, dtypeOf(st.rows.map((r) => r[j])), 0));
          return d;
        }
        const j = st.columns.indexOf(attr);
        return j >= 0 ? makeSeries(attr, st.rows.map((r) => r[j])) : undefined;
      },
      attrNames: () => ["columns", "shape", "empty", "dtypes", ...st.columns],
      setAttr: (attr, v, line) => {
        if (attr !== "columns") throw new PyError(`no se puede cambiar '${attr}' (para una columna usa df["${attr}"] = ...)`, line);
        const names = strList(v, "los nombres de las columnas", line);
        if (names.length !== st.columns.length) throw new PyError(`la tabla tiene ${st.columns.length} columnas y le diste ${names.length} nombres`, line);
        st.columns = names;
      },
      getItem: (k, line) => {
        if (typeof k === "string") {
          const j = colIndex(k, line);
          return makeSeries(k, st.rows.map((r) => r[j]));
        }
        if (k instanceof PyList) {
          const idx = k.items.map((c) => colIndex(c, line));
          return df(idx.map((j) => st.columns[j]), st.rows.map((r) => idx.map((j) => r[j])));
        }
        if (isSeries(k)) {
          const mask = seriesValues(k);
          if (mask.length !== st.rows.length) throw new PyError("el filtro tiene otro largo que la tabla", line);
          return df(st.columns, st.rows.filter((_, i) => mask[i] === true));
        }
        throw new PyError('usa df["columna"], df[["col1", "col2"]] o un filtro como df[df["Cantidad"] > 0]', line);
      },
      setItem: (k, v, line) => {
        const name = needStr(k, "el nombre de la columna", line);
        const values = valuesOf(v, line);
        if (values.length !== st.rows.length) throw new PyError(`la columna nueva tiene ${values.length} valores y la tabla ${st.rows.length} filas`, line);
        let j = st.columns.indexOf(name);
        if (j < 0) {
          st.columns.push(name);
          j = st.columns.length - 1;
          st.rows.forEach((r) => r.push(null));
        }
        st.rows.forEach((r, i) => (r[j] = values[i]));
      },
      len: () => st.rows.length,
      iter: () => [...st.columns],
      repr: () => renderTable(st.columns, st.rows),
    },
  );
  return self;
}

// ── el módulo pandas ─────────────────────────────────────────

export function makePandas(files: Workbook[], getAdapter: () => SqlAdapter | undefined): HostObject {
  const readSheet = (args: Value[], kw: Record<string, Value>, ctx: CallContext, fnName: string) => {
    const path = needStr(args[0] ?? kw.io ?? null, "el nombre del archivo", ctx.line);
    const book = files.find((f) => f.filename === path || f.filename.replace(/\.xlsx$/, ".csv") === path);
    if (!book) {
      throw new PyError(`el archivo '${path}' no existe. Archivos: ${files.map((f) => `'${f.filename}'`).join(", ")}`, ctx.line);
    }
    const sheetArg = kw.sheet_name ?? args[1] ?? 0;
    const sheet = typeof sheetArg === "number" ? book.sheets[sheetArg] : book.sheets.find((s) => s.name === sheetArg);
    if (!sheet) throw new PyError(`la hoja ${pyRepr(sheetArg)} no existe. Hojas: ${book.sheets.map((s) => `'${s.name}'`).join(", ")}`, ctx.line);
    void fnName;
    return makeDataFrame(sheet.columns, sheet.rows.map((r) => r.map((c: Cell) => c as Value)), getAdapter);
  };

  return new HostObject(
    "módulo",
    {
      read_excel: fn("read_excel", (a, kw, ctx) => readSheet(a, kw, ctx, "read_excel")),
      read_csv: fn("read_csv", (a, kw, ctx) => readSheet(a, kw, ctx, "read_csv")),
      read_sql: fn("read_sql", (args, _kw, ctx) => {
        const sql = needStr(args[0], "la consulta", ctx.line);
        const adapter = getAdapter();
        if (!adapter) throw new PyError("la base de datos todavía está arrancando", ctx.line);
        const promise = adapter.query(sql, []).then(
          (res) => makeDataFrame(res.fields, res.rows.map((r) => res.fields.map((f) => fromJS(r[f]))), getAdapter),
          (e: Error) => {
            throw new PyError(`SQL: ${e.message}`, ctx.line);
          },
        );
        return Action.async(SQL_TICKS, promise);
      }),
      DataFrame: fn("DataFrame", (args, _kw, ctx) => {
        const data = args[0];
        if (data instanceof PyDict) {
          const cols = data.keys().map((k) => needStr(k, "el nombre de la columna", ctx.line));
          const lists = cols.map((c) => {
            const v = data.get(c, ctx.line)!;
            return v instanceof PyList ? v.items : [v];
          });
          const n = Math.max(0, ...lists.map((l) => l.length));
          return makeDataFrame(cols, Array.from({ length: n }, (_, i) => lists.map((l) => l[i] ?? null)), getAdapter);
        }
        if (data instanceof PyList) {
          const cols: string[] = [];
          for (const r of data.items) if (r instanceof PyDict) for (const k of r.keys()) if (!cols.includes(k as string)) cols.push(k as string);
          return makeDataFrame(cols, data.items.map((r) => cols.map((c) => (r instanceof PyDict ? r.get(c, 0) ?? null : null))), getAdapter);
        }
        throw new PyError("pd.DataFrame() necesita un diccionario de listas o una lista de diccionarios", ctx.line);
      }),
    },
    "<módulo pandas>",
  );
}
