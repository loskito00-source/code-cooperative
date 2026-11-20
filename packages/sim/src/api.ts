import { Action, HostObject, PyBuiltin, PyError, PyList, PyTuple, type Value } from "@cdb/interpreter";
import { PRODUCTS, type ProductName, ROBOT, TICKS, COST_RATIO } from "./config.js";
import type { Customer, Robot, Shelf, World } from "./world.js";

const DIRS: Record<string, [number, number]> = {
  North: [0, 1],
  South: [0, -1],
  East: [1, 0],
  West: [-1, 0],
};

const PRODUCT_NAMES = Object.keys(PRODUCTS) as ProductName[];

function suggestProduct(name: string): string {
  const close = PRODUCT_NAMES.find((p) => p.startsWith(name.slice(0, 2)));
  return close ? ` ¿Quisiste decir '${close}'?` : ` Productos: ${PRODUCT_NAMES.join(", ")}.`;
}

function needProduct(v: Value, fn: string): ProductName {
  if (typeof v !== "string") throw new PyError(`${fn}() necesita el nombre de un producto, como "pan"`, 0);
  if (!(v in PRODUCTS)) throw new PyError(`el producto '${v}' no existe.${suggestProduct(v)}`, 0);
  return v as ProductName;
}

function needNumber(v: Value, fn: string): number {
  if (typeof v !== "number") throw new PyError(`${fn}() necesita un número`, 0);
  return v;
}

const tuple = (x: number, y: number) => new PyTuple([x, y]);
const ARROWS: Record<string, string> = { North: "⬆", South: "⬇", East: "➡", West: "⬅" };
const money = (n: number) => "$" + Math.round(n).toLocaleString("es-CO");

