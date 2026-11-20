import type { PGlite } from "@electric-sql/pglite";
import { COST_RATIO, type DbRecord, PRODUCTS, type ProductName, type World } from "@cdb/sim";
import { SCHEMA_SQL } from "./schema.js";

export interface QueryResult {
  ok: true;
  columns: string[];
  rows: unknown[][];
  /** Filas que había en total (rows se recorta a MAX_ROWS). */
  rowCount: number;
  ms: number;
  /** Mensaje cuando la consulta no devuelve filas (p. ej. SET, SHOW). */
  note?: string;
}

export interface QueryError {
  ok: false;
  message: string;
  /** Mensaje original de PostgreSQL. */
  detail: string;
  ms: number;
}

export interface TableInfo {
  /** Siempre "public": las tablas que creó el jugador. */
  schema: string;
  name: string;
  columns: { name: string; type: string }[];
}

const MAX_ROWS = 500;

/** Resultado de una consulta hecha desde Python (db.fetch, df.to_sql...). */
export interface PlayerResult {
  rows: Record<string, unknown>[];
  fields: string[];
  affectedRows: number;
}

/** Estado de la misión "organiza tu inventario". */
export interface InventoryStatus {
  tables: string[];
  /** Tabla del jugador que más se parece a un inventario. */
  best: { table: string; counts: Record<string, number>; hasTotalRow: boolean; rows: number } | null;
}

/** Dónde está el almacén dentro de la base del jugador: su tabla de inventario y sus columnas. */
export interface WarehouseSource {
  table: string;
  /** Columna con el nombre del producto. */
  nameCol: string;
  /** Columna con la cantidad (null si no se encontró ninguna). */
  qtyCol: string | null;
  /** Unidades por producto (0 si no aparece o no hay columna de cantidad). */
  stock: Record<string, number>;
}

const QTY_NAME = /cant|qty|quant|stock|unidad|existen|inventario|disponib/i;
const NUMERIC = /^(smallint|integer|bigint|numeric|real|double precision)$/;
const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Sentencias que el juego no deja escribir: los permisos y las transacciones los maneja él. */
const FORBIDDEN = [
  /(^|;)\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|SAVEPOINT|RELEASE|END|ABORT)\b/i,
  /\b(SET\s+(LOCAL\s+|SESSION\s+)?ROLE|RESET\s+(ROLE|ALL)|SESSION\s+AUTHORIZATION)\b/i,
  /(^|;)\s*COPY\b/i,
];

export class SqlError extends Error {
  constructor(message: string, readonly detail: string) {
    super(message);
  }
}

function checkAllowed(sql: string): void {
  if (FORBIDDEN.some((re) => re.test(sql))) {
    throw new SqlError(
      "Las transacciones (BEGIN/COMMIT) y los permisos los maneja el juego: escribe solo las sentencias.",
      "sentencia no permitida",
    );
  }
}

/**
 * La base de datos de la tienda: guarda lo que pasa en la simulación y deja consultarlo con SQL.
 * Las consultas del jugador corren en una transacción de solo lectura: no se pueden borrar los datos.
 */
export class GameDB {
  private pg: PGlite | null = null;
  private queue: DbRecord[] = [];
  private productIds = new Map<string, number>();
  private readyPromise: Promise<void> | null = null;
  private flushing: Promise<void> = Promise.resolve();

  constructor(private readonly world: World) {}

  get ready(): boolean {
    return this.pg !== null;
  }

  /**
   * Arranca PostgreSQL (tarda unos segundos la primera vez).
   * `dataDir`: "idb://nombre" guarda las tablas del jugador en el navegador; sin nada, todo en memoria.
   */
  start(opts: { dataDir?: string; create?: () => Promise<PGlite> } = {}): Promise<void> {
    this.readyPromise ??= (async () => {
      const { PGlite } = await import("@electric-sql/pglite");
      const pg = opts.create ? await opts.create() : opts.dataDir ? await PGlite.create(opts.dataDir) : await PGlite.create();
      await pg.exec(SCHEMA_SQL);
      for (const name of Object.keys(PRODUCTS) as ProductName[]) {
        const price = PRODUCTS[name].price;
        const res = await pg.query<{ id: number }>(
          "INSERT INTO registro.products (name, price, cost, stock, warehouse, capacity) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
          [name, price, Math.round(price * COST_RATIO), this.world.shelfStock(name), this.world.warehouseStock[name], 0],
        );
        this.productIds.set(name, Number(res.rows[0].id));
      }
      this.pg = pg;
      await this.flush();
    })();
    return this.readyPromise;
  }

