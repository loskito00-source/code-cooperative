import { VM } from "@cdb/interpreter";
import { DELIVERY_PRODUCTS, PRODUCT_NAMES, TICKS_PER_SECOND, World } from "@cdb/sim";
import { beforeEach, describe, expect, test } from "vitest";
import { GameDB } from "../src/index.js";

/** Corre un script como inventario.py (toda la sintaxis, con db y pandas) esperando las consultas. */
async function script(world: World, source: string) {
  const out: string[] = [];
  const libs = world.libraries();
  const vm = new VM(source, { globals: libs.globals, nativeModules: libs.nativeModules, opsPerTick: 100_000, onPrint: (t) => out.push(t) });
  for (let i = 0; i < 5000 && (vm.status === "running" || vm.status === "waiting"); i++) {
    vm.tick();
    if (vm.waitingAsync) await new Promise((r) => setTimeout(r, 1));
  }
  return { vm, out, error: vm.error?.format() ?? null };
}

let world: World;
let db: GameDB;
beforeEach(async () => {
  world = new World(3);
  db = new GameDB(world);
  await db.start();
  world.sql = { query: (sql, params) => db.playerQuery(sql, params) };
}, 30_000);

const SOLUCION = `
import pandas as pd
hoja = pd.read_excel("entrega_distribuidor.xlsx")
cursor.execute("CREATE TABLE productos (codigo TEXT PRIMARY KEY, nombre TEXT NOT NULL UNIQUE, categoria TEXT, cantidad INT NOT NULL, precio BIGINT NOT NULL, costo BIGINT NOT NULL, vence DATE)")
vistos = []
for fila in hoja.select("A1", "G6"):
    nombre = fila["Producto"].strip().lower()
    if nombre == "total" or nombre in vistos:
        continue
    vistos.append(nombre)
    cursor.execute("INSERT INTO productos VALUES (%s, %s, %s, %s, %s, %s, %s)",
                   (fila["Código"], nombre, fila["Categoría"], fila["Cantidad"], fila["Precio Unitario"], fila["Costo Unitario"], fila["Vence"]))
print(f"subí {len(vistos)} productos")
print(cursor.fetchval("SELECT precio FROM productos WHERE nombre = %s", "leche"))
fila = cursor.fetchrow("SELECT nombre, cantidad FROM productos ORDER BY cantidad DESC LIMIT 1")
print(fila["nombre"], fila["cantidad"])
print(len(cursor.fetch("SELECT * FROM productos")))
print(cursor.execute("UPDATE productos SET cantidad = cantidad - 1 WHERE nombre = $1", "pan"))
`;

