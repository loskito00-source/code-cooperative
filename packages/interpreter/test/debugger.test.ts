import { describe, expect, test } from "vitest";
import { Action, PyBuiltin, VM } from "../src/index.js";
import { errorOf, output, py } from "./helpers.js";

describe("f-strings", () => {
  test.each([
    ['nombre = "Lupe"\nprint(f"Hola {nombre}")', "Hola Lupe"],
    ['total = 6500\nprint(f"Total: {total}")', "Total: 6500"],
    ['a = 2\nb = 3\nprint(f"{a} + {b} = {a + b}")', "2 + 3 = 5"],
    ['print(f"{10 / 4:.2f}")', "2.50"],
    ['print(f"${1234567:,}")', "$1,234,567"],
    ['print(f"{1234.5:,.0f}")', "1,234"],
    ['print(f"[{7:>4}] [{7:<4}] [{7:04d}]")', "[   7] [7   ] [0007]"],
    ['print(f"{0.19:.0%}")', "19%"],
    ['d = {"pan": 3}\nprint(f"Quedan {d[\'pan\']} panes")', "Quedan 3 panes"],
    ["print(f'{{llaves}} y {1}')", "{llaves} y 1"],
    ['print(f"{[1, 2]} {None} {True}")', "[1, 2] None True"],
    ['x = "pan"\nprint(f"{x.upper()}!")', "PAN!"],
  ])("%s", (src, expected) => {
    expect(output(src)).toBe(expected);
  });

  test("errores de f-string en español y en la línea correcta", () => {
    expect(errorOf('x = 1\nprint(f"{x")')).toBe("Línea 2: en un f-string, falta cerrar '}'");
    expect(errorOf('print(f"{}")')).toBe("Línea 1: en un f-string, hay unas llaves {} vacías");
    expect(errorOf('x = 1\n\nprint(f"{y}")')).toBe("Línea 3: 'y' no existe");
    expect(errorOf('print(f"{\'pan\':.2f}")')).toBe("Línea 1: el formato '.2f' es para números, no para texto");
  });

  test("sumar texto y número sigue siendo error (como en Python) pero con pista", () => {
    expect(errorOf('print("Total: " + 5)')).toContain("Usa str(...) para convertir a texto");
  });
});

describe("depurador", () => {
  const SRC = py`
    total = 0
    for i in range(3):
        total = total + i
    fin = True
  `;

  test("se detiene en un punto de parada antes de ejecutar la línea", () => {
    const vm = new VM(SRC, { breakpoints: new Set([4]) });
    for (let i = 0; i < 10 && vm.status !== "paused"; i++) vm.tick();
    expect(vm.status).toBe("paused");
    expect(vm.line).toBe(4);
    expect(vm.pauseReason).toBe("punto");
    expect(vm.getGlobal("fin")).toBeUndefined();
    expect(vm.getGlobal("total")).toBe(3);
    vm.resume();
    vm.tick();
    expect(vm.status).toBe("done");
    expect(vm.getGlobal("fin")).toBe(true);
  });

  test("paso a paso: una línea por vez, pasando por la cabecera del for", () => {
    const vm = new VM(SRC);
    vm.pause();
    const lines: number[] = [];
    vm.tick();
    while (vm.status === "paused") {
      lines.push(vm.line);
      vm.step();
      vm.tick();
    }
    expect(lines).toEqual([1, 2, 3, 2, 3, 2, 3, 4]);
    expect(vm.status).toBe("done");
  });

  test("pausado no avanza aunque pasen ticks", () => {
    const vm = new VM("while True:\n    x = 1", { breakpoints: new Set([2]) });
    vm.tick();
    const ops = vm.totalOps;
    for (let i = 0; i < 20; i++) expect(vm.tick()).toBe("paused");
    expect(vm.totalOps).toBe(ops);
  });

  test("pausar en medio de una acción espera a que termine", () => {
    let moves = 0;
    const move = new PyBuiltin("move", () => new Action(4, () => ++moves));
    const vm = new VM("move()\nmove()", { globals: { move } });
    vm.tick(); // empieza el primer move
    vm.pause();
    for (let i = 0; i < 10 && vm.status !== "paused"; i++) vm.tick();
    expect(vm.status).toBe("paused");
    expect(vm.line).toBe(2);
    expect(moves).toBe(1);
  });

  test("los puntos de parada se pueden cambiar mientras corre", () => {
    const bps = new Set<number>();
    const vm = new VM("while True:\n    x = 1\n    y = 2", { breakpoints: bps, opsPerTick: 5 });
    vm.tick();
    expect(vm.status).toBe("running");
    bps.add(3);
    for (let i = 0; i < 10 && vm.status !== "paused"; i++) vm.tick();
    expect(vm.status).toBe("paused");
    expect(vm.line).toBe(3);
  });

  test("inspect() muestra locales de la función y globales del script", () => {
    const vm = new VM(
      py`
        precios = {"pan": 2000}
        def cobrar(item, cantidad):
            subtotal = precios[item] * cantidad
            return subtotal
        total = cobrar("pan", 3)
      `,
      { breakpoints: new Set([4]) },
    );
    for (let i = 0; i < 10 && vm.status !== "paused"; i++) vm.tick();
    const vars = vm.inspect();
    expect(vars.filter((v) => v.scope === "local").map((v) => `${v.name}=${v.value}`)).toEqual(["item='pan'", "cantidad=3", "subtotal=6000"]);
    expect(vars.find((v) => v.name === "precios")).toMatchObject({ scope: "global", type: "diccionario", value: "{'pan': 2000}" });
    expect(vars.some((v) => v.name === "cobrar")).toBe(false); // las funciones no se listan
  });

  test("no se detiene dentro de shared.py", () => {
    const vm = new VM("import shared\nshared.f()", { modules: { shared: "def f():\n    return 1" }, breakpoints: new Set([2]) });
    vm.pause();
    vm.tick();
    expect(vm.line).toBe(1);
    vm.step();
    vm.tick();
    expect(vm.line).toBe(2);
    vm.step();
    vm.tick();
    expect(vm.status).toBe("done");
  });
});
