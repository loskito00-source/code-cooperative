import { describe, expect, test } from "vitest";
import { Action, HostObject, PyBuiltin, PyList, VM, type Value } from "../src/index.js";
import { errorOf, output } from "./helpers.js";

/** Un "vector" de juguete con protocolo: v[i], len(v), for, print, v * 2, v > 1. */
function vector(items: number[]): HostObject {
  const self: HostObject = new HostObject("vector", {
    total: new PyBuiltin("total", () => items.reduce((a, b) => a + b, 0)),
  }, undefined, {
    getItem: (k) => items[k as number],
    setItem: (k, v) => void (items[k as number] = v as number),
    len: () => items.length,
    iter: () => [...items],
    repr: () => `vector(${items.join(", ")})`,
    getAttr: (name) => (name === "size" ? items.length : undefined),
    setAttr: (name, v) => {
      if (name === "first") items[0] = v as number;
    },
    binop: (op, other, reflected) => (op === "*" && typeof other === "number" ? vector(items.map((x) => x * other)) : reflected ? undefined : undefined),
    compare: (op, other) => (op === ">" ? new PyList(items.map((x) => x > (other as number))) : undefined),
  });
  return self;
}

describe("módulos nativos e import as", () => {
  const lib = new HostObject("módulo", { vec: new PyBuiltin("vec", (a) => vector((a[0] as PyList).items as number[])), PI: 3.14 });

  test("import x as y y from x import a as b", () => {
    expect(output("import lib as l\nfrom lib import PI as pi, vec\nprint(pi, l.PI, vec([1]))", { nativeModules: { lib } })).toBe("3.14 3.14 vector(1)");
  });

  test("un módulo nativo no necesita desbloquear import; shared sí", () => {
    const features = new Set(["variables"] as const);
    expect(output("import lib as l\nx = l.PI\nprint(x)", { nativeModules: { lib }, features })).toBe("3.14");
    expect(errorOf("import shared", { modules: { shared: "" }, features })).toContain("todavía no has desbloqueado 'import'");
  });

  test("protocolo: índices, len, for, print, atributos calculados, operadores", () => {
    expect(
      output(
        "import lib\nv = lib.vec([1, 2, 3])\nv[0] = 10\nv.first = 7\ns = 0\nfor x in v:\n    s += x\nprint(v, len(v), v.size, s, v.total(), v * 2, v > 2)",
        { nativeModules: { lib } },
      ),
    ).toBe("vector(7, 2, 3) 3 3 12 12 vector(14, 4, 6) [True, False, True]");
  });

  test("sugerencias incluyen atributos dinámicos", () => {
    const o = new HostObject("tabla", {}, undefined, { getAttr: (n) => (n === "shape" ? 1 : undefined), attrNames: () => ["shape"] });
    expect(errorOf("o.shap", { globals: { o } })).toBe("Línea 1: tabla no tiene 'shap'. ¿Quisiste decir 'shape'?");
  });
});

describe("acciones asíncronas (base de datos)", () => {
  test("el robot espera la promesa y recibe su valor", async () => {
    let resolve!: (v: Value) => void;
    const query = new PyBuiltin("query", () => Action.async(2, new Promise<Value>((r) => (resolve = r))));
    const vm = new VM("x = query()\ny = x + 1", { globals: { query } });
    vm.tick();
    for (let i = 0; i < 5; i++) expect(vm.tick()).toBe("waiting");
    expect(vm.waitingAsync).toBe(true);
    resolve(41);
    await Promise.resolve();
    vm.tick();
    expect(vm.status).toBe("done");
    expect(vm.getGlobal("y")).toBe(42);
  });

  test("si la promesa falla, el error aparece en la línea que llamó", async () => {
    const query = new PyBuiltin("query", () => Action.async(1, Promise.reject(new Error("la tabla \"x\" no existe"))));
    const vm = new VM("a = 1\nquery()", { globals: { query } });
    vm.tick();
    await new Promise((r) => setTimeout(r, 0));
    vm.tick();
    expect(vm.status).toBe("error");
    expect(vm.error!.format()).toBe('Línea 2: la tabla "x" no existe');
  });
});
