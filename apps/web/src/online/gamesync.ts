/**
 * Sincronización de la tienda en una partida en línea.
 *
 * El anfitrión (el que lleva más tiempo en la sala) corre la simulación, PostgreSQL, las terminales y inventario.py.
 * Varias veces por segundo manda una "vista" del mundo (solo los campos que cambiaron) y los eventos (sonidos,
 * tiquetes...). El otro jugador tiene un mundo "espejo": no lo simula, solo aplica esas vistas. Cuando hace algo
 * (comprar, ejecutar un robot, poner un estante), el espejo lo aplica al tiro para responder rápido y se lo pide al
 * anfitrión, que es quien manda: su próxima vista corrige cualquier diferencia.
 */
import type { GameDB } from "@cdb/db";
import { applyWorld, encodeWorld, eventCount, injectEvents, type SimEvent, truncateEvents, type VmView, type World } from "@cdb/sim";
import type { Collab } from "./collab.js";
import type { Room } from "./room.js";

export type Mode = "local" | "host" | "guest";

/** Estado de la sesión en línea (uno por pestaña). */
export const session = {
  mode: "local" as Mode,
  room: null as Room | null,
  collab: null as Collab | null,
  partida: null as { id: string; nombre: string } | null,
};

export const isGuest = (): boolean => session.mode === "guest";
export const isOnline = (): boolean => session.mode !== "local";

/** Métodos del mundo que cambian algo y puede pedir cualquiera de los dos jugadores. */
export const FORWARD = new Set([
  "runRobot", "stopRobot", "buy", "placeShelf", "placeRegister", "setRegisterActive", "vote", "orderGoods", "order", "hint", "report",
  "installPart", "connectCable", "removePart", "disconnectCable", "powerOn", "openCase", "attach", "renameRobot", "setServerOnline",
]);
/** Métodos que solo corre el anfitrión (el reloj, la noche, el camión...): en el espejo no hacen nada. */
const HOST_ONLY = new Set(["step", "updateNight", "startNight", "openStore", "startServerTutorial", "skipServerTutorial", "deliver"]);

/** Envuelve el mundo: en el modo local y en el anfitrión es el mundo de siempre; en el espejo reenvía las acciones. */
export function wrapWorld(world: World): World {
  return new Proxy(world, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (typeof v !== "function") return v;
      if (session.mode !== "guest" || typeof prop !== "string") return v.bind(target);
      if (HOST_ONLY.has(prop)) return () => undefined;
      if (FORWARD.has(prop)) {
        return (...args: unknown[]) => {
          // se aplica en el espejo para tener la respuesta ya, pero sus eventos se descartan (llegan del anfitrión)
          const n = eventCount(target);
          let result: unknown;
          try {
            result = v.apply(target, args);
          } finally {
            truncateEvents(target, n);
          }
          void session.room?.call("world", { m: prop, a: args }).catch((e: Error) => console.warn(`[en línea] ${prop}:`, e.message));
          return result;
        };
      }
      return v.bind(target);
    },
  });
}

/** Métodos de la base de datos que el espejo le pide al anfitrión (la base solo existe en su navegador). */
const DB_REMOTE = new Set(["run", "tables", "inventoryStatus", "warehouseSource", "resetPlayerSchema", "playerQuery"]);

