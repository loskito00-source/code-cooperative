import type { Expr, Param, Program, Stmt, Target } from "./ast.js";
import { PyError } from "./errors.js";
import { tokenize, type Token } from "./lexer.js";

export function parse(source: string): Program {
  return new Parser(tokenize(source)).program();
}

const COMPARE_OPS = new Set(["==", "!=", "<", ">", "<=", ">="]);
const AUG_OPS = new Set(["+=", "-=", "*=", "/=", "//=", "%=", "**="]);

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  // ── utilidades ──────────────────────────────────────────────
  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }
  private next(): Token {
    return this.tokens[this.pos++];
  }
  private is(type: Token["type"], value?: string): boolean {
    const t = this.peek();
    return t.type === type && (value === undefined || t.value === value);
  }
  private isOp(value: string): boolean {
    return this.is("op", value);
  }
  private isKw(value: string): boolean {
    return this.is("keyword", value);
  }
  private eat(type: Token["type"], value?: string): boolean {
    if (this.is(type, value)) {
      this.pos++;
      return true;
    }
    return false;
  }
  private expect(type: Token["type"], value: string | undefined, what: string): Token {
    if (!this.is(type, value)) {
      const t = this.peek();
      const got = t.type === "newline" ? "fin de línea" : t.type === "eof" ? "fin del código" : `'${t.value}'`;
      throw new PyError(`se esperaba ${what} pero encontré ${got}`, t.line, "sintaxis");
    }
    return this.next();
  }

  // ── sentencias ──────────────────────────────────────────────
  program(): Program {
    const body: Stmt[] = [];
    while (!this.is("eof")) {
      if (this.eat("newline")) continue;
      if (this.is("indent")) throw new PyError("indentación inesperada", this.peek().line, "sintaxis");
      body.push(this.statement());
    }
    return { body };
  }

  private block(): Stmt[] {
    this.expect("op", ":", "':'");
    if (!this.is("newline")) {
      // bloque en la misma línea: if x: pass
      const s = this.simpleStatement();
      this.expect("newline", undefined, "fin de línea");
      return [s];
    }
    this.next();
    if (!this.is("indent")) {
      throw new PyError("se esperaba un bloque indentado después de ':'", this.peek().line, "sintaxis");
    }
    this.next();
    const body: Stmt[] = [];
    while (!this.is("dedent") && !this.is("eof")) {
      if (this.eat("newline")) continue;
      body.push(this.statement());
    }
    this.eat("dedent");
    return body;
  }

  private statement(): Stmt {
    const t = this.peek();
    if (t.type === "keyword") {
      switch (t.value) {
        case "if": return this.ifStatement();
        case "while": {
          this.next();
          const test = this.expression();
          return { kind: "while", test, body: this.block(), line: t.line };
        }
        case "for": {
          this.next();
          const target = this.targetList();
          this.expect("keyword", "in", "'in'");
          const iter = this.expression();
          return { kind: "for", target, iter, body: this.block(), line: t.line };
        }
        case "def": {
          this.next();
          const name = this.expect("name", undefined, "el nombre de la función").value;
          this.expect("op", "(", "'('");
          const params: Param[] = [];
          while (!this.isOp(")")) {
            const pname = this.expect("name", undefined, "el nombre de un parámetro").value;
            const def = this.eat("op", "=") ? this.expression() : null;
            if (!def && params.some((p) => p.default)) {
              throw new PyError("los parámetros sin valor por defecto van antes que los que tienen", t.line, "sintaxis");
            }
            params.push({ name: pname, default: def });
            if (!this.eat("op", ",")) break;
          }
          this.expect("op", ")", "')'");
          return { kind: "def", name, params, body: this.block(), line: t.line };
        }
      }
    }
    const s = this.simpleStatement();
    if (!this.is("eof")) this.expect("newline", undefined, "fin de línea");
    return s;
  }

  private ifStatement(): Stmt {
    const line = this.next().line; // if / elif
    const test = this.expression();
    const body = this.block();
    let orelse: Stmt[] = [];
    if (this.isKw("elif")) {
      orelse = [this.ifStatement()];
    } else if (this.eat("keyword", "else")) {
      orelse = this.block();
    }
    return { kind: "if", test, body, orelse, line };
  }

  private simpleStatement(): Stmt {
    const t = this.peek();
    const line = t.line;
    if (t.type === "keyword") {
      switch (t.value) {
        case "return": {
          this.next();
          const value = this.is("newline") || this.is("eof") ? null : this.exprList();
          return { kind: "return", value, line };
        }
        case "break": this.next(); return { kind: "break", line };
        case "continue": this.next(); return { kind: "continue", line };
        case "pass": this.next(); return { kind: "pass", line };
        case "global": {
          this.next();
          const names = [this.expect("name", undefined, "un nombre").value];
          while (this.eat("op", ",")) names.push(this.expect("name", undefined, "un nombre").value);
          return { kind: "global", names, line };
        }
        case "import": {
          this.next();
          const module = this.expect("name", undefined, "el nombre del módulo").value;
          const alias = this.eat("keyword", "as") ? this.expect("name", undefined, "un nombre después de 'as'").value : null;
          return { kind: "import", module, alias, names: null, line };
        }
        case "from": {
          this.next();
          const module = this.expect("name", undefined, "el nombre del módulo").value;
          this.expect("keyword", "import", "'import'");
          const names: { name: string; alias: string | null }[] = [];
          do {
            const name = this.expect("name", undefined, "un nombre").value;
            const alias = this.eat("keyword", "as") ? this.expect("name", undefined, "un nombre después de 'as'").value : null;
            names.push({ name, alias });
          } while (this.eat("op", ","));
          return { kind: "import", module, alias: null, names, line };
        }
        case "elif":
        case "else":
          throw new PyError(`'${t.value}' sin un 'if' antes`, line, "sintaxis");
      }
    }

    const expr = this.exprList();
    if (this.isOp("=")) {
      // a = b = 0  ->  targets [a, b]
      const targets: Target[] = [this.toTarget(expr)];
      this.next();
      let value = this.exprList();
      while (this.eat("op", "=")) {
        targets.push(this.toTarget(value));
        value = this.exprList();
      }
      return { kind: "assign", targets, value, line };
    }
    const t2 = this.peek();
    if (t2.type === "op" && AUG_OPS.has(t2.value)) {
      this.next();
      const target = this.toTarget(expr);
      if (target.kind === "tuple") throw new PyError("no se puede usar " + t2.value + " con varias variables", line, "sintaxis");
      return { kind: "augassign", target, op: t2.value.slice(0, -1), value: this.expression(), line };
    }
    return { kind: "expr", expr, line };
  }

  private toTarget(e: Expr): Target {
    switch (e.kind) {
      case "name":
      case "index":
      case "attr":
        return e;
      case "tuple":
      case "list":
        return { kind: "tuple", items: e.items.map((x) => this.toTarget(x)), line: e.line };
      default:
        throw new PyError("no se puede asignar un valor a esto", e.line, "sintaxis");
    }
  }

  /** Destino de un for: nombres separados por coma, sin consumir 'in'. */
  private targetList(): Target {
    const line = this.peek().line;
    const items: Target[] = [];
    do {
      const name = this.expect("name", undefined, "el nombre de una variable");
      items.push({ kind: "name", id: name.value, line: name.line });
    } while (this.eat("op", ","));
    return items.length === 1 ? items[0] : { kind: "tuple", items, line };
  }

  // ── expresiones ─────────────────────────────────────────────
  /** Expresión o tupla sin paréntesis: a, b */
  private exprList(): Expr {
    const first = this.expression();
    if (!this.isOp(",")) return first;
    const items = [first];
    while (this.eat("op", ",")) {
      if (this.is("newline") || this.isOp("=") || this.is("eof")) break;
      items.push(this.expression());
    }
    return { kind: "tuple", items, line: first.line };
  }

  expression(): Expr {
    const body = this.orExpr();
    if (this.isKw("if")) {
      this.next();
      const test = this.orExpr();
      this.expect("keyword", "else", "'else'");
      const orelse = this.expression();
      return { kind: "ifexp", test, body, orelse, line: body.line };
    }
    return body;
  }

  private orExpr(): Expr {
    let left = this.andExpr();
    while (this.isKw("or")) {
      const line = this.next().line;
      left = { kind: "boolop", op: "or", left, right: this.andExpr(), line };
    }
    return left;
  }

  private andExpr(): Expr {
    let left = this.notExpr();
    while (this.isKw("and")) {
      const line = this.next().line;
      left = { kind: "boolop", op: "and", left, right: this.notExpr(), line };
    }
    return left;
  }

  private notExpr(): Expr {
    if (this.isKw("not")) {
      const line = this.next().line;
      return { kind: "unary", op: "not", operand: this.notExpr(), line };
    }
    return this.comparison();
  }

  private comparison(): Expr {
    const first = this.bitOr();
    const ops: string[] = [];
    const operands = [first];
    for (;;) {
      const t = this.peek();
      let op: string | null = null;
      if (t.type === "op" && COMPARE_OPS.has(t.value)) {
        op = t.value;
        this.next();
      } else if (t.type === "keyword" && t.value === "in") {
        op = "in";
        this.next();
      } else if (t.type === "keyword" && t.value === "not" && this.peek(1).value === "in") {
        op = "not in";
        this.pos += 2;
      } else if (t.type === "keyword" && t.value === "is") {
        this.next();
        op = this.eat("keyword", "not") ? "is not" : "is";
      }
      if (!op) break;
      ops.push(op);
      operands.push(this.bitOr());
    }
    return ops.length ? { kind: "compare", ops, operands, line: first.line } : first;
  }

  /** a | b  (en pandas: combinar filtros). Precedencia de Python: | < & < + -. */
  private bitOr(): Expr {
    let left = this.bitAnd();
    while (this.isOp("|")) {
      const t = this.next();
      left = { kind: "binop", op: "|", left, right: this.bitAnd(), line: t.line };
    }
    return left;
  }

  private bitAnd(): Expr {
    let left = this.arith();
    while (this.isOp("&")) {
      const t = this.next();
      left = { kind: "binop", op: "&", left, right: this.arith(), line: t.line };
    }
    return left;
  }

  private arith(): Expr {
    let left = this.term();
    while (this.isOp("+") || this.isOp("-")) {
      const t = this.next();
      left = { kind: "binop", op: t.value, left, right: this.term(), line: t.line };
    }
    return left;
  }

  private term(): Expr {
    let left = this.unary();
    while (this.isOp("*") || this.isOp("/") || this.isOp("//") || this.isOp("%")) {
      const t = this.next();
      left = { kind: "binop", op: t.value, left, right: this.unary(), line: t.line };
    }
    return left;
  }

  private unary(): Expr {
    if (this.isOp("-") || this.isOp("+")) {
      const t = this.next();
      return { kind: "unary", op: t.value as "-" | "+", operand: this.unary(), line: t.line };
    }
    return this.power();
  }

  private power(): Expr {
    const base = this.postfix();
    if (this.isOp("**")) {
      const t = this.next();
      return { kind: "binop", op: "**", left: base, right: this.unary(), line: t.line };
    }
    return base;
  }

  private postfix(): Expr {
    let e = this.atom();
    for (;;) {
      if (this.isOp("(")) {
        const line = this.next().line;
        const args: Expr[] = [];
        const kwargs: { name: string; value: Expr }[] = [];
        while (!this.isOp(")")) {
          if (this.is("name") && this.peek(1).type === "op" && this.peek(1).value === "=") {
            const name = this.next().value;
            this.next();
            kwargs.push({ name, value: this.expression() });
          } else {
            if (kwargs.length) throw new PyError("los argumentos con nombre van al final", line, "sintaxis");
            args.push(this.expression());
          }
          if (!this.eat("op", ",")) break;
        }
        this.expect("op", ")", "')'");
        e = { kind: "call", func: e, args, kwargs, line };
      } else if (this.isOp("[")) {
        const line = this.next().line;
        let start: Expr | null = null;
        if (!this.isOp(":")) start = this.expression();
        if (this.eat("op", ":")) {
          const stop = this.isOp("]") ? null : this.expression();
          this.expect("op", "]", "']'");
          e = { kind: "slice", obj: e, start, stop, line };
        } else {
          this.expect("op", "]", "']'");
          e = { kind: "index", obj: e, index: start!, line };
        }
      } else if (this.isOp(".")) {
        const line = this.next().line;
        const name = this.expect("name", undefined, "un nombre después de '.'").value;
        e = { kind: "attr", obj: e, name, line };
      } else {
        return e;
      }
    }
  }

  private atom(): Expr {
    const t = this.next();
    const line = t.line;
    switch (t.type) {
      case "number": {
        const isFloat = /[.eE]/.test(t.value);
        return { kind: "num", value: Number(t.value), isFloat, line };
      }
      case "string": {
        let value = t.value;
        while (this.is("string")) value += this.next().value; // "a" "b"
        return { kind: "str", value, line };
      }
      case "fstring":
        return parseFString(t.value, line);
      case "name":
        return { kind: "name", id: t.value, line };
      case "keyword":
        if (t.value === "True") return { kind: "const", value: true, line };
        if (t.value === "False") return { kind: "const", value: false, line };
        if (t.value === "None") return { kind: "const", value: null, line };
        break;
      case "op":
        if (t.value === "(") {
          if (this.eat("op", ")")) return { kind: "tuple", items: [], line };
          const first = this.expression();
          if (this.eat("op", ")")) return first;
          const items = [first];
          while (this.eat("op", ",")) {
            if (this.isOp(")")) break;
            items.push(this.expression());
          }
          this.expect("op", ")", "')'");
          return { kind: "tuple", items, line };
        }
        if (t.value === "[") {
          const items: Expr[] = [];
          while (!this.isOp("]")) {
            items.push(this.expression());
            if (!this.eat("op", ",")) break;
          }
          this.expect("op", "]", "']'");
          return { kind: "list", items, line };
        }
        if (t.value === "{") {
          const keys: Expr[] = [];
          const values: Expr[] = [];
          while (!this.isOp("}")) {
            keys.push(this.expression());
            this.expect("op", ":", "':' entre la clave y el valor");
            values.push(this.expression());
            if (!this.eat("op", ",")) break;
          }
          this.expect("op", "}", "'}'");
          return { kind: "dict", keys, values, line };
        }
        break;
    }
    const got = t.type === "newline" ? "fin de línea" : t.type === "eof" ? "fin del código" : t.type === "indent" ? "indentación" : `'${t.value}'`;
    throw new PyError(`no entiendo ${got} aquí`, line, "sintaxis");
  }
}

