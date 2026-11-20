import type { Param, Stmt } from "./ast.js";
import { PyError } from "./errors.js";

/**
 * Valores del lenguaje. Los números son number de JS (no distinguimos int/float al imprimir:
 * 4 / 2 se muestra como 2, no 2.0). Textos = string, bool = boolean, None = null.
 */
export type Value =
  | number
  | string
  | boolean
  | null
  | PyList
  | PyTuple
  | PyDict
  | PyRange
  | PyFunction
  | PyBuiltin
  | PyModule
  | HostObject;

export class PyList {
  constructor(public items: Value[]) {}
}

export class PyTuple {
  constructor(public readonly items: readonly Value[]) {}
}

export class PyDict {
  /** clave hash -> [clave, valor]; Map conserva el orden de inserción como Python. */
  readonly entries = new Map<string, [Value, Value]>();

  get(key: Value, line: number): Value | undefined {
    return this.entries.get(hashKey(key, line))?.[1];
  }
  set(key: Value, value: Value, line: number): void {
    this.entries.set(hashKey(key, line), [key, value]);
  }
  has(key: Value, line: number): boolean {
    return this.entries.has(hashKey(key, line));
  }
  delete(key: Value, line: number): boolean {
    return this.entries.delete(hashKey(key, line));
  }
  get size(): number {
    return this.entries.size;
  }
  keys(): Value[] {
    return [...this.entries.values()].map((e) => e[0]);
  }
}

export class PyRange {
  constructor(public readonly start: number, public readonly stop: number, public readonly step: number) {}
  get length(): number {
    const n = Math.ceil((this.stop - this.start) / this.step);
    return Math.max(0, n);
  }
  at(i: number): number {
    return this.start + i * this.step;
  }
}

export interface Module {
  name: string;
  globals: Map<string, Value>;
}

export class PyModule {
  constructor(public readonly module: Module) {}
}

export class PyFunction {
  constructor(
    public readonly name: string,
    public readonly params: Param[],
    public readonly defaults: (Value | undefined)[],
    public readonly body: Stmt[],
    /** Nombres asignados dentro de la función (son locales salvo 'global'). */
    public readonly localNames: Set<string>,
    public readonly globalNames: Set<string>,
    public readonly closure: Frame | null,
    public readonly module: Module,
  ) {}
}

/**
 * Acción física del robot (moverse, tomar, cobrar...). Ocupa al robot `ticks` ticks contando el
 * tick en que se llamó; `complete` se ejecuta al terminar y su resultado es el valor de la llamada.
 */
export class Action {
  constructor(
    public readonly ticks: number,
    public readonly complete: () => Value = () => null,
    /** Si existe, el robot espera además a que la promesa termine (consultas a la base de datos). */
    public readonly promise?: Promise<Value>,
  ) {}

  /** Acción que dura al menos `ticks` y devuelve lo que resuelva la promesa. */
  static async(ticks: number, promise: Promise<Value>): Action {
    return new Action(ticks, () => null, promise);
  }
}

export interface CallContext {
  line: number;
  /** Llama a una función del jugador (p. ej. key= de sorted). Usar con yield*. */
  call(fn: Value, args: Value[]): Generator<unknown, Value, unknown>;
}

export type BuiltinResult = Value | Action | Generator<unknown, Value, unknown>;

export class PyBuiltin {
  constructor(
    public readonly name: string,
    public readonly fn: (args: Value[], kwargs: Record<string, Value>, ctx: CallContext) => BuiltinResult,
  ) {}
}

/**
 * Comportamiento extra de un objeto del juego (DataFrame, Series...): obj[k], len(obj), for x in obj,
 * print(obj), operadores y atributos calculados. Lo que no esté definido da el error normal.
 */
export interface HostProtocol {
  getAttr?(name: string, line: number): Value | undefined;
  setAttr?(name: string, value: Value, line: number): void;
  getItem?(key: Value, line: number): Value;
  setItem?(key: Value, value: Value, line: number): void;
  len?(): number;
  iter?(): Value[];
  repr?(): string;
  /** Devuelve undefined si no sabe operar con `other`. `reflected`: el objeto estaba a la derecha. */
  binop?(op: string, other: Value, reflected: boolean, line: number): Value | undefined;
  compare?(op: string, other: Value, line: number): Value | undefined;
  attrNames?(): string[];
}

/** Objeto del juego (estante, cliente, producto...). Atributos de solo lectura; pueden ser PyBuiltin. */
export class HostObject {
  constructor(
    public readonly typeName: string,
    public readonly attrs: Record<string, Value>,
    public readonly display?: string,
    public readonly protocol: HostProtocol = {},
  ) {}
}

export interface Frame {
  locals: Map<string, Value>;
  /** null en el nivel del módulo: ahí locals === globals. */
  fn: PyFunction | null;
  module: Module;
}

// ── helpers ───────────────────────────────────────────────────