  /** Recibe los registros de la simulación; se escriben en la próxima llamada a flush(). */
  ingest(records: DbRecord[]): void {
    this.queue.push(...records);
  }

  /** Escribe lo pendiente y actualiza el stock y el estado de los robots. */
  flush(): Promise<void> {
    this.flushing = this.flushing.then(() => this.doFlush());
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    const pg = this.pg;
    if (!pg) return;
    const batch = this.queue;
    this.queue = [];
    const pid = (name: string) => this.productIds.get(name)!;
    await pg.transaction(async (tx) => {
      await tx.exec("SET LOCAL search_path = registro");
      for (const r of batch) {
        switch (r.kind) {
          case "customer_arrived":
            await tx.query("INSERT INTO customers (id, arrived_at, wanted) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING", [r.customerId, r.at, r.wanted]);
            break;
          case "customer_left":
            await tx.query("UPDATE customers SET left_at = $2, outcome = $3, mood = $4 WHERE id = $1", [r.customerId, r.at, r.outcome, r.mood]);
            break;
          case "sale": {
            const res = await tx.query<{ id: number }>(
              "INSERT INTO sales (customer_id, sold_at, cashier, total, charged, paid, change, result) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
              [r.customerId, r.at, r.cashier, r.total, r.charged, r.paid, r.change, r.result],
            );
            const saleId = res.rows[0].id;
            for (const it of r.items) {
              await tx.query("INSERT INTO sale_items (sale_id, product_id, price) VALUES ($1, $2, $3)", [saleId, pid(it.product), it.price]);
            }
            break;
          }
          case "stockout":
            await tx.query("INSERT INTO stockouts (at, product_id, customer_id) VALUES ($1, $2, $3)", [r.at, pid(r.product), r.customerId]);
            break;
          case "purchase":
            await tx.query("INSERT INTO supplier_purchases (at, robot, product_id, quantity, unit_cost) VALUES ($1, $2, $3, $4, $5)", [
              r.at, r.robot, pid(r.product), r.quantity, Math.round(r.unitCost),
            ]);
            break;
          case "restock":
            await tx.query("INSERT INTO restocks (at, robot, product_id, quantity) VALUES ($1, $2, $3, $4)", [r.at, r.robot, pid(r.product), r.quantity]);
            break;
        }
      }
      // stock y capacidad suman todos los estantes del producto; shelf_x/shelf_y es el primero (null si no tiene)
      for (const name of Object.keys(PRODUCTS) as ProductName[]) {
        const mine = this.world.shelves.filter((s) => s.product === name);
        const first = mine[0];
        await tx.query(
          `UPDATE products SET stock = $2, warehouse = $3, capacity = $4, shelf_x = $5, shelf_y = $6
           WHERE id = $1 AND (stock, warehouse, capacity, shelf_x, shelf_y) IS DISTINCT FROM ($2, $3, $4, $5, $6)`,
          [pid(name), this.world.shelfStock(name), this.world.warehouseStock[name], mine.reduce((n, s) => n + s.capacity, 0), first?.x ?? null, first?.y ?? null],
        );
      }
      for (const r of this.world.robots) {
        await tx.query(
          `INSERT INTO robots (id, name, color, status, x, y, cargo_product, cargo) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, x = EXCLUDED.x, y = EXCLUDED.y,
             cargo_product = EXCLUDED.cargo_product, cargo = EXCLUDED.cargo`,
          [r.id, r.name, r.color, r.vm?.status ?? "detenido", r.x, r.y, r.cargo.product, r.cargo.n],
        );
      }
    });
  }