/** Separa f"hola {nombre}, total {total:,.0f}" en texto y expresiones. */
function parseFString(raw: string, line: number): Expr {
  const parts: (string | { expr: Expr; spec: string | null })[] = [];
  let text = "";
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "{" && raw[i + 1] === "{") { text += "{"; i += 2; continue; }
    if (ch === "}" && raw[i + 1] === "}") { text += "}"; i += 2; continue; }
    if (ch === "}") throw new PyError("en un f-string, '}' sin su '{'. Usa '}}' para escribir una llave", line, "sintaxis");
    if (ch !== "{") { text += ch; i++; continue; }

    // busca la '}' que cierra, respetando paréntesis, corchetes y textos
    let depth = 0;
    let quote: string | null = null;
    let colon = -1;
    let j = i + 1;
    for (; j < raw.length; j++) {
      const c = raw[j];
      if (quote) { if (c === quote) quote = null; continue; }
      if (c === "'" || c === '"') quote = c;
      else if ("([{".includes(c)) depth++;
      else if (")]".includes(c) || (c === "}" && depth > 0)) depth--;
      else if (c === "}" && depth === 0) break;
      else if (c === ":" && depth === 0 && colon < 0) colon = j;
    }
    if (j >= raw.length) throw new PyError("en un f-string, falta cerrar '}'", line, "sintaxis");
    const exprText = raw.slice(i + 1, colon >= 0 ? colon : j).trim();
    if (!exprText) throw new PyError("en un f-string, hay unas llaves {} vacías", line, "sintaxis");
    if (text) parts.push(text);
    text = "";
    // saltos de línea delante para que los errores apunten a la línea correcta
    const sub = new Parser(tokenize("\n".repeat(line - 1) + exprText));
    const expr = sub.expression();
    parts.push({ expr, spec: colon >= 0 ? raw.slice(colon + 1, j) : null });
    i = j + 1;
  }
  if (text) parts.push(text);
  return { kind: "fstr", parts, line };
}
