import { FEATURES } from "@cdb/interpreter";
import { describe, expect, test } from "vitest";
import { DAY, TICKS_PER_SECOND, World } from "../src/index.js";

const MINUTO = 60 * TICKS_PER_SECOND;

function mundo(seed = 7) {
  const w = new World(seed);
  for (const f of FEATURES) w.features.add(f); // en los tests: toda la sintaxis
  return w;
}

/** Pone pan, leche y huevos en los primeros estantes (empiezan libres y vacíos). */
function surtir(w: World, stock = 10) {
  w.shelves.forEach((s, i) => Object.assign(s, { product: (["pan", "leche", "huevos"] as const)[i % 3], stock }));
}

function correr(w: World, ticks: number) {
  for (let i = 0; i < ticks; i++) w.step();
}

const ir_a = `
def ir_a(x, y):
    while get_pos()[0] < x:
        move(East)
    while get_pos()[0] > x:
        move(West)
    while get_pos()[1] < y:
        move(North)
    while get_pos()[1] > y:
        move(South)
`;

/** Reponedor: decide que los tres primeros estantes son de pan, leche y huevos, y los mantiene llenos. */
const REPONEDOR = `${ir_a}
productos = ["pan", "leche", "huevos"]
while True:
    estantes = get_shelves()
    for i in range(3):
        if estantes[i].stock() < 5:
            ir_a(WAREHOUSE[0], WAREHOUSE[1])
            pick(productos[i])
            x, y = estantes[i].pos()
            ir_a(x, y)
            place()
    wait()
`;

/** Cajera del GDD: scan_item() devuelve la lista del carrito. */
const CAJERA = `
while True:
    if has_customer():
        total = 0
        for item in scan_item():
            total = total + price(item)
        pago = take_payment(total)
        give_change(pago - total)
        next_customer()
`;

describe("mapa del Kiosco", () => {
  test("posiciones según el plano (y crece hacia el norte)", () => {
    const w = mundo();
    expect(w.width).toBe(15); // con el terreno por ampliar
    expect(w.openWidth).toBe(9);
    expect(w.height).toBe(6);
    expect(w.warehouse).toEqual({ x: 2, y: 5 }); // junto a la puerta
    expect(w.register).toMatchObject({ x: 3, y: 0, id: 1, active: true });
    expect(w.entrance).toEqual({ x: 8, y: 5 });
    expect(w.shelves.map((s) => [s.product, s.stock, s.x, s.y])).toEqual([
      [null, 0, 4, 5],
      [null, 0, 5, 5],
      [null, 0, 6, 5],
      [null, 0, 7, 5],
    ]);
    expect(w.robots.map((r) => [r.name, r.x, r.y])).toEqual([
      ["Toño", 2, 5],
      ["Lupe", 3, 0],
    ]);
    expect(w.warehouseStock).toEqual({ pan: 40, leche: 30, huevos: 36, chocolate: 0, queso: 0, miel: 0, aceite: 0, vino: 0 });
  });

  test("el almacén es un cuarto aparte: la pared solo se cruza por la puerta", () => {
    const w = mundo();
    const toño = w.robot("tono");
    Object.assign(toño, { x: 2, y: 3 });
    w.setScript("tono", "a = move(East)\nb = move(North)\nb = move(North)\nc = move(East)");
    w.runRobot("tono");
    correr(w, 30);
    const vm = toño.vm!;
    expect(vm.getGlobal("a")).toBe(false); // pared
    expect(vm.getGlobal("c")).toBe(true); // puerta en (2, 5) -> (3, 5)
    expect([toño.x, toño.y]).toEqual([3, 5]);
  });
});

