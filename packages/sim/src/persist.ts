/**
 * Guardar y cargar el mundo (partidas en línea) y el "espejo" que ve el segundo jugador.
 *
 * El mundo es un objeto grande con Sets, Maps, el sistema de archivos de cada servidor (VFS), el generador
 * aleatorio y referencias entre clientes y cajas. Aquí se pasa a JSON y de vuelta, sin las VM de los robots
 * (al cargar una partida los robots quedan detenidos; el espejo recibe una "vista" de cada VM).
 */
import type { VariableInfo } from "@cdb/interpreter";
import { Rng } from "./rng.js";
import { VFS } from "./shell/vfs.js";
import type { Customer, Register, Robot, SimEvent, World } from "./world.js";

/** Lo que el segundo jugador necesita saber de la VM de un robot (para su ventana de código). */
export interface VmView {
  status: string;
  line: number;
  file: string;
  pauseReason: string | null;
  busyTicks: number;
  waitingAsync: boolean;
  error: { line: number; file: string | null; text: string } | null;
  vars: VariableInfo[];
}

export interface EncodeOptions {
  /** Incluir el disco de los servidores (para guardar; el espejo no lo necesita). */
  vfs?: boolean;
  /** Incluir las hojas de cálculo (pandas). */
  workbooks?: boolean;
  /** Incluir los tiquetes guardados. */
  tickets?: boolean;
  /** Cuántas líneas de consola de cada robot (por defecto todas). */
  consoleTail?: number;
  /** Mandar la vista de cada VM (espejo). Sin esto, los robots quedan sin programa. */
  vmView?: boolean;
}

/** Campos del mundo que no se guardan (se reconstruyen o son de la sesión). */
const SKIP = new Set(["rng", "security", "libs", "events", "sql", "register"]);

// ── codificación genérica ───────────────────────────────────────

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function encode(v: unknown, o: EncodeOptions): Json {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : { $num: String(v) };
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "function") return null;
  if (Array.isArray(v)) return v.map((x) => encode(x, o));
  if (v instanceof Set) return { $set: [...v].map((x) => encode(x, o)) };
  if (v instanceof Map) return { $map: [...v].map(([k, x]) => [encode(k, o), encode(x, o)]) };
  if (v instanceof VFS) return { $vfs: o.vfs ? encode((v as unknown as { nodes: Map<string, unknown> }).nodes, o) : null };
  if (v instanceof Rng) return { $rng: (v as unknown as { state: number }).state };
  if (typeof v === "object") {
    const out: Record<string, Json> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (typeof x === "function") continue;
      out[k] = encode(x, o);
    }
    return out;
  }
  return null;
}

function decode(v: Json): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(decode);
  if ("$num" in v) return Number(v.$num);
  if ("$set" in v) return new Set((v.$set as Json[]).map(decode));
  if ("$map" in v) return new Map((v.$map as [Json, Json][]).map(([k, x]) => [decode(k), decode(x)]));
  if ("$vfs" in v) {
    const fs = new VFS();
    if (v.$vfs) (fs as unknown as { nodes: Map<string, unknown> }).nodes = decode(v.$vfs) as Map<string, unknown>;
    return fs;
  }
  if ("$rng" in v) {
    const r = new Rng(0);
    (r as unknown as { state: number }).state = v.$rng as number;
    return r;
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = decode(x);
  return out;
}

// ── el mundo ────────────────────────────────────────────────────

function vmView(robot: Robot): VmView | null {
  const vm = robot.vm;
  if (!vm) return null;
  const alive = vm.status === "running" || vm.status === "waiting" || vm.status === "paused";
  const err = vm.error;
  return {
    status: vm.status,
    line: vm.line,
    file: vm.file,
    pauseReason: vm.pauseReason ?? null,
    busyTicks: vm.busyTicks,
    waitingAsync: vm.waitingAsync,
    error: err ? { line: err.line, file: err.file ?? null, text: err.format() } : null,
    vars: alive ? vm.inspect() : [],
  };
}