  /** Corre `fn` como el rol jugador: solo ve y usa su esquema public. */
  private asPlayer<T>(fn: (tx: Parameters<Parameters<PGlite["transaction"]>[0]>[0]) => Promise<T>): Promise<T> {
    return this.pg!.transaction(async (tx) => {
      await tx.exec("SET LOCAL ROLE jugador; SET LOCAL search_path = public; SET LOCAL statement_timeout = '3s'");
      return fn(tx);
    });
  }

  private async whenReady(): Promise<void> {
    if (!this.pg) await this.readyPromise;
    await this.flushing; // que los datos recientes ya estén
  }

  /** SQL de la ventana Base de datos (puede tener varias sentencias). Devuelve el resultado de la última con filas. */
  async run(sql: string): Promise<QueryResult | QueryError> {
    const t0 = performance.now();
    await this.whenReady();
    try {
      checkAllowed(sql);
      const results = await this.asPlayer((tx) => tx.exec(sql));
      const ms = Math.round(performance.now() - t0);
      const last = [...results].reverse().find((r) => r.fields.length > 0);
      if (!last) {
        const affected = results.reduce((n, r) => n + (r.affectedRows ?? 0), 0);
        const verb = (sql.trim().match(/^\s*(\w+)/)?.[1] ?? "").toUpperCase();
        const note =
          verb === "CREATE" ? "Listo: se creó." : verb === "DROP" ? "Listo: se borró." : verb === "ALTER" ? "Listo: se modificó la tabla."
          : affected > 0 ? `Listo: ${affected} fila${affected === 1 ? "" : "s"} afectada${affected === 1 ? "" : "s"}.` : "Listo.";
        return { ok: true, columns: [], rows: [], rowCount: 0, ms, note };
      }
      const columns = last.fields.map((f) => f.name);
      const all = last.rows as Record<string, unknown>[];
      const rows = all.slice(0, MAX_ROWS).map((row) => columns.map((c) => row[c]));
      return { ok: true, columns, rows, rowCount: all.length, ms };
    } catch (e) {
      const detail = e instanceof SqlError ? e.detail : ((e as Error).message ?? String(e));
      const message = e instanceof SqlError ? e.message : translateError(detail);
      return { ok: false, message, detail, ms: Math.round(performance.now() - t0) };
    }
  }

  /** Una sentencia con parámetros $1, $2... (desde el código Python). Lanza SqlError con el mensaje en español. */
  async playerQuery(sql: string, params: unknown[] = []): Promise<PlayerResult> {
    await this.whenReady();
    checkAllowed(sql);
    try {
      const res = await this.asPlayer((tx) => tx.query<Record<string, unknown>>(sql, params));
      return { rows: res.rows, fields: res.fields.map((f) => f.name), affectedRows: res.affectedRows ?? 0 };
    } catch (e) {
      const detail = (e as Error).message ?? String(e);
      throw new SqlError(translateError(detail), detail);
    }
  }

  /** Consulta interna del juego sobre el registro (no es para el jugador; la usan los tests y el juego). */
  async systemRun(sql: string): Promise<QueryResult | QueryError> {
    const t0 = performance.now();
    await this.whenReady();
    try {
      const results = await this.pg!.transaction(async (tx) => {
        await tx.exec("SET LOCAL search_path = registro");
        return tx.exec(sql);
      });
      const last = [...results].reverse().find((r) => r.fields.length > 0) ?? results.at(-1)!;
      const columns = last.fields.map((f) => f.name);
      const all = last.rows as Record<string, unknown>[];
      return { ok: true, columns, rows: all.map((row) => columns.map((c) => row[c])), rowCount: all.length, ms: Math.round(performance.now() - t0) };
    } catch (e) {
      const detail = (e as Error).message ?? String(e);
      return { ok: false, message: translateError(detail), detail, ms: Math.round(performance.now() - t0) };
    }
  }

  /** Borra todas las tablas del jugador (para empezar el diseño de cero). */
  async resetPlayerSchema(): Promise<void> {
    await this.whenReady();
    await this.pg!.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE, CREATE ON SCHEMA public TO jugador;");
  }

