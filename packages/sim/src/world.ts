import { type Feature, type HostObject, type Value, VM } from "@cdb/interpreter";
import { makeApi } from "./api.js";
import {
  BILLS,
  CPU_OPS,
  CUSTOMER,
  KIOSCO_MAP,
  DAY,
  NIGHT,
  type PlayerId,
  PRODUCTS,
  type ProductName,
  REPUTATION,
  SHELF_CAPACITY,
  START_FEATURES,
  START_MONEY,
  TICKS_PER_SECOND,
  UNLOCKS,
  WAREHOUSE_START,
  gameTime,
} from "./config.js";
import { DELIVERY } from "./delivery.js";
import { makePandas } from "./pandas.js";
import { Rng } from "./rng.js";
import { makeDbConnection, type SqlAdapter } from "./sqlapi.js";

export interface Pos {
  x: number;
  y: number;
}

export type TileKind = "floor" | "warehouse" | "shelf" | "register" | "entrance";

export interface Shelf extends Pos {
  /** null = estante libre: el primer producto que se ponga lo define (y se queda así). */
  product: ProductName | null;
  stock: number;
  capacity: number;
}

export interface ConsoleLine {
  kind: "print" | "error" | "warn" | "info";
  text: string;
  tick: number;
}

export interface Robot extends Pos {
  id: string;
  name: string;
  color: "cian" | "naranja";
  cargo: { product: ProductName | null; n: number };
  source: string;
  vm: VM | null;
  console: ConsoleLine[];
  /** Movimiento en curso (para que el render interpole). */
  moving: { from: Pos; to: Pos; startTick: number; ticks: number } | null;
  /** Lo que está haciendo ahora, para mostrarlo sobre el robot ("➡ East", "💵 cobrando $6.500"). */
  action: string | null;
  /** Líneas con punto de parada (las edita la UI; la VM las lee en vivo). */
  breakpoints: Set<number>;
}

export type SoundName =
  | "door" | "scan" | "cash" | "coins" | "angry" | "missing" | "error" | "pick" | "place" | "unlock" | "paused" | "open" | "close";

export type Mood = "feliz" | "neutral" | "enojado";

export interface Customer extends Pos {
  id: number;
  list: ProductName[];
  listIndex: number;
  cart: ProductName[];
  state: "shopping" | "queue" | "leaving";
  /** En el primer puesto de la cola, listo para que el cajero lo atienda. */
  atRegister: boolean;
  patience: number;
  mood: Mood | null;
  stepCooldown: number;
  /** Ticks que le faltan mirando el estante donde está parado. */
  browse: number;
  checkout: { scanned: number; charged: number | null; paid: number | null; change: number | null; done: boolean };
}

export type TicketResult = "ok" | "cobro_de_mas" | "cobro_de_menos" | "sin_cobrar";

export interface Ticket {
  tick: number;
  customerId: number;
  items: { product: ProductName; price: number }[];
  total: number;
  charged: number | null;
  paid: number;
  change: number;
  result: TicketResult;
}

export type SimEvent =
  | { type: "float"; x: number; y: number; text: string; tone: "good" | "bad" | "info" }
  | { type: "ticket"; ticket: Ticket }
  | { type: "robot"; robotId: string; status: string }
  | { type: "sound"; name: SoundName; x?: number; y?: number }
  | { type: "record"; record: DbRecord }
  | { type: "night"; votes: PlayerId[]; remainingMs: number }
  | { type: "closed"; summary: DaySummary }
  /** Un robot sacó mercancía del almacén (la web lo descuenta de la base de datos del jugador). */
  | { type: "warehouse"; product: ProductName; quantity: number }
  | { type: "opened"; reason: "votos" | "tiempo"; day: number };

/** Lo que pasa en la tienda, para guardarlo en la base de datos. `at` es la hora del juego (ISO). */
export type DbRecord =
  | { kind: "customer_arrived"; customerId: number; at: string; wanted: ProductName[] }
  | { kind: "customer_left"; customerId: number; at: string; outcome: "compró" | "se fue sin comprar" | "abandonó la fila"; mood: Mood | null }
  | {
      kind: "sale"; customerId: number; at: string; cashier: string; total: number; charged: number | null;
      paid: number; change: number; result: TicketResult; items: { product: ProductName; price: number }[];
    }
  | { kind: "stockout"; customerId: number; at: string; product: ProductName }
  | { kind: "purchase"; at: string; robot: string; product: ProductName; quantity: number; unitCost: number }
  | { kind: "restock"; at: string; robot: string; product: ProductName; quantity: number };

