/**
 * Tamaño del código de un robot: entre menos líneas, más rápido trabaja (reemplaza a los ticks de CPU).
 *
 * Se cuentan instrucciones (no líneas de texto): los comentarios y las líneas en blanco no cuentan, y partir o juntar
 * líneas no cambia nada. Para que no se pueda hacer trampa escondiendo el código en shared.py, también cuentan las
 * funciones de shared que el robot usa, las que esas llaman (y así sucesivamente) y lo que shared ejecuta al importarse.
 */
import { type Expr, parse, type Program, type Stmt, type Target } from "@cdb/interpreter";

/** Velocidad según el tamaño: 20 instrucciones = normal; menos, más rápido; más, más lento. */
export const CODE_SPEED = {
  /** Con estas instrucciones el robot va a velocidad normal. */
  normal: 20,
  /** Cuánto más lento por cada instrucción (fracción de la velocidad normal). */
  perStatement: 0.025,
  /** Lo más rápido y lo más lento que puede ir (factor de duración: 0.5 = el doble de rápido). */
  min: 0.5,
  max: 2.5,
};

export interface CodeSize {
  /** Instrucciones propias del robot. */
  own: number;
  /** Instrucciones que trae de shared.py. */
  shared: number;
  total: number;
  /** Factor de duración de sus acciones (1 = normal, 0.5 = el doble de rápido, 2 = la mitad de rápido). */
  factor: number;
  /** Funciones de shared que cuentan. */
  sharedFunctions: string[];
}

export function speedFactor(statements: number): number {
  const f = 1 + (statements - CODE_SPEED.normal) * CODE_SPEED.perStatement;
  return Math.round(Math.min(CODE_SPEED.max, Math.max(CODE_SPEED.min, f)) * 100) / 100;
}

function countStmts(body: Stmt[]): number {
  let n = 0;
  for (const s of body) {
    n += 1;
    if (s.kind === "if") n += countStmts(s.body) + countStmts(s.orelse);
    else if (s.kind === "while" || s.kind === "for" || s.kind === "def") n += countStmts(s.body);
  }
  return n;
}

// ── recorrer el árbol buscando nombres y atributos ──

function walkExpr(e: Expr | null, visit: (e: Expr) => void): void {
  if (!e) return;
  visit(e);
  switch (e.kind) {
    case "list":
    case "tuple":
      e.items.forEach((x) => walkExpr(x, visit));
      break;
    case "dict":
      e.keys.forEach((x) => walkExpr(x, visit));
      e.values.forEach((x) => walkExpr(x, visit));
      break;
    case "binop":
    case "boolop":
      walkExpr(e.left, visit);
      walkExpr(e.right, visit);
      break;
    case "unary":
      walkExpr(e.operand, visit);
      break;
    case "compare":
      e.operands.forEach((x) => walkExpr(x, visit));
      break;
    case "ifexp":
      walkExpr(e.test, visit);
      walkExpr(e.body, visit);
      walkExpr(e.orelse, visit);
      break;
    case "call":
      walkExpr(e.func, visit);
      e.args.forEach((x) => walkExpr(x, visit));
      e.kwargs.forEach((k) => walkExpr(k.value, visit));
      break;
    case "attr":
      walkExpr(e.obj, visit);
      break;
    case "index":
      walkExpr(e.obj, visit);
      walkExpr(e.index, visit);
      break;
    case "slice":
      walkExpr(e.obj, visit);
      walkExpr(e.start, visit);
      walkExpr(e.stop, visit);
      break;
    case "fstr":
      for (const p of e.parts) if (typeof p !== "string") walkExpr(p.expr, visit);
      break;
  }
}

function walkTarget(t: Target, visit: (e: Expr) => void): void {
  if (t.kind === "tuple") t.items.forEach((x) => walkTarget(x, visit));
  else if (t.kind === "index") {
    walkExpr(t.obj, visit);
    walkExpr(t.index, visit);
  } else if (t.kind === "attr") walkExpr(t.obj, visit);
}

