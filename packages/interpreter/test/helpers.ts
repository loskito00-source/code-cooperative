import { VM, type VMOptions } from "../src/index.js";

/** Ejecuta un script hasta que termine (o hasta maxTicks) y devuelve lo impreso. */
export function run(source: string, opts: VMOptions = {}, maxTicks = 10_000) {
  const out: string[] = [];
  const vm = new VM(source, { opsPerTick: 1_000, ...opts, onPrint: (t) => out.push(t) });
  let ticks = 0;
  while (ticks < maxTicks && (vm.status === "running" || vm.status === "waiting")) {
    vm.tick();
    ticks++;
  }
  return { vm, out, ticks, error: vm.error?.format() ?? null };
}

/** Atajo: lo impreso como un solo texto; falla si hubo error. */
export function output(source: string, opts: VMOptions = {}): string {
  const r = run(source, opts);
  if (r.error) throw new Error(r.error);
  return r.out.join("\n");
}

export function errorOf(source: string, opts: VMOptions = {}): string {
  const r = run(source, opts);
  if (!r.error) throw new Error("se esperaba un error pero el script terminó bien");
  return r.error;
}

/** Quita la indentación común para escribir scripts legibles en los tests. */
export function py(strings: TemplateStringsArray, ...vals: unknown[]): string {
  const raw = strings.reduce((acc, s, i) => acc + s + (i < vals.length ? String(vals[i]) : ""), "");
  const lines = raw.replace(/^\n/, "").split("\n");
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length));
  return lines.map((l) => l.slice(indent)).join("\n");
}
