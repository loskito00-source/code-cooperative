import { FEATURES } from "@cdb/interpreter";
import { PRODUCT_NAMES, TICKS_PER_SECOND, World } from "@cdb/sim";
import { beforeAll, describe, expect, test } from "vitest";
import { GameDB, type QueryResult, type SavedQuery } from "../src/index.js";

/** Consultas típicas que un jugador escribiría (el juego empieza sin consultas guardadas). */
const EXAMPLE_QUERIES: SavedQuery[] = [
  {
    id: "ej-ventas",
    name: "Últimas ventas",
    sql: "SELECT id, sold_at, cashier, total, paid, change, result\nFROM sales\nORDER BY sold_at DESC\nLIMIT 20;",
  },
  {
    id: "ej-mas-vendidos",
    name: "Productos más vendidos",
    sql: "SELECT p.name, count(*) AS unidades, sum(si.price) AS ingresos\nFROM sale_items si\nJOIN products p ON p.id = si.product_id\nGROUP BY p.name\nORDER BY unidades DESC;",
  },
  {
    id: "ej-por-minuto",
    name: "Ventas por minuto",
    sql: "SELECT date_trunc('minute', sold_at) AS minuto,\n       count(*) AS ventas,\n       sum(total) AS ingresos\nFROM sales\nGROUP BY 1\nORDER BY 1 DESC;",
  },
  {
    id: "ej-faltantes",
    name: "Productos que faltaron",
    sql: "SELECT p.name, count(*) AS veces\nFROM stockouts s\nJOIN products p ON p.id = s.product_id\nGROUP BY p.name\nORDER BY veces DESC;",
  },
  {
    id: "ej-ganancia",
    name: "Ganancia por producto",
    sql: "SELECT p.name,\n       sum(si.price) AS ingresos,\n       count(*) * p.cost AS costo,\n       sum(si.price) - count(*) * p.cost AS ganancia\nFROM sale_items si\nJOIN products p ON p.id = si.product_id\nGROUP BY p.name, p.cost\nORDER BY ganancia DESC;",
  },
  {
    id: "ej-errores-caja",
    name: "Errores de la caja",
    sql: "SELECT result, count(*) AS veces,\n       sum(total - (paid - change)) AS diferencia\nFROM sales\nGROUP BY result;",
  },
  {
    id: "ej-perdidos",
    name: "Clientes que se fueron sin comprar",
    sql: "SELECT id, arrived_at, wanted, outcome\nFROM customers\nWHERE outcome <> 'compró'\nORDER BY arrived_at DESC;",
  },
];

const CAJERA = `
while True:
    if has_customer():
        total = 0
        for p in scan_item():
            total = total + price(p)
        give_change(take_payment(total) - total)
        next_customer()
`;

const REPONEDOR = `
def ir(x):
    while get_pos()[0] < x:
        move(East)
    while get_pos()[0] > x:
        move(West)
productos = ["pan", "leche", "huevos"]
while True:
    for i in range(3):
        s = get_shelves()[i]
        if s.stock() < 6:
            ir(WAREHOUSE[0])
            pick(productos[i])
            ir(s.pos()[0])
            place()
    wait()
`;

/** Juega 5 minutos guardando todo en la base de datos. */
async function partida() {
  const world = new World(11);
  for (const f of FEATURES) world.features.add(f);
  const db = new GameDB(world);
  await db.start();
  world.setScript("lupe", CAJERA);
  world.setScript("tono", REPONEDOR);
  world.warehouseStock.leche = 4; // se acaba: el resto lo trae el proveedor (supplier_purchases)
  world.runRobot("lupe");
  world.runRobot("tono");
  for (let i = 0; i < 5 * 60 * TICKS_PER_SECOND; i++) {
    world.step();
    db.ingest(world.drainEvents().flatMap((e) => (e.type === "record" ? [e.record] : [])));
  }
  await db.flush();
  return { world, db };
}

const ok = (r: Awaited<ReturnType<GameDB["run"]>>): QueryResult => {
  if (!r.ok) throw new Error(r.message + " | " + r.detail);
  return r;
};

