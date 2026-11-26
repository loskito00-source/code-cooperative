export type Expr =
  | { kind: "num"; value: number; isFloat: boolean; line: number }
  | { kind: "str"; value: string; line: number }
  | { kind: "const"; value: true | false | null; line: number }
  | { kind: "name"; id: string; line: number }
  | { kind: "list"; items: Expr[]; line: number }
  /** Comprensión de listas: [elt for x in a if c for y in b ...] */
  | { kind: "listcomp"; elt: Expr; generators: Comprehension[]; line: number }
  | { kind: "tuple"; items: Expr[]; line: number }
  | { kind: "dict"; keys: Expr[]; values: Expr[]; line: number }
  | { kind: "binop"; op: string; left: Expr; right: Expr; line: number }
  | { kind: "unary"; op: "-" | "+" | "not"; operand: Expr; line: number }
  | { kind: "boolop"; op: "and" | "or"; left: Expr; right: Expr; line: number }
  | { kind: "compare"; ops: string[]; operands: Expr[]; line: number }
  | { kind: "ifexp"; test: Expr; body: Expr; orelse: Expr; line: number }
  | { kind: "call"; func: Expr; args: Expr[]; kwargs: { name: string; value: Expr }[]; line: number }
  | { kind: "attr"; obj: Expr; name: string; line: number }
  | { kind: "index"; obj: Expr; index: Expr; line: number }
  | { kind: "slice"; obj: Expr; start: Expr | null; stop: Expr | null; line: number }
  | { kind: "fstr"; parts: (string | { expr: Expr; spec: string | null })[]; line: number };

export type Target =
  | { kind: "name"; id: string; line: number }
  | { kind: "index"; obj: Expr; index: Expr; line: number }
  | { kind: "attr"; obj: Expr; name: string; line: number }
  | { kind: "tuple"; items: Target[]; line: number };

export type Stmt =
  | { kind: "expr"; expr: Expr; line: number }
  | { kind: "assign"; targets: Target[]; value: Expr; line: number }
  | { kind: "augassign"; target: Target; op: string; value: Expr; line: number }
  | { kind: "if"; test: Expr; body: Stmt[]; orelse: Stmt[]; line: number }
  | { kind: "while"; test: Expr; body: Stmt[]; line: number }
  | { kind: "for"; target: Target; iter: Expr; body: Stmt[]; line: number }
  | { kind: "def"; name: string; params: Param[]; body: Stmt[]; line: number }
  | { kind: "return"; value: Expr | null; line: number }
  | { kind: "break"; line: number }
  | { kind: "continue"; line: number }
  | { kind: "pass"; line: number }
  | { kind: "global"; names: string[]; line: number }
  | { kind: "import"; module: string; alias: string | null; names: { name: string; alias: string | null }[] | null; line: number };

/** Una cláusula "for x in iter if c1 if c2" de una comprensión. */
export interface Comprehension {
  target: Target;
  iter: Expr;
  ifs: Expr[];
}

export interface Param {
  name: string;
  default: Expr | null;
}

export interface Program {
  body: Stmt[];
}