/** El mundo como JSON (un objeto por campo de nivel superior: así se pueden mandar solo los que cambiaron). */
export function encodeWorld(world: World, o: EncodeOptions = {}): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [key, value] of Object.entries(world)) {
    if (SKIP.has(key)) continue;
    if (key === "workbooks" && !o.workbooks) continue;
    if (key === "tickets" && !o.tickets) continue;
    if (key === "robots") {
      out.robots = (value as Robot[]).map((r) => {
        const { vm: _vm, console: log, ...rest } = r;
        const enc = encode(rest, o) as Record<string, Json>;
        enc.console = encode(o.consoleTail ? log.slice(-o.consoleTail) : log, o);
        enc.vm = o.vmView ? (encode(vmView(r), o) as Json) : null;
        return enc;
      });
      continue;
    }
    if (key === "customers") {
      out.customers = (value as Customer[]).map((c) => encode({ ...c, register: c.register?.id ?? null }, o));
      continue;
    }
    if (key === "registers") {
      out.registers = (value as Register[]).map((r) => encode({ ...r, queue: r.queue.map((c) => c.id) }, o));
      continue;
    }
    out[key] = encode(value, o);
  }
  out.$rng = encode(world.rng, o);
  const { rng: secRng, ...sec } = world.security as unknown as Record<string, unknown>;
  out.$security = encode({ ...sec, rngState: encode(secRng, o) }, o);
  return out;
}

/** Reemplaza el contenido de un arreglo, Set, Map u objeto sin cambiar la referencia (otros lo tienen guardado). */
function assignInPlace(target: unknown, value: unknown): boolean {
  if (Array.isArray(target) && Array.isArray(value)) {
    target.splice(0, target.length, ...value);
    return true;
  }
  if (target instanceof Set && value instanceof Set) {
    target.clear();
    for (const x of value) target.add(x);
    return true;
  }
  if (target instanceof Map && value instanceof Map) {
    target.clear();
    for (const [k, x] of value) target.set(k, x);
    return true;
  }
  return false;
}

/**
 * Carga en `world` lo que salió de `encodeWorld` (completo o solo algunos campos).
 * `vm(robot, view)` arma lo que va en robot.vm (en el espejo, una VM remota); por defecto queda en null.
 */
export function applyWorld(world: World, data: Record<string, Json>, vm?: (robot: Robot, view: VmView | null) => Robot["vm"]): void {
  const w = world as unknown as Record<string, unknown>;
  for (const [key, raw] of Object.entries(data)) {
    if (key === "$rng") {
      (world.rng as unknown as { state: number }).state = (raw as { $rng: number }).$rng;
      continue;
    }
    if (key === "$security") {
      const sec = decode(raw) as Record<string, unknown>;
      const rngState = (sec.rngState as { state?: number } | undefined)?.state;
      delete sec.rngState;
      const target = world.security as unknown as Record<string, unknown>;
      for (const [k, x] of Object.entries(sec)) if (!assignInPlace(target[k], x)) target[k] = x;
      if (rngState !== undefined) (world.security.rng as unknown as { state: number }).state = rngState;
      continue;
    }
    if (key === "robots") {
      const robots = (raw as Json[]).map((r) => {
        const rec = r as Record<string, Json>;
        const robot = decode({ ...rec, vm: null }) as Robot;
        robot.vm = vm ? vm(robot, rec.vm ? (decode(rec.vm) as VmView) : null) : null;
        return robot;
      });
      world.robots.splice(0, world.robots.length, ...robots);
      continue;
    }
    if (SKIP.has(key)) continue;
    const value = decode(raw);
    if (assignInPlace(w[key], value)) continue;
    // objetos de valores (warehouseStock): se reemplazan sus claves
    if (key === "warehouseStock" && w[key] && typeof value === "object") {
      Object.assign(w[key] as object, value);
      continue;
    }
    w[key] = value;
  }
  // referencias: la caja de cada cliente y los clientes de cada fila
  if ("registers" in data || "customers" in data) {
    const byId = new Map(world.customers.map((c) => [c.id, c]));
    for (const r of world.registers) r.queue = (r.queue as unknown as number[]).map((id) => (typeof id === "number" ? byId.get(id) : (id as Customer))).filter((c): c is Customer => !!c);
    const regs = new Map(world.registers.map((r) => [r.id, r]));
    for (const c of world.customers) {
      const id = c.register as unknown as number | Register | null;
      c.register = typeof id === "number" ? (regs.get(id) ?? null) : id;
    }
    (world as unknown as { register: Register }).register = world.registers[0];
  }
}

/** Mete eventos de afuera en la cola del mundo (el espejo los recibe del anfitrión). */
export function injectEvents(world: World, events: SimEvent[]): void {
  (world as unknown as { events: SimEvent[] }).events.push(...events);
}

/** Cuántos eventos hay en la cola (para descartar los que produce una acción optimista en el espejo). */
export function eventCount(world: World): number {
  return (world as unknown as { events: SimEvent[] }).events.length;
}

export function truncateEvents(world: World, n: number): void {
  (world as unknown as { events: SimEvent[] }).events.length = n;
}
