/**
 * La hoja de cálculo que trae el camión del distribuidor (entrega_distribuidor.xlsx).
 * Viene "como en la vida real": encabezados con tildes y espacios, nombres con mayúsculas y espacios,
 * un producto anotado dos veces y una fila TOTAL al final. Limpiarla es parte del reto.
 */
import { PRODUCTS, type ProductName, SUPPLIER } from "./config.js";

export type Cell = string | number | null;

export interface Sheet {
  name: string;
  columns: string[];
  rows: Cell[][];
}

export interface Workbook {
  filename: string;
  sheets: Sheet[];
}

export const DELIVERY: Workbook = {
  filename: "entrega_distribuidor.xlsx",
  sheets: [
    {
      name: "entrega",
      columns: ["Código", "Producto", "Categoría", "Cantidad", "Precio Unitario", "Costo Unitario", "Vence"],
      rows: [
        ["P-001", "Pan ", "Panadería", 40, 2000, 1200, "2026-01-07"],
        ["P-002", "Leche", "Lácteos", 30, 4500, 2700, "2026-01-09"],
        ["P-003", "HUEVOS", "Granja", 36, 3800, 2280, "2026-01-25"],
        ["P-002", "Leche", "Lácteos", 30, 4500, 2700, "2026-01-09"],
        [null, "TOTAL", null, 136, null, null, null],
      ],
    },
  ],
};

/** Productos que el juego espera encontrar en el inventario del jugador. */
export const DELIVERY_PRODUCTS = ["pan", "leche", "huevos"];

/** Línea de un pedido a El Surtidor: un producto y cuántas cajas. */
export interface GoodsLine {
  product: ProductName;
  cases: number;
}

/** Así anota el repartidor los nombres: a veces en mayúsculas, con espacios de más o con mayúscula inicial. */
const MESSY = [(s: string) => s, (s: string) => s.toUpperCase(), (s: string) => `${s} `, (s: string) => s[0].toUpperCase() + s.slice(1), (s: string) => ` ${s}`];

/**
 * El Excel que deja el repartidor de El Surtidor: **siempre con la misma estructura** que entrega_distribuidor.xlsx
 * (mismas columnas, una fila por producto y la fila TOTAL al final). Como en la primera entrega, viene "a mano":
 * nombres desordenados y a veces una fila anotada dos veces. Así el script de migración del jugador le sirve
 * para todos los pedidos.
 * `pick(n)` da un entero en [0, n) (para que sea determinista con la semilla del mundo).
 */
export function supplierWorkbook(n: number, lines: GoodsLine[], vence: (days: number) => string, pick: (n: number) => number): Workbook {
  const rows: Cell[][] = [];
  for (const l of lines) {
    const def = PRODUCTS[l.product];
    const units = l.cases * SUPPLIER.caseUnits;
    const name = MESSY[pick(MESSY.length)](l.product);
    rows.push([def.code, name, def.category, units, def.price, def.cost, vence(def.life)]);
  }
  // el repartidor a veces anota una línea dos veces (y la suma en el TOTAL, como en la primera entrega)
  if (rows.length && pick(2) === 0) {
    const i = pick(rows.length);
    rows.splice(i + 1, 0, [...rows[i]]);
  }
  const total = rows.reduce((s, r) => s + (r[3] as number), 0);
  rows.push([null, "TOTAL", null, total, null, null, null]);
  return { filename: `pedido_${n}.xlsx`, sheets: [{ name: "entrega", columns: [...DELIVERY.sheets[0].columns], rows }] };
}
