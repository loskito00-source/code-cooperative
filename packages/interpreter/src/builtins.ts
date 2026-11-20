import { PyError } from "./errors.js";
import {
  type BuiltinResult,
  type CallContext,
  HostObject,
  PyBuiltin,
  PyDict,
  PyList,
  PyRange,
  PyTuple,
  type Value,
  isNumber,
  num,
  pyCompare,
  pyEquals,
  pyRepr,
  pyStr,
  truthy,
  typeName,
} from "./values.js";

/** Lo que las funciones incluidas necesitan de la VM. */
export interface Runtime {
  print(text: string): void;
  /** Lanza error si una colección pasaría el límite de memoria del robot. */
  limit(size: number, line: number): void;
  toArray(v: Value, line: number): Value[];
}

type Impl = (args: Value[], kw: Record<string, Value>, ctx: CallContext) => BuiltinResult;

function arity(name: string, args: Value[], min: number, max: number, line: number): void {
  if (args.length < min || args.length > max) {
    const want = min === max ? `${min}` : `entre ${min} y ${max}`;
    throw new PyError(`${name}() recibe ${want} valor(es) pero le diste ${args.length}`, line);
  }
}

function needInt(v: Value, what: string, line: number): number {
  if (!isNumber(v) || !Number.isInteger(num(v))) {
    throw new PyError(`${what} debe ser un número entero, no ${typeName(v)}`, line);
  }
  return num(v);
}

function needNumber(v: Value, fn: string, line: number): number {
  if (!isNumber(v)) throw new PyError(`${fn}() necesita un número, no ${typeName(v)}`, line);
  return num(v);
}

/** Redondeo bancario como Python: round(2.5) == 2. */
export function pyRound(x: number, digits: number): number {
  const f = 10 ** digits;
  const y = x * f;
  const r = Math.round(y);
  const half = Math.abs(y % 1) === 0.5;
  const res = half && r % 2 !== 0 ? r - 1 : r;
  return res / f;
}

/** Ordena de forma estable calculando primero las claves (key= puede ser una función del jugador). */
function* sortValues(
  items: Value[],
  key: Value | undefined,
  reverse: boolean,
  ctx: CallContext,
): Generator<unknown, Value[], unknown> {
  const keys: Value[] = [];
  for (const it of items) keys.push(key == null ? it : yield* ctx.call(key, [it]));
  const idx = items.map((_, i) => i);
  idx.sort((a, b) => {
    const c = pyCompare(keys[a], keys[b], ctx.line);
    return (reverse ? -c : c) || a - b;
  });
  return idx.map((i) => items[i]);
}

function* minMax(name: "min" | "max", args: Value[], kw: Record<string, Value>, rt: Runtime, ctx: CallContext) {
  const items = args.length === 1 ? rt.toArray(args[0], ctx.line) : args;
  if (items.length === 0) {
    if ("default" in kw) return kw.default;
    throw new PyError(`${name}() recibió una lista vacía`, ctx.line);
  }
  let best = items[0];
  let bestKey = kw.key == null ? best : yield* ctx.call(kw.key, [best]);
  for (let i = 1; i < items.length; i++) {
    const k = kw.key == null ? items[i] : yield* ctx.call(kw.key, [items[i]]);
    const c = pyCompare(k, bestKey, ctx.line);
    if (name === "min" ? c < 0 : c > 0) {
      best = items[i];
      bestKey = k;
    }
  }
  return best;
}

