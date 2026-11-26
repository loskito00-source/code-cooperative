import { FEATURES, VM } from "@cdb/interpreter";
import { describe, expect, test } from "vitest";
import { DELIVERY, PRODUCTS, SUPPLIER, supplierWorkbook, TICKS_PER_SECOND, World } from "../src/index.js";

function mundo(seed = 3) {
  const w = new World(seed);
  for (const f of FEATURES) w.features.add(f);
  return w;
}

function correr(w: World, ticks: number) {
  for (let i = 0; i < ticks; i++) w.step();
}

/** Corre un script con pandas (como inventario.py) y devuelve lo que imprimió. */
function script(w: World, source: string) {
  const out: string[] = [];
  const libs = w.libraries();
  const vm = new VM("import pandas as pd\n" + source, { globals: libs.globals, nativeModules: libs.nativeModules, opsPerTick: 100_000, onPrint: (t) => out.push(t) });
  for (let i = 0; i < 100 && vm.status === "running"; i++) vm.tick();
  return { out: out.join("\n"), error: vm.error?.format() ?? null };
}

describe("Distribuidora El Surtidor", () => {
  test("un pedido se paga al hacerlo y el repartidor llega un minuto después con su Excel", () => {
    const w = mundo();
    w.money = 500_000;
    const r = w.orderGoods([{ product: "queso", cases: 2 }, { product: "pan", cases: 1 }]);
    expect(r.ok).toBe(true);
    const total = 2 * SUPPLIER.caseUnits * PRODUCTS.queso.cost + SUPPLIER.caseUnits * PRODUCTS.pan.cost;
    expect(w.money).toBe(500_000 - total);
    expect(w.goodsInTransit()).toHaveLength(1);
    correr(w, SUPPLIER.deliveryTicks - 1);
    expect(w.workbooks.map((b) => b.filename)).toEqual(["entrega_distribuidor.xlsx"]);
    w.drainEvents();
    correr(w, 1);
    expect(w.goodsInTransit()).toHaveLength(0);
    expect(w.workbooks.map((b) => b.filename)).toEqual(["entrega_distribuidor.xlsx", "pedido_1.xlsx"]);
    expect(w.drainEvents().some((e) => e.type === "goods" && e.order.file === "pedido_1.xlsx")).toBe(true);
    // sin base de datos (simulación sola), la mercancía entra directo al almacén
    expect(w.warehouseStock.queso).toBe(20);
    expect(w.warehouseStock.pan).toBe(40 + 10);
  });

  test("con la base de datos del jugador, la mercancía no entra al almacén hasta migrar el Excel", () => {
    const w = mundo();
    w.warehouseFromDb = true;
    w.money = 500_000;
    w.orderGoods([{ product: "vino", cases: 1 }]);
    correr(w, SUPPLIER.deliveryTicks);
    expect(w.warehouseStock.vino).toBe(0);
  });

  test("valida el pedido: vacío, sin dinero, demasiadas cajas", () => {
    const w = mundo();
    expect(w.orderGoods([])).toMatchObject({ ok: false, reason: "el pedido está vacío" });
    w.money = 100;
    expect(w.orderGoods([{ product: "vino", cases: 1 }])).toMatchObject({ ok: false, reason: "no alcanza el dinero" });
    w.money = 10_000_000;
    expect(w.orderGoods([{ product: "vino", cases: SUPPLIER.maxCases + 1 }]).ok).toBe(false);
    expect(w.money).toBe(10_000_000);
  });

  test("el Excel de cada pedido tiene siempre la misma estructura que la primera entrega", () => {
    for (let seed = 1; seed <= 30; seed++) {
      let k = seed;
      const pick = (n: number) => (k = (k * 7 + 3) % 101) % n;
      const book = supplierWorkbook(seed, [{ product: "miel", cases: 3 }, { product: "leche", cases: 2 }], () => "2026-03-01", pick);
      const sheet = book.sheets[0];
      expect(book.filename).toBe(`pedido_${seed}.xlsx`);
      expect(sheet.name).toBe(DELIVERY.sheets[0].name);
      expect(sheet.columns).toEqual(DELIVERY.sheets[0].columns);
      const last = sheet.rows.at(-1)!;
      expect(last[1]).toBe("TOTAL");
      const data = sheet.rows.slice(0, -1);
      expect(last[3]).toBe(data.reduce((s, r) => s + (r[3] as number), 0));
      // los nombres vienen desordenados, pero limpios son productos de verdad
      expect(new Set(data.map((r) => String(r[1]).trim().toLowerCase()))).toEqual(new Set(["miel", "leche"]));
      expect(data.find((r) => r[0] === PRODUCTS.miel.code)![3]).toBe(30);
    }
  });

  test("pandas lee el Excel del pedido y el mismo script de migración sirve", () => {
    const w = mundo();
    w.money = 500_000;
    w.orderGoods([{ product: "chocolate", cases: 2 }, { product: "aceite", cases: 1 }]);
    correr(w, SUPPLIER.deliveryTicks);
    const r = script(w, 'hoja = pd.read_excel("pedido_1.xlsx")\nhoja.select("A1", "G40")');
    expect(r.error).toMatch(/se sale de la hoja/);
    const ok = script(w, `
hoja = pd.read_excel("pedido_1.xlsx")
print(hoja.file)
vistos = {}
for fila in hoja.select("A2:G4"):
    nombre = fila["Producto"].strip().lower()
    if nombre == "total" or nombre in vistos:
        continue
    vistos[nombre] = fila["Cantidad"]
print(vistos)
`);
    expect(ok.error).toBeNull();
    expect(ok.out.split("\n")[0]).toBe("pedido_1.xlsx");
    expect(ok.out).toMatch(/'chocolate': 20/);
    expect(ok.out).toMatch(/'aceite': 10/);
  });

  test("pick() no le compra lo premium al proveedor del barrio", () => {
    const w = mundo();
    w.money = 1_000_000;
    const tono = w.robot("tono");
    w.setScript("tono", 'print(pick("queso"))\nprint(pick("pan"))');
    w.runRobot("tono");
    correr(w, 200);
    const text = tono.console.map((c) => c.text).join("\n");
    expect(text).toMatch(/Pídelo a la Distribuidora El Surtidor/);
    expect(tono.cargo).toEqual({ product: "pan", n: 5 });
  });

  test("lo premium en los estantes: los clientes lo piden más y llegan más clientes", () => {
    const count = (premium: boolean) => {
      const w = mundo(11);
      w.shelves.forEach((s, i) => Object.assign(s, { product: premium ? (["vino", "queso", "chocolate", "pan"] as const)[i] : (["pan", "leche", "huevos", "pan"] as const)[i], stock: 10, capacity: 10 ** 9 }));
      w.shelves.forEach((s) => (s.stock = 10 ** 8));
      const wanted: string[] = [];
      for (let i = 0; i < 30 * 60 * TICKS_PER_SECOND; i++) {
        w.step();
        for (const e of w.drainEvents()) if (e.type === "record" && e.record.kind === "customer_arrived") wanted.push(...e.record.wanted);
        w.customers = [];
        w.queue = [];
      }
      return wanted;
    };
    const base = count(false);
    const rich = count(true);
    expect(base.every((p) => ["pan", "leche", "huevos"].includes(p))).toBe(true);
    const premiumShare = rich.filter((p) => ["vino", "queso", "chocolate"].includes(p)).length / rich.length;
    expect(premiumShare).toBeGreaterThan(0.5);
    expect(rich.length).toBeGreaterThan(base.length * 1.15);
  });
});
