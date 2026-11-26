import { FEATURES } from "@cdb/interpreter";
import { describe, expect, test } from "vitest";
import { applyWorld, encodeWorld, World } from "../src/index.js";

function avanzada() {
  const w = new World(11);
  for (const f of FEATURES) w.features.add(f);
  w.money = 200_000;
  w.buy("estante1");
  w.placeShelf(5, 2);
  w.buy("caja2");
  w.placeRegister(6, 3);
  w.buy("robot1");
  w.buy("local1");
  w.renameRobot("tono", "Bartolo");
  w.shelves.forEach((s, i) => Object.assign(s, { product: (["pan", "leche", "huevos"] as const)[i % 3], stock: 8 }));
  w.meta.storeOpen = true;
  for (let i = 0; i < 1500; i++) w.step(); // llegan clientes, hacen fila...
  return w;
}

describe("guardar y cargar el mundo", () => {
  test("lo guardado vuelve igual (y como JSON de verdad)", () => {
    const w = avanzada();
    const json = JSON.parse(JSON.stringify(encodeWorld(w, { vfs: true, workbooks: true, tickets: true })));
    const w2 = new World(1);
    applyWorld(w2, json);
    expect(encodeWorld(w2, { vfs: true, workbooks: true, tickets: true })).toEqual(encodeWorld(w, { vfs: true, workbooks: true, tickets: true }));
    expect(w2.robot("tono").name).toBe("Bartolo");
    expect(w2.registers.length).toBe(2);
    expect(w2.register).toBe(w2.registers[0]);
    // las filas apuntan a los clientes del mundo cargado
    for (const r of w2.registers) for (const c of r.queue) expect(w2.customers).toContain(c);
    for (const c of w2.customers) if (c.register) expect(w2.registers).toContain(c.register);
    expect(w2.tileAt(10, 2)).toBe("floor"); // el terreno 1 ya estaba comprado
    expect(w2.meta.storeOpen).toBe(true);
  });

  test("después de cargar, la simulación sigue igual que la original", () => {
    const w = avanzada();
    const w2 = new World(1);
    applyWorld(w2, JSON.parse(JSON.stringify(encodeWorld(w, { vfs: true, workbooks: true, tickets: true }))));
    for (let i = 0; i < 600; i++) {
      w.step();
      w2.step();
    }
    expect(w2.money).toBe(w.money);
    expect(w2.customers.map((c) => [c.id, c.x, c.y])).toEqual(w.customers.map((c) => [c.id, c.x, c.y]));
  });

  test("los servidores guardan su disco (VFS)", () => {
    const w = new World(2);
    w.server("srv-01")!.fs.write("/home/admin/nota.txt", "hola");
    const w2 = new World(3);
    applyWorld(w2, JSON.parse(JSON.stringify(encodeWorld(w, { vfs: true }))));
    expect(w2.server("srv-01")!.fs.read("/home/admin/nota.txt")).toBe("hola");
  });

  test("renombrar robots: nombre limpio y sin repetir", () => {
    const w = new World(1);
    expect(w.renameRobot("tono", "  Don   Pepe  ")).toEqual({ ok: true });
    expect(w.robot("tono").name).toBe("Don Pepe");
    expect(w.renameRobot("lupe", "don pepe")).toEqual({ ok: false, reason: "otro robot ya se llama así" });
    expect(w.renameRobot("lupe", "   ")).toEqual({ ok: false, reason: "escribe un nombre" });
  });
});