  /** ¿Ya hay una tabla del jugador con los productos del distribuidor, sin repetidos ni la fila TOTAL? */
  async inventoryStatus(products: string[]): Promise<InventoryStatus> {
    await this.whenReady();
    const pg = this.pg!;
    const t = await pg.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name",
    );
    const tables = t.rows.map((r) => r.table_name);
    let best: InventoryStatus["best"] = null;
    for (const table of tables) {
      const res = await pg.query<Record<string, unknown>>(`SELECT * FROM public."${table.replace(/"/g, '""')}" LIMIT 2000`);
      const counts: Record<string, number> = Object.fromEntries(products.map((p) => [p, 0]));
      let hasTotalRow = false;
      for (const row of res.rows) {
        for (const v of Object.values(row)) {
          if (typeof v !== "string") continue;
          const norm = v.trim().toLowerCase();
          if (norm in counts) counts[norm]++;
          if (norm === "total") hasTotalRow = true;
        }
      }
      const score = products.filter((p) => counts[p] > 0).length;
      const bestScore = best ? products.filter((p) => best!.counts[p] > 0).length : -1;
      if (score > bestScore) best = { table, counts, hasTotalRow, rows: res.rows.length };
    }
    return { tables, best: best && products.some((p) => best!.counts[p] > 0) ? best : null };
  }

  /**
   * El almacén es la base de datos del jugador: lee su tabla de inventario (la que encontró la misión),
   * la columna con el nombre del producto y la de la cantidad. null si todavía no hay tabla de inventario.
   */
  async warehouseSource(products: string[]): Promise<WarehouseSource | null> {
    const st = await this.inventoryStatus(products);
    if (!st.best) return null;
    const table = st.best.table;
    const pg = this.pg!;
    const cols = await pg.query<{ column_name: string; data_type: string }>(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position",
      [table],
    );
    const rows = (await pg.query<Record<string, unknown>>(`SELECT * FROM public.${ident(table)} LIMIT 2000`)).rows;
    const norm = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : null);
    // la columna del nombre: la que tiene más valores que son productos
    let nameCol: string | null = null;
    let bestHits = 0;
    for (const c of cols.rows) {
      const hits = rows.filter((r) => products.includes(norm(r[c.column_name]) ?? "")).length;
      if (hits > bestHits) [nameCol, bestHits] = [c.column_name, hits];
    }
    if (!nameCol) return null;
    const qty = cols.rows.find((c) => NUMERIC.test(c.data_type) && QTY_NAME.test(c.column_name));
    const qtyCol = qty?.column_name ?? null;
    const stock: Record<string, number> = Object.fromEntries(products.map((p) => [p, 0]));
    if (qtyCol) {
      for (const r of rows) {
        const p = norm(r[nameCol]);
        if (p && p in stock) stock[p] += Math.max(0, Math.floor(Number(r[qtyCol]) || 0));
      }
    }
    return { table, nameCol, qtyCol, stock };
  }

  /** Descuenta del inventario del jugador lo que un robot sacó del almacén (como el rol jugador: es su tabla). */
  async takeFromWarehouse(src: WarehouseSource, product: string, quantity: number): Promise<void> {
    if (!src.qtyCol) return;
    await this.whenReady();
    const q = ident(src.qtyCol);
    // si el producto está en varias filas, se descuenta de la primera que tenga
    await this.asPlayer((tx) =>
      tx.query(
        `UPDATE public.${ident(src.table)} SET ${q} = ${q} - $2
         WHERE ctid = (SELECT ctid FROM public.${ident(src.table)} WHERE lower(trim(${ident(src.nameCol)}::text)) = $1 AND ${q} >= $2 LIMIT 1)`,
        [product, quantity],
      ),
    );
  }

  /** Tablas y columnas (para el panel lateral y el autocompletado). */
  async tables(): Promise<TableInfo[]> {
    await this.whenReady();
    const res = await this.pg!.query<{ table_schema: string; table_name: string; column_name: string; data_type: string }>(
      `SELECT c.table_schema, c.table_name, c.column_name, c.data_type
       FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
       WHERE c.table_schema = 'public'
       ORDER BY c.table_schema, c.table_name, c.ordinal_position`,
    );
    const map = new Map<string, TableInfo>();
    for (const r of res.rows) {
      const key = `${r.table_schema}.${r.table_name}`;
      if (!map.has(key)) map.set(key, { schema: r.table_schema, name: r.table_name, columns: [] });
      map.get(key)!.columns.push({ name: r.column_name, type: r.data_type });
    }
    return [...map.values()];
  }
}

