import { Action, HostObject, PyBuiltin, PyDict, PyError, PyList, PyTuple, type Value } from "@cdb/interpreter";

/** Lo que la simulación necesita de la base de datos (lo implementa GameDB.playerQuery). */
export interface SqlAdapter {
  query(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[]; fields: string[]; affectedRows: number }>;
}

export const SQL_TICKS = 2;

/** Valor de Python -> parámetro de PostgreSQL. */
export function toJS(v: Value, line = 0): unknown {
  if (v === null || typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  if (v instanceof PyList || v instanceof PyTuple) return v.items.map((x) => toJS(x, line));
  throw new PyError("solo se pueden mandar a la base de datos números, textos, True/False, None o listas", line);
}

/** Valor de PostgreSQL -> Python. Fechas como texto 'AAAA-MM-DD HH:MM:SS'. */
export function fromJS(x: unknown): Value {
  if (x === null || x === undefined) return null;
  if (typeof x === "number" || typeof x === "string" || typeof x === "boolean") return x;
  if (typeof x === "bigint") return Number(x);
  if (x instanceof Date) {
    const iso = x.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.replace("T", " ").slice(0, 19);
  }
  if (Array.isArray(x)) return new PyList(x.map(fromJS));
  if (typeof x === "object") {
    const d = new PyDict();
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) d.set(k, fromJS(v), 0);
    return d;
  }
  return String(x);
}

export function rowToDict(row: Record<string, unknown>, fields: string[]): PyDict {
  const d = new PyDict();
  for (const f of fields) d.set(f, fromJS(row[f]), 0);
  return d;
}

/** "INSERT 0 1", "UPDATE 3", "CREATE TABLE"... como devuelve asyncpg. */
function statusOf(sql: string, affected: number): string {
  const words = sql.trim().split(/\s+/).map((w) => w.toUpperCase());
  const verb = words[0] ?? "";
  if (verb === "INSERT") return `INSERT 0 ${affected}`;
  if (["UPDATE", "DELETE", "SELECT"].includes(verb)) return `${verb} ${affected}`;
  return words.slice(0, 2).join(" ").replace(/[;(].*$/, "");
}

/**
 * `%s` (estilo psycopg) -> `$1, $2...` (PostgreSQL), sin tocar lo que va entre comillas. `%%` es un % literal.
 * Si el SQL ya usa $1, se deja igual.
 */
export function placeholders(sql: string): string {
  let out = "";
  let n = 0;
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      if (ch === quote) quote = null;
      out += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
    } else if (ch === "%" && sql[i + 1] === "s") {
      out += `$${++n}`;
      i++;
    } else if (ch === "%" && sql[i + 1] === "%") {
      out += "%";
      i++;
    } else out += ch;
  }
  return out;
}

/** cursor.execute(sql, (a, b)) o cursor.execute(sql, a, b): los dos sirven. */
function paramsOf(rest: Value[], line: number): unknown[] {
  const list = rest.length === 1 && (rest[0] instanceof PyTuple || rest[0] instanceof PyList) ? rest[0].items : rest;
  return list.map((a) => toJS(a, line));
}

/**
 * La conexión `cursor` (también se llama `db`): ya viene conectada a la base de datos de la tienda, sin await.
 * Los valores van con %s (o $1, $2...), nunca pegados al texto del SQL.
 *   cursor.execute("INSERT INTO productos (nombre, cantidad) VALUES (%s, %s)", ("pan", 40))  -> "INSERT 0 1"
 *   cursor.fetch(sql, valores)    -> lista de filas (diccionarios)
 *   cursor.fetchrow(sql, valores) -> una fila o None
 *   cursor.fetchval(sql, valores) -> un valor o None
 *   cursor.executemany(sql, lista_de_tuplas)
 */
export function makeDbConnection(getAdapter: () => SqlAdapter | undefined, onCall?: (sql: string) => void): HostObject {
  const adapter = (line: number) => {
    const a = getAdapter();
    if (!a) throw new PyError("la base de datos todavía está arrancando; intenta de nuevo en unos segundos", line);
    return a;
  };
  const needSql = (v: Value, fn: string, line: number): string => {
    if (typeof v !== "string") throw new PyError(`cursor.${fn}() necesita el SQL como texto, por ejemplo cursor.${fn}("SELECT * FROM productos")`, line);
    return placeholders(v);
  };
  const wrapError = (e: unknown, line: number): never => {
    throw new PyError(`SQL: ${(e as Error)?.message ?? String(e)}`, line);
  };
  const call = (fn: string, handle: (res: Awaited<ReturnType<SqlAdapter["query"]>>, sql: string) => Value) =>
    new PyBuiltin(fn, (args, _kw, ctx) => {
      const sql = needSql(args[0], fn, ctx.line);
      const params = paramsOf(args.slice(1), ctx.line);
      onCall?.(sql);
      const promise = adapter(ctx.line).query(sql, params).then((res) => handle(res, sql), (e) => wrapError(e, ctx.line));
      return Action.async(SQL_TICKS, promise);
    });

  return new HostObject(
    "conexión",
    {
      execute: call("execute", (res, sql) => statusOf(sql, res.affectedRows || res.rows.length)),
      fetch: call("fetch", (res) => new PyList(res.rows.map((r) => rowToDict(r, res.fields)))),
      fetchrow: call("fetchrow", (res) => (res.rows[0] ? rowToDict(res.rows[0], res.fields) : null)),
      fetchval: call("fetchval", (res) => (res.rows[0] ? fromJS(res.rows[0][res.fields[0]]) : null)),
      executemany: new PyBuiltin("executemany", (args, _kw, ctx) => {
        const sql = needSql(args[0], "executemany", ctx.line);
        const list = args[1];
        if (!(list instanceof PyList)) throw new PyError("cursor.executemany() necesita una lista de filas, por ejemplo [(1, 'pan'), (2, 'leche')]", ctx.line);
        const rows = list.items.map((r) => (r instanceof PyTuple || r instanceof PyList ? r.items.map((x) => toJS(x, ctx.line)) : [toJS(r, ctx.line)]));
        onCall?.(sql);
        const a = adapter(ctx.line);
        const promise = (async () => {
          for (const params of rows) await a.query(sql, params);
          return null;
        })().catch((e) => wrapError(e, ctx.line));
        return Action.async(SQL_TICKS * Math.max(1, rows.length), promise);
      }),
    },
    "<conexión a la base de datos de la tienda>",
  );
}