/** Todas las expresiones de un bloque (incluidas las de bloques internos y valores por defecto). */
function walkStmts(body: Stmt[], visit: (e: Expr) => void): void {
  for (const s of body) {
    switch (s.kind) {
      case "expr":
        walkExpr(s.expr, visit);
        break;
      case "assign":
        s.targets.forEach((t) => walkTarget(t, visit));
        walkExpr(s.value, visit);
        break;
      case "augassign":
        walkTarget(s.target, visit);
        walkExpr(s.value, visit);
        break;
      case "if":
      case "while":
        walkExpr(s.test, visit);
        walkStmts(s.body, visit);
        if (s.kind === "if") walkStmts(s.orelse, visit);
        break;
      case "for":
        walkTarget(s.target, visit);
        walkExpr(s.iter, visit);
        walkStmts(s.body, visit);
        break;
      case "def":
        s.params.forEach((p) => walkExpr(p.default, visit));
        walkStmts(s.body, visit);
        break;
      case "return":
        walkExpr(s.value, visit);
        break;
    }
  }
}

/** Imports de shared en todo el programa (también los que están dentro de funciones). */
function sharedImports(body: Stmt[], out: Extract<Stmt, { kind: "import" }>[] = []): Extract<Stmt, { kind: "import" }>[] {
  for (const s of body) {
    if (s.kind === "import" && s.module === "shared") out.push(s);
    if (s.kind === "if") {
      sharedImports(s.body, out);
      sharedImports(s.orelse, out);
    } else if (s.kind === "while" || s.kind === "for" || s.kind === "def") sharedImports(s.body, out);
  }
  return out;
}

function tryParse(source: string): Program | null {
  try {
    return parse(source);
  } catch {
    return null;
  }
}

/**
 * Mide el código de un robot (y lo que usa de shared.py). null si el código del robot tiene un error de sintaxis.
 * Si shared.py tiene un error, no suma nada (el robot fallará al importarlo de todos modos).
 */
export function measureCode(source: string, sharedSource = ""): CodeSize | null {
  const prog = tryParse(source);
  if (!prog) return null;
  const own = countStmts(prog.body);
  const imports = sharedImports(prog.body);
  const shared = imports.length ? tryParse(sharedSource) : null;
  if (!shared) return { own, shared: 0, total: own, factor: speedFactor(own), sharedFunctions: [] };

  const defs = new Map<string, Extract<Stmt, { kind: "def" }>>();
  for (const s of shared.body) if (s.kind === "def") defs.set(s.name, s);
  // lo que no es def se ejecuta al importar: siempre cuenta
  const topLevel = shared.body.filter((s) => s.kind !== "def");
  let sharedCount = countStmts(topLevel);

  // qué funciones de shared usa el robot
  const used = new Set<string>();
  let everything = false;
  const moduleNames = new Set<string>();
  for (const imp of imports) {
    if (imp.names) {
      for (const n of imp.names) if (defs.has(n.name)) used.add(n.name);
    } else moduleNames.add(imp.alias ?? "shared");
  }
  if (moduleNames.size) {
    // shared.f(...) cuenta f; usar el módulo de otra forma (pasarlo, guardarlo en una variable) cuenta todo shared
    const attrObjs = new Set<Expr>();
    walkStmts(prog.body, (e) => {
      if (e.kind === "attr" && e.obj.kind === "name" && moduleNames.has(e.obj.id)) {
        attrObjs.add(e.obj);
        if (defs.has(e.name)) used.add(e.name);
      }
    });
    walkStmts(prog.body, (e) => {
      if (e.kind === "name" && moduleNames.has(e.id) && !attrObjs.has(e)) everything = true;
    });
  }
  if (everything) for (const name of defs.keys()) used.add(name);

  // funciones que llaman (o mencionan) las usadas, y las que menciona lo de nivel superior
  const queue = [...used];
  walkStmts(topLevel, (e) => {
    if (e.kind === "name" && defs.has(e.id) && !used.has(e.id)) {
      used.add(e.id);
      queue.push(e.id);
    }
  });
  while (queue.length) {
    const def = defs.get(queue.pop()!)!;
    walkStmts(def.body, (e) => {
      if (e.kind === "name" && defs.has(e.id) && !used.has(e.id)) {
        used.add(e.id);
        queue.push(e.id);
      }
    });
    s_params(def).forEach((d) => walkExpr(d, (e) => {
      if (e.kind === "name" && defs.has(e.id) && !used.has(e.id)) {
        used.add(e.id);
        queue.push(e.id);
      }
    }));
  }
  for (const name of used) sharedCount += countStmts([defs.get(name)!]);
  const total = own + sharedCount;
  return { own, shared: sharedCount, total, factor: speedFactor(total), sharedFunctions: [...used].sort() };
}

function s_params(def: Extract<Stmt, { kind: "def" }>): Expr[] {
  return def.params.map((p) => p.default).filter((d): d is Expr => d !== null);
}