describe("base de datos de la tienda", () => {
  let world: World;
  let db: GameDB;
  beforeAll(async () => {
    ({ world, db } = await partida());
  }, 60_000);

  test("cada tiquete del juego está en sales, con sus productos", async () => {
    const sales = ok(await db.systemRun("SELECT count(*) AS n FROM sales"));
    expect(Number(sales.rows[0][0])).toBe(world.tickets.length);
    const items = ok(await db.systemRun("SELECT count(*) FROM sale_items"));
    expect(Number(items.rows[0][0])).toBe(world.tickets.reduce((s, t) => s + t.items.length, 0));
  });

  test("los totales de la base cuadran con los tiquetes", async () => {
    const r = ok(await db.systemRun("SELECT sum(total) FROM sales WHERE result = 'ok'"));
    const expected = world.tickets.filter((t) => t.result === "ok").reduce((s, t) => s + t.total, 0);
    expect(Number(r.rows[0][0])).toBe(expected);
  });

  test("el stock de products es el de los estantes", async () => {
    const r = ok(await db.systemRun("SELECT name, stock FROM products ORDER BY id"));
    expect(r.rows.map(([n, s]) => [n, Number(s)])).toEqual(PRODUCT_NAMES.map((p) => [p, world.shelfStock(p)]));
    const w = ok(await db.systemRun("SELECT name, warehouse, shelf_x FROM products ORDER BY id"));
    // los premium no tienen estante en esta partida: shelf_x es null
    expect(w.rows.map(([n, q, x]) => [n, Number(q), x])).toEqual(PRODUCT_NAMES.map((p) => [p, world.warehouseStock[p], world.shelves.find((s) => s.product === p)?.x ?? null]));
  });

  test("las horas son la hora del juego (el día 1 va de 7:00 a 19:00 del 5 de enero de 2026)", async () => {
    const r = ok(await db.systemRun("SELECT min(arrived_at) >= '2026-01-05 07:00:00+00', max(arrived_at) <= '2026-01-05 19:00:00+00' FROM customers"));
    expect(r.rows[0]).toEqual([true, true]);
  });

  test("consultas típicas de análisis funcionan", async () => {
    for (const q of EXAMPLE_QUERIES) {
      const r = await db.systemRun(q.sql);
      expect(r.ok, `${q.name}: ${!r.ok ? r.detail : ""}`).toBe(true);
    }
    const top = ok(await db.systemRun(EXAMPLE_QUERIES.find((q) => q.id === "ej-mas-vendidos")!.sql));
    expect(top.columns).toEqual(["name", "unidades", "ingresos"]);
    expect(top.rows.length).toBeGreaterThan(0);
  });

  test("compras al proveedor y reposiciones quedan registradas", async () => {
    const r = ok(await db.systemRun("SELECT count(*), sum(total_cost) FROM supplier_purchases"));
    expect(Number(r.rows[0][0])).toBeGreaterThan(0);
    const re = ok(await db.systemRun("SELECT robot, sum(quantity) FROM restocks GROUP BY robot"));
    expect(re.rows[0][0]).toBe("Toño");
  });

  test("funciones de PostgreSQL: arrays, date_trunc, CTE y ventanas", async () => {
    const r = ok(
      await db.systemRun(`
        WITH por_minuto AS (
          SELECT date_trunc('minute', sold_at) AS minuto, sum(total) AS ingresos FROM sales GROUP BY 1
        )
        SELECT minuto, ingresos, sum(ingresos) OVER (ORDER BY minuto) AS acumulado FROM por_minuto ORDER BY minuto`),
    );
    expect(r.columns).toEqual(["minuto", "ingresos", "acumulado"]);
    const arr = ok(await db.systemRun("SELECT count(*) FROM customers WHERE 'pan' = ANY (wanted)"));
    expect(Number(arr.rows[0][0])).toBeGreaterThan(0);
  });

  test("el registro interno es invisible para el jugador: su base empieza vacía", async () => {
    expect(await db.tables()).toEqual([]);
    for (const sql of ["SELECT * FROM sales", "DELETE FROM sales", "SELECT * FROM products"]) {
      const r = await db.run(sql);
      expect(r.ok, sql).toBe(false);
      if (!r.ok) expect(r.message, sql).toMatch(/La tabla "(sales|products)" no existe/);
    }
    const qualified = await db.run("SELECT * FROM registro.sales");
    expect(qualified.ok).toBe(false);
    if (!qualified.ok) expect(qualified.message).toContain("no es tuyo");
    const still = ok(await db.systemRun("SELECT count(*) FROM sales"));
    expect(Number(still.rows[0][0])).toBe(world.tickets.length);
  });

  test("el jugador diseña sus tablas: CREATE, INSERT, SELECT, UPDATE, DROP", async () => {
    expect(ok(await db.run("CREATE TABLE prueba (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, nombre TEXT NOT NULL, precio BIGINT)")).note).toBe("Listo: se creó.");
    expect(ok(await db.run("INSERT INTO prueba (nombre, precio) VALUES ('pan', 2000), ('leche', 4500)")).note).toBe("Listo: 2 filas afectadas.");
    const sel = ok(await db.run("SELECT nombre, precio FROM prueba ORDER BY id"));
    expect(sel.rows).toEqual([["pan", 2000], ["leche", 4500]]);
    ok(await db.run("UPDATE prueba SET precio = 2100 WHERE nombre = 'pan'"));
    const dup = await db.run("CREATE TABLE prueba (x INT)");
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.message).toContain('La tabla "prueba" ya existe');
    ok(await db.run("DROP TABLE prueba"));
  });

  test("no deja escribir transacciones ni cambiar de rol", async () => {
    for (const sql of ["BEGIN; DELETE FROM registro.sales; COMMIT;", "RESET ROLE; DELETE FROM registro.sales", "SET ROLE postgres"]) {
      const r = await db.run(sql);
      expect(r.ok, sql).toBe(false);
      if (!r.ok) expect(r.message).toContain("los maneja el juego");
    }
  });

  test("consultas con parámetros $1 (para db.execute desde Python)", async () => {
    await db.playerQuery("CREATE TABLE ventas_jugador (total BIGINT NOT NULL, pagado BIGINT NOT NULL)");
    const ins = await db.playerQuery("INSERT INTO ventas_jugador (total, pagado) VALUES ($1, $2)", [6500, 10000]);
    expect(ins.affectedRows).toBe(1);
    const res = await db.playerQuery("SELECT total, pagado - total AS devuelta FROM ventas_jugador WHERE total > $1", [100]);
    expect(res.fields).toEqual(["total", "devuelta"]);
    expect(res.rows).toEqual([{ total: 6500, devuelta: 3500 }]);
    await expect(db.playerQuery("SELECT $1, $2", [1])).rejects.toThrow("parámetro");
    await expect(db.playerQuery("INSERT INTO ventas_jugador (total) VALUES (1)")).rejects.toThrow('Falta el valor de la columna "pagado"');
    await db.playerQuery("DROP TABLE ventas_jugador");
  });

  test("revisión del inventario: encuentra la tabla, repetidos y la fila TOTAL", async () => {
    const products = ["pan", "leche", "huevos"];
    expect((await db.inventoryStatus(products)).best).toBeNull();
    await db.run("CREATE TABLE inventario (producto TEXT, cantidad INT); INSERT INTO inventario VALUES (' Pan ', 40), ('LECHE', 30), ('leche', 30), ('TOTAL', 100)");
    let st = await db.inventoryStatus(products);
    expect(st.best).toMatchObject({ table: "inventario", counts: { pan: 1, leche: 2, huevos: 0 }, hasTotalRow: true });
    await db.run("DELETE FROM inventario; INSERT INTO inventario VALUES ('pan', 40), ('leche', 30), ('huevos', 36)");
    st = await db.inventoryStatus(products);
    expect(st.best).toMatchObject({ counts: { pan: 1, leche: 1, huevos: 1 }, hasTotalRow: false, rows: 3 });
    await db.resetPlayerSchema();
    expect((await db.inventoryStatus(products)).tables).toEqual([]);
  });

  test("errores traducidos al español", async () => {
    await db.run("CREATE TABLE prod (id BIGINT PRIMARY KEY, nombre TEXT); CREATE TABLE venta (id BIGINT PRIMARY KEY, prod_id BIGINT)");
    const cases: [string, string][] = [
      ["SELEC * FROM prod", 'Error de sintaxis cerca de "SELEC"'],
      ["SELECT * FROM ventas", 'La tabla "ventas" no existe'],
      ["SELECT precio FROM prod", 'La columna "precio" no existe'],
      ["SELECT nombre, count(*) FROM prod", 'La columna "prod.nombre" tiene que ir en el GROUP BY'],
      ["SELECT id FROM prod JOIN venta ON true", 'La columna "id" está en varias tablas'],
    ];
    for (const [sql, expected] of cases) {
      const r = await db.run(sql);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message, sql).toContain(expected);
    }
    await db.run("DROP TABLE prod; DROP TABLE venta");
  });

  test("varias sentencias: se muestra el resultado de la última que devuelve filas", async () => {
    const r = ok(await db.run("SELECT 1 AS a; SELECT 2 AS b"));
    expect(r.columns).toEqual(["b"]);
  });

  test("lista de tablas: solo las que creó el jugador", async () => {
    await db.run("CREATE TABLE ventas (id BIGINT PRIMARY KEY, total BIGINT, sold_at TIMESTAMPTZ)");
    const tables = await db.tables();
    expect(tables.map((t) => t.name)).toEqual(["ventas"]);
    expect(tables[0].columns.map((c) => c.name)).toEqual(["id", "total", "sold_at"]);
    await db.run("DROP TABLE ventas");
  });
});