describe("robots", () => {
  test("move tarda 4 pasos (a velocidad normal) y no atraviesa bordes", () => {
    const w = mundo();
    w.setScript("tono", "a = move(East)\nb = move(North)");
    w.runRobot("tono");
    w.robot("tono").code!.factor = 1; // velocidad normal (el código corto lo haría más rápido)
    // tick 1-4: el robot está ocupado moviéndose; al empezar el tick 5 llega y sigue con su código
    correr(w, 4);
    expect(w.robot("tono").x).toBe(2);
    expect(w.robot("tono").moving).not.toBeNull();
    correr(w, 1);
    expect(w.robot("tono").x).toBe(3);
    correr(w, 10);
    expect(w.robot("tono").vm!.getGlobal("a")).toBe(true);
    expect(w.robot("tono").vm!.getGlobal("b")).toBe(false); // borde norte
  });

  test("dos robots no pueden ocupar la misma casilla", () => {
    const w = mundo();
    const lupe = w.robot("lupe");
    lupe.x = 3;
    lupe.y = 5;
    w.setScript("tono", "ok = move(East)");
    w.runRobot("tono");
    correr(w, 5);
    expect(w.robot("tono").vm!.getGlobal("ok")).toBe(false);
    expect(w.robot("tono").x).toBe(2);
  });

  test("pick saca del almacén y place en un estante libre lo deja para ese producto", () => {
    const w = mundo();
    w.customersEnabled = false;
    const antes = w.money;
    w.setScript("tono", `${ir_a}\nn = pick("pan", 4)\nir_a(5, 5)\nm = place()\nk = pick("leche")`);
    w.runRobot("tono");
    correr(w, 100);
    const vm = w.robot("tono").vm!;
    expect(vm.error).toBeNull();
    expect(vm.getGlobal("n")).toBe(4);
    expect(vm.getGlobal("m")).toBe(4);
    expect(vm.getGlobal("k")).toBe(0); // ya no está en el almacén
    expect(w.shelves[1]).toMatchObject({ product: "pan", stock: 4 });
    expect(w.shelves[0]).toMatchObject({ product: null, stock: 0 });
    expect(w.warehouseStock.pan).toBe(36);
    expect(w.money).toBe(antes); // la entrega ya estaba pagada
  });

  test("un estante de pan no acepta leche", () => {
    const w = mundo();
    w.shelves[0].product = "pan";
    w.setScript("tono", `${ir_a}\npick("leche", 2)\nir_a(4, 5)\nm = place()`);
    w.runRobot("tono");
    correr(w, 60);
    expect(w.robot("tono").vm!.getGlobal("m")).toBe(0);
    expect(w.robot("tono").console.some((l) => l.text.includes("este estante es de pan"))).toBe(true);
  });

  test("cuando el almacén se queda sin un producto, el proveedor cobra el resto", () => {
    const w = mundo();
    w.warehouseStock.pan = 2;
    const antes = w.money;
    w.setScript("tono", 'n = pick("pan", 5)');
    w.runRobot("tono");
    correr(w, 20);
    expect(w.robot("tono").vm!.getGlobal("n")).toBe(5);
    expect(w.warehouseStock.pan).toBe(0);
    expect(w.money).toBe(antes - 3 * 2000 * 0.6);
  });

  test("pick funciona en cualquier casilla del almacén", () => {
    const w = mundo();
    Object.assign(w.robot("tono"), { x: 0, y: 1 });
    w.setScript("tono", 'n = pick("huevos", 3)\nq = warehouse_stock("huevos")');
    w.runRobot("tono");
    correr(w, 20);
    expect(w.robot("tono").vm!.getGlobal("n")).toBe(3);
    expect(w.robot("tono").vm!.getGlobal("q")).toBe(33);
  });

  test("los clientes buscan el estante que tiene su producto", () => {
    const w = mundo();
    w.shelves[3].product = "leche";
    w.shelves[3].stock = 10;
    expect(w.shelfFor("leche")).toBe(w.shelves[3]);
    expect(w.shelfFor("pan")).toBeUndefined();
  });

  test("pick fuera del almacén avisa en consola y devuelve 0", () => {
    const w = mundo();
    w.setScript("lupe", 'n = pick("pan")');
    w.runRobot("lupe");
    correr(w, 3);
    expect(w.robot("lupe").vm!.getGlobal("n")).toBe(0);
    expect(w.robot("lupe").console.some((l) => l.kind === "warn" && l.text.includes("almacén"))).toBe(true);
  });

  test("producto mal escrito: error con sugerencia en la línea correcta", () => {
    const w = mundo();
    w.setScript("tono", 'x = 1\npick("pna")');
    w.runRobot("tono");
    correr(w, 2);
    expect(w.robot("tono").console.at(-1)!.text).toBe("Línea 2: el producto 'pna' no existe. Productos: pan, leche, huevos, chocolate, queso, miel, aceite, vino.");
  });

  test("errores de sintaxis aparecen al ejecutar", () => {
    const w = mundo();
    w.setScript("tono", "while True\n    move(East)");
    w.runRobot("tono");
    expect(w.robot("tono").console.at(-1)).toMatchObject({ kind: "error", text: "Línea 1: se esperaba ':' pero encontré fin de línea" });
  });
});

