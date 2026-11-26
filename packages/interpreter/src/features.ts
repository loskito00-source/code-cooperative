import type { Expr, Program, Stmt, Target } from "./ast.js";
import { PyError } from "./errors.js";

/** Sintaxis que se compra en el árbol de desbloqueos (GDD §6). */
export const FEATURES = ["while", "if", "variables", "for", "lists", "functions", "import", "dicts"] as const;
export type Feature = (typeof FEATURES)[number];

const LABEL: Record<Feature, string> = {
  while: "while",
  if: "if / else",
  variables: "variables",
  for: "for",
  lists: "listas",
  functions: "funciones (def)",
  import: "import",
  dicts: "diccionarios",
};

/** Devuelve un error por cada sintaxis bloqueada que use el programa (la primera aparición). */
export function checkFeatures(program: Program, unlocked: ReadonlySet<Feature>): PyError[] {
  const found = new Map<Feature, number>();
  const use = (f: Feature, line: number) => {
    if (!unlocked.has(f) && !found.has(f)) found.set(f, line);
  };

  const target = (t: Target): void => {
    if (t.kind === "tuple") t.items.forEach(target);
    else if (t.kind === "index") { use("lists", t.line); expr(t.obj); expr(t.index); }
    else if (t.kind === "attr") expr(t.obj);
  };

  const expr = (e: Expr | null): void => {
    if (!e) return;
    switch (e.kind) {
      case "list": use("lists", e.line); e.items.forEach(expr); break;
      case "listcomp":
        use("lists", e.line);
        use("for", e.line);
        expr(e.elt);
        e.generators.forEach((g) => { target(g.target); expr(g.iter); g.ifs.forEach(expr); });
        break;
      case "tuple": e.items.forEach(expr); break;
      case "dict": use("dicts", e.line); e.keys.forEach(expr); e.values.forEach(expr); break;
      case "binop": case "boolop": expr(e.left); expr(e.right); break;
      case "unary": expr(e.operand); break;
      case "compare": e.operands.forEach(expr); break;
      case "ifexp": use("if", e.line); expr(e.test); expr(e.body); expr(e.orelse); break;
      case "call": expr(e.func); e.args.forEach(expr); e.kwargs.forEach((k) => expr(k.value)); break;
      case "attr": expr(e.obj); break;
      case "index": use("lists", e.line); expr(e.obj); expr(e.index); break;
      case "slice": use("lists", e.line); expr(e.obj); expr(e.start); expr(e.stop); break;
      case "fstr": e.parts.forEach((p) => typeof p !== "string" && expr(p.expr)); break;
    }
  };

  const stmts = (list: Stmt[]): void => list.forEach(stmt);
  const stmt = (s: Stmt): void => {
    switch (s.kind) {
      case "expr": expr(s.expr); break;
      case "assign": use("variables", s.line); s.targets.forEach(target); expr(s.value); break;
      case "augassign": use("variables", s.line); target(s.target); expr(s.value); break;
      case "global": use("variables", s.line); break;
      case "if": use("if", s.line); expr(s.test); stmts(s.body); stmts(s.orelse); break;
      case "while": use("while", s.line); expr(s.test); stmts(s.body); break;
      case "for": use("for", s.line); target(s.target); expr(s.iter); stmts(s.body); break;
      case "def": use("functions", s.line); s.params.forEach((p) => expr(p.default)); stmts(s.body); break;
      case "return": use("functions", s.line); expr(s.value); break;
      // solo shared.py se desbloquea; las librerías del juego (pandas) siempre se pueden importar
      case "import": if (s.module === "shared") use("import", s.line); break;
    }
  };

  stmts(program.body);
  return [...found].map(
    ([f, line]) =>
      new PyError(`todavía no has desbloqueado '${LABEL[f]}'. Cómpralo en el árbol de desbloqueos.`, line, "bloqueado"),
  );
}