export function makeBuiltins(rt: Runtime): Map<string, Value> {
  const b = new Map<string, Value>();
  const def = (name: string, fn: Impl) => b.set(name, new PyBuiltin(name, fn));

  def("print", (args, kw) => {
    const sep = kw.sep == null ? " " : pyStr(kw.sep);
    rt.print(args.map(pyStr).join(sep));
    return null;
  });

  def("len", (args, _kw, ctx) => {
    arity("len", args, 1, 1, ctx.line);
    const v = args[0];
    if (typeof v === "string") return v.length;
    if (v instanceof PyList || v instanceof PyTuple) return v.items.length;
    if (v instanceof PyDict) return v.size;
    if (v instanceof PyRange) return v.length;
    if (v instanceof HostObject && v.protocol.len) return v.protocol.len();
    throw new PyError(`len() no funciona con ${typeName(v)}`, ctx.line);
  });

  def("range", (args, _kw, ctx) => {
    arity("range", args, 1, 3, ctx.line);
    const n = args.map((a) => needInt(a, "el valor de range()", ctx.line));
    const [start, stop, step] = n.length === 1 ? [0, n[0], 1] : [n[0], n[1], n[2] ?? 1];
    if (step === 0) throw new PyError("el paso de range() no puede ser 0", ctx.line);
    return new PyRange(start, stop, step);
  });

  def("abs", (args, _kw, ctx) => {
    arity("abs", args, 1, 1, ctx.line);
    return Math.abs(needNumber(args[0], "abs", ctx.line));
  });

  def("min", (args, kw, ctx) => minMax("min", args, kw, rt, ctx));
  def("max", (args, kw, ctx) => minMax("max", args, kw, rt, ctx));

  def("sum", (args, _kw, ctx) => {
    arity("sum", args, 1, 2, ctx.line);
    let total = args.length > 1 ? needNumber(args[1], "sum", ctx.line) : 0;
    for (const x of rt.toArray(args[0], ctx.line)) total += needNumber(x, "sum", ctx.line);
    return total;
  });

  def("int", (args, _kw, ctx) => {
    arity("int", args, 0, 1, ctx.line);
    if (args.length === 0) return 0;
    const v = args[0];
    if (isNumber(v)) return Math.trunc(num(v));
    if (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v)) return parseInt(v, 10);
    throw new PyError(`no se puede convertir ${pyRepr(v)} a número entero`, ctx.line);
  });

  def("float", (args, _kw, ctx) => {
    arity("float", args, 0, 1, ctx.line);
    if (args.length === 0) return 0;
    const v = args[0];
    if (isNumber(v)) return num(v);
    if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
    throw new PyError(`no se puede convertir ${pyRepr(v)} a número`, ctx.line);
  });

  def("str", (args, _kw, ctx) => {
    arity("str", args, 0, 1, ctx.line);
    return args.length ? pyStr(args[0]) : "";
  });

  def("bool", (args, _kw, ctx) => {
    arity("bool", args, 0, 1, ctx.line);
    return args.length ? truthy(args[0]) : false;
  });

  def("round", (args, _kw, ctx) => {
    arity("round", args, 1, 2, ctx.line);
    const x = needNumber(args[0], "round", ctx.line);
    const d = args.length > 1 ? needInt(args[1], "los decimales de round()", ctx.line) : 0;
    return pyRound(x, d);
  });

  def("sorted", function* (args, kw, ctx) {
    arity("sorted", args, 1, 1, ctx.line);
    const items = rt.toArray(args[0], ctx.line);
    return new PyList(yield* sortValues(items, kw.key, truthy(kw.reverse ?? false), ctx));
  });

  def("list", (args, _kw, ctx) => {
    arity("list", args, 0, 1, ctx.line);
    return new PyList(args.length ? rt.toArray(args[0], ctx.line) : []);
  });

  def("dict", (args, _kw, ctx) => {
    arity("dict", args, 0, 0, ctx.line);
    return new PyDict();
  });

  def("enumerate", (args, kw, ctx) => {
    arity("enumerate", args, 1, 2, ctx.line);
    const start = needInt(args[1] ?? kw.start ?? 0, "el inicio de enumerate()", ctx.line);
    return new PyList(rt.toArray(args[0], ctx.line).map((x, i) => new PyTuple([i + start, x])));
  });

  def("reversed", (args, _kw, ctx) => {
    arity("reversed", args, 1, 1, ctx.line);
    return new PyList(rt.toArray(args[0], ctx.line).reverse());
  });

  return b;
}

// ── métodos ──────────────────────────────────────────────────

type Method<T> = (self: T, args: Value[], kw: Record<string, Value>, ctx: CallContext, rt: Runtime) => BuiltinResult;

function needStr(v: Value, what: string, line: number): string {
  if (typeof v !== "string") throw new PyError(`${what} debe ser texto, no ${typeName(v)}`, line);
  return v;
}