describe("tienda completa", () => {
  test("con un buen reponedor y una buena cajera la tienda gana dinero", () => {
    const w = mundo();
    w.setScript("tono", REPONEDOR);
    w.setScript("lupe", CAJERA);
    w.runRobot("tono");
    w.runRobot("lupe");
    const inicial = w.money;
    correr(w, 10 * MINUTO);

    for (const r of w.robots) expect(r.vm!.error, r.name).toBeNull();
    expect(w.tickets.length).toBeGreaterThan(10);
    expect(w.tickets.every((t) => t.result === "ok")).toBe(true);
    expect(w.money).toBeGreaterThan(inicial);
    expect(w.reputation).toBeGreaterThan(50);
  });

  test("desde el inicio (sin for) la cajera puede sumar la lista con while y pop()", () => {
    const w = new World(7); // solo while, if y variables
    surtir(w);
    w.setScript("lupe", `
while True:
    if has_customer():
        productos = scan_item()
        total = 0
        while len(productos) > 0:
            total = total + price(productos.pop())
        pago = take_payment(total)
        give_change(pago - total)
        next_customer()
`);
    w.runRobot("lupe");
    correr(w, 5 * MINUTO);
    expect(w.robot("lupe").vm!.error).toBeNull();
    expect(w.tickets.length).toBeGreaterThan(0);
    expect(w.tickets.every((t) => t.result === "ok")).toBe(true);
  });

  test("una cajera que cobra de más enoja a los clientes", () => {
    const w = mundo();
    surtir(w);
    w.setScript("lupe", CAJERA.replace("total = total + price(item)", "total = total + price(item) + 500"));
    w.runRobot("lupe");
    correr(w, 5 * MINUTO);
    expect(w.tickets.length).toBeGreaterThan(0);
    expect(w.tickets.every((t) => t.result === "cobro_de_mas")).toBe(true);
    expect(w.reputation).toBeLessThan(50);
  });

  test("sin cajera los clientes se cansan de esperar", () => {
    const w = mundo();
    surtir(w);
    correr(w, 5 * MINUTO);
    expect(w.tickets).toEqual([]);
    expect(w.reputation).toBeLessThan(50);
  });

  test("devuelta de menos: la tienda pierde la diferencia pero el cliente no se queja", () => {
    const w = mundo();
    surtir(w);
    w.setScript("lupe", CAJERA.replace("give_change(pago - total)", "give_change(pago - total + 100)"));
    w.runRobot("lupe");
    correr(w, 5 * MINUTO);
    expect(w.tickets.length).toBeGreaterThan(0);
    expect(w.tickets.every((t) => t.result === "cobro_de_menos")).toBe(true);
  });

  test("la simulación es determinista con la misma semilla", () => {
    const run = () => {
      const w = mundo(42);
      w.setScript("tono", REPONEDOR);
      w.setScript("lupe", CAJERA);
      w.runRobot("tono");
      w.runRobot("lupe");
      correr(w, 3 * MINUTO);
      return [w.money, w.reputation, w.tickets.length];
    };
    expect(run()).toEqual(run());
  });
});

