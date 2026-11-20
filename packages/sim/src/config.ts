import type { Feature } from "@cdb/interpreter";

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

export const PRODUCTS = {
  pan: { price: 2000 },
  leche: { price: 4500 },
  huevos: { price: 3800 },
} as const;
export type ProductName = keyof typeof PRODUCTS;

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

/** Sintaxis disponible desde el inicio. */
export const START_FEATURES: Feature[] = ["while", "if", "variables"];

export interface UnlockDef {
  id: string;
  label: string;
  cost: number;
  description: string;
  feature?: Feature;
  /** Nivel de CPU que da esta mejora. */
  cpuLevel?: number;
  requires?: string;
}

/** Árbol de desbloqueos del Kiosco. [PLAYTEST] Con scripts buenos se ganan ~$110.000 cada 10 min. */
export const UNLOCKS: UnlockDef[] = [
  { id: "for", label: "for", cost: 3000, feature: "for", description: "Recorrer listas y range(). Sumar los productos de scan_item() se vuelve fácil." },
  { id: "lists", label: "Listas", cost: 8000, feature: "lists", requires: "for", description: "[1, 2, 3], índices y métodos de lista." },
  { id: "functions", label: "Funciones (def)", cost: 15000, feature: "functions", description: "Reutilizar código con def y return." },
  { id: "import", label: "import shared", cost: 30000, feature: "import", requires: "functions", description: "Librería compartida entre los dos jugadores." },
  { id: "dicts", label: "Diccionarios", cost: 60000, feature: "dicts", requires: "lists", description: "{'pan': 3}: claves y valores." },
  { id: "cpu1", label: "CPU 2", cost: 10000, cpuLevel: 1, description: "100 operaciones por tick." },
  { id: "cpu2", label: "CPU 3", cost: 30000, cpuLevel: 2, requires: "cpu1", description: "200 operaciones por tick." },
  { id: "cpu3", label: "CPU 4", cost: 90000, cpuLevel: 3, requires: "cpu2", description: "400 operaciones por tick." },
];

export const CPU_OPS = [50, 100, 200, 400];

/**
 * Plano del Kiosco. Fila de arriba = norte. y crece hacia el norte (como en The Farmer Was Replaced):
 * la fila de abajo del texto es y = 0.
 *   A = almacén (un cuarto aparte: en cualquier casilla suya se puede tomar cualquier producto)
 *   S = estante (empieza vacío y sin producto: el primero que pongas define qué vende)
 *   C = caja, E = entrada, . = piso
 *   | = pared entre dos casillas, : = puerta (no ocupan casilla)
 */
export const KIOSCO_MAP = [
  "AAA:.SSSSE",
  "AAA|......",
  "AAA|......",
  "AAA|......",
  "AAA|......",
  "AAA|C.....",
];

/** Mercancía que hay en el almacén al abrir: la entrega del distribuidor (ya pagada). */
export const WAREHOUSE_START: Record<ProductName, number> = { pan: 40, leche: 30, huevos: 36 };

/**
 * La noche: 10 minutos (tiempo real) con la tienda cerrada, sin clientes, para escribir código.
 * La primera noche es la preparación después de la misión del inventario.
 */
export const NIGHT = {
  ms: 10 * 60 * 1000,
  /** Jugadores que deben votar "¡Listo!" para abrir antes de que amanezca. */
  players: ["j1", "j2"] as const,
};
export type PlayerId = (typeof NIGHT.players)[number];
