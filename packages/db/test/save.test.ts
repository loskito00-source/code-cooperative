import { World } from "@cdb/sim";
import { describe, expect, test } from "vitest";
import { GameDB } from "../src/index.js";

describe("guardar y cargar la base del jugador (pg_dump)", () => {
  test("las tablas del jugador y el registro vuelven iguales en una base nueva", async () => {
    const w = new World(1);
    const db = new GameDB(w);
    await db.start();
    const r = await db.run(`CREATE TABLE inventario (id serial PRIMARY KEY, nombre text UNIQUE NOT NULL, cantidad int DEFAULT 0 CHECK (cantidad >= 0));
      INSERT INTO inventario (nombre, cantidad) VALUES ('pan', 40), ('leche', 30);
      CREATE VIEW poquito AS SELECT nombre FROM inventario WHERE cantidad < 35;`);
    expect(r.ok).toBe(true);
    db.ingest([{ kind: "customer_arrived", customerId: 1, at: "2026-01-05T07:00:00.000Z", wanted: ["pan"] }]);
    await db.flush();
    // mientras corre pg_dump llegan ventas y consultas (como en el juego): no deben caer en su transacción de solo lectura
    const exporting = db.exportState();
    db.ingest([{ kind: "customer_arrived", customerId: 5, at: "2026-01-05T07:00:30.000Z", wanted: ["leche"] }]);
    const during = db.run("INSERT INTO inventario (nombre, cantidad) VALUES ('queso', 2)");
    void db.flush();
    const saved = await exporting;
    expect((await during).ok).toBe(true);
    await db.run("DELETE FROM inventario WHERE nombre = 'queso'");
    expect(saved.public.length).toBeLessThan(20_000);
    // la sesión sigue funcionando después de pg_dump (y se puede escribir: antes quedaba en solo lectura)
    expect((await db.run("SELECT count(*) AS n FROM inventario")).ok).toBe(true);
    expect((await db.run("INSERT INTO inventario (nombre, cantidad) VALUES ('miel', 1)")).ok).toBe(true);
    db.ingest([{ kind: "customer_arrived", customerId: 9, at: "2026-01-05T07:02:00.000Z", wanted: ["pan"] }]);
    await db.flush();
    expect(await db.systemRun("SELECT count(*)::int FROM customers")).toMatchObject({ ok: true, rows: [[3]] });
    await db.run("DELETE FROM inventario WHERE nombre = 'miel'");

    const db2 = new GameDB(new World(2));
    await db2.start();
    await db2.importState(JSON.parse(JSON.stringify(saved)));
    const inv = await db2.run("SELECT nombre, cantidad FROM inventario ORDER BY id");
    expect(inv).toMatchObject({ ok: true, rows: [["pan", 40], ["leche", 30]] });
    expect(await db2.run("SELECT * FROM poquito")).toMatchObject({ ok: true, rows: [["leche"]] });
    // la secuencia sigue donde iba y el jugador sigue siendo dueño de su tabla
    expect((await db2.run("INSERT INTO inventario (nombre) VALUES ('huevos') RETURNING id")) as { rows: unknown[][] }).toMatchObject({ rows: [[3]] });
    expect((await db2.run("DROP VIEW poquito")).ok).toBe(true);
    expect(await db2.systemRun("SELECT count(*)::int FROM customers")).toMatchObject({ ok: true, rows: [[1]] });
    // y el registro sigue recibiendo datos
    db2.ingest([{ kind: "customer_arrived", customerId: 2, at: "2026-01-05T07:01:00.000Z", wanted: ["leche"] }]);
    await db2.flush();
    expect(await db2.systemRun("SELECT count(*)::int FROM customers")).toMatchObject({ ok: true, rows: [[2]] });
  }, 60_000);
});