describe("mejoras", () => {
  test("toda la sintaxis viene desbloqueada desde el inicio", () => {
    const w = new World(1);
    w.setScript("tono", "for i in range(2):\n    pass");
    w.runRobot("tono");
    correr(w, 5);
    expect(w.robot("tono").vm!.status).toBe("done");
  });

  test("requisitos y dinero", () => {
    const w = new World(1);
    w.money = 100_000;
    expect(w.buy("estante2")).toEqual({ ok: false, reason: "primero compra Estante nuevo" });
    expect(w.buy("cpu1")).toEqual({ ok: false, reason: "no existe" }); // las CPU ya no se compran en Mejoras
    w.money = 0;
    expect(w.buy("sala1")).toEqual({ ok: false, reason: "no alcanza el dinero" });
  });

  test("un estante comprado se coloca donde el jugador elige", () => {
    const w = new World(1);
    w.money = 10_000;
    expect(w.placeShelf(5, 2)).toEqual({ ok: false, reason: "no tienes estantes por colocar" });
    expect(w.buy("estante1")).toEqual({ ok: true });
    expect(w.money).toBe(6_000);
    expect(w.shelvesToPlace).toBe(1);
    expect(w.placeShelf(w.register.x, w.register.y)).toMatchObject({ ok: false });
    expect(w.placeShelf(6, 0)).toEqual({ ok: false, reason: "ahí hacen fila los clientes" });
    expect(w.placeShelf(10, 2)).toEqual({ ok: false, reason: "ese terreno todavía no es de la tienda" });
    const r = w.placeShelf(5, 2);
    expect(r.ok).toBe(true);
    expect(w.shelvesToPlace).toBe(0);
    expect(w.tileAt(5, 2)).toBe("shelf");
    // get_shelves() sigue de oeste a este
    expect(w.shelves.map((s) => s.x)).toEqual([4, 5, 5, 6, 7]);
  });

  test("ampliar el local abre el terreno del este y caben más clientes", () => {
    const w = new World(1);
    w.money = 100_000;
    expect(w.openWidth).toBe(9);
    expect(w.tileAt(9, 3)).toBeNull();
    expect(w.maxCustomers).toBe(8);
    w.buy("estante1");
    expect(w.buy("local1")).toEqual({ ok: true });
    expect(w.openWidth).toBe(12);
    expect(w.tileAt(9, 3)).toBe("floor");
    expect(w.tileAt(12, 3)).toBeNull();
    expect(w.maxCustomers).toBe(12);
    expect(w.lockedLots).toEqual([2]);
  });

  test("el marketing trae más clientes", () => {
    const contar = (comprar: string[]) => {
      const w = new World(4);
      w.money = 1_000_000;
      for (const id of comprar) expect(w.buy(id)).toEqual({ ok: true });
      let llegaron = 0;
      for (let i = 0; i < 6000; i++) {
        w.step();
        llegaron += w.drainEvents().filter((e) => e.type === "record" && e.record.kind === "customer_arrived").length;
        w.customers.length = 0; // que no se llene la tienda
        w.queue = [];
      }
      return llegaron;
    };
    expect(contar(["volantes", "letrero", "radio", "redes"])).toBeGreaterThan(contar([]) * 1.5);
  });
});

