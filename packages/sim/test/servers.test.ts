import { FEATURES } from "@cdb/interpreter";
import { describe, expect, test } from "vitest";
import { NIGHT, slowdown, World } from "../src/index.js";

function mundo() {
  const w = new World(3);
  for (const f of FEATURES) w.features.add(f);
  w.customersEnabled = false;
  return w;
}

function correr(w: World, ticks: number) {
  for (let i = 0; i < ticks; i++) w.step();
}

/** Toño camina de un lado a otro: cuántas casillas avanza en `ticks`. */
const CAMINANTE = "n = 0\nwhile True:\n    move(East)\n    move(West)\n";
const pasos = (w: World) => w.robot("tono").vm!.totalOps;

describe("servidores: la CPU se reparte entre los robots", () => {
  test("la partida empieza con srv-01 (1 núcleo) y los dos robots conectados a él", () => {
    const w = mundo();
    expect(w.servers.map((s) => [s.hostname, s.ip, s.cores])).toEqual([["srv-01", "10.0.0.10", 1]]);
    expect(w.robots.map((r) => [r.id, r.ip, r.cpu.server])).toEqual([["tono", "10.0.0.21", "srv-01"], ["lupe", "10.0.0.22", "srv-01"]]);
  });

  test("con código que usa wait() la carga es baja y nadie va lento", () => {
    const w = mundo();
    w.setScript("lupe", "while True:\n    if has_customer():\n        next_customer()\n    wait()\n");
    w.setScript("tono", CAMINANTE);
    w.runRobot("lupe");
    w.runRobot("tono");
    correr(w, 200);
    const srv = w.server("srv-01")!;
    expect(srv.load).toBeLessThan(0.2);
    expect(slowdown(srv)).toBe(1); // el servidor no frena (la velocidad de cada robot sale del tamaño de su código)
  });

  test("un bucle sin wait() satura la CPU y hace más lento a TODOS los robots", () => {
    const rapido = mundo();
    rapido.setScript("tono", CAMINANTE);
    rapido.runRobot("tono");
    correr(rapido, 400);

    const lento = mundo();
    lento.setScript("tono", CAMINANTE);
    lento.setScript("lupe", "while True:\n    if has_customer():\n        next_customer()\n");
    lento.runRobot("tono");
    lento.runRobot("lupe");
    correr(lento, 400);

    const srv = lento.server("srv-01")!;
    expect(srv.load).toBeGreaterThan(0.85);
    expect(slowdown(srv)).toBeGreaterThan(1.4);
    // Toño camina bastante menos en el mismo tiempo, aunque su código es el mismo
    expect(pasos(lento)).toBeLessThan(pasos(rapido) * 0.6);
  });

  test("más núcleos aguantan el bucle: la carga baja a la mitad", () => {
    const w = mundo();
    w.server("srv-01")!.cores = 2;
    w.setScript("lupe", "while True:\n    pass\n");
    w.runRobot("lupe");
    correr(w, 200);
    expect(w.server("srv-01")!.load).toBeGreaterThan(0.4);
    expect(w.server("srv-01")!.load).toBeLessThan(0.6);
    expect(w.slowdown(w.robot("tono"))).toBe(1);
  });

  test("sin servidor o con el servidor apagado, el robot no arranca (y se detiene si se apaga)", () => {
    const w = mundo();
    w.setScript("tono", CAMINANTE);
    expect(w.attach("tono", null)).toEqual({ ok: true });
    w.runRobot("tono");
    expect(w.isRunning("tono")).toBe(false);
    expect(w.robot("tono").console.at(-1)!.text).toBe("No se puede ejecutar: Toño no está conectado a ningún servidor.");

    expect(w.attach("tono", "10.0.0.10")).toEqual({ ok: true });
    expect(w.attach("tono", "srv-09")).toEqual({ ok: false, reason: "no existe el servidor srv-09" });
    w.runRobot("tono");
    correr(w, 5);
    expect(w.isRunning("tono")).toBe(true);
    w.setServerOnline("srv-01", false);
    expect(w.isRunning("tono")).toBe(false);
    expect(w.robot("tono").console.at(-1)!.text).toBe("■ Se detuvo: el servidor srv-01 se apagó.");
    w.runRobot("tono");
    expect(w.robot("tono").console.at(-1)!.text).toBe("No se puede ejecutar: el servidor srv-01 está apagado.");
  });

  test("la RAM limita cuántos robots corren en un servidor", () => {
    const w = mundo();
    w.server("srv-01")!.ramGb = 1; // 0,5 GB del sistema + 0,5 GB de un robot
    w.setScript("tono", CAMINANTE);
    w.setScript("lupe", "while True:\n    wait()\n");
    w.runRobot("tono");
    w.runRobot("lupe");
    expect(w.isRunning("lupe")).toBe(false);
    expect(w.robot("lupe").console.at(-1)!.text).toBe("No se puede ejecutar: no hay memoria RAM libre en srv-01 para otro robot.");
  });

  test("la primera noche dura 20 minutos", () => {
    expect(NIGHT.firstMs).toBe(20 * 60 * 1000);
  });
});
