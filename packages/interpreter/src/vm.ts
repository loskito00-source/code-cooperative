import type { Expr, Program, Stmt, Target } from "./ast.js";
import { getMethod, makeBuiltins, methodNames, pyRound, type Runtime } from "./builtins.js";
import { closest, PyError } from "./errors.js";
import { checkFeatures, FEATURES, type Feature } from "./features.js";
import { parse } from "./parser.js";
import {
  Action,
  type CallContext,
  type Frame,
  HostObject,
  type Module,
  PyBuiltin,
  PyDict,
  PyFunction,
  PyList,
  PyModule,
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

export type Status = "running" | "waiting" | "paused" | "done" | "error" | "stopped";

export interface VariableInfo {
  scope: "local" | "global";
  name: string;
  type: string;
  value: string;
}

export interface VMOptions {
  /** API del juego: funciones (PyBuiltin) y constantes (North, WAREHOUSE...). */
  globals?: Record<string, Value>;
  /** Código de los módulos importables, p. ej. { shared: "def f(): ..." }. */
  modules?: Record<string, string>;
  /** Librerías del juego que se importan con import (p. ej. { pandas: <objeto> }). */
  nativeModules?: Record<string, Value>;
  /** Sintaxis desbloqueada. Por defecto: todo. */
  features?: ReadonlySet<Feature>;
  /** Operaciones del intérprete por tick (mejora "CPU"). */
  opsPerTick?: number;
  maxCallDepth?: number;
  /** Máximo de elementos en una lista/diccionario (y longitud de texto / 10). */
  maxCollectionSize?: number;
  onPrint?: (text: string) => void;
  /** Líneas del script principal donde el robot se detiene (se puede cambiar mientras corre). */
  breakpoints?: ReadonlySet<number>;
}

const ALL_FEATURES: ReadonlySet<Feature> = new Set(FEATURES);

/** Parsea y valida desbloqueos. Lanza el primer PyError. */
export function compile(source: string, features: ReadonlySet<Feature> = ALL_FEATURES): Program {
  const program = parse(source);
  const locked = checkFeatures(program, features);
  if (locked.length) throw locked[0];
  return program;
}

/** Para el editor: lista de errores sin ejecutar (vacía = todo bien). */
export function check(source: string, features: ReadonlySet<Feature> = ALL_FEATURES): PyError[] {
  try {
    return checkFeatures(parse(source), features);
  } catch (e) {
    if (e instanceof PyError) return [e];
    throw e;
  }
}

const PAUSE = Symbol("pause");
/** El depurador detuvo al robot antes de ejecutar una línea. */
const BREAK = Symbol("break");
type Yielded = typeof PAUSE | typeof BREAK | Action;
type Gen<T> = Generator<Yielded, T, Value>;

class BreakSignal {}
class ContinueSignal {}
class ReturnSignal {
  constructor(public readonly value: Value) {}
}

function isGenerator(v: unknown): v is Generator<unknown, Value, unknown> {
  return typeof v === "object" && v !== null && typeof (v as Generator).next === "function" && Symbol.iterator in v;
}

/**
 * Ejecuta el script de un robot. Llamar tick() una vez por tick de simulación.
 * El robot "piensa" hasta opsPerTick operaciones por tick; las acciones (Action) lo ocupan varios ticks.
 */
export class VM {
  status: Status = "running";
  error: PyError | null = null;
  /** Línea en ejecución (para resaltarla en el editor). */
  line = 0;
  /** Módulo en ejecución: "main" o p. ej. "shared". */
  file = "main";
  /** Ticks que le faltan a la acción en curso. */
  busyTicks = 0;
  /** Esperando la respuesta de una promesa (p. ej. una consulta SQL). */
  waitingAsync = false;
  private asyncResult: { done: boolean; value: Value; error: unknown } | null = null;
  totalOps = 0;

  /** Se puede cambiar en caliente (mejora de CPU). */
  opsPerTick: number;
  private readonly maxDepth: number;
  private readonly maxSize: number;
  private readonly features: ReadonlySet<Feature>;
  private readonly builtins: Map<string, Value>;
  private readonly modules = new Map<string, Module>();
  private readonly main: Module = { name: "main", globals: new Map() };
  private readonly rt: Runtime;
  private gen: Gen<void> | null = null;
  private pending: Action | null = null;
  private opsThisTick = 0;
  private depth = 0;
  /** Detenerse en la próxima línea (botón Paso o Pausar). */
  private stepRequested = false;
  private currentFrame: Frame | null = null;
  /** Por qué está pausado: "punto" (breakpoint) o "paso". */
  pauseReason: "punto" | "paso" | null = null;

  constructor(source: string | Program, private readonly opts: VMOptions = {}) {
    this.opsPerTick = opts.opsPerTick ?? 50;
    this.maxDepth = opts.maxCallDepth ?? 64;
    this.maxSize = opts.maxCollectionSize ?? 10_000;
    this.features = opts.features ?? ALL_FEATURES;
    this.rt = {
      print: (t) => opts.onPrint?.(t),
      limit: (n, line) => this.limit(n, line),
      toArray: (v, line) => this.toArray(v, line),
    };
    this.builtins = makeBuiltins(this.rt);
    for (const [k, v] of Object.entries(opts.globals ?? {})) this.builtins.set(k, v);

    try {
      const program = typeof source === "string" ? compile(source, this.features) : source;
      this.gen = this.run(program);
    } catch (e) {
      this.fail(e);
    }
  }

  /** Avanza un tick. Devuelve el estado resultante. */
  tick(): Status {
    if (this.status === "done" || this.status === "error" || this.status === "stopped" || this.status === "paused") return this.status;
    if (this.busyTicks > 0) {
      this.busyTicks--;
      this.status = "waiting";
      return this.status;
    }
    this.opsThisTick = 0;
    try {
      let input: Value = null;
      if (this.pending) {
        const action = this.pending;
        if (action.promise) {
          const res = this.asyncResult!;
          if (!res.done) {
            this.waitingAsync = true;
            this.status = "waiting";
            return this.status;
          }
          this.waitingAsync = false;
          this.pending = null;
          this.asyncResult = null;
          if (res.error !== undefined) throw res.error instanceof PyError ? res.error : new PyError(String((res.error as Error)?.message ?? res.error), this.line);
          input = res.value;
        } else {
          this.pending = null;
          input = action.complete();
        }
      }
      const r = this.gen!.next(input);
      if (r.done) {
        this.status = "done";
      } else if (r.value === BREAK) {
        this.status = "paused";
      } else if (r.value instanceof Action) {
        this.pending = r.value;
        if (r.value.promise) {
          const res = { done: false, value: null as Value, error: undefined as unknown };
          this.asyncResult = res;
          r.value.promise.then(
            (v) => Object.assign(res, { done: true, value: v }),
            (e) => Object.assign(res, { done: true, error: e ?? new Error("error desconocido") }),
          );
        }
        this.busyTicks = Math.max(0, Math.floor(r.value.ticks) - 1);
        this.status = "waiting";
      } else {
        this.status = "running";
      }
    } catch (e) {
      this.fail(e);
    }
    return this.status;
  }

  stop(): void {
    if (this.status !== "error" && this.status !== "done") this.status = "stopped";
  }

  // ── depurador ───────────────────────────────────────────────

  /** Se detiene antes de la próxima línea (si está en medio de una acción, al terminarla). */
  pause(): void {
    if (this.status === "running" || this.status === "waiting") this.stepRequested = true;
  }

  /** Sigue normalmente hasta el próximo punto de parada. */
  resume(): void {
    if (this.status !== "paused") return;
    this.stepRequested = false;
    this.pauseReason = null;
    this.status = "running";
  }

  /** Ejecuta una sola línea y vuelve a detenerse. */
  step(): void {
    if (this.status !== "paused") return;
    this.stepRequested = true;
    this.pauseReason = null;
    this.status = "running";
  }

  /** Variables visibles en la línea actual: las locales de la función y las globales del script. */
  inspect(): VariableInfo[] {
    const out: VariableInfo[] = [];
    const add = (scope: VariableInfo["scope"], vars: Map<string, Value>) => {
      for (const [name, v] of vars) {
        if (v instanceof PyBuiltin || v instanceof PyModule || v instanceof PyFunction) continue;
        let value = pyRepr(v);
        if (value.length > 160) value = value.slice(0, 157) + "...";
        out.push({ scope, name, type: typeName(v), value });
      }
    };
    const f = this.currentFrame;
    if (f?.fn) add("local", f.locals);
    add("global", this.main.globals);
    return out;
  }

  /** Punto de parada antes de ejecutar `line` en el script principal. */
  private shouldBreak(line: number): boolean {
    if (this.file !== "main") return false;
    if (this.stepRequested) {
      this.pauseReason = "paso";
      return true;
    }
    if (this.opts.breakpoints?.has(line)) {
      this.pauseReason = "punto";
      return true;
    }
    return false;
  }

  /** Lee una variable global del script (útil para tests y depuración). */
  getGlobal(name: string): Value | undefined {
    return this.main.globals.get(name);
  }

  // ── control ─────────────────────────────────────────────────

  private fail(e: unknown): void {
    this.status = "error";
    this.pending = null;
    if (e instanceof PyError) {
      if (e.line === 0) e.line = this.line;
      if (e.file === undefined) e.file = this.file;
      this.error = e;
    } else if (e instanceof RangeError) {
      this.error = new PyError("demasiadas llamadas anidadas (¿recursión infinita?)", this.line);
      this.error.file = this.file;
    } else {
      // Error del juego (no del jugador): se reporta pero no tumba la simulación.
      this.error = new PyError(`error interno: ${(e as Error)?.message ?? String(e)}`, this.line);
      this.error.file = this.file;
    }
  }

  /** Cuenta una operación; true si se acabó el presupuesto del tick. */
  private op(line: number): boolean {
    this.line = line;
    this.totalOps++;
    return ++this.opsThisTick > this.opsPerTick;
  }

  private limit(n: number, line: number): void {
    if (n > this.maxSize) {
      throw new PyError(`la memoria del robot se llenó (máximo ${this.maxSize} elementos)`, line);
    }
  }

  private *run(program: Program): Gen<void> {
    const frame: Frame = { locals: this.main.globals, fn: null, module: this.main };
    try {
      yield* this.execBlock(program.body, frame);
    } catch (e) {
      if (e instanceof BreakSignal) throw new PyError("'break' fuera de un bucle", this.line);
      if (e instanceof ContinueSignal) throw new PyError("'continue' fuera de un bucle", this.line);
      throw e;
    }
  }

  // ── sentencias ──────────────────────────────────────────────

  private *execBlock(body: Stmt[], frame: Frame): Gen<void> {
    for (const s of body) yield* this.exec(s, frame);
  }

  private *loopBody(body: Stmt[], frame: Frame): Gen<"break" | "continue" | null> {
    try {
      yield* this.execBlock(body, frame);
      return null;
    } catch (e) {
      if (e instanceof BreakSignal) return "break";
      if (e instanceof ContinueSignal) return "continue";
      throw e;
    }
  }

  private *exec(s: Stmt, frame: Frame): Gen<void> {
    if (this.op(s.line)) yield PAUSE;
    this.currentFrame = frame;
    if (this.shouldBreak(s.line)) {
      this.stepRequested = false;
      yield BREAK;
    }
    switch (s.kind) {
      case "expr":
        yield* this.eval(s.expr, frame);
        return;

      case "assign": {
        const v = yield* this.eval(s.value, frame);
        for (const t of s.targets) yield* this.assign(t, v, frame);
        return;
      }

      case "augassign": {
        const rhs = yield* this.eval(s.value, frame);
        const t = s.target;
        if (t.kind === "name") {
          const cur = this.lookup(t.id, frame, s.line);
          this.setName(t.id, this.augmented(cur, s.op, rhs, s.line), frame);
        } else if (t.kind === "index") {
          const obj = yield* this.eval(t.obj, frame);
          const idx = yield* this.eval(t.index, frame);
          const cur = this.getIndex(obj, idx, s.line);
          this.setIndex(obj, idx, this.augmented(cur, s.op, rhs, s.line), s.line);
        } else {
          throw new PyError("no se puede modificar este valor", s.line);
        }
        return;
      }

      case "if": {
        const test = yield* this.eval(s.test, frame);
        yield* this.execBlock(truthy(test) ? s.body : s.orelse, frame);
        return;
      }

      case "while": {
        let first = true;
        for (;;) {
          if (!first && this.shouldBreak(s.line)) {
            this.line = s.line;
            this.currentFrame = frame;
            this.stepRequested = false;
            yield BREAK;
          }
          first = false;
          if (!truthy(yield* this.eval(s.test, frame))) break;
          if ((yield* this.loopBody(s.body, frame)) === "break") break;
        }
        return;
      }

      case "for": {
        const iterable = yield* this.eval(s.iter, frame);
        const it = this.iterate(iterable, s.line);
        let first = true;
        for (let r = it.next(); !r.done; r = it.next()) {
          if (this.op(s.line)) yield PAUSE;
          if (!first && this.shouldBreak(s.line)) {
            this.currentFrame = frame;
            this.stepRequested = false;
            yield BREAK;
          }
          first = false;
          yield* this.assign(s.target, r.value, frame);
          if ((yield* this.loopBody(s.body, frame)) === "break") break;
        }
        return;
      }

      case "def": {
        const defaults: (Value | undefined)[] = [];
        for (const p of s.params) defaults.push(p.default ? yield* this.eval(p.default, frame) : undefined);
        const { locals, globals } = scanLocals(s.body);
        for (const p of s.params) locals.add(p.name);
        for (const g of globals) locals.delete(g);
        const fn = new PyFunction(s.name, s.params, defaults, s.body, locals, globals, frame.fn ? frame : null, frame.module);
        this.setName(s.name, fn, frame);
        return;
      }

      case "return":
        if (!frame.fn) throw new PyError("'return' fuera de una función", s.line);
        throw new ReturnSignal(s.value ? yield* this.eval(s.value, frame) : null);

      case "break":
        throw new BreakSignal();
      case "continue":
        throw new ContinueSignal();
      case "pass":
      case "global":
        return;

      case "import": {
        const native = this.opts.nativeModules?.[s.module];
        if (native !== undefined) {
          if (s.names === null) this.setName(s.alias ?? s.module, native, frame);
          else for (const n of s.names) this.setName(n.alias ?? n.name, this.getAttr(native, n.name, s.line), frame);
          return;
        }
        const mod = yield* this.importModule(s.module, s.line);
        if (s.names === null) {
          this.setName(s.alias ?? s.module, new PyModule(mod), frame);
        } else {
          for (const { name: n, alias } of s.names) {
            if (!mod.globals.has(n)) {
              const hint = closest(n, mod.globals.keys());
              throw new PyError(`el módulo '${s.module}' no tiene '${n}'${hint ? `. ¿Quisiste decir '${hint}'?` : ""}`, s.line);
            }
            this.setName(alias ?? n, mod.globals.get(n)!, frame);
          }
        }
        return;
      }
    }
  }

  private augmented(cur: Value, op: string, rhs: Value, line: number): Value {
    // lista += algo  modifica la misma lista (como Python)
    if (op === "+" && cur instanceof PyList) {
      const more = this.toArray(rhs, line);
      this.limit(cur.items.length + more.length, line);
      cur.items.push(...more);
      return cur;
    }
    return this.binop(op, cur, rhs, line);
  }

  private *assign(t: Target, v: Value, frame: Frame): Gen<void> {
    switch (t.kind) {
      case "name":
        this.setName(t.id, v, frame);
        return;
      case "index": {
        const obj = yield* this.eval(t.obj, frame);
        const idx = yield* this.eval(t.index, frame);
        this.setIndex(obj, idx, v, t.line);
        return;
      }
      case "attr": {
        const obj = yield* this.eval(t.obj, frame);
        if (obj instanceof HostObject && obj.protocol.setAttr) {
          obj.protocol.setAttr(t.name, v, t.line);
          return;
        }
        throw new PyError(`no se puede cambiar '${t.name}'`, t.line);
      }
      case "tuple": {
        const items = this.toArray(v, t.line);
        if (items.length !== t.items.length) {
          throw new PyError(`se esperaban ${t.items.length} valores pero hay ${items.length}`, t.line);
        }
        for (let i = 0; i < items.length; i++) yield* this.assign(t.items[i], items[i], frame);
        return;
      }
    }
  }

  private setName(id: string, v: Value, frame: Frame): void {
    if (frame.fn && frame.fn.globalNames.has(id)) frame.module.globals.set(id, v);
    else frame.locals.set(id, v);
  }

  private lookup(id: string, frame: Frame, line: number): Value {
    const fn = frame.fn;
    if (fn && !fn.globalNames.has(id)) {
      if (fn.localNames.has(id)) {
        if (frame.locals.has(id)) return frame.locals.get(id)!;
        throw new PyError(`la variable '${id}' se usa antes de darle un valor`, line);
      }
      for (let f = fn.closure; f; f = f.fn?.closure ?? null) {
        if (f.locals.has(id)) return f.locals.get(id)!;
      }
    }
    if (frame.module.globals.has(id)) return frame.module.globals.get(id)!;
    if (this.builtins.has(id)) return this.builtins.get(id)!;

    const known = new Set<string>([...frame.locals.keys(), ...frame.module.globals.keys(), ...this.builtins.keys()]);
    const hint = closest(id, known);
    throw new PyError(`'${id}' no existe${hint ? `. ¿Quisiste decir '${hint}'?` : ""}`, line);
  }

  // ── expresiones ─────────────────────────────────────────────

  private *eval(e: Expr, frame: Frame): Gen<Value> {
    if (this.op(e.line)) yield PAUSE;
    switch (e.kind) {
      case "num":
        return e.value;
      case "str":
        return e.value;
      case "const":
        return e.value;
      case "name":
        return this.lookup(e.id, frame, e.line);

      case "list": {
        const items: Value[] = [];
        for (const x of e.items) items.push(yield* this.eval(x, frame));
        this.limit(items.length, e.line);
        return new PyList(items);
      }
      case "tuple": {
        const items: Value[] = [];
        for (const x of e.items) items.push(yield* this.eval(x, frame));
        return new PyTuple(items);
      }
      case "dict": {
        const d = new PyDict();
        for (let i = 0; i < e.keys.length; i++) {
          const k = yield* this.eval(e.keys[i], frame);
          d.set(k, yield* this.eval(e.values[i], frame), e.line);
        }
        this.limit(d.size, e.line);
        return d;
      }

      case "binop": {
        const l = yield* this.eval(e.left, frame);
        const r = yield* this.eval(e.right, frame);
        return this.binop(e.op, l, r, e.line);
      }

      case "unary": {
        const v = yield* this.eval(e.operand, frame);
        if (e.op === "not") return !truthy(v);
        if (!isNumber(v)) throw new PyError(`no se puede usar '${e.op}' con ${typeName(v)}`, e.line);
        return e.op === "-" ? -num(v) : num(v);
      }

      case "boolop": {
        const l = yield* this.eval(e.left, frame);
        if (e.op === "and" ? !truthy(l) : truthy(l)) return l;
        return yield* this.eval(e.right, frame);
      }

      case "compare": {
        let left = yield* this.eval(e.operands[0], frame);
        for (let i = 0; i < e.ops.length; i++) {
          const right = yield* this.eval(e.operands[i + 1], frame);
          const res = this.compare(e.ops[i], left, right, e.line);
          if (e.ops.length === 1) return res; // df["x"] > 3 devuelve una Series, no un booleano
          if (!truthy(res)) return false;
          left = right;
        }
        return true;
      }

      case "ifexp":
        return truthy(yield* this.eval(e.test, frame))
          ? yield* this.eval(e.body, frame)
          : yield* this.eval(e.orelse, frame);

      case "call": {
        const f = yield* this.eval(e.func, frame);
        const args: Value[] = [];
        for (const a of e.args) args.push(yield* this.eval(a, frame));
        const kwargs: Record<string, Value> = {};
        for (const k of e.kwargs) kwargs[k.name] = yield* this.eval(k.value, frame);
        return yield* this.callValue(f, args, kwargs, e.line);
      }

      case "attr":
        return this.getAttr(yield* this.eval(e.obj, frame), e.name, e.line);

      case "index": {
        const obj = yield* this.eval(e.obj, frame);
        return this.getIndex(obj, yield* this.eval(e.index, frame), e.line);
      }

      case "fstr": {
        let out = "";
        for (const p of e.parts) {
          if (typeof p === "string") out += p;
          else out += formatValue(yield* this.eval(p.expr, frame), p.spec, e.line);
        }
        this.limit(out.length / 10, e.line);
        return out;
      }

      case "slice": {
        const obj = yield* this.eval(e.obj, frame);
        const start = e.start ? yield* this.eval(e.start, frame) : null;
        const stop = e.stop ? yield* this.eval(e.stop, frame) : null;
        return this.getSlice(obj, start, stop, e.line);
      }
    }
  }

  private binop(op: string, a: Value, b: Value, line: number): Value {
    if (a instanceof HostObject && a.protocol.binop) {
      const r = a.protocol.binop(op, b, false, line);
      if (r !== undefined) return r;
    }
    if (b instanceof HostObject && b.protocol.binop) {
      const r = b.protocol.binop(op, a, true, line);
      if (r !== undefined) return r;
    }
    const bothNum = isNumber(a) && isNumber(b);
    if (op === "&" || op === "|") {
      if (typeof a === "boolean" && typeof b === "boolean") return op === "&" ? a && b : a || b;
      if (bothNum && Number.isInteger(num(a)) && Number.isInteger(num(b))) return op === "&" ? num(a) & num(b) : num(a) | num(b);
      throw new PyError(`'${op}' es para combinar True/False (o filtros de pandas); para condiciones normales usa '${op === "&" ? "and" : "or"}'`, line);
    }
    switch (op) {
      case "+":
        if (bothNum) return num(a) + num(b);
        if (typeof a === "string" && typeof b === "string") {
          this.limit((a.length + b.length) / 10, line);
          return a + b;
        }
        if (a instanceof PyList && b instanceof PyList) {
          this.limit(a.items.length + b.items.length, line);
          return new PyList([...a.items, ...b.items]);
        }
        if (a instanceof PyTuple && b instanceof PyTuple) return new PyTuple([...a.items, ...b.items]);
        if (typeof a === "string" || typeof b === "string") {
          throw new PyError(`no se puede sumar ${typeName(a)} y ${typeName(b)}. Usa str(...) para convertir a texto`, line);
        }
        throw new PyError(`no se puede sumar ${typeName(a)} y ${typeName(b)}`, line);
      case "*": {
        if (bothNum) return num(a) * num(b);
        const [seq, times] = isNumber(a) ? [b, a] : [a, b];
        if (isNumber(times) && Number.isInteger(num(times))) {
          const n = Math.max(0, num(times));
          if (typeof seq === "string") {
            this.limit((seq.length * n) / 10, line);
            return seq.repeat(n);
          }
          if (seq instanceof PyList || seq instanceof PyTuple) {
            this.limit(seq.items.length * n, line);
            const out: Value[] = [];
            for (let i = 0; i < n; i++) out.push(...seq.items);
            return seq instanceof PyList ? new PyList(out) : new PyTuple(out);
          }
        }
        throw new PyError(`no se puede multiplicar ${typeName(a)} por ${typeName(b)}`, line);
      }
    }
    if (!bothNum) {
      const verb: Record<string, string> = { "-": "restar", "/": "dividir", "//": "dividir", "%": "sacar módulo de", "**": "elevar" };
      throw new PyError(`no se puede ${verb[op] ?? "operar"} ${typeName(a)} y ${typeName(b)}`, line);
    }
    const x = num(a);
    const y = num(b);
    switch (op) {
      case "-":
        return x - y;
      case "**":
        return x ** y;
    }
    if (y === 0) throw new PyError("división por cero", line);
    switch (op) {
      case "/":
        return x / y;
      case "//":
        return Math.floor(x / y);
      case "%":
        return x - y * Math.floor(x / y);
    }
    throw new PyError(`operador desconocido '${op}'`, line);
  }

  private compare(op: string, a: Value, b: Value, line: number): Value {
    if (a instanceof HostObject && a.protocol.compare && !op.includes("in") && !op.startsWith("is")) {
      const r = a.protocol.compare(op, b, line);
      if (r !== undefined) return r;
    }
    switch (op) {
      case "==": return pyEquals(a, b);
      case "!=": return !pyEquals(a, b);
      case "<": return pyCompare(a, b, line) < 0;
      case ">": return pyCompare(a, b, line) > 0;
      case "<=": return pyCompare(a, b, line) <= 0;
      case ">=": return pyCompare(a, b, line) >= 0;
      case "is": return a === b;
      case "is not": return a !== b;
      case "in": return this.contains(b, a, line);
      case "not in": return !this.contains(b, a, line);
    }
    throw new PyError(`comparación desconocida '${op}'`, line);
  }

  private contains(container: Value, item: Value, line: number): boolean {
    if (typeof container === "string") {
      if (typeof item !== "string") throw new PyError(`'in' con texto necesita texto, no ${typeName(item)}`, line);
      return container.includes(item);
    }
    if (container instanceof PyList || container instanceof PyTuple) return container.items.some((x) => pyEquals(x, item));
    if (container instanceof PyDict) return container.has(item, line);
    if (container instanceof PyRange) {
      if (!isNumber(item)) return false;
      const n = num(item);
      const i = (n - container.start) / container.step;
      return Number.isInteger(i) && i >= 0 && i < container.length;
    }
    throw new PyError(`no se puede usar 'in' con ${typeName(container)}`, line);
  }

  private *callValue(f: Value, args: Value[], kwargs: Record<string, Value>, line: number): Gen<Value> {
    if (f instanceof PyBuiltin) {
      const ctx: CallContext = { line, call: (fn, a) => this.callValue(fn, a, {}, line) as Generator<unknown, Value, unknown> };
      let res;
      try {
        res = f.fn(args, kwargs, ctx);
      } catch (e) {
        if (e instanceof PyError && e.line === 0) e.line = line;
        throw e;
      }
      if (res instanceof Action) {
        if (res.ticks <= 0) return res.complete();
        this.line = line;
        return yield res;
      }
      if (isGenerator(res)) return (yield* res as Gen<Value>) as Value;
      return res;
    }

    if (f instanceof PyFunction) {
      if (this.depth >= this.maxDepth) {
        throw new PyError(`demasiadas llamadas anidadas (máximo ${this.maxDepth}). ¿Recursión infinita?`, line);
      }
      const frame: Frame = { locals: new Map(), fn: f, module: f.module };
      const params = f.params;
      if (args.length > params.length) {
        throw new PyError(`'${f.name}' recibe ${params.length} valor(es) pero le diste ${args.length}`, line);
      }
      params.forEach((p, i) => {
        if (i < args.length) frame.locals.set(p.name, args[i]);
      });
      for (const [k, v] of Object.entries(kwargs)) {
        if (!params.some((p) => p.name === k)) {
          throw new PyError(`'${f.name}' no tiene un parámetro llamado '${k}'`, line);
        }
        if (frame.locals.has(k)) throw new PyError(`'${k}' se pasó dos veces a '${f.name}'`, line);
        frame.locals.set(k, v);
      }
      params.forEach((p, i) => {
        if (frame.locals.has(p.name)) return;
        const d = f.defaults[i];
        if (d === undefined) throw new PyError(`a '${f.name}' le falta el valor de '${p.name}'`, line);
        frame.locals.set(p.name, d);
      });

      const prevFile = this.file;
      this.depth++;
      this.file = f.module.name;
      try {
        yield* this.execBlock(f.body, frame);
        return null;
      } catch (e) {
        if (e instanceof ReturnSignal) return e.value;
        if (e instanceof BreakSignal || e instanceof ContinueSignal) {
          throw new PyError(`'${e instanceof BreakSignal ? "break" : "continue"}' fuera de un bucle`, this.line);
        }
        if (e instanceof PyError && e.file === undefined) {
          if (e.line === 0) e.line = this.line;
          e.file = this.file;
        }
        throw e;
      } finally {
        this.depth--;
        this.file = prevFile;
      }
    }

    throw new PyError(`${typeName(f)} no se puede llamar como función`, line);
  }

  private *importModule(name: string, line: number): Gen<Module> {
    const cached = this.modules.get(name);
    if (cached) return cached;
    const src = this.opts.modules?.[name];
    if (src === undefined) {
      const hint = closest(name, Object.keys(this.opts.modules ?? {}));
      throw new PyError(`el módulo '${name}' no existe${hint ? `. ¿Quisiste decir '${hint}'?` : ""}`, line);
    }
    let program: Program;
    try {
      program = compile(src, this.features);
    } catch (e) {
      if (e instanceof PyError) e.file = name;
      throw e;
    }
    const mod: Module = { name, globals: new Map() };
    this.modules.set(name, mod);
    const prevFile = this.file;
    this.file = name;
    try {
      yield* this.execBlock(program.body, { locals: mod.globals, fn: null, module: mod });
    } catch (e) {
      if (e instanceof PyError && e.file === undefined) {
        if (e.line === 0) e.line = this.line;
        e.file = name;
      }
      throw e;
    } finally {
      this.file = prevFile;
    }
    return mod;
  }

  // ── acceso a datos ──────────────────────────────────────────

  private getAttr(obj: Value, name: string, line: number): Value {
    if (obj instanceof PyModule) {
      if (obj.module.globals.has(name)) return obj.module.globals.get(name)!;
      const hint = closest(name, obj.module.globals.keys());
      throw new PyError(`el módulo '${obj.module.name}' no tiene '${name}'${hint ? `. ¿Quisiste decir '${hint}'?` : ""}`, line);
    }
    if (obj instanceof HostObject) {
      if (Object.hasOwn(obj.attrs, name)) return obj.attrs[name];
      const dyn = obj.protocol.getAttr?.(name, line);
      if (dyn !== undefined) return dyn;
      const hint = closest(name, [...Object.keys(obj.attrs), ...(obj.protocol.attrNames?.() ?? [])]);
      throw new PyError(`${obj.typeName} no tiene '${name}'${hint ? `. ¿Quisiste decir '${hint}'?` : ""}`, line);
    }
    const m = getMethod(obj, name, this.rt);
    if (m) return m;
    const hint = closest(name, methodNames(obj));
    throw new PyError(`${typeName(obj)} no tiene '${name}'${hint ? `. ¿Quisiste decir '${hint}'?` : ""}`, line);
  }

  private seqIndex(len: number, idx: Value, what: string, line: number): number {
    if (!isNumber(idx) || !Number.isInteger(num(idx))) {
      throw new PyError(`los índices deben ser números enteros, no ${typeName(idx)}`, line);
    }
    let i = num(idx);
    if (i < 0) i += len;
    if (i < 0 || i >= len) throw new PyError(`el índice ${num(idx)} está fuera ${what} (tiene ${len} elementos)`, line);
    return i;
  }

  private getIndex(obj: Value, idx: Value, line: number): Value {
    if (obj instanceof HostObject && obj.protocol.getItem) return obj.protocol.getItem(idx, line);
    if (obj instanceof PyList || obj instanceof PyTuple) {
      return obj.items[this.seqIndex(obj.items.length, idx, obj instanceof PyList ? "de la lista" : "de la tupla", line)];
    }
    if (typeof obj === "string") return obj[this.seqIndex(obj.length, idx, "del texto", line)];
    if (obj instanceof PyRange) return obj.at(this.seqIndex(obj.length, idx, "del range", line));
    if (obj instanceof PyDict) {
      const v = obj.get(idx, line);
      if (v === undefined) throw new PyError(`la clave ${pyRepr(idx)} no existe en el diccionario`, line);
      return v;
    }
    throw new PyError(`no se puede usar [] con ${typeName(obj)}`, line);
  }

  private setIndex(obj: Value, idx: Value, v: Value, line: number): void {
    if (obj instanceof HostObject && obj.protocol.setItem) {
      obj.protocol.setItem(idx, v, line);
      return;
    }
    if (obj instanceof PyList) {
      obj.items[this.seqIndex(obj.items.length, idx, "de la lista", line)] = v;
      return;
    }
    if (obj instanceof PyDict) {
      obj.set(idx, v, line);
      this.limit(obj.size, line);
      return;
    }
    throw new PyError(`no se puede cambiar un elemento de ${typeName(obj)}`, line);
  }

  private getSlice(obj: Value, start: Value, stop: Value, line: number): Value {
    const len = typeof obj === "string" ? obj.length : obj instanceof PyList || obj instanceof PyTuple ? obj.items.length : -1;
    if (len < 0) throw new PyError(`no se puede cortar [a:b] ${typeName(obj)}`, line);
    const norm = (v: Value, def: number) => {
      if (v === null) return def;
      if (!isNumber(v) || !Number.isInteger(num(v))) throw new PyError("los límites de [a:b] deben ser enteros", line);
      const n = num(v) < 0 ? num(v) + len : num(v);
      return Math.max(0, Math.min(len, n));
    };
    const s = norm(start, 0);
    const e = norm(stop, len);
    if (typeof obj === "string") return obj.slice(s, e);
    const items = (obj as PyList | PyTuple).items.slice(s, e);
    return obj instanceof PyList ? new PyList(items) : new PyTuple(items);
  }

  private toArray(v: Value, line: number): Value[] {
    if (v instanceof HostObject && v.protocol.iter) return v.protocol.iter();
    if (v instanceof PyList || v instanceof PyTuple) return [...v.items];
    if (typeof v === "string") return [...v];
    if (v instanceof PyDict) return v.keys();
    if (v instanceof PyRange) {
      this.limit(v.length, line);
      return Array.from({ length: v.length }, (_, i) => v.at(i));
    }
    throw new PyError(`no se puede recorrer ${typeName(v)}`, line);
  }

  /** Iterador para for: las listas se recorren "en vivo" y range sin crear la lista. */
  private iterate(v: Value, line: number): Iterator<Value> {
    if (v instanceof PyList) {
      let i = 0;
      return { next: () => (i < v.items.length ? { value: v.items[i++], done: false } : { value: null, done: true }) };
    }
    if (v instanceof PyRange) {
      let i = 0;
      return { next: () => (i < v.length ? { value: v.at(i++), done: false } : { value: null, done: true }) };
    }
    return this.toArray(v, line)[Symbol.iterator]();
  }
}

/** Nombres asignados en el cuerpo de una función (sin entrar a funciones anidadas) y los declarados 'global'. */
function scanLocals(body: Stmt[]): { locals: Set<string>; globals: Set<string> } {
  const locals = new Set<string>();
  const globals = new Set<string>();
  const target = (t: Target) => {
    if (t.kind === "name") locals.add(t.id);
    else if (t.kind === "tuple") t.items.forEach(target);
  };
  const walk = (list: Stmt[]) => {
    for (const s of list) {
      switch (s.kind) {
        case "assign": s.targets.forEach(target); break;
        case "augassign": target(s.target); break;
        case "for": target(s.target); walk(s.body); break;
        case "while": walk(s.body); break;
        case "if": walk(s.body); walk(s.orelse); break;
        case "def": locals.add(s.name); break;
        case "global": s.names.forEach((n) => globals.add(n)); break;
        case "import":
          if (s.names) s.names.forEach((n) => locals.add(n.alias ?? n.name));
          else locals.add(s.alias ?? s.module);
          break;
      }
    }
  };
  walk(body);
  return { locals, globals };
}

/**
 * Formato de f-strings: {x}, {x:.2f}, {x:,}, {x:,.0f}, {x:>8}, {x:05d}, {x:%}.
 * Subconjunto de la mini-sintaxis de Python.
 */
function formatValue(v: Value, spec: string | null, line: number): string {
  if (!spec) return pyStr(v);
  const m = /^([<>^]?)(0?)(\d*)(,?)(?:\.(\d+))?([fd%s]?)$/.exec(spec);
  if (!m) throw new PyError(`formato '${spec}' no soportado en f-string (prueba :.2f o :,)`, line);
  const [, align, zero, widthStr, comma, prec, type] = m;
  let text: string;
  if (type === "s" || (!type && !comma && prec === undefined)) {
    text = pyStr(v);
  } else {
    if (!isNumber(v)) throw new PyError(`el formato '${spec}' es para números, no para ${typeName(v)}`, line);
    let n = num(v);
    if (type === "%") n *= 100;
    const digits = prec !== undefined ? Number(prec) : type === "f" || type === "%" ? 6 : type === "d" ? 0 : undefined;
    if (type === "d" && !Number.isInteger(n)) throw new PyError("el formato 'd' es solo para números enteros", line);
    // redondeo al par como Python: f"{2.5:.0f}" == "2"
    text = digits !== undefined ? pyRound(n, digits).toFixed(digits) : String(n);
    if (comma) {
      const [int, dec] = text.split(".");
      text = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (dec !== undefined ? "." + dec : "");
    }
    if (type === "%") text += "%";
  }
  const width = Number(widthStr || 0);
  if (text.length < width) {
    const pad = width - text.length;
    if (zero && !align) text = (text.startsWith("-") ? "-" : "") + "0".repeat(pad) + text.replace(/^-/, "");
    else if (align === "<") text = text + " ".repeat(pad);
    else if (align === "^") text = " ".repeat(Math.floor(pad / 2)) + text + " ".repeat(Math.ceil(pad / 2));
    else if (align === ">" || isNumber(v)) text = " ".repeat(pad) + text;
    else text = text + " ".repeat(pad);
  }
  return text;
}
