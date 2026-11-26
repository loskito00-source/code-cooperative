import { describe, expect, test } from "vitest";
import { CODE_SPEED, measureCode, speedFactor, World } from "../src/index.js";

describe("tamaño del código = velocidad del robot", () => {
  test("cuentan instrucciones, no comentarios ni líneas en blanco", () => {
    const m = measureCode("# hola\n\nx = 1\nwhile True:\n    # nada\n    if x:\n        wait()\n")!;
    expect(m.own).toBe(4); // x = 1, while, if, wait()
    expect(m.total).toBe(4);
    expect(measureCode("while True\n")).toBeNull(); // error de sintaxis
  });

  test("menos código = más rápido; más código = más lento (con tope)", () => {
    expect(speedFactor(CODE_SPEED.normal)).toBe(1);
    expect(speedFactor(4)).toBeLessThan(1);
    expect(speedFactor(0)).toBe(CODE_SPEED.min);
    expect(speedFactor(60)).toBe(2);
    expect(speedFactor(500)).toBe(CODE_SPEED.max);
  });

  const shared = `
def ayuda(n):
    return n + 1

def larga():
    a = 1
    b = 2
    c = 3
    return ayuda(a + b + c)

def otra():
    pass
`;

  test("la función importada de shared cuenta, con las que ella llama", () => {
    const m = measureCode("import shared\nshared.larga()\n", shared)!;
    expect(m.own).toBe(2);
    expect(m.sharedFunctions).toEqual(["ayuda", "larga"]); // larga llama a ayuda; otra no se usa
    expect(m.shared).toBe(2 + 5); // ayuda (def + return) + larga (def + 4)
    expect(m.total).toBe(9);
  });

  test("from shared import y alias también cuentan", () => {
    expect(measureCode("from shared import larga as l\nl()\n", shared)!.sharedFunctions).toEqual(["ayuda", "larga"]);
    expect(measureCode("import shared as s\ns.ayuda(1)\n", shared)!.shared).toBe(2);
  });

  test("usar el módulo sin punto (guardarlo o pasarlo) cuenta todo shared", () => {
    const m = measureCode("import shared\nm = shared\nm.otra()\n", shared)!;
    expect(m.sharedFunctions).toEqual(["ayuda", "larga", "otra"]);
  });

  test("lo que shared ejecuta al importarse siempre cuenta", () => {
    const m = measureCode("import shared\n", "x = 1\ny = 2\ndef f():\n    pass\n")!;
    expect(m.shared).toBe(2);
  });

  test("sin import, shared no cuenta", () => {
    expect(measureCode("wait()\n", shared)!.shared).toBe(0);
  });

  test("un robot con código corto camina más rápido que uno con código largo", () => {
    const pasos = (relleno: number) => {
      const w = new World(1);
      const extra = Array.from({ length: relleno }, (_, i) => `v${i} = ${i}`).join("\n");
      w.setScript("lupe", `${extra}\nwhile True:\n    move(North)\n`);
      w.runRobot("lupe");
      for (let i = 0; i < 40; i++) w.step();
      return w.robot("lupe").y;
    };
    expect(pasos(0)).toBeGreaterThan(pasos(60));
  });
});