describe("depurador y sonidos", () => {
  test("un punto de parada pausa al robot, avisa y el robot sigue 'vivo'", () => {
    const w = mundo();
    const r = w.robot("tono");
    r.breakpoints.add(2);
    w.setScript("tono", "move(East)\nmove(East)\nmove(East)");
    w.runRobot("tono");
    correr(w, 20);
    expect(r.vm!.status).toBe("paused");
    expect(r.x).toBe(3);
    expect(w.isRunning("tono")).toBe(true);
    const events = w.drainEvents();
    expect(events.some((e) => e.type === "robot" && e.status === "paused")).toBe(true);
    expect(events.some((e) => e.type === "sound" && e.name === "paused")).toBe(true);
    r.vm!.resume();
    correr(w, 20);
    expect(r.x).toBe(5);
  });

  test("la cajera suena: escáner, monedas y caja registradora", () => {
    const w = mundo();
    surtir(w);
    w.setScript("lupe", "while True:\n    if has_customer():\n        total = 0\n        for p in scan_item():\n            total += price(p)\n        give_change(take_payment(total) - total)\n        next_customer()");
    w.runRobot("lupe");
    const sounds = new Set<string>();
    for (let i = 0; i < 3 * MINUTO; i++) {
      w.step();
      for (const e of w.drainEvents()) if (e.type === "sound") sounds.add(e.name);
    }
    expect([...sounds]).toEqual(expect.arrayContaining(["door", "scan", "cash"]));
  });

  test("la etiqueta de acción muestra lo que hace el robot", () => {
    const w = mundo();
    w.setScript("tono", 'pick("pan", 3)');
    w.runRobot("tono");
    w.step();
    expect(w.robot("tono").action).toBe("📦 3 pan");
    correr(w, 12);
    expect(w.robot("tono").action).toBeNull();
  });
});

describe("clientes", () => {
  test("si nadie vende lo que busca, igual entra hasta un estante antes de irse", () => {
    const w = mundo();
    // estantes libres: ningún producto está a la venta
    const visitados = new Map<number, boolean>();
    for (let i = 0; i < 2 * MINUTO; i++) {
      w.step();
      for (const c of w.customers) if (w.shelfAt(c.x, c.y)) visitados.set(c.id, true);
      for (const c of w.customers) if (!visitados.has(c.id)) visitados.set(c.id, false);
    }
    expect(visitados.size).toBeGreaterThan(0);
    // todos los que ya se fueron pasaron por un estante
    const idos = [...visitados.keys()].filter((id) => !w.customers.some((c) => c.id === id));
    expect(idos.length).toBeGreaterThan(0);
    expect(idos.every((id) => visitados.get(id))).toBe(true);
  });

  test("se queda mirando el estante un momento antes de tomar el producto", () => {
    const w = mundo();
    surtir(w);
    let llegó = -1;
    let tomó = -1;
    for (let i = 0; i < MINUTO && tomó < 0; i++) {
      w.step();
      const c = w.customers[0];
      if (!c) continue;
      if (llegó < 0 && w.shelfAt(c.x, c.y)) llegó = w.tick;
      if (c.cart.length > 0) tomó = w.tick;
    }
    expect(llegó).toBeGreaterThan(0);
    expect(tomó - llegó).toBeGreaterThanOrEqual(8);
  });
});

describe("la noche (preparación) antes de abrir", () => {
  test("durante la preparación no llegan clientes; al acabarse el tiempo, abre", () => {
    const w = mundo();
    surtir(w);
    w.startNight(10 * 60 * 1000);
    correr(w, 3 * MINUTO);
    expect(w.customers.filter((c) => !c.test)).toEqual([]); // (de noche solo está el cliente de prueba)
    w.updateNight(9 * 60 * 1000);
    expect(w.night).not.toBeNull();
    w.updateNight(60 * 1000);
    expect(w.night).toBeNull();
    expect(w.customersEnabled).toBe(true);
    expect(w.drainEvents().some((e) => e.type === "opened" && e.reason === "tiempo")).toBe(true);
    correr(w, 2 * TICKS_PER_SECOND);
    expect(w.customers).toEqual([]); // el primero llega 3 s después de abrir (y el de prueba ya se fue)
    correr(w, 2 * TICKS_PER_SECOND);
    expect(w.customers.length).toBe(1);
  });

  test("abre antes solo si votan los dos jugadores", () => {
    const w = mundo();
    w.startNight();
    w.vote("j1");
    expect(w.night?.votes.has("j1")).toBe(true);
    w.vote("j1", false); // se arrepiente
    w.vote("j2");
    expect(w.night).not.toBeNull();
    w.vote("j1");
    expect(w.night).toBeNull();
    expect(w.customersEnabled).toBe(true);
    expect(w.drainEvents().some((e) => e.type === "opened" && e.reason === "votos")).toBe(true);
  });

  test("los robots sí trabajan durante la preparación", () => {
    const w = mundo();
    w.startNight();
    w.setScript("tono", REPONEDOR);
    w.runRobot("tono");
    correr(w, 2 * MINUTO);
    expect(w.robot("tono").vm!.error).toBeNull();
    expect(w.shelves.slice(0, 3).map((s) => s.product)).toEqual(["pan", "leche", "huevos"]);
    expect(w.shelves.slice(0, 3).every((s) => s.stock >= 5)).toBe(true);
  });
});