const MAX_CONSOLE = 200;
const MAX_CUSTOMERS = 8;

/** La noche: tienda cerrada, cuenta regresiva y votos para abrir antes. */
export interface NightState {
  remainingMs: number;
  totalMs: number;
  votes: Set<PlayerId>;
}

/** Cómo le fue a la tienda en un día. */
export interface DaySummary {
  day: number;
  /** Ventas cobradas (cualquier resultado). */
  sales: number;
  /** Lo que entró a la caja ese día. */
  revenue: number;
  /** Ventas con las cuentas claras. */
  ok: number;
  /** Clientes que se fueron sin comprar o abandonaron la fila. */
  lost: number;
}

/** Hora del juego: día, si es de día o de noche, y la hora (7.5 = 7:30). */
export interface Clock {
  day: number;
  phase: "day" | "night";
  hour: number;
}

/** Clave de una pared entre dos casillas vecinas (en cualquier orden). */
const edgeKey = (a: Pos, b: Pos) => (a.x < b.x || (a.x === b.x && a.y < b.y) ? `${a.x},${a.y}|${b.x},${b.y}` : `${b.x},${b.y}|${a.x},${a.y}`);

export class World {
  tick = 0;
  money = START_MONEY;
  reputation = REPUTATION.start;
  readonly width: number;
  readonly height: number;
  readonly tiles: TileKind[][]; // tiles[y][x]
  /** Casilla del almacén junto a la puerta (la constante WAREHOUSE de los robots). */
  readonly warehouse: Pos;
  /** Paredes entre casillas (el robot no puede cruzarlas). */
  readonly walls = new Set<string>();
  /** Unidades de cada producto guardadas en el almacén (la entrega del distribuidor). */
  readonly warehouseStock: Record<ProductName, number> = { ...WAREHOUSE_START };
  readonly register: Pos;
  readonly entrance: Pos;
  readonly shelves: Shelf[] = [];
  readonly robots: Robot[] = [];
  customers: Customer[] = [];
  queue: Customer[] = [];
  readonly tickets: Ticket[] = [];
  readonly unlocked = new Set<string>();
  readonly features = new Set<Feature>(START_FEATURES);
  cpuLevel = 0;
  sharedSource = "";
  /** false = no llegan clientes (tutorial, preparación y tests). */
  customersEnabled = true;
  /** Tick en que abrió la tienda (el primer cliente llega unos segundos después). */
  openedTick = 0;
  /** Día actual (1, 2, 3...). La noche pertenece al día que viene. */
  day = 1;
  /** Noche en curso (null = es de día, o el ciclo no ha empezado). */
  night: NightState | null = null;
  /** ¿Corre el ciclo de día y noche? (en los tests de la simulación sola, no: la tienda está siempre abierta). */
  cycle = false;
  /** Tick en que amaneció el día actual. */
  dayStartTick = 0;
  /** Cómo va el día actual. */
  today: DaySummary = { day: 1, sales: 0, revenue: 0, ok: 0, lost: 0 };
  /** Resumen del último día que terminó. */
  lastDay: DaySummary | null = null;
  /** Base de datos del jugador (la conecta la web o los tests). */
  sql?: SqlAdapter;
  private libs: { db: HostObject; pandas: HostObject } | null = null;
  /** Ingresos recientes para calcular $/min. */
  private incomes: { tick: number; amount: number }[] = [];
  private events: SimEvent[] = [];
  private nextCustomerId = 1;
  readonly rng: Rng;