export function wrapDb(db: GameDB): GameDB {
  return new Proxy(db, {
    get(target, prop) {
      if (session.mode !== "guest") {
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      }
      if (prop === "ready") return true;
      if (typeof prop === "string" && DB_REMOTE.has(prop)) return (...a: unknown[]) => session.room!.call("db", { m: prop, a }, 30000);
      if (prop === "ingest") return () => undefined;
      if (prop === "start" || prop === "flush" || prop === "takeFromWarehouse") return () => Promise.resolve();
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/** La VM de un robot vista desde el espejo: lee lo que manda el anfitrión y le pide pausar, seguir, etc. */
export class RemoteVM {
  status: string;
  line: number;
  file: string;
  pauseReason: string | null;
  busyTicks: number;
  waitingAsync: boolean;
  error: { line: number; file: string | null; format: () => string } | null;
  private readonly vars: VmView["vars"];

  constructor(private readonly robotId: string, view: VmView) {
    this.status = view.status;
    this.line = view.line;
    this.file = view.file;
    this.pauseReason = view.pauseReason;
    this.busyTicks = view.busyTicks;
    this.waitingAsync = view.waitingAsync;
    this.vars = view.vars;
    this.error = view.error ? { line: view.error.line, file: view.error.file, format: () => view.error!.text } : null;
  }

  inspect(): VmView["vars"] {
    return this.vars;
  }

  private op(op: string): void {
    void session.room?.call("vm", { r: this.robotId, op }).catch(() => undefined);
  }

  pause(): void {
    this.op("pause");
  }
  resume(): void {
    this.op("resume");
  }
  step(): void {
    this.op("step");
  }
  stop(): void {
    this.op("stop");
  }
  tick(): string {
    return this.status;
  }
}

/** Eventos que no se le mandan al espejo (la base de datos y el almacén los maneja solo el anfitrión). */
const LOCAL_EVENTS = new Set(["record", "warehouse"]);

/** Lado del anfitrión: manda las vistas y responde lo que pide el otro. */
export class HostSync {
  private readonly last = new Map<string, string>();
  private events: SimEvent[] = [];
  private workbooks = -1;
  private timer = 0;

  constructor(private readonly room: Room, private readonly world: World, private readonly meta: () => Record<string, unknown>) {
    room.on("need-full", () => this.reset());
    this.timer = window.setInterval(() => this.tick(), 140);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** La próxima vista va completa (alguien acaba de entrar). */
  reset(): void {
    this.last.clear();
    this.workbooks = -1;
  }

  queue(events: SimEvent[]): void {
    for (const e of events) if (!LOCAL_EVENTS.has(e.type)) this.events.push(e);
  }

  private tick(): void {
    if (this.room.peers.length < 2) {
      this.events = [];
      return;
    }
    const enc = encodeWorld(this.world, { vmView: true, consoleTail: 40 });
    if (this.world.workbooks.length !== this.workbooks) {
      this.workbooks = this.world.workbooks.length;
      enc.workbooks = encodeWorld(this.world, { workbooks: true }).workbooks;
    }
    enc.$meta = JSON.parse(JSON.stringify(this.meta()));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(enc)) {
      const s = JSON.stringify(v);
      if (this.last.get(k) === s) continue;
      this.last.set(k, s);
      out[k] = v;
    }
    if (!Object.keys(out).length && !this.events.length) return;
    this.room.send("view", { d: out, ev: this.events });
    this.events = [];
  }
}

/** Lado del espejo: aplica las vistas del anfitrión. */
export class GuestSync {
  /** Cuándo llegó la última vista (para interpolar el movimiento). */
  lastViewAt = performance.now();
  gotFirst = false;
  private readonly firstView: Promise<void>;

  constructor(room: Room, world: World, onMeta: (meta: Record<string, unknown>) => void) {
    let first!: () => void;
    this.firstView = new Promise((r) => (first = r));
    room.on("view", (p: { d: Record<string, unknown>; ev: SimEvent[] }) => {
      const { $meta, ...data } = p.d;
      applyWorld(world, data as Parameters<typeof applyWorld>[1], (robot, view) => (view ? (new RemoteVM(robot.id, view) as unknown as typeof robot.vm) : null));
      if (p.ev.length) injectEvents(world, p.ev);
      if ($meta) onMeta($meta as Record<string, unknown>);
      this.lastViewAt = performance.now();
      if (!this.gotFirst && "robots" in data && "tiles" in data) {
        this.gotFirst = true;
        first();
      }
    });
    room.send("need-full", null, room.hostId);
  }

  /** Espera la primera vista completa del anfitrión. */
  ready(timeoutMs = 15000): Promise<boolean> {
    return Promise.race([this.firstView.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs))]);
  }
}
