import { PyError } from "./errors.js";

export type TokenType =
  | "name"
  | "number"
  | "string"
  | "fstring"
  | "op"
  | "keyword"
  | "newline"
  | "indent"
  | "dedent"
  | "eof";

export interface Token {
  type: TokenType;
  value: string;
  line: number;
}

export const KEYWORDS = new Set([
  "if", "elif", "else", "while", "for", "in", "def", "return", "break", "continue",
  "pass", "and", "or", "not", "is", "True", "False", "None", "import", "from", "global", "as",
]);

/** Palabras de Python que no soportamos: error claro en vez de "variable no existe". */
const UNSUPPORTED = new Set([
  "class", "try", "except", "finally", "raise", "with", "lambda", "yield", "async",
  "await", "del", "assert", "nonlocal",
]);

const OPS = [
  "**=", "//=", "==", "!=", "<=", ">=", "+=", "-=", "*=", "/=", "%=", "**", "//",
  "+", "-", "*", "/", "%", "<", ">", "=", "(", ")", "[", "]", "{", "}", ",", ":", ".", "&", "|",
];

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const indents = [0];
  const lines = source.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  let depth = 0; // paréntesis abiertos: dentro de ellos los saltos de línea no cuentan

  for (let ln = 0; ln < lines.length; ln++) {
    let text = lines[ln];
    const line = ln + 1;
    let i = 0;

    if (depth === 0) {
      while (i < text.length && text[i] === " ") i++;
      if (i === text.length || text[i] === "#") continue; // línea vacía o comentario
      const col = i;
      if (col > indents[indents.length - 1]) {
        indents.push(col);
        tokens.push({ type: "indent", value: "", line });
      } else {
        while (col < indents[indents.length - 1]) {
          indents.pop();
          tokens.push({ type: "dedent", value: "", line });
        }
        if (col !== indents[indents.length - 1]) {
          throw new PyError("la indentación no coincide con ningún bloque anterior", line, "sintaxis");
        }
      }
    }

    while (i < text.length) {
      const ch = text[i];
      if (ch === " ") { i++; continue; }
      if (ch === "#") break;

      if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(text[i + 1] ?? ""))) {
        const m = /^(\d+\.\d*|\.\d+|\d+)(e[+-]?\d+)?/i.exec(text.slice(i))!;
        tokens.push({ type: "number", value: m[0], line });
        i += m[0].length;
        continue;
      }

      // f"Total: {total}" -> el contenido se separa en el parser
      const isFString = (ch === "f" || ch === "F") && (text[i + 1] === '"' || text[i + 1] === "'");
      if (isFString) i++;

      if (!isFString && /[A-Za-z_áéíóúñÁÉÍÓÚÑ]/.test(ch)) {
        const m = /^[A-Za-z_0-9áéíóúñÁÉÍÓÚÑ]+/.exec(text.slice(i))!;
        const word = m[0];
        if (UNSUPPORTED.has(word)) {
          throw new PyError(`'${word}' no existe en este juego (todavía)`, line, "sintaxis");
        }
        tokens.push({ type: KEYWORDS.has(word) ? "keyword" : "name", value: word, line });
        i += word.length;
        continue;
      }

      const quote = text[i];
      // """texto de varias líneas""" (útil para SQL): puede seguir en las líneas siguientes
      if ((quote === '"' || quote === "'") && text.startsWith(quote.repeat(3), i)) {
        const close = quote.repeat(3);
        let rest = text.slice(i + 3);
        let value = "";
        let end = rest.indexOf(close);
        while (end < 0) {
          value += rest + "\n";
          if (++ln >= lines.length) throw new PyError(`falta cerrar el texto con ${close}`, line, "sintaxis");
          rest = lines[ln];
          end = rest.indexOf(close);
        }
        value += rest.slice(0, end);
        tokens.push({ type: isFString ? "fstring" : "string", value, line });
        // el resto de la línea donde se cerró el texto sigue normal
        text = rest;
        i = end + 3;
        continue;
      }
      if (quote === '"' || quote === "'") {
        let j = i + 1;
        let value = "";
        while (j < text.length && text[j] !== quote) {
          if (text[j] === "\\" && j + 1 < text.length) {
            const esc = text[j + 1];
            value += esc === "n" ? "\n" : esc === "t" ? "\t" : esc;
            j += 2;
          } else {
            value += text[j++];
          }
        }
        if (j >= text.length) throw new PyError("falta cerrar las comillas del texto", line, "sintaxis");
        tokens.push({ type: isFString ? "fstring" : "string", value, line });
        i = j + 1;
        continue;
      }

      const op = OPS.find((o) => text.startsWith(o, i));
      if (!op) throw new PyError(`carácter no válido '${ch}'`, line, "sintaxis");
      if ("([{".includes(op)) depth++;
      if (")]}".includes(op)) depth = Math.max(0, depth - 1);
      tokens.push({ type: "op", value: op, line });
      i += op.length;
    }

    if (depth === 0 && tokens.length > 0 && tokens[tokens.length - 1].type !== "newline") {
      tokens.push({ type: "newline", value: "", line });
    }
  }

  const last = lines.length;
  if (depth > 0) throw new PyError("hay un paréntesis o corchete sin cerrar", last, "sintaxis");
  while (indents.length > 1) {
    indents.pop();
    tokens.push({ type: "dedent", value: "", line: last });
  }
  tokens.push({ type: "eof", value: "", line: last });
  return tokens;
}