  constructor(seed = 1, map: string[] = KIOSCO_MAP) {
    this.rng = new Rng(seed);
    this.height = map.length;
    this.width = map[0].replace(/[|:]/g, "").length;
    this.tiles = Array.from({ length: this.height }, () => Array<TileKind>(this.width).fill("floor"));
    let door: Pos | null = null;
    let register: Pos | null = null;
    let entrance: Pos | null = null;
    map.forEach((row, r) => {
      const y = this.height - 1 - r; // la primera fila del texto es el norte
      let x = 0;
      for (const ch of row) {
        // | y : van entre dos casillas: pared o puerta entre (x - 1, y) y (x, y)
        if (ch === "|") { this.walls.add(edgeKey({ x: x - 1, y }, { x, y })); continue; }
        if (ch === ":") { door = { x: x - 1, y }; continue; }
        if (ch === "A") this.tiles[y][x] = "warehouse";
        else if (ch === "C") { this.tiles[y][x] = "register"; register = { x, y }; }
        else if (ch === "E") { this.tiles[y][x] = "entrance"; entrance = { x, y }; }
        else if (ch === "S") {
          this.tiles[y][x] = "shelf";
          this.shelves.push({ x, y, product: null, stock: 0, capacity: SHELF_CAPACITY });
        }
        x++;
      }
    });
    // sin puerta marcada, WAREHOUSE es la primera casilla de almacén que aparece
    const firstWarehouse = (): Pos | null => {
      for (let y = this.height - 1; y >= 0; y--) for (let x = 0; x < this.width; x++) if (this.tiles[y][x] === "warehouse") return { x, y };
      return null;
    };
    const warehouse = door ?? firstWarehouse();
    if (!warehouse || !register || !entrance) throw new Error("el mapa necesita A, C y E");
    this.warehouse = warehouse;
    this.register = register;
    this.entrance = entrance;

    this.addRobot("tono", "Toño", "cian", this.warehouse);
    this.addRobot("lupe", "Lupe", "naranja", this.register);
  }

  private addRobot(id: string, name: string, color: Robot["color"], at: Pos): void {
    this.robots.push({
      id, name, color, x: at.x, y: at.y, cargo: { product: null, n: 0 }, source: "", vm: null, console: [], moving: null,
      action: null, breakpoints: new Set(),
    });
  }

  // ── consultas ────────────────────────────────────────────────

  robot(id: string): Robot {
    const r = this.robots.find((x) => x.id === id);
    if (!r) throw new Error(`robot desconocido: ${id}`);
    return r;
  }

  tileAt(x: number, y: number): TileKind | null {
    return x >= 0 && y >= 0 && x < this.width && y < this.height ? this.tiles[y][x] : null;
  }

  shelfAt(x: number, y: number): Shelf | undefined {
    return this.shelves.find((s) => s.x === x && s.y === y);
  }

  /** ¿Hay una pared entre dos casillas vecinas? */
  wallBetween(a: Pos, b: Pos): boolean {
    return this.walls.has(edgeKey(a, b));
  }

  /** ¿La casilla es parte del cuarto del almacén? */
  inWarehouse(x: number, y: number): boolean {
    return this.tileAt(x, y) === "warehouse";
  }

  /** Estante más cercano a `from` que tenga ese producto (si alguno tiene stock, ese). */
  shelfFor(product: ProductName, from?: Pos): Shelf | undefined {
    const mine = this.shelves.filter((s) => s.product === product);
    const pool = mine.some((s) => s.stock > 0) ? mine.filter((s) => s.stock > 0) : mine;
    const d = (s: Shelf) => (from ? Math.abs(s.x - from.x) + Math.abs(s.y - from.y) : 0);
    return pool.reduce<Shelf | undefined>((best, s) => (!best || d(s) < d(best) ? s : best), undefined);
  }

  /** Unidades de un producto en los estantes (sumando todos los suyos). */
  shelfStock(product: ProductName): number {
    return this.shelves.reduce((n, s) => n + (s.product === product ? s.stock : 0), 0);
  }

  /** ¿Hay un robot en (x, y) o yendo hacia allá? */
  occupied(x: number, y: number, except?: Robot): boolean {
    return this.robots.some((r) => r !== except && ((r.x === x && r.y === y) || (r.moving && r.moving.to.x === x && r.moving.to.y === y)));
  }

  /** Cliente que el cajero puede atender ahora (si el robot está en la caja). */
  customerAtRegister(robot: Robot): Customer | null {
    if (robot.x !== this.register.x || robot.y !== this.register.y) return null;
    const c = this.queue[0];
    return c && c.atRegister ? c : null;
  }

