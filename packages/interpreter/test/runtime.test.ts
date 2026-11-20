import { describe, expect, test } from "vitest";
import { Action, check, type Feature, PyBuiltin, PyDict, PyList, VM, type Value } from "../src/index.js";
import { errorOf, output, py, run } from "./helpers.js";

describe("ticks y presupuesto de operaciones", () => {
  test("un bucle infinito sin acciones no bloquea: se reparte entre ticks", () => {
    const vm = new VM("while True:\n    pass", { opsPerTick: 50 });
    for (let i = 0; i < 100; i++) {
      const before = vm.totalOps;
      expect(vm.tick()).toBe("running");
      expect(vm.totalOps - before).toBeLessThanOrEqual(51);
    }
    expect(vm.line).toBeGreaterThan(0);
  });

  test("más CPU = el mismo cálculo termina en menos ticks", () => {
    const src = "t = 0\nfor i in range(300):\n    t += i";
    const lento = run(src, { opsPerTick: 50 });
    const rapido = run(src, { opsPerTick: 400 });
    expect(lento.vm.getGlobal("t")).toBe(44850);
    expect(rapido.ticks).toBeLessThan(lento.ticks / 4);
  });

  test("una acción de N ticks ocupa al robot exactamente N ticks", () => {
    const log: string[] = [];
    let x = 0;
    const move = new PyBuiltin("move", () => new Action(4, () => ++x));
    const vm = new VM("a = move()\nb = move()", { globals: { move } });

    const statuses: string[] = [];
    for (let t = 1; t <= 9; t++) {
      statuses.push(vm.tick());
      log.push(`${t}:${x}`);
    }
    // tick 1 inicia move #1; ticks 2-4 esperando; tick 5 termina #1 e inicia #2; tick 9 termina.
    expect(statuses).toEqual(["waiting", "waiting", "waiting", "waiting", "waiting", "waiting", "waiting", "waiting", "done"]);
    expect(log[3]).toBe("4:0");
    expect(log[4]).toBe("5:1");
    expect(vm.getGlobal("a")).toBe(1);
    expect(vm.getGlobal("b")).toBe(2);
  });

  test("acciones de 0 ticks se resuelven en el acto", () => {
    const now = new PyBuiltin("now", () => new Action(0, () => 7));
    expect(output("print(now() + now())", { globals: { now } })).toBe("14");
  });

  test("un error del juego dentro de una acción se reporta en la línea que la llamó", () => {
    const pick = new PyBuiltin("pick", () =>
      new Action(3, () => {
        throw new Error("no debería pasar");
      }),
    );
    const r = run("x = 1\npick()", { globals: { pick } });
    expect(r.error).toBe("Línea 2: error interno: no debería pasar");
  });

  test("stop() detiene al robot", () => {
    const vm = new VM("while True:\n    pass");
    vm.tick();
    vm.stop();
    expect(vm.tick()).toBe("stopped");
  });

  test("print no cuesta ticks y la línea actual queda registrada", () => {
    const r = run("print('hola')\nx = 1");
    expect(r.out).toEqual(["hola"]);
    expect(r.vm.line).toBe(2);
    expect(r.vm.status).toBe("done");
  });
});

describe("desbloqueos de sintaxis", () => {
  const solo = (...f: Feature[]) => new Set<Feature>(f);

  test("usar sintaxis no comprada da error 'bloqueado' sin ejecutar nada", () => {
    const r = run("print('hola')\nfor i in range(3):\n    print(i)", { features: solo("while") });
    expect(r.out).toEqual([]);
    expect(r.vm.error?.kind).toBe("bloqueado");
    expect(r.error).toBe("Línea 2: todavía no has desbloqueado 'for'. Cómpralo en el árbol de desbloqueos.");
  });

  test("check() lista todos los desbloqueos que faltan", () => {
    const errs = check("x = [1]\nif x:\n    def f():\n        pass", solo());
    expect(errs.map((e) => e.message.match(/'(.+?)'/)![1])).toEqual(["variables", "listas", "if / else", "funciones (def)"]);
  });

  test("el kiosco: solo while y llamadas", () => {
    expect(check("while True:\n    move(East)\n    harvest()", solo("while"))).toEqual([]);
  });
});

