export interface CommandDoc {
  name: string;
  signature: string;
  description: string;
  group: "Moverse" | "Reponer" | "Caja" | "Python";
  kind: "function" | "constant";
}

export const COMMANDS: CommandDoc[] = [
  { group: "Moverse", kind: "function", name: "move", signature: "move(North)", description: "Mueve el robot una casilla: North, South, East o West. Tarda 4 ticks. Devuelve False si no pudo (borde, pared u otro robot). Al almacén se entra por su puerta, arriba." },
  { group: "Moverse", kind: "function", name: "get_pos", signature: "get_pos()", description: "Posición actual como (x, y). (0, 0) es la esquina de abajo a la izquierda." },
  { group: "Moverse", kind: "function", name: "wait", signature: "wait()", description: "Espera 1 tick sin hacer nada." },
  { group: "Moverse", kind: "constant", name: "WAREHOUSE", signature: "WAREHOUSE", description: "La casilla del almacén junto a su puerta: (2, 5). El almacén es el cuarto de la izquierda (x de 0 a 2)." },
  { group: "Moverse", kind: "constant", name: "REGISTER", signature: "REGISTER", description: "Posición de la caja: (3, 0)." },
  { group: "Moverse", kind: "constant", name: "ENTRANCE", signature: "ENTRANCE", description: "Posición de la entrada: (8, 5)." },
  { group: "Moverse", kind: "constant", name: "North", signature: "North", description: "Dirección: arriba." },
  { group: "Moverse", kind: "constant", name: "South", signature: "South", description: "Dirección: abajo." },
  { group: "Moverse", kind: "constant", name: "East", signature: "East", description: "Dirección: derecha." },
  { group: "Moverse", kind: "constant", name: "West", signature: "West", description: "Dirección: izquierda." },

  { group: "Reponer", kind: "function", name: "pick", signature: 'pick("pan", 5)', description: "En cualquier casilla del almacén: toma productos (máximo 5 a la vez). Sale de la mercancía guardada; si se acabó, el proveedor trae más y cobra el 60% del precio. Tarda 3 ticks por unidad." },
  { group: "Reponer", kind: "function", name: "place", signature: "place()", description: "Sobre un estante: pone lo que cargas. Un estante libre queda para ese producto; uno que ya tiene otro producto no lo acepta. Tarda 3 ticks por unidad." },
  { group: "Reponer", kind: "function", name: "cargo", signature: "cargo()", description: "Cuántas unidades lleva el robot." },
  { group: "Reponer", kind: "function", name: "cargo_product", signature: "cargo_product()", description: "Qué producto lleva, o None." },
  { group: "Reponer", kind: "function", name: "get_shelf", signature: 'get_shelf("pan")', description: "El estante más cercano con ese producto (o None si ninguno lo tiene). Tiene .stock(), .capacity(), .pos() y .product()." },
  { group: "Reponer", kind: "function", name: "warehouse_stock", signature: 'warehouse_stock("pan")', description: "Cuántas unidades de un producto quedan guardadas en el almacén." },
  { group: "Reponer", kind: "function", name: "get_shelves", signature: "get_shelves()", description: "Lista con todos los estantes, de oeste a este. .product() es None si el estante todavía está libre." },

  { group: "Caja", kind: "function", name: "has_customer", signature: "has_customer()", description: "True si el robot está en la caja y hay un cliente esperando." },
  { group: "Caja", kind: "function", name: "queue_length", signature: "queue_length()", description: "Cuántos clientes hay en la cola." },
  { group: "Caja", kind: "function", name: "scan_item", signature: "scan_item()", description: "Escanea todo el carrito del cliente y devuelve la lista de productos, por ejemplo [\"pan\", \"leche\"]. 2 ticks por producto." },
  { group: "Caja", kind: "function", name: "price", signature: 'price("pan")', description: "Precio de un producto: pan 2000, leche 4500, huevos 3800." },
  { group: "Caja", kind: "function", name: "take_payment", signature: "take_payment(total)", description: "Le cobra `total` al cliente y devuelve con cuánto pagó (puede ser un billete más grande). 2 ticks." },
  { group: "Caja", kind: "function", name: "give_change", signature: "give_change(devuelta)", description: "Le entrega la devuelta al cliente. Si cobras de más o das de menos, se enoja. 3 ticks." },
  { group: "Caja", kind: "function", name: "next_customer", signature: "next_customer()", description: "Despide al cliente para atender al siguiente. 1 tick." },

  { group: "Python", kind: "function", name: "print", signature: "print(valor)", description: "Escribe en la consola del robot." },
  { group: "Python", kind: "function", name: "len", signature: "len(lista)", description: "Cantidad de elementos." },
  { group: "Python", kind: "function", name: "range", signature: "range(5)", description: "Números del 0 al 4 (con for)." },
  { group: "Python", kind: "function", name: "abs", signature: "abs(x)", description: "Valor absoluto." },
  { group: "Python", kind: "function", name: "min", signature: "min(a, b)", description: "El menor." },
  { group: "Python", kind: "function", name: "max", signature: "max(a, b)", description: "El mayor." },
  { group: "Python", kind: "function", name: "round", signature: "round(x)", description: "Redondea." },
  { group: "Python", kind: "function", name: "str", signature: "str(x)", description: "Convierte a texto." },
  { group: "Python", kind: "function", name: "int", signature: "int(x)", description: "Convierte a número entero." },
];
