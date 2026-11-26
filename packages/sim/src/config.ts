import { FEATURES, type Feature } from "@cdb/interpreter";

/** Todos los números de balance en un solo lugar (GDD §5, §6, §14). Ajustar aquí al hacer playtest. */
export const TICKS_PER_SECOND = 10;

/** El día 1 es el lunes 5 de enero de 2026 (UTC). */
export const GAME_START_MS = Date.UTC(2026, 0, 5);

/** Hora del juego en formato ISO (para la base de datos): `hours` desde la medianoche del día `day`. */
export function gameTime(day: number, hours: number): string {
  return new Date(GAME_START_MS + (day - 1) * 86_400_000 + hours * 3_600_000).toISOString();
}

/**
 * Ciclo de día y noche. El día dura 5 minutos de juego (de 7:00 a 19:00): llegan clientes.
 * Cada día es como un nivel: llegan más clientes que el anterior.
 */
export const DAY = {
  ticks: 5 * 60 * TICKS_PER_SECOND,
  opensAt: 7,
  closesAt: 19,
  /** Cada día llegan este % más clientes que el anterior. */
  customerGrowth: 0.25,
};

export interface ProductDef {
  /** Precio de venta al cliente. */
  price: number;
  /** Lo que cobra la Distribuidora El Surtidor por unidad (en el Excel: "Costo Unitario"). */
  cost: number;
  /** Código del producto en las hojas del distribuidor. */
  code: string;
  category: string;
  /** Días hasta que vence (para la columna "Vence" del Excel). */
  life: number;
  /** Qué tanto lo piden los clientes (1 = como el pan). Los productos premium se venden mucho mejor. */
  demand: number;
  /** Básico: el proveedor del barrio lo trae si se acaba. Premium: solo llega pidiéndolo a El Surtidor. */
  basic: boolean;
  blurb: string;
}

/**
 * Productos de la tienda. Los tres básicos vienen desde el inicio; los premium se piden a la Distribuidora El Surtidor
 * (en el Navegador): cuestan más, pero dejan más ganancia, los clientes los piden más y atraen clientes nuevos.
 */
export const PRODUCTS = {
  pan: { price: 2000, cost: 1000, code: "P-001", category: "Panadería", life: 2, demand: 1, basic: true, blurb: "El de todos los días." },
  leche: { price: 4500, cost: 2300, code: "P-002", category: "Lácteos", life: 4, demand: 1, basic: true, blurb: "Bolsa de un litro." },
  huevos: { price: 3800, cost: 1900, code: "P-003", category: "Granja", life: 20, demand: 1, basic: true, blurb: "Cubeta pequeña." },
  chocolate: { price: 9000, cost: 4500, code: "P-101", category: "Dulces", life: 180, demand: 2.2, basic: false, blurb: "Barra de chocolate fino. Los niños no se resisten." },
  queso: { price: 16000, cost: 8000, code: "P-102", category: "Lácteos", life: 25, demand: 2, basic: false, blurb: "Queso madurado en bloque." },
  miel: { price: 22000, cost: 11000, code: "P-103", category: "Despensa", life: 365, demand: 1.8, basic: false, blurb: "Miel de abejas pura, frasco de vidrio." },
  aceite: { price: 26000, cost: 13000, code: "P-104", category: "Despensa", life: 300, demand: 1.8, basic: false, blurb: "Aceite de oliva extra virgen." },
  vino: { price: 48000, cost: 24000, code: "P-105", category: "Licores", life: 720, demand: 1.6, basic: false, blurb: "Vino tinto reserva. El más caro y el que más deja." },
} satisfies Record<string, ProductDef>;
export type ProductName = keyof typeof PRODUCTS;
export const PRODUCT_NAMES = Object.keys(PRODUCTS) as ProductName[];
export const BASIC_PRODUCTS = PRODUCT_NAMES.filter((p) => PRODUCTS[p].basic);

/** Distribuidora El Surtidor: la página del proveedor en el Navegador. */
export const SUPPLIER = {
  name: "Distribuidora El Surtidor",
  /** Se vende por cajas de este número de unidades. */
  caseUnits: 10,
  /** Máximo de cajas de un producto por pedido. */
  maxCases: 9,
  /** El repartidor llega 1 minuto (de juego) después del pedido. */
  deliveryTicks: 60 * TICKS_PER_SECOND,
  /** Cada producto premium que hay en los estantes trae este % más de clientes. */
  premiumPull: 0.12,
};

