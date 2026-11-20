/** Error mostrado al jugador. Siempre en español y con número de línea (1-based). */
export class PyError extends Error {
  /** Módulo donde ocurrió; undefined o "main" = el script del robot. */
  file?: string;

  constructor(
    message: string,
    /** 0 = desconocida; la VM la completa con la línea en ejecución. */
    public line: number,
    public readonly kind: "sintaxis" | "ejecucion" | "bloqueado" = "ejecucion",
  ) {
    super(message);
    this.name = "PyError";
  }

  /** Texto listo para la consola del juego: "Línea 4: ..." o "shared.py, línea 4: ..." */
  format(): string {
    const where = this.file && this.file !== "main" ? `${this.file}.py, línea ${this.line}` : `Línea ${this.line}`;
    return this.line > 0 ? `${where}: ${this.message}` : this.message;
  }
}

/** Sugerencia para "¿Quisiste decir ...?" (nada para nombres de menos de 3 letras). */
export function closest(name: string, candidates: Iterable<string>): string | undefined {
  if (name.length < 3) return undefined;
  let best: string | undefined;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = editDistance(name, c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  const limit = Math.max(1, Math.floor(name.length / 3));
  return bestDist <= limit ? best : undefined;
}

/** Distancia de edición contando un intercambio de letras vecinas (pirnt -> print) como 1. */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}