export function typeName(v: Value): string {
  if (v === null) return "None";
  switch (typeof v) {
    case "number": return "número";
    case "string": return "texto";
    case "boolean": return "booleano";
  }
  if (v instanceof PyList) return "lista";
  if (v instanceof PyTuple) return "tupla";
  if (v instanceof PyDict) return "diccionario";
  if (v instanceof PyRange) return "range";
  if (v instanceof PyFunction || v instanceof PyBuiltin) return "función";
  if (v instanceof PyModule) return "módulo";
  return v.typeName;
}

export function hashKey(v: Value, line: number): string {
  if (v === null) return "N";
  switch (typeof v) {
    case "number": return "n" + v;
    case "boolean": return "n" + (v ? 1 : 0); // True == 1 como en Python
    case "string": return "s" + v;
  }
  if (v instanceof PyTuple) return "t(" + v.items.map((x) => hashKey(x, line)).join(",") + ")";
  throw new PyError(`un(a) ${typeName(v)} no puede ser clave de diccionario`, line);
}

export function truthy(v: Value): boolean {
  if (v === null || v === false || v === 0 || v === "") return false;
  if (v instanceof PyList || v instanceof PyTuple) return v.items.length > 0;
  if (v instanceof PyDict) return v.size > 0;
  if (v instanceof PyRange) return v.length > 0;
  return true;
}

export function isNumber(v: Value): v is number | boolean {
  return typeof v === "number" || typeof v === "boolean";
}

export function num(v: Value): number {
  return typeof v === "boolean" ? (v ? 1 : 0) : (v as number);
}

export function pyEquals(a: Value, b: Value): boolean {
  if (isNumber(a) && isNumber(b)) return num(a) === num(b);
  if ((a instanceof PyList && b instanceof PyList) || (a instanceof PyTuple && b instanceof PyTuple)) {
    return a.items.length === b.items.length && a.items.every((x, i) => pyEquals(x, b.items[i]));
  }
  if (a instanceof PyDict && b instanceof PyDict) {
    if (a.size !== b.size) return false;
    for (const [k, [, v]] of a.entries) {
      const other = b.entries.get(k);
      if (!other || !pyEquals(v, other[1])) return false;
    }
    return true;
  }
  if (a instanceof PyRange && b instanceof PyRange) {
    return a.start === b.start && a.stop === b.stop && a.step === b.step;
  }
  return a === b;
}

/** a < b : -1, a == b : 0, a > b : 1. */
export function pyCompare(a: Value, b: Value, line: number): number {
  if (isNumber(a) && isNumber(b)) return num(a) < num(b) ? -1 : num(a) > num(b) ? 1 : 0;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if ((a instanceof PyList && b instanceof PyList) || (a instanceof PyTuple && b instanceof PyTuple)) {
    const n = Math.min(a.items.length, b.items.length);
    for (let i = 0; i < n; i++) {
      const c = pyCompare(a.items[i], b.items[i], line);
      if (c !== 0) return c;
    }
    return a.items.length - b.items.length < 0 ? -1 : a.items.length > b.items.length ? 1 : 0;
  }
  throw new PyError(`no se puede comparar ${typeName(a)} con ${typeName(b)}`, line);
}

export function formatNumber(n: number): string {
  if (Number.isNaN(n)) return "nan";
  if (n === Infinity) return "inf";
  if (n === -Infinity) return "-inf";
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 1e12) / 1e12);
}

/** str(x) */
export function pyStr(v: Value): string {
  return typeof v === "string" ? v : pyRepr(v);
}

/** repr(x): como Python muestra el valor dentro de una lista. */
export function pyRepr(v: Value, seen = new Set<unknown>()): string {
  if (v === null) return "None";
  switch (typeof v) {
    case "boolean": return v ? "True" : "False";
    case "number": return formatNumber(v);
    case "string": return "'" + v.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n") + "'";
  }
  if (seen.has(v)) return "[...]";
  if (v instanceof PyList) {
    seen.add(v);
    const s = "[" + v.items.map((x) => pyRepr(x, seen)).join(", ") + "]";
    seen.delete(v);
    return s;
  }
  if (v instanceof PyTuple) {
    const inner = v.items.map((x) => pyRepr(x, seen));
    return "(" + inner.join(", ") + (inner.length === 1 ? ",)" : ")");
  }
  if (v instanceof PyDict) {
    seen.add(v);
    const s = "{" + [...v.entries.values()].map(([k, x]) => pyRepr(k, seen) + ": " + pyRepr(x, seen)).join(", ") + "}";
    seen.delete(v);
    return s;
  }
  if (v instanceof PyRange) {
    return v.step === 1 ? `range(${v.start}, ${v.stop})` : `range(${v.start}, ${v.stop}, ${v.step})`;
  }
  if (v instanceof PyFunction) return `<función ${v.name}>`;
  if (v instanceof PyBuiltin) return `<función ${v.name}>`;
  if (v instanceof PyModule) return `<módulo ${v.module.name}>`;
  return v.protocol.repr?.() ?? v.display ?? `<${v.typeName}>`;
}