/** El proveedor del barrio cobra este % del precio al tomar del almacén (hasta que exista order()). */
export const COST_RATIO = 0.6;

export const TICKS = {
  move: 4,
  pickPerUnit: 3,
  placePerUnit: 3,
  scanPerItem: 2,
  takePayment: 2,
  giveChange: 3,
  nextCustomer: 1,
  wait: 1,
  failed: 1, // acción que no se pudo hacer (p. ej. pick fuera del almacén)
};

export const ROBOT = {
  capacity: 5,
};

export const SHELF_CAPACITY = 10;

export const CUSTOMER = {
  /** clientes_por_minuto = base * (0.2 + reputacion / 62.5) */
  basePerMinute: 4,
  itemsMin: 1,
  itemsMax: 3,
  ticksPerStep: 5,
  /** Tiempo que se queda mirando cada estante antes de tomar el producto (o darse cuenta de que no hay): 0,8 s. */
  browseTicks: 8,
  /** Paciencia en la cola: 45 s. */
  patienceTicks: 45 * TICKS_PER_SECOND,
  /** El primer cliente llega a los 3 s para que la tienda no empiece vacía. */
  firstArrivalTick: 3 * TICKS_PER_SECOND,
  /** Probabilidad de pagar con el monto exacto. */
  exactPayChance: 0.3,
};

export const BILLS = [1000, 2000, 5000, 10000, 20000, 50000];

export const REPUTATION = {
  start: 50,
  goodCheckout: +1,
  badCheckout: -5,
  missingProduct: -2,
  abandonQueue: -4,
};

export const START_MONEY = 5000;

/** Toda la sintaxis viene desbloqueada desde el inicio (lo pidió el usuario): lo que se compra es la tienda. */
export const START_FEATURES: Feature[] = [...FEATURES];

export type UpgradeBranch = "tienda" | "equipo" | "marketing" | "datos";

export interface UnlockDef {
  id: string;
  label: string;
  branch: UpgradeBranch;
  cost: number;
  description: string;
  /** Mejoras que hay que tener antes (todas). */
  requires?: string[];
  /** Nivel de CPU que da esta mejora (srv-01). */
  cpuLevel?: number;
  /** Estantes nuevos que el jugador coloca donde quiera. */
  shelves?: number;
  /** Abre este lote del terreno (los números del mapa). */
  lot?: number;
  /** Clientes extra por minuto (0.2 = 20 % más). */
  marketing?: number;
  /** Paciencia extra en la fila (0.5 = 50 % más). */
  patience?: number;
  /** Cuántos racks caben en la sala de servidores con esta mejora. */
  racks?: number;
  /** Cajas nuevas (cada una trae su robot cajero); el jugador elige dónde ponerlas. */
  registers?: number;
  /** Robots reponedores nuevos (como Toño): aparecen en el almacén. */
  stockers?: number;
}

/**
 * Árbol de mejoras (ventana Mejoras). Tres ramas: la tienda (estantes y ampliar el local), marketing (más clientes)
 * y el centro de datos (CPU y racks). [PLAYTEST] Con scripts buenos se ganan ~$110.000 cada 10 min.
 */
