/**
 * La hoja de cálculo que trae el camión del distribuidor (entrega_distribuidor.xlsx).
 * Viene "como en la vida real": encabezados con tildes y espacios, nombres con mayúsculas y espacios,
 * un producto anotado dos veces y una fila TOTAL al final. Limpiarla es parte del reto.
 */
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