describe("día y noche", () => {
  test("el día dura 5 minutos: a las 19:00 cierra, empieza la noche y luego el día 2", () => {
    const w = mundo();
    surtir(w);
    w.openStore();
    expect(w.clock).toMatchObject({ day: 1, phase: "day", hour: 7 });
    correr(w, DAY.ticks / 2);
    expect(w.clock.hour).toBeCloseTo(13);
    expect(w.now).toBe("2026-01-05T13:00:00.000Z");
    correr(w, DAY.ticks / 2);
    expect(w.night).not.toBeNull();
    expect(w.customersEnabled).toBe(false);
    expect(w.day).toBe(2);
    const closed = w.drainEvents().find((e) => e.type === "closed");
    expect(closed).toMatchObject({ summary: { day: 1 } });
    // de noche el reloj va de 19:00 a 7:00 según el tiempo real
    expect(w.clock).toMatchObject({ day: 2, phase: "night", hour: 19 });
    w.updateNight(5 * 60 * 1000);
    expect(w.clock.hour).toBeCloseTo(1);
    expect(w.now).toBe("2026-01-06T01:00:00.000Z");
    w.updateNight(5 * 60 * 1000);
    expect(w.night).toBeNull();
    expect(w.clock).toMatchObject({ day: 2, phase: "day", hour: 7 });
    expect(w.now).toBe("2026-01-06T07:00:00.000Z");
  });

  test("de noche no llegan clientes, pero los que estaban adentro terminan de comprar", () => {
    const w = mundo();
    surtir(w);
    w.setScript("lupe", CAJERA);
    w.runRobot("lupe");
    w.openStore();
    correr(w, DAY.ticks);
    const reales = () => w.customers.filter((c) => !c.test);
    const adentro = reales().length;
    const ids = new Set(reales().map((c) => c.id));
    correr(w, 2 * MINUTO);
    expect(reales().every((c) => ids.has(c.id))).toBe(true); // nadie nuevo (fuera del cliente de prueba)
    expect(reales().length).toBeLessThanOrEqual(adentro);
  });

  test("el resumen del día cuenta ventas, plata y clientes perdidos", () => {
    const w = mundo();
    surtir(w);
    w.setScript("lupe", CAJERA);
    w.runRobot("lupe");
    w.openStore();
    correr(w, DAY.ticks);
    const s = w.lastDay!;
    expect(s.day).toBe(1);
    expect(s.sales).toBeGreaterThan(0);
    expect(s.ok).toBe(s.sales);
    expect(s.revenue).toBe(w.tickets.reduce((n, t) => n + t.total, 0));
  });

  test("cada día llegan más clientes", () => {
    const llegadas = (dia: number) => {
      const w = mundo(5);
      surtir(w);
      w.day = dia;
      w.openStore();
      let n = 0;
      for (let i = 0; i < DAY.ticks - 1; i++) {
        w.step();
        n += w.drainEvents().filter((e) => e.type === "record" && e.record.kind === "customer_arrived").length;
      }
      return n;
    };
    expect(llegadas(5)).toBeGreaterThan(llegadas(1));
  });
});

const CAJERO = `
while True:
    if has_customer():
        total = 0
        for p in scan_item():
            total = total + price(p)
        pago = take_payment(total)
        give_change(pago - total)
        next_customer()
    else:
        wait()
`;