export const UNLOCKS: UnlockDef[] = [
  { id: "estante1", branch: "tienda", label: "Estante nuevo", cost: 4000, shelves: 1, description: "Un estante más. Tú eliges dónde ponerlo." },
  { id: "estante2", branch: "tienda", label: "Dos estantes", cost: 9000, shelves: 2, requires: ["estante1"], description: "Dos estantes más para vender más productos a la vez." },
  { id: "local1", branch: "tienda", label: "Ampliar el local", cost: 25000, lot: 1, requires: ["estante1"], description: "Tumba la pared del este: 3 columnas más de tienda y caben más clientes." },
  { id: "estante3", branch: "tienda", label: "Tres estantes", cost: 20000, shelves: 3, requires: ["local1", "estante2"], description: "Tres estantes más para llenar el espacio nuevo." },
  { id: "local2", branch: "tienda", label: "Supermercado", cost: 60000, lot: 2, requires: ["local1"], description: "Otras 3 columnas al este. La Esquina ya es un supermercado." },
  { id: "estante4", branch: "tienda", label: "Cuatro estantes", cost: 40000, shelves: 4, requires: ["local2", "estante3"], description: "Cuatro estantes más." },

  { id: "caja2", branch: "equipo", label: "Segunda caja", cost: 20000, registers: 1, description: "Otra caja registradora con su robot cajero. Tú eliges dónde ponerla; el código del cajero lo escribes tú." },
  { id: "caja3", branch: "equipo", label: "Tercera caja", cost: 45000, registers: 1, requires: ["caja2"], description: "Una caja más con su robot cajero: menos fila en las horas pico." },
  { id: "robot1", branch: "equipo", label: "Robot reponedor", cost: 15000, stockers: 1, description: "Un robot como Toño para surtir los estantes. Llega al almacén listo para que le escribas el código." },
  { id: "robot2", branch: "equipo", label: "Otro reponedor", cost: 35000, stockers: 1, requires: ["robot1"], description: "Un reponedor más. Ojo: cada robot que corre ocupa RAM y CPU del servidor." },

  { id: "volantes", branch: "marketing", label: "Volantes", cost: 3000, marketing: 0.15, description: "Volantes en el barrio: llegan 15 % más clientes." },
  { id: "musica", branch: "marketing", label: "Música ambiental", cost: 8000, patience: 0.5, requires: ["volantes"], description: "Los clientes aguantan 50 % más en la fila antes de irse." },
  { id: "letrero", branch: "marketing", label: "Letrero luminoso", cost: 12000, marketing: 0.2, requires: ["volantes"], description: "Se ve desde la avenida: 20 % más clientes." },
  { id: "radio", branch: "marketing", label: "Cuña en la radio", cost: 30000, marketing: 0.3, requires: ["letrero"], description: "Anuncio en la emisora del barrio: 30 % más clientes." },
  { id: "redes", branch: "marketing", label: "Redes sociales", cost: 70000, marketing: 0.4, requires: ["radio"], description: "Todo el mundo habla de La Esquina: 40 % más clientes." },

  { id: "sala1", branch: "datos", label: "Sala más grande", cost: 12000, racks: 2, description: "Cabe un segundo rack en la sala de servidores (se compra en TecnoMercado)." },
  { id: "sala2", branch: "datos", label: "Centro de datos", cost: 35000, racks: 3, requires: ["sala1"], description: "Cabe un tercer rack: la sala se vuelve un centro de datos." },
];

/**
 * Robots que se compran en Mejoras (en orden). Los cajeros llegan con su caja; los reponedores, al almacén.
 * La IP de cada uno está en SERVER.robotIps.
 */
export const EXTRA_ROBOTS = {
  reponedor: [
    { id: "chucho", name: "Chucho", color: "verde" },
    { id: "rosa", name: "Rosa", color: "morado" },
  ],
  cajero: [
    { id: "memo", name: "Memo", color: "rosa" },
    { id: "kika", name: "Kika", color: "amarillo" },
  ],
} as const;

/** Casillas de fila que tiene cada caja (hacia el este). Ahí no se pueden poner estantes. */
export const QUEUE_CELLS = 5;

/** Noche: cada cuánto llega otro cliente de prueba a una caja activa después de despedir al anterior. */
export const TEST_CUSTOMER_DELAY = 3 * TICKS_PER_SECOND;

/** Racks que caben en la sala de servidores sin ampliarla. */
export const START_RACKS = 1;

/** Clientes que caben a la vez en la tienda: los de base y cuántos más por cada lote abierto. */
export const STORE_CAPACITY = { base: 8, perLot: 4 };

/** Operaciones por tick de un núcleo, según la velocidad de la CPU del servidor. */
export const CPU_OPS = [50, 100, 200, 400];

/**
 * Servidores (docs/servidores.md). El código de los robots corre en un servidor y comparte su CPU.
 * [PLAYTEST] srv-01 tiene 1 núcleo: un bucle sin wait() lo satura y todos los robots van más lentos.
 */
export const SERVER = {
  /** El servidor con el que empieza la partida. */
  start: { id: "srv-01", hostname: "srv-01", ip: "10.0.0.10", cores: 1, ramGb: 2 },
  /** IPs de los robots en la red de la tienda. */
  robotIps: { tono: "10.0.0.21", lupe: "10.0.0.22", chucho: "10.0.0.23", memo: "10.0.0.24", rosa: "10.0.0.25", kika: "10.0.0.26" } as Record<string, string>,
  osRamGb: 0.5,
  robotRamGb: 0.5,
  /** Desde esta carga los robots empiezan a ir más lento... */
  slowFrom: 0.8,
  /** ...hasta ir así de lento al 100%. */
  maxSlowdown: 2.5,
  /** Qué tanto pesa el último tick en la carga suavizada (0.1 ≈ 1 segundo). */
  smoothing: 0.1,
  /** El router de la tienda (puerta de enlace). */
  gateway: "10.0.0.1",
  /** Temperatura: en reposo, cuánto sube al 100% de carga, cuánto baja cada ventilador y el aire acondicionado. */
  tempIdle: 35,
  tempPerLoad: 55,
  fanCooling: 12,
  airconCooling: 20,
  /** Por encima de esta temperatura la CPU baja su velocidad sola... */
  throttleTemp: 85,
  /** ...y los robots van así de más lentos. */
  thermalSlowdown: 1.5,
};