  moneyPerMinute(): number {
    const since = this.tick - 60 * TICKS_PER_SECOND;
    return this.incomes.filter((i) => i.tick > since).reduce((s, i) => s + i.amount, 0);
  }

  /** Tiene un programa vivo (corriendo, ocupado en una acción o pausado por el depurador). */
  isRunning(id: string): boolean {
    const vm = this.robot(id).vm;
    return !!vm && (vm.status === "running" || vm.status === "waiting" || vm.status === "paused");
  }

  record(record: DbRecord): void {
    this.events.push({ type: "record", record });
  }

  /** Hora del juego. De día va de 7:00 a 19:00 en DAY.ticks; de noche, de 19:00 a 7:00 según el tiempo real. */
  get clock(): Clock {
    if (this.night) {
      const k = 1 - this.night.remainingMs / this.night.totalMs;
      return { day: this.day, phase: "night", hour: (DAY.closesAt + k * (24 - DAY.closesAt + DAY.opensAt)) % 24 };
    }
    const span = DAY.closesAt - DAY.opensAt;
    return { day: this.day, phase: "day", hour: DAY.opensAt + ((this.tick - this.dayStartTick) / DAY.ticks) * span };
  }

  /** Ticks que le quedan al día (Infinity si no hay ciclo o es de noche). */
  get dayTicksLeft(): number {
    if (!this.cycle || this.night) return Infinity;
    return Math.max(0, DAY.ticks - (this.tick - this.dayStartTick));
  }

  get now(): string {
    const c = this.clock;
    // la noche empieza a las 19:00 del día anterior y termina a las 7:00 del día que viene
    if (c.phase === "night") return gameTime(this.day - 1, c.hour < DAY.opensAt ? c.hour + 24 : c.hour);
    return gameTime(this.day, c.hour);
  }

  sound(name: SoundName, at?: Pos): void {
    this.events.push({ type: "sound", name, x: at?.x, y: at?.y });
  }

  /** Se sacaron unidades del almacén. */
  takeFromWarehouse(product: ProductName, quantity: number): void {
    this.warehouseStock[product] -= quantity;
    this.events.push({ type: "warehouse", product, quantity });
  }

  drainEvents(): SimEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  /** `db` (estilo asyncpg) y `pandas`, compartidos por los robots y los scripts. */
  libraries(): { globals: Record<string, Value>; nativeModules: Record<string, Value> } {
    this.libs ??= {
      db: makeDbConnection(() => this.sql),
      pandas: makePandas([DELIVERY], () => this.sql),
    };
    return { globals: { db: this.libs.db }, nativeModules: { pandas: this.libs.pandas } };
  }

  // ── acciones del jugador (UI) ────────────────────────────────

  setScript(robotId: string, source: string): void {
    this.robot(robotId).source = source;
  }

  runRobot(robotId: string): void {
    const robot = this.robot(robotId);
    this.stopRobot(robotId, true);
    const libs = this.libraries();
    robot.vm = new VM(robot.source, {
      globals: { ...libs.globals, ...makeApi(this, robot) },
      nativeModules: libs.nativeModules,
      modules: { shared: this.sharedSource },
      features: this.features,
      opsPerTick: CPU_OPS[this.cpuLevel],
      breakpoints: robot.breakpoints,
      onPrint: (text) => this.log(robot, "print", text),
    });
    if (robot.vm.status === "error") this.reportError(robot);
    else this.log(robot, "info", "▶ Ejecutando");
  }

  stopRobot(robotId: string, silent = false): void {
    const robot = this.robot(robotId);
    if (robot.vm && (robot.vm.status === "running" || robot.vm.status === "waiting" || robot.vm.status === "paused")) {
      robot.vm.stop();
      if (!silent) this.log(robot, "info", "■ Detenido");
    }
    robot.moving = null; // el movimiento a medias se cancela: queda en su casilla
    robot.action = null;
  }

  // ── noche, día y apertura ────────────────────────────────────

  /** Empieza la noche: la tienda cierra y no llegan clientes hasta que voten todos o amanezca. */
  startNight(ms: number = NIGHT.ms): void {
    this.cycle = true;
    this.customersEnabled = false;
    this.night = { remainingMs: ms, totalMs: ms, votes: new Set() };
    this.emitNight();
  }

