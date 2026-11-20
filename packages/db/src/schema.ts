/**
 * Esquema de la base de datos de la tienda (PostgreSQL real, vía PGlite).
 * Dinero en pesos enteros (BIGINT): el peso colombiano no usa centavos en la práctica.
 * Las horas son la hora del juego (TIMESTAMPTZ, empieza el 5 de enero de 2026 a las 8:00).
 */
export const SCHEMA_SQL = `
SET TimeZone = 'UTC';

-- Registro interno del juego (el jugador no lo ve: su base de datos empieza vacía y la diseña él).
-- Se rehace en cada partida. Las tablas del jugador (esquema public) no se tocan.
DROP SCHEMA IF EXISTS registro CASCADE;
CREATE SCHEMA registro;
SET search_path = registro;

CREATE TABLE products (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name      TEXT   NOT NULL UNIQUE,
  price     BIGINT NOT NULL CHECK (price > 0),
  cost      BIGINT NOT NULL CHECK (cost >= 0),
  stock     BIGINT NOT NULL DEFAULT 0,
  warehouse BIGINT NOT NULL DEFAULT 0,
  capacity  BIGINT NOT NULL,
  shelf_x   INT,
  shelf_y   INT
);

CREATE TABLE customers (
  id          BIGINT PRIMARY KEY,
  arrived_at  TIMESTAMPTZ NOT NULL,
  left_at     TIMESTAMPTZ,
  wanted      TEXT[] NOT NULL,
  outcome     TEXT CHECK (outcome IN ('compró', 'se fue sin comprar', 'abandonó la fila')),
  mood        TEXT CHECK (mood IN ('feliz', 'neutral', 'enojado'))
);
CREATE INDEX customers_arrived_at_idx ON customers (arrived_at);

CREATE TABLE sales (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id  BIGINT NOT NULL REFERENCES customers (id),
  sold_at      TIMESTAMPTZ NOT NULL,
  cashier      TEXT   NOT NULL,
  total        BIGINT NOT NULL,
  charged      BIGINT,
  paid         BIGINT NOT NULL,
  change       BIGINT NOT NULL,
  result       TEXT   NOT NULL CHECK (result IN ('ok', 'cobro_de_mas', 'cobro_de_menos', 'sin_cobrar'))
);
CREATE INDEX sales_customer_id_idx ON sales (customer_id);
CREATE INDEX sales_sold_at_idx ON sales (sold_at);

CREATE TABLE sale_items (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sale_id     BIGINT NOT NULL REFERENCES sales (id) ON DELETE CASCADE,
  product_id  BIGINT NOT NULL REFERENCES products (id),
  price       BIGINT NOT NULL
);
CREATE INDEX sale_items_sale_id_idx ON sale_items (sale_id);
CREATE INDEX sale_items_product_id_idx ON sale_items (product_id);

CREATE TABLE stockouts (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at           TIMESTAMPTZ NOT NULL,
  product_id   BIGINT NOT NULL REFERENCES products (id),
  customer_id  BIGINT REFERENCES customers (id)
);
CREATE INDEX stockouts_product_id_idx ON stockouts (product_id);
CREATE INDEX stockouts_customer_id_idx ON stockouts (customer_id);

CREATE TABLE supplier_purchases (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL,
  robot       TEXT   NOT NULL,
  product_id  BIGINT NOT NULL REFERENCES products (id),
  quantity    BIGINT NOT NULL CHECK (quantity > 0),
  unit_cost   BIGINT NOT NULL,
  total_cost  BIGINT GENERATED ALWAYS AS (quantity * unit_cost) STORED
);
CREATE INDEX supplier_purchases_product_id_idx ON supplier_purchases (product_id);

CREATE TABLE restocks (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL,
  robot       TEXT   NOT NULL,
  product_id  BIGINT NOT NULL REFERENCES products (id),
  quantity    BIGINT NOT NULL CHECK (quantity > 0)
);
CREATE INDEX restocks_product_id_idx ON restocks (product_id);

CREATE TABLE robots (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  color          TEXT NOT NULL,
  status         TEXT NOT NULL,
  x              INT  NOT NULL,
  y              INT  NOT NULL,
  cargo_product  TEXT,
  cargo          INT  NOT NULL DEFAULT 0
);

RESET search_path;

-- El jugador solo tiene su esquema public: el registro interno no existe para él.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jugador') THEN CREATE ROLE jugador; END IF;
END $$;
GRANT USAGE, CREATE ON SCHEMA public TO jugador;
REVOKE ALL ON SCHEMA registro FROM jugador;
`;

/** Esquemas: el del jugador y el registro interno del juego (invisible para el jugador). */
export const PLAYER_SCHEMA = "public";
export const LOG_SCHEMA = "registro";

/** Descripción en español de cada tabla y columna (para el panel de tablas y el autocompletado). */
export const TABLE_DOCS: Record<string, { description: string; columns: Record<string, string> }> = {
  products: {
    description: "Productos de la tienda, con su precio, lo que hay en los estantes y en el almacén.",
    columns: {
      id: "Identificador", name: "Nombre (pan, leche...)", price: "Precio de venta", cost: "Lo que cobra el proveedor por unidad",
      stock: "Unidades en los estantes ahora", warehouse: "Unidades guardadas en el almacén", capacity: "Capacidad de sus estantes",
      shelf_x: "Posición x de su primer estante (vacío si no tiene)", shelf_y: "Posición y de su primer estante",
    },
  },
  customers: {
    description: "Cada cliente que entró a la tienda.",
    columns: {
      id: "Número de cliente", arrived_at: "Hora de llegada", left_at: "Hora en que se fue", wanted: "Lista de lo que quería comprar",
      outcome: "compró, se fue sin comprar o abandonó la fila", mood: "Cómo se fue: feliz, neutral o enojado",
    },
  },
  sales: {
    description: "Cada cobro en la caja (un tiquete).",
    columns: {
      id: "Número de venta", customer_id: "Cliente (customers.id)", sold_at: "Hora de la venta", cashier: "Robot que cobró",
      total: "Lo que debía pagar", charged: "Lo que cobró el robot", paid: "Con cuánto pagó el cliente", change: "Devuelta entregada",
      result: "ok, cobro_de_mas, cobro_de_menos o sin_cobrar",
    },
  },
  sale_items: {
    description: "Cada producto de cada venta.",
    columns: { id: "Identificador", sale_id: "Venta (sales.id)", product_id: "Producto (products.id)", price: "Precio al que se vendió" },
  },
  stockouts: {
    description: "Veces que un cliente buscó un producto y el estante estaba vacío.",
    columns: { id: "Identificador", at: "Hora", product_id: "Producto (products.id)", customer_id: "Cliente (customers.id)" },
  },
  supplier_purchases: {
    description: "Compras al proveedor (cada pick() en el almacén).",
    columns: {
      id: "Identificador", at: "Hora", robot: "Robot que compró", product_id: "Producto (products.id)", quantity: "Unidades",
      unit_cost: "Costo por unidad", total_cost: "Costo total (calculado)",
    },
  },
  restocks: {
    description: "Productos puestos en los estantes (cada place()).",
    columns: { id: "Identificador", at: "Hora", robot: "Robot que repuso", product_id: "Producto (products.id)", quantity: "Unidades" },
  },
  robots: {
    description: "Los robots y su estado actual.",
    columns: {
      id: "Identificador", name: "Nombre", color: "Color", status: "Estado del programa", x: "Posición x", y: "Posición y",
      cargo_product: "Producto que carga", cargo: "Unidades que carga",
    },
  },
};

export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
}