/** Funciones y constantes que ve el script de un robot. */
export function makeApi(world: World, robot: Robot): Record<string, Value> {
  const warn = (text: string) => world.log(robot, "warn", text);
  /** Acción que no se pudo hacer: avisa en consola, gasta 1 tick y devuelve `value`. */
  const fail = (text: string, value: Value = false) => {
    warn(text);
    return new Action(TICKS.failed, () => value);
  };
  const fn = (name: string, impl: (args: Value[]) => Value | Action) =>
    new PyBuiltin(name, (args) => impl(args));
  /** Acción con etiqueta visible sobre el robot mientras dura. */
  const act = (label: string, ticks: number, complete: () => Value) => {
    robot.action = label;
    return new Action(ticks, complete);
  };

  const shelfObject = (s: Shelf): HostObject =>
    new HostObject(
      "estante",
      {
        product: fn("product", () => s.product),
        stock: fn("stock", () => s.stock),
        capacity: fn("capacity", () => s.capacity),
        pos: fn("pos", () => tuple(s.x, s.y)),
      },
      `<estante ${s.product ?? "libre"} (${s.x}, ${s.y})>`,
    );

  const customer = (fnName: string): Customer | null => {
    const c = world.customerAtRegister(robot);
    if (!c) {
      if (robot.x !== world.register.x || robot.y !== world.register.y) warn(`${fnName}(): el robot no está en la caja`);
      else warn(`${fnName}(): no hay ningún cliente en la caja`);
    }
    return c;
  };

  return {
    North: "North",
    South: "South",
    East: "East",
    West: "West",
    WAREHOUSE: tuple(world.warehouse.x, world.warehouse.y),
    REGISTER: tuple(world.register.x, world.register.y),
    ENTRANCE: tuple(world.entrance.x, world.entrance.y),

    // ── movimiento ──
    move: fn("move", ([dir]) => {
      const d = typeof dir === "string" ? DIRS[dir] : undefined;
      if (!d) throw new PyError("move() necesita North, South, East o West", 0);
      const to = { x: robot.x + d[0], y: robot.y + d[1] };
      if (world.tileAt(to.x, to.y) === null || world.wallBetween(robot, to) || world.occupied(to.x, to.y, robot)) {
        return new Action(TICKS.failed, () => false);
      }
      robot.moving = { from: { x: robot.x, y: robot.y }, to, startTick: world.tick, ticks: TICKS.move };
      return act(`${ARROWS[dir as string]} ${dir}`, TICKS.move, () => {
        if (robot.moving) {
          robot.x = to.x;
          robot.y = to.y;
          robot.moving = null;
        }
        return true;
      });
    }),
    get_pos: fn("get_pos", () => tuple(robot.x, robot.y)),
    wait: fn("wait", () => act("…", TICKS.wait, () => null)),

    // ── reposición ──
    pick: fn("pick", ([p, n]) => {
      const product = needProduct(p, "pick");
      const want = n === undefined ? ROBOT.capacity : Math.floor(needNumber(n, "pick"));
      if (!world.inWarehouse(robot.x, robot.y)) return fail("pick(): hay que estar dentro del almacén", 0);
      if (robot.cargo.n > 0 && robot.cargo.product !== product) {
        return fail(`pick(): ya cargas ${robot.cargo.product}; primero ponlo en su estante`, 0);
      }
      const room = Math.max(0, Math.min(want, ROBOT.capacity - robot.cargo.n));
      // primero sale de lo que hay guardado; si se acabó, el proveedor del barrio trae más (y cobra)
      const fromStock = Math.min(room, world.warehouseStock[product]);
      const unitCost = PRODUCTS[product].price * COST_RATIO;
      const bought = Math.min(room - fromStock, Math.floor(world.money / unitCost));
      const amount = fromStock + bought;
      if (amount === 0) {
        return fail(robot.cargo.n >= ROBOT.capacity ? "pick(): el robot ya va lleno" : `pick(): no queda ${product} en el almacén y no alcanza el dinero para el proveedor`, 0);
      }
      if (fromStock > 0) world.takeFromWarehouse(product, fromStock);
      if (bought > 0) {
        world.earn(-bought * unitCost); // el proveedor cobra al tomar
        world.record({ kind: "purchase", at: world.now, robot: robot.name, product, quantity: bought, unitCost });
      }
      return act(`📦 ${amount} ${product}`, TICKS.pickPerUnit * amount, () => {
        world.sound("pick", robot);
        robot.cargo = { product, n: robot.cargo.n + amount };
        return amount;
      });
    }),

    warehouse_stock: fn("warehouse_stock", ([p]) => world.warehouseStock[needProduct(p, "warehouse_stock")]),

    place: fn("place", () => {
      const shelf = world.shelfAt(robot.x, robot.y);
      if (!shelf) return fail("place(): hay que estar sobre un estante", 0);
      if (robot.cargo.n === 0) return fail("place(): el robot no carga nada", 0);
      if (shelf.product !== null && shelf.product !== robot.cargo.product) {
        return fail(`place(): este estante es de ${shelf.product} y llevas ${robot.cargo.product}`, 0);
      }
      const amount = Math.min(robot.cargo.n, shelf.capacity - shelf.stock);
      if (amount === 0) return fail("place(): el estante está lleno", 0);
      const product = robot.cargo.product!;
      shelf.product = product; // un estante libre queda para este producto
      return act(`🧺 poniendo ${product}`, TICKS.placePerUnit * amount, () => {
        world.sound("place", shelf);
        const real = Math.min(amount, shelf.capacity - shelf.stock);
        if (real > 0) world.record({ kind: "restock", at: world.now, robot: robot.name, product, quantity: real });
        shelf.stock += real;
        robot.cargo.n -= real;
        if (robot.cargo.n === 0) robot.cargo.product = null;
        return real;
      });
    }),

    cargo: fn("cargo", () => robot.cargo.n),
    cargo_product: fn("cargo_product", () => robot.cargo.product),
    get_shelves: fn("get_shelves", () => new PyList(world.shelves.map(shelfObject))),
    get_shelf: fn("get_shelf", ([p]) => {
      const product = needProduct(p, "get_shelf");
      const s = world.shelfFor(product, robot);
      return s ? shelfObject(s) : null;
    }),

    // ── caja ──
    has_customer: fn("has_customer", () => world.customerAtRegister(robot) !== null),
    queue_length: fn("queue_length", () => world.queue.length),

    /** Escanea todo lo que queda en el carrito y devuelve la lista de productos. 2 ticks por producto. */
    scan_item: fn("scan_item", () => {
      const c = customer("scan_item");
      if (!c) return new Action(TICKS.failed, () => new PyList([]));
      const rest = c.cart.slice(c.checkout.scanned);
      if (rest.length) world.sound("scan", world.register);
      return act(`🔎 escaneando ${rest.length}`, Math.max(1, TICKS.scanPerItem * rest.length), () => {
        c.checkout.scanned = c.cart.length;
        return new PyList(rest);
      });
    }),

    price: fn("price", ([p]) => PRODUCTS[needProduct(p, "price")].price),

    take_payment: fn("take_payment", ([total]) => {
      const amount = needNumber(total, "take_payment");
      const c = customer("take_payment");
      if (!c) return new Action(TICKS.failed, () => 0);
      if (c.checkout.paid !== null) return fail("take_payment(): este cliente ya pagó", 0);
      return act(`💵 cobrando ${money(amount)}`, TICKS.takePayment, () => {
        c.checkout.charged = amount;
        c.checkout.paid = world.customerPays(amount);
        return c.checkout.paid;
      });
    }),

    give_change: fn("give_change", ([amount]) => {
      const change = needNumber(amount, "give_change");
      if (change < 0) throw new PyError("give_change() no acepta montos negativos", 0);
      const c = customer("give_change");
      if (!c) return new Action(TICKS.failed, () => null);
      if (c.checkout.paid === null) return fail("give_change(): primero cobra con take_payment()", null);
      if (c.checkout.change !== null) return fail("give_change(): ya le diste la devuelta", null);
      if (change > 0) world.sound("coins", world.register);
      return act(`🪙 devuelta ${money(change)}`, TICKS.giveChange, () => {
        c.checkout.change = change;
        world.finishCheckout(c);
        return null;
      });
    }),

    next_customer: fn("next_customer", () => {
      const c = customer("next_customer");
      if (!c) return new Action(TICKS.failed, () => null);
      return act("👋 ¡gracias!", TICKS.nextCustomer, () => {
        if (c.checkout.paid === null) warn("next_customer(): el cliente se fue sin pagar");
        world.releaseCustomer(c);
        return null;
      });
    }),
  };
}