/** Traduce los errores más comunes de PostgreSQL al español. */
export function translateError(msg: string): string {
  let m: RegExpMatchArray | null;
  if (/read-only transaction/.test(msg)) {
    return "Solo puedes consultar datos (SELECT). La base de datos guarda la historia de la tienda y no se puede modificar.";
  }
  if (/permission denied for schema registro/.test(msg)) return "Ese esquema no es tuyo: crea tus tablas sin nada delante (quedan en tu base de datos).";
  if (/permission denied/.test(msg)) return "No tienes permiso para hacer eso en la base de datos.";
  if ((m = msg.match(/relation "(.+?)" already exists/))) return `La tabla "${m[1]}" ya existe. Si quieres rehacerla: DROP TABLE ${m[1]};`;
  if ((m = msg.match(/column "(.+?)" of relation "(.+?)" does not exist/))) {
    return `La tabla "${m[2]}" no tiene la columna "${m[1]}". Revisa que los nombres de las columnas coincidan (con pandas: df.rename(columns={...})).`;
  }
  if ((m = msg.match(/null value in column "(.+?)"/))) return `Falta el valor de la columna "${m[1]}" (está marcada NOT NULL).`;
  if ((m = msg.match(/duplicate key value violates unique constraint "(.+?)"/))) return `Ese valor ya existe y la tabla no permite repetidos (${m[1]}).`;
  if ((m = msg.match(/violates check constraint "(.+?)"/))) return `Un valor no cumple la regla CHECK "${m[1]}".`;
  if ((m = msg.match(/violates foreign key constraint "(.+?)"/))) return `El valor no existe en la tabla relacionada (llave foránea ${m[1]}).`;
  if (/bind message supplies (\d+) parameters?, but prepared statement "" requires (\d+)/.test(msg)) {
    const [, a, b] = msg.match(/supplies (\d+) parameters?, but prepared statement "" requires (\d+)/)!;
    return `La consulta usa ${b} parámetro(s) ($1, $2...) pero le pasaste ${a} valor(es).`;
  }
  if ((m = msg.match(/there is no parameter \$(\d+)/))) return `La consulta usa $${m[1]} pero no le pasaste ese valor.`;
  if (/cannot insert multiple commands into a prepared statement/.test(msg)) return "Desde el código se ejecuta una sola sentencia por llamada (sin ; en medio).";
  if ((m = msg.match(/syntax error at or near "(.+?)"/))) return `Error de sintaxis cerca de "${m[1]}".`;
  if (/syntax error at end of input/.test(msg)) return "La consulta está incompleta (falta algo al final).";
  if ((m = msg.match(/relation "(.+?)" does not exist/))) return `La tabla "${m[1]}" no existe. Mira la lista de tablas a la izquierda.`;
  if ((m = msg.match(/column "(.+?)" does not exist/))) return `La columna "${m[1]}" no existe. Revisa el nombre (o ponle el nombre de la tabla delante).`;
  if ((m = msg.match(/column reference "(.+?)" is ambiguous/))) return `La columna "${m[1]}" está en varias tablas: escribe tabla.${m[1]}.`;
  if ((m = msg.match(/column "(.+?)" must appear in the GROUP BY clause/))) {
    return `La columna "${m[1]}" tiene que ir en el GROUP BY o dentro de una función como count() o sum().`;
  }
  if ((m = msg.match(/function (.+?) does not exist/))) return `La función ${m[1]} no existe (o no acepta esos tipos de datos).`;
  if (/canceling statement due to statement timeout/.test(msg)) return "La consulta tardó demasiado (más de 3 segundos).";
  if (/division by zero/.test(msg)) return "División por cero.";
  if ((m = msg.match(/invalid input syntax for type (\w+): "(.*?)"/))) return `"${m[2]}" no es un valor válido de tipo ${m[1]}.`;
  if (/operator does not exist/.test(msg)) return "No se pueden comparar o combinar esos tipos de datos (p. ej. texto con número).";
  return msg;
}