describe("módulos compartidos", () => {
  const modules = {
    shared: py`
      VERSION = 2
      def doble(x):
          return x * 2
      def falla():
          return 1 / 0
    `,
  };

  test("import shared y from shared import", () => {
    expect(output("import shared\nfrom shared import doble\nprint(shared.VERSION, doble(4), shared.doble(1))", { modules })).toBe(
      "2 8 2",
    );
  });

  test("los errores dentro de shared indican el archivo", () => {
    expect(errorOf("import shared\nshared.falla()", { modules })).toBe("shared.py, línea 5: división por cero");
  });

  test("módulo inexistente o nombre mal escrito", () => {
    expect(errorOf("import shraed", { modules })).toBe("Línea 1: el módulo 'shraed' no existe. ¿Quisiste decir 'shared'?");
    expect(errorOf("from shared import dobel", { modules })).toBe(
      "Línea 1: el módulo 'shared' no tiene 'dobel'. ¿Quisiste decir 'doble'?",
    );
  });

  test("shared también respeta los desbloqueos", () => {
    const r = run("import shared", { modules: { shared: "for i in range(2):\n    pass" }, features: new Set<Feature>(["import"]) });
    expect(r.error).toBe("shared.py, línea 1: todavía no has desbloqueado 'for'. Cómpralo en el árbol de desbloqueos.");
  });
});

describe("ejemplo del GDD: robot cajero", () => {
  /** Mini simulación de una caja: precios, clientes con carrito y lo que paga cada uno. */
  function caja(clientes: { carrito: string[]; paga: number }[]) {
    const precios: Record<string, number> = { pan: 2000, leche: 4500, huevos: 3800 };
    const tiquetes: { total: number; cobrado: number; devuelta: number }[] = [];
    let actual = 0;
    let cobrado = 0;
    const fn = (name: string, f: (args: Value[]) => Value | Action) => new PyBuiltin(name, (a) => f(a));

    const globals: Record<string, Value> = {
      has_customer: fn("has_customer", () => actual < clientes.length),
      scan_cart: fn("scan_cart", () => new Action(2 * clientes[actual].carrito.length, () => new PyList([...clientes[actual].carrito]))),
      price: fn("price", ([item]) => precios[item as string]),
      take_payment: fn("take_payment", ([total]) =>
        new Action(2, () => {
          cobrado = total as number;
          return clientes[actual].paga;
        }),
      ),
      give_change: fn("give_change", ([monto]) =>
        new Action(3, () => {
          const devuelta =
            monto instanceof PyDict
              ? monto.keys().reduce<number>((s, d) => s + (d as number) * (monto.get(d, 0) as number), 0)
              : (monto as number);
          const total = clientes[actual].carrito.reduce((s, p) => s + precios[p], 0);
          tiquetes.push({ total, cobrado, devuelta });
          return null;
        }),
      ),
      next_customer: fn("next_customer", () => new Action(1, () => (actual++, null))),
    };
    return { globals, tiquetes };
  }

  const clientes = [
    { carrito: ["pan", "leche"], paga: 10000 },
    { carrito: ["huevos"], paga: 3800 },
    { carrito: ["pan", "pan", "huevos"], paga: 20000 },
  ];

  test("el script mínimo del GDD (etapa 2) cobra y da la devuelta exacta", () => {
    const { globals, tiquetes } = caja(clientes);
    const r = run(
      py`
        while has_customer():
            total = 0
            for item in scan_cart():
                total = total + price(item)
            pago = take_payment(total)
            give_change(pago - total)
            next_customer()
      `,
      { globals, opsPerTick: 50 },
    );
    expect(r.error).toBeNull();
    expect(tiquetes).toEqual([
      { total: 6500, cobrado: 6500, devuelta: 3500 },
      { total: 3800, cobrado: 3800, devuelta: 0 },
      { total: 7800, cobrado: 7800, devuelta: 12200 },
    ]);
  });

  test("etapa 3: devuelta con billetes usando un algoritmo greedy", () => {
    const { globals, tiquetes } = caja(clientes);
    const r = run(
      py`
        DENOMINACIONES = [50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50]

        def desglosar(monto):
            billetes = {}
            for d in DENOMINACIONES:
                if monto >= d:
                    billetes[d] = monto // d
                    monto = monto % d
            return billetes

        while has_customer():
            total = 0
            for p in scan_cart():
                total += price(p)
            pago = take_payment(total)
            give_change(desglosar(pago - total))
            next_customer()
      `,
      { globals },
    );
    expect(r.error).toBeNull();
    expect(tiquetes.map((t) => t.devuelta)).toEqual([3500, 0, 12200]);
  });

  test("un cajero con bug cobra de más y se nota en el tiquete", () => {
    const { globals, tiquetes } = caja(clientes.slice(0, 1));
    run(
      py`
        while has_customer():
            total = 0
            for item in scan_cart():
                total = total + price(item) + 100
            pago = take_payment(total)
            give_change(pago - total)
            next_customer()
      `,
      { globals },
    );
    expect(tiquetes[0].cobrado).toBeGreaterThan(tiquetes[0].total);
  });
});