const STR_METHODS: Record<string, Method<string>> = {
  upper: (s) => s.toUpperCase(),
  lower: (s) => s.toLowerCase(),
  strip: (s) => s.trim(),
  capitalize: (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(),
  isdigit: (s) => s.length > 0 && /^\d+$/.test(s),
  startswith: (s, a, _k, c) => s.startsWith(needStr(a[0], "el prefijo", c.line)),
  endswith: (s, a, _k, c) => s.endsWith(needStr(a[0], "el sufijo", c.line)),
  find: (s, a, _k, c) => s.indexOf(needStr(a[0], "lo que buscas", c.line)),
  count: (s, a, _k, c) => {
    const sub = needStr(a[0], "lo que cuentas", c.line);
    return sub === "" ? s.length + 1 : s.split(sub).length - 1;
  },
  replace: (s, a, _k, c, rt) => {
    const r = s.split(needStr(a[0], "el texto a reemplazar", c.line)).join(needStr(a[1], "el texto nuevo", c.line));
    rt.limit(r.length / 10, c.line);
    return r;
  },
  split: (s, a, _k, c) => {
    const parts = a.length === 0 || a[0] === null ? s.trim().split(/\s+/).filter(Boolean) : s.split(needStr(a[0], "el separador", c.line));
    return new PyList(parts);
  },
  join: (s, a, _k, c, rt) =>
    rt.toArray(a[0], c.line).map((x) => {
      if (typeof x !== "string") throw new PyError(`join() solo une textos, encontré ${typeName(x)}`, c.line);
      return x;
    }).join(s),
};

function listIndex(list: PyList, i: Value, line: number, insert = false): number {
  let n = needInt(i, "el índice", line);
  const len = list.items.length;
  if (n < 0) n += len;
  if (insert) return Math.max(0, Math.min(len, n));
  if (n < 0 || n >= len) throw new PyError(`el índice ${num(i)} está fuera de la lista (tiene ${len} elementos)`, line);
  return n;
}

const LIST_METHODS: Record<string, Method<PyList>> = {
  append: (l, a, _k, c, rt) => {
    arity("append", a, 1, 1, c.line);
    rt.limit(l.items.length + 1, c.line);
    l.items.push(a[0]);
    return null;
  },
  extend: (l, a, _k, c, rt) => {
    const more = rt.toArray(a[0], c.line);
    rt.limit(l.items.length + more.length, c.line);
    l.items.push(...more);
    return null;
  },
  insert: (l, a, _k, c, rt) => {
    arity("insert", a, 2, 2, c.line);
    rt.limit(l.items.length + 1, c.line);
    l.items.splice(listIndex(l, a[0], c.line, true), 0, a[1]);
    return null;
  },
  pop: (l, a, _k, c) => {
    if (l.items.length === 0) throw new PyError("no se puede hacer pop() de una lista vacía", c.line);
    const i = a.length ? listIndex(l, a[0], c.line) : l.items.length - 1;
    return l.items.splice(i, 1)[0];
  },
  remove: (l, a, _k, c) => {
    const i = l.items.findIndex((x) => pyEquals(x, a[0]));
    if (i < 0) throw new PyError(`${pyRepr(a[0])} no está en la lista`, c.line);
    l.items.splice(i, 1);
    return null;
  },
  index: (l, a, _k, c) => {
    const i = l.items.findIndex((x) => pyEquals(x, a[0]));
    if (i < 0) throw new PyError(`${pyRepr(a[0])} no está en la lista`, c.line);
    return i;
  },
  count: (l, a) => l.items.filter((x) => pyEquals(x, a[0])).length,
  reverse: (l) => {
    l.items.reverse();
    return null;
  },
  copy: (l) => new PyList([...l.items]),
  clear: (l) => {
    l.items.length = 0;
    return null;
  },
  sort: function* (l, _a, kw, c) {
    l.items = yield* sortValues(l.items, kw.key, truthy(kw.reverse ?? false), c);
    return null;
  },
};

const DICT_METHODS: Record<string, Method<PyDict>> = {
  get: (d, a, _k, c) => d.get(a[0], c.line) ?? (a.length > 1 ? a[1] : null),
  keys: (d) => new PyList(d.keys()),
  values: (d) => new PyList([...d.entries.values()].map((e) => e[1])),
  items: (d) => new PyList([...d.entries.values()].map(([k, v]) => new PyTuple([k, v]))),
  pop: (d, a, _k, c) => {
    const v = d.get(a[0], c.line);
    if (v === undefined) {
      if (a.length > 1) return a[1];
      throw new PyError(`la clave ${pyRepr(a[0])} no existe en el diccionario`, c.line);
    }
    d.delete(a[0], c.line);
    return v;
  },
  copy: (d) => {
    const n = new PyDict();
    for (const [h, e] of d.entries) n.entries.set(h, [e[0], e[1]]);
    return n;
  },
  clear: (d) => {
    d.entries.clear();
    return null;
  },
  update: (d, a, _k, c, rt) => {
    const o = a[0];
    if (!(o instanceof PyDict)) throw new PyError("update() necesita un diccionario", c.line);
    for (const [h, e] of o.entries) d.entries.set(h, [e[0], e[1]]);
    rt.limit(d.size, c.line);
    return null;
  },
};

/** Devuelve el método ligado (p. ej. lista.append) o undefined si el tipo no lo tiene. */
export function getMethod(obj: Value, name: string, rt: Runtime): PyBuiltin | undefined {
  const bind = <T>(table: Record<string, Method<T>>, self: T) =>
    Object.hasOwn(table, name)
      ? new PyBuiltin(name, (args, kw, ctx) => table[name](self, args, kw, ctx, rt))
      : undefined;
  if (typeof obj === "string") return bind(STR_METHODS, obj);
  if (obj instanceof PyList) return bind(LIST_METHODS, obj);
  if (obj instanceof PyDict) return bind(DICT_METHODS, obj);
  return undefined;
}

export function methodNames(obj: Value): string[] {
  if (typeof obj === "string") return Object.keys(STR_METHODS);
  if (obj instanceof PyList) return Object.keys(LIST_METHODS);
  if (obj instanceof PyDict) return Object.keys(DICT_METHODS);
  return [];
}