  /** Un jugador vota (o retira su voto) para abrir ya. Cuando votan todos, abre. */
  vote(player: PlayerId, ready = true): void {
    if (!this.night) return;
    if (ready) this.night.votes.add(player);
    else this.night.votes.delete(player);
    this.emitNight();
    if (NIGHT.players.every((p) => this.night!.votes.has(p))) this.openStore("votos");
  }

  /** Descuenta tiempo real de la noche (lo llama quien maneja el reloj: la web o el servidor). */
  updateNight(realMs: number): void {
    if (!this.night) return;
    this.night.remainingMs = Math.max(0, this.night.remainingMs - realMs);
    if (this.night.remainingMs === 0) this.openStore("tiempo");
  }

  /** Amanece y abre la tienda: empiezan a llegar clientes. */
  openStore(reason: "votos" | "tiempo" = "votos"): void {
    const wasNight = this.night !== null;
    this.night = null;
    this.cycle = true;
    this.customersEnabled = true;
    this.openedTick = this.tick;
    this.dayStartTick = this.tick;
    this.today = { day: this.day, sales: 0, revenue: 0, ok: 0, lost: 0 };
    if (wasNight) {
      this.events.push({ type: "opened", reason, day: this.day });
      this.sound("open");
    }
  }

  /** A las 19:00 la tienda cierra: no entran más clientes (los de adentro terminan) y empieza la noche. */
  private closeStore(): void {
    this.lastDay = { ...this.today };
    this.events.push({ type: "closed", summary: this.lastDay });
    this.sound("close");
    this.day++;
    this.startNight();
  }

  private emitNight(): void {
    if (this.night) this.events.push({ type: "night", votes: [...this.night.votes], remainingMs: this.night.remainingMs });
  }

  buy(unlockId: string): { ok: true } | { ok: false; reason: string } {
    const def = UNLOCKS.find((u) => u.id === unlockId);
    if (!def) return { ok: false, reason: "no existe" };
    if (this.unlocked.has(def.id)) return { ok: false, reason: "ya lo tienes" };
    if (def.requires && !this.unlocked.has(def.requires)) return { ok: false, reason: "primero desbloquea el anterior" };
    if (this.money < def.cost) return { ok: false, reason: "no alcanza el dinero" };
    this.money -= def.cost;
    this.unlocked.add(def.id);
    if (def.feature) this.features.add(def.feature);
    this.sound("unlock");
    if (def.cpuLevel !== undefined) {
      this.cpuLevel = Math.max(this.cpuLevel, def.cpuLevel);
      for (const r of this.robots) if (r.vm) r.vm.opsPerTick = CPU_OPS[this.cpuLevel];
    }
    return { ok: true };
  }

  // ── simulación ───────────────────────────────────────────────

  step(): void {
    this.tick++;
    for (const robot of this.robots) {
      const vm = robot.vm;
      if (!vm || (vm.status !== "running" && vm.status !== "waiting")) continue;
      const status = vm.tick();
      if (status !== "waiting") robot.action = null;
      if (status === "paused") {
        this.events.push({ type: "robot", robotId: robot.id, status });
        this.sound("paused");
      } else if (status === "error") this.reportError(robot);
      else if (status === "done") {
        this.log(robot, "info", "✓ El script terminó");
        this.events.push({ type: "robot", robotId: robot.id, status });
      }
    }
    this.updateCustomers();
    this.spawnCustomers();
    if (this.cycle && !this.night && this.tick - this.dayStartTick >= DAY.ticks) this.closeStore();
    if (this.incomes.length > 500) this.incomes = this.incomes.filter((i) => i.tick > this.tick - 600);
  }

  private reportError(robot: Robot): void {
    const err = robot.vm?.error;
    if (!err) return;
    this.log(robot, "error", err.format());
    this.events.push({ type: "float", x: robot.x, y: robot.y, text: "¡error!", tone: "bad" });
    this.events.push({ type: "robot", robotId: robot.id, status: "error" });
    this.sound("error", robot);
    robot.moving = null;
    robot.action = null;
  }

  log(robot: Robot, kind: ConsoleLine["kind"], text: string): void {
    robot.console.push({ kind, text, tick: this.tick });
    if (robot.console.length > MAX_CONSOLE) robot.console.splice(0, robot.console.length - MAX_CONSOLE);
  }