describe("equipo: cajas y robots nuevos", () => {
  test("una caja comprada se coloca donde el jugador elige y llega con su cajero", () => {
    const w = mundo();
    w.money = 100_000;
    expect(w.placeRegister(6, 3)).toEqual({ ok: false, reason: "no tienes cajas por colocar" });
    expect(w.buy("caja2")).toEqual({ ok: true });
    expect(w.registersToPlace).toBe(1);
    expect(w.placeRegister(4, 0)).toEqual({ ok: false, reason: "ahí hace fila otra caja" });
    expect(w.placeRegister(7, 3)).toEqual({ ok: false, reason: "los clientes necesitan 2 casillas libres al este para hacer fila" });
    const r = w.placeRegister(5, 3);
    expect(r.ok).toBe(true);
    expect(w.registers.map((x) => [x.id, x.x, x.y])).toEqual([[1, 3, 0], [2, 5, 3]]);
    const memo = w.robot("memo");
    expect([memo.x, memo.y, memo.role]).toEqual([5, 3, "cajero"]);
    expect(w.shelfProblem(6, 3)).toBe("ahí hacen fila los clientes");
    expect(w.drainEvents().some((e) => e.type === "hired" && e.robotId === "memo")).toBe(true);
  });

  test("comprar un reponedor trae un robot nuevo al almacén", () => {
    const w = mundo();
    w.money = 100_000;
    expect(w.buy("robot1")).toEqual({ ok: true });
    const chucho = w.robot("chucho");
    expect(w.inWarehouse(chucho.x, chucho.y)).toBe(true);
    expect(chucho.cpu.server).toBe(w.robot("tono").cpu.server);
    expect(chucho.ip).toBe("10.0.0.23");
    expect(w.robots.length).toBe(3);
  });

  test("una caja inactiva no atiende y pasa su fila a otra caja activa", () => {
    const w = mundo();
    w.money = 100_000;
    w.buy("caja2");
    w.placeRegister(5, 3);
    surtir(w);
    // las dos cajas reciben clientes (cada uno va a la de menos fila)
    for (let i = 0; i < 6 * MINUTO && w.registers.some((r) => r.queue.length < 2); i++) w.step();
    expect(w.registers.every((r) => r.queue.length >= 2)).toBe(true);
    w.setRegisterActive(2, false);
    expect(w.customerAtRegister(w.robot("memo"))).toBeNull();
    expect(w.registers[1].queue.filter((c) => c.checkout.scanned === 0).length).toBe(0);
    correr(w, MINUTO);
    expect(w.queue.every((c) => c.register!.id === 1)).toBe(true);
  });

  test("de noche llega un cliente de prueba: se puede cobrar sin mover plata ni productos", () => {
    const w = mundo();
    surtir(w);
    w.startNight();
    correr(w, 2);
    const prueba = w.registers[0].queue[0];
    expect(prueba.test).toBe(true);
    const plata = w.money;
    const stock = w.shelves.map((s) => s.stock);
    w.setScript("lupe", CAJERO);
    w.runRobot("lupe");
    const tiquetes: boolean[] = [];
    for (let i = 0; i < 200; i++) {
      w.step();
      for (const e of w.drainEvents()) if (e.type === "ticket") tiquetes.push(!!e.ticket.test && e.ticket.result === "ok");
      if (e_records(w)) throw new Error("no debe guardar nada");
    }
    expect(tiquetes.length).toBeGreaterThanOrEqual(2); // despide a uno y llega otro
    expect(tiquetes.every(Boolean)).toBe(true);
    expect(w.money).toBe(plata);
    expect(w.shelves.map((s) => s.stock)).toEqual(stock);
    expect(w.tickets.length).toBe(0);
    // al amanecer los de prueba se van
    w.openStore();
    expect(w.customers.some((c) => c.test)).toBe(false);
  });
});

/** ¿Quedó algún registro para la base de datos en los eventos pendientes? */
function e_records(w: World): boolean {
  return w.drainEvents().some((e) => e.type === "record");
}