/**
 * Ataques y casos de investigación (docs/servidores.md §5–§8). Los ataques solo frenan.
 * [PLAYTEST] frecuencia y recompensas.
 */
export const SECURITY = {
  /** Desde qué día empiezan los ataques (el día 1 es el de la primera apertura). */
  firstDay: 2,
  /** Probabilidad de un segundo ataque el mismo día (sube con los días). */
  extraAttackPerDay: 0.08,
  easyUntilDay: 3,
  mediumUntilDay: 6,
  /** Intentos para denunciar y días que dura un caso abierto. */
  attempts: 3,
  caseDays: 3,
  bountyBase: 4000,
  bountyPerLevel: 3000,
  bountyPerProxy: 1500,
  /** Cada pista pedida descuenta este % del bounty; adjuntar la evidencia suma este %. */
  hintPenalty: 0.2,
  evidenceBonus: 0.25,
  rightReputation: 3,
  wrongReputation: 3,
  /** Fuerza bruta: cuánto dura, cada cuántos ticks intenta, intentos hasta que fail2ban bloquea. */
  bruteTicks: 1200,
  bruteEvery: 20,
  banAfter: 5,
  /** Con contraseña débil y sin fail2ban, después de estos intentos entra y deja un minero. */
  bruteSuccessAfter: 12,
  /** Fracción de la CPU que roba un minero. */
  minerSteal: 0.5,
  /** Si se mata el minero pero su archivo sigue, vuelve a arrancar después de estos ticks. */
  respawnTicks: 150,
  /** DDoS: qué tanto satura la red y cuánto dura (el firewall y la protección anti-DDoS lo bajan). */
  ddosLevel: 0.8,
  ddosTicks: 1800,
  ufwFactor: 0.7,
  antiddosFactor: 0.3,
  sqliLevel: 0.35,
  sqliTicks: 600,
  /** Ticks que la trampa (cowrie) tiene que estar corriendo para que el atacante caiga. */
  honeypotTicks: 300,
};


/**
 * Plano del Kiosco. Fila de arriba = norte. y crece hacia el norte (como en The Farmer Was Replaced):
 * la fila de abajo del texto es y = 0.
 *   A = almacén (un cuarto aparte: en cualquier casilla suya se puede tomar cualquier producto)
 *   S = estante (empieza vacío y sin producto: el primero que pongas define qué vende)
 *   C = caja, E = entrada, . = piso
 *   1, 2 = terreno por ampliar (lote 1, lote 2): no se puede pisar hasta comprar "Ampliar el local" en Mejoras
 *   | = pared entre dos casillas, : = puerta (no ocupan casilla)
 */
export const KIOSCO_MAP = [
  "AAA:.SSSSE111222",
  "AAA|......111222",
  "AAA|......111222",
  "AAA|......111222",
  "AAA|......111222",
  "AAA|C.....111222",
];

/** Mercancía que hay en el almacén al abrir: la entrega del distribuidor (ya pagada). */
export const WAREHOUSE_START: Record<ProductName, number> = { pan: 40, leche: 30, huevos: 36, chocolate: 0, queso: 0, miel: 0, aceite: 0, vino: 0 };

/**
 * La noche: 10 minutos (tiempo real) con la tienda cerrada, sin clientes, para escribir código.
 * La primera noche es la preparación después de la misión del inventario.
 */
export const NIGHT = {
  ms: 10 * 60 * 1000,
  /** La primera noche es más larga: hay que montar el servidor y conectar los robots antes de programarlos. */
  firstMs: 20 * 60 * 1000,
  /** Jugadores que deben votar "¡Listo!" para abrir antes de que amanezca. */
  players: ["j1", "j2"] as const,
};
export type PlayerId = (typeof NIGHT.players)[number];