  float(at: Pos, text: string, tone: "good" | "bad" | "info"): void {
    this.events.push({ type: "float", x: at.x, y: at.y, text, tone });
  }

  addReputation(delta: number, at?: Pos): void {
    this.reputation = Math.max(0, Math.min(100, this.reputation + delta));
    if (at && delta !== 0) this.float(at, `${delta > 0 ? "+" : ""}${delta} rep`, delta > 0 ? "good" : "bad");
  }

  earn(amount: number, at?: Pos): void {
    this.money = Math.max(0, this.money + amount);
    if (amount > 0) this.incomes.push({ tick: this.tick, amount });
    if (at && amount !== 0) {
      this.float(at, `${amount > 0 ? "+" : "-"}$${Math.abs(Math.round(amount)).toLocaleString("es-CO")}`, amount > 0 ? "good" : "bad");
    }
  }

  private spawnCustomers(): void {
    if (!this.customersEnabled || this.customers.length >= MAX_CUSTOMERS) return;
    // cada día llegan más clientes (es como un nivel nuevo)
    const perMinute = CUSTOMER.basePerMinute * (0.2 + this.reputation / 62.5) * (1 + DAY.customerGrowth * (this.day - 1));
    const first = this.nextCustomerId === 1 && this.tick >= this.openedTick + CUSTOMER.firstArrivalTick;
    if (this.nextCustomerId === 1 && !first) return;
    if (!first && this.rng.next() >= perMinute / (60 * TICKS_PER_SECOND)) return;
    const products = Object.keys(PRODUCTS) as ProductName[];
    const n = this.rng.int(CUSTOMER.itemsMin, CUSTOMER.itemsMax);
    const list = Array.from({ length: n }, () => this.rng.pick(products));
    this.sound("door", this.entrance);
    this.record({ kind: "customer_arrived", customerId: this.nextCustomerId, at: this.now, wanted: list });
    this.customers.push({
      id: this.nextCustomerId++,
      x: this.entrance.x,
      y: this.entrance.y,
      list,
      listIndex: 0,
      cart: [],
      state: "shopping",
      atRegister: false,
      patience: CUSTOMER.patienceTicks,
      mood: null,
      stepCooldown: CUSTOMER.ticksPerStep,
      browse: CUSTOMER.browseTicks,
      checkout: { scanned: 0, charged: null, paid: null, change: null, done: false },
    });
  }

  private customerTarget(c: Customer): Pos {
    if (c.state === "shopping") {
      // si ningún estante tiene lo que busca, igual entra a buscarlo en alguno (no se devuelve desde la puerta)
      const shelf = this.shelfFor(c.list[c.listIndex], c) ?? this.shelves[(c.id + c.listIndex) % this.shelves.length];
      return shelf ?? this.entrance;
    }
    if (c.state === "queue") {
      const i = this.queue.indexOf(c);
      return { x: Math.min(this.width - 1, this.register.x + 1 + i), y: this.register.y };
    }
    return this.entrance;
  }