describe("misión: organiza tu inventario", () => {
  test("la solución completa: select -> Python -> cursor.execute con %s y $1", async () => {
    const r = await script(world, SOLUCION);
    expect(r.error).toBeNull();
    expect(r.out).toEqual(["subí 3 productos", "4500", "pan 40", "3", "UPDATE 1"]);
    const st = await db.inventoryStatus(DELIVERY_PRODUCTS);
    expect(st.best).toMatchObject({ table: "productos", counts: { pan: 1, leche: 1, huevos: 1 }, hasTotalRow: false, rows: 3 });
  });

  test("el almacén es la tabla del jugador: se lee la cantidad y se descuenta al sacar", async () => {
    expect((await script(world, SOLUCION)).error).toBeNull();
    const src = await db.warehouseSource(DELIVERY_PRODUCTS);
    // la solución ya restó 1 pan con un UPDATE
    expect(src).toMatchObject({ table: "productos", nameCol: "nombre", qtyCol: "cantidad", stock: { pan: 39, leche: 30, huevos: 36 } });
    await db.takeFromWarehouse(src!, "leche", 5);
    expect((await db.warehouseSource(DELIVERY_PRODUCTS))!.stock.leche).toBe(25);
  });

  test("sin columna de cantidad el almacén queda en 0", async () => {
    await db.run("CREATE TABLE cosas (producto TEXT)");
    await db.run("INSERT INTO cosas VALUES ('pan'), ('leche'), ('huevos')");
    expect(await db.warehouseSource(DELIVERY_PRODUCTS)).toMatchObject({ qtyCol: null, stock: { pan: 0, leche: 0, huevos: 0 } });
  });

  test("subir la hoja sin limpiar: repetidos y la fila TOTAL quedan marcados", async () => {
    await db.run("CREATE TABLE inv (producto TEXT, cantidad INT)");
    const r = await script(world, `
import pandas as pd
for fila in pd.read_excel("entrega_distribuidor.xlsx").select("B1:D6"):
    cursor.execute("INSERT INTO inv VALUES (%s, %s)", (fila["Producto"], fila["Cantidad"]))
`);
    expect(r.error).toBeNull();
    const st = await db.inventoryStatus(DELIVERY_PRODUCTS);
    expect(st.best).toMatchObject({ counts: { pan: 1, leche: 2, huevos: 1 }, hasTotalRow: true });
  });

  test("insertar en una tabla que no existe: error claro", async () => {
    const r = await script(world, 'cursor.execute("INSERT INTO productos VALUES (%s)", ("pan",))');
    expect(r.error).toContain('La tabla "productos" no existe');
  });

  test("la cajera guarda cada venta con SQL desde su código", async () => {
    await db.run("CREATE TABLE ventas (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, total BIGINT NOT NULL, pagado BIGINT NOT NULL)");
    world.shelves.forEach((s, i) => Object.assign(s, { product: (["pan", "leche", "huevos"] as const)[i % 3], stock: 10 }));
    world.features.add("for");
    world.setScript("lupe", `
while True:
    if has_customer():
        total = 0
        for p in scan_item():
            total = total + price(p)
        pago = take_payment(total)
        db.execute("INSERT INTO ventas (total, pagado) VALUES ($1, $2)", total, pago)
        give_change(pago - total)
        next_customer()
`);
    world.runRobot("lupe");
    for (let i = 0; i < 3 * 60 * TICKS_PER_SECOND; i++) {
      world.step();
      if (world.robot("lupe").vm?.waitingAsync) await new Promise((r) => setTimeout(r, 1));
    }
    expect(world.robot("lupe").vm!.error).toBeNull();
    const res = await db.run("SELECT count(*), sum(total) FROM ventas");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(Number(res.rows[0][0])).toBe(world.tickets.length);
      expect(Number(res.rows[0][1])).toBe(world.tickets.reduce((s, t) => s + t.total, 0));
    }
  }, 30_000);

  test("errores de SQL desde Python llegan en español y en la línea correcta", async () => {
    const r = await script(world, 'x = 1\ndb.execute("INSERT INTO nada VALUES (1)")');
    expect(r.error).toBe('Línea 2: SQL: La tabla "nada" no existe. Mira la lista de tablas a la izquierda.');
    const r2 = await script(world, 'db.execute("DELETE FROM sales")');
    expect(r2.error).toContain('La tabla "sales" no existe');
  });
});

describe("pedidos de El Surtidor: el mismo script migra cada Excel", () => {
  const MIGRAR = (archivo: string) => `
import pandas as pd
hoja = pd.read_excel("${archivo}")
vistos = []
for fila in hoja.select("A1", hoja.last_cell):
    nombre = fila["Producto"].strip().lower()
    if nombre == "total" or nombre in vistos:
        continue
    vistos.append(nombre)
    ya = cursor.fetchval("SELECT cantidad FROM productos WHERE nombre = %s", (nombre,))
    if ya is None:
        cursor.execute("INSERT INTO productos VALUES (%s, %s, %s, %s, %s, %s, %s)",
                       (fila["Código"], nombre, fila["Categoría"], fila["Cantidad"], fila["Precio Unitario"], fila["Costo Unitario"], fila["Vence"]))
    else:
        cursor.execute("UPDATE productos SET cantidad = cantidad + %s WHERE nombre = %s", (fila["Cantidad"], nombre))
print(vistos)
`;

  test("primera entrega + un pedido con productos nuevos y repetidos: el almacén los ve", async () => {
    world.warehouseFromDb = true;
    await script(world, `cursor.execute("CREATE TABLE productos (codigo TEXT PRIMARY KEY, nombre TEXT NOT NULL UNIQUE, categoria TEXT, cantidad INT NOT NULL, precio BIGINT NOT NULL, costo BIGINT NOT NULL, vence DATE)")`);
    expect((await script(world, MIGRAR("entrega_distribuidor.xlsx"))).error).toBeNull();
    world.money = 1_000_000;
    expect(world.orderGoods([{ product: "vino", cases: 2 }, { product: "pan", cases: 1 }]).ok).toBe(true);
    for (let i = 0; i < 60 * TICKS_PER_SECOND; i++) world.step();
    expect(world.workbooks.at(-1)!.filename).toBe("pedido_1.xlsx");
    // antes de migrar, el almacén no tiene vino
    const before = await db.warehouseSource(PRODUCT_NAMES);
    expect(before!.stock.vino).toBe(0);
    const r = await script(world, MIGRAR("pedido_1.xlsx"));
    expect(r.error).toBeNull();
    const after = await db.warehouseSource(PRODUCT_NAMES);
    expect(after!.stock.vino).toBe(20);
    expect(after!.stock.pan).toBe(40 + 10);
    expect(after!.stock.leche).toBe(30);
  });
});