  private updateCustomers(): void {
    for (const c of [...this.customers]) {
      const target = this.customerTarget(c);
      const arrived = c.x === target.x && c.y === target.y;

      if (!arrived) {
        c.atRegister = false;
        if (--c.stepCooldown <= 0) {
          c.stepCooldown = CUSTOMER.ticksPerStep;
          if (c.x !== target.x) c.x += Math.sign(target.x - c.x);
          else c.y += Math.sign(target.y - c.y);
        }
      } else if (c.state === "shopping" && c.browse > 0) {
        c.browse--; // mira el estante un momento
      } else if (c.state === "shopping") {
        c.browse = CUSTOMER.browseTicks;
        const product = c.list[c.listIndex];
        const shelf = this.shelfAt(c.x, c.y);
        if (shelf && shelf.product === product && shelf.stock > 0) {
          shelf.stock--;
          c.cart.push(product);
        } else {
          this.float(c, `¿No hay ${product}?`, "bad");
          this.sound("missing", c);
          this.record({ kind: "stockout", customerId: c.id, at: this.now, product });
          this.addReputation(REPUTATION.missingProduct);
        }
        c.listIndex++;
        if (c.listIndex >= c.list.length) {
          if (c.cart.length === 0) {
            c.state = "leaving";
            c.mood = "enojado";
            this.record({ kind: "customer_left", customerId: c.id, at: this.now, outcome: "se fue sin comprar", mood: c.mood });
            this.today.lost++;
          } else {
            c.state = "queue";
            this.queue.push(c);
          }
        }
      } else if (c.state === "queue") {
        c.atRegister = this.queue[0] === c;
      } else if (c.state === "leaving") {
        this.customers = this.customers.filter((x) => x !== c);
        continue;
      }

      // Paciencia: corre mientras espera en la cola y nadie ha empezado a atenderlo.
      const started = c.checkout.scanned > 0 || c.checkout.charged !== null;
      if (c.state === "queue" && !started && --c.patience <= 0) {
        this.queue = this.queue.filter((x) => x !== c);
        c.state = "leaving";
        c.atRegister = false;
        c.mood = "enojado";
        this.float(c, "¡Me voy!", "bad");
        this.sound("angry", c);
        this.record({ kind: "customer_left", customerId: c.id, at: this.now, outcome: "abandonó la fila", mood: c.mood });
        this.today.lost++;
        this.addReputation(REPUTATION.abandonQueue);
        for (const p of c.cart) {
          const shelf = this.shelves.find((s) => s.product === p && s.stock < s.capacity);
          if (shelf) shelf.stock = Math.min(shelf.capacity, shelf.stock + 1); // deja las cosas en el estante
        }
      }
    }
  }

  /** Lo que entrega el cliente: a veces exacto, si no el billete más pequeño que alcance. */
  customerPays(charged: number): number {
    if (charged <= 0) return 0;
    if (this.rng.next() < CUSTOMER.exactPayChance) return charged;
    const bill = BILLS.find((b) => b >= charged);
    return bill ?? Math.ceil(charged / 10000) * 10000;
  }

  /** Cierra la venta: compara lo cobrado y la devuelta con lo correcto (GDD §5.5). */
  /** Quién está en la caja (para la base de datos). */
  private cashierName(): string {
    return this.robots.find((r) => r.x === this.register.x && r.y === this.register.y)?.name ?? "?";
  }

  finishCheckout(c: Customer): Ticket {
    const items = c.cart.map((p) => ({ product: p, price: PRODUCTS[p].price }));
    const total = items.reduce((s, i) => s + i.price, 0);
    const { charged } = c.checkout;
    const paid = c.checkout.paid ?? 0;
    const change = c.checkout.change ?? 0;
    const net = paid - change;
    let result: TicketResult;

    if (c.checkout.paid === null) {
      result = "sin_cobrar";
      c.mood = "feliz";
    } else if (net > total + 1e-9) {
      result = "cobro_de_mas";
      c.mood = "enojado";
      this.earn(total, this.register); // el dinero de más se le devuelve
      this.addReputation(REPUTATION.badCheckout, c);
      this.sound("angry", c);
    } else if (Math.abs(net - total) <= 1e-9) {
      result = "ok";
      c.mood = "feliz";
      this.earn(total, this.register);
      this.addReputation(REPUTATION.goodCheckout);
      this.sound("cash", this.register);
    } else {
      result = "cobro_de_menos";
      c.mood = "feliz";
      this.earn(net, this.register);
      this.sound("cash", this.register);
    }

    c.checkout.done = true;
    const ticket: Ticket = { tick: this.tick, customerId: c.id, items, total, charged, paid, change, result };
    this.tickets.push(ticket);
    this.today.sales++;
    if (result === "ok") this.today.ok++;
    this.today.revenue += result === "ok" || result === "cobro_de_mas" ? total : result === "cobro_de_menos" ? net : 0;
    this.record({ kind: "sale", customerId: c.id, at: this.now, cashier: this.cashierName(), total, charged, paid, change, result, items });
    if (this.tickets.length > 100) this.tickets.shift();
    this.events.push({ type: "ticket", ticket });
    return ticket;
  }

  releaseCustomer(c: Customer): void {
    if (!c.checkout.done) this.finishCheckout(c);
    this.queue = this.queue.filter((x) => x !== c);
    c.state = "leaving";
    c.atRegister = false;
    this.record({ kind: "customer_left", customerId: c.id, at: this.now, outcome: "compró", mood: c.mood });
  }
}
