import { VM } from "@cdb/interpreter";
import { describe, expect, test } from "vitest";
import { World } from "../src/index.js";
import { placeholders } from "../src/sqlapi.js";

function run(source: string) {
  const out: string[] = [];
  const libs = new World(1).libraries();
  const vm = new VM("import pandas as pd\nhoja = pd.read_excel('entrega_distribuidor.xlsx')\n" + source, {
    globals: libs.globals, nativeModules: libs.nativeModules, opsPerTick: 100_000, onPrint: (t) => out.push(t),
  });
  for (let i = 0; i < 100 && vm.status === "running"; i++) vm.tick();
  return { out: out.join("\n"), error: vm.error?.format() ?? null };
}

describe("pandas del juego: read_excel + select", () => {
  test("print(hoja) la muestra con letras de columna y números de fila", () => {
    const r = run("print(hoja)");
    expect(r.error).toBeNull();
    const lines = r.out.split("\n");
    expect(lines[0]).toBe('entrega_distribuidor.xlsx (hoja "entrega", de A1 a G6)');
    expect(lines[1]).toMatch(/^ {2}\| A +\| B +\| C/);
    expect(lines[2]).toMatch(/^1 \| Código \| Producto \|/);
    expect(lines[7]).toMatch(/^6 \| +\| TOTAL/);
  });

  test("select devuelve una lista de diccionarios, uno por fila, con los encabezados como claves", () => {
    const r = run(`
filas = hoja.select("A1", "G6")
print(len(filas))
print(filas[0])
print(filas[4]["Producto"], filas[4]["Código"])
`);
    expect(r.error).toBeNull();
    expect(r.out).toBe(
      "5\n{'Código': 'P-001', 'Producto': 'Pan ', 'Categoría': 'Panadería', 'Cantidad': 40, 'Precio Unitario': 2000, 'Costo Unitario': 1200, 'Vence': '2026-01-07'}\nTOTAL None",
    );
  });

  test("un rango parcial (B2:D3), en una sola cadena o al revés", () => {
    const r = run(`
print(hoja.select("B2:D3"))
print(hoja.select("d3", "b2") == hoja.select("B2", "D3"))
`);
    expect(r.error).toBeNull();
    expect(r.out).toBe("[{'Producto': 'Pan ', 'Categoría': 'Panadería', 'Cantidad': 40}, {'Producto': 'Leche', 'Categoría': 'Lácteos', 'Cantidad': 30}]\nTrue");
  });

  test("el jugador limpia con Python normal", () => {
    const r = run(`
vistos = []
for fila in hoja.select("A1", "G6"):
    nombre = fila["Producto"].strip().lower()
    if nombre == "total" or nombre in vistos:
        continue
    vistos.append(nombre)
print(vistos)
`);
    expect(r.error).toBeNull();
    expect(r.out).toBe("['pan', 'leche', 'huevos']");
  });

  test("errores útiles en español", () => {
    expect(run("hoja.select('A1', 'H2')").error).toContain("se sale de la hoja: los datos van de A1 a G6");
    expect(run("hoja.select('A1', 'G9')").error).toContain("se sale de la hoja");
    expect(run("hoja.select('1A', 'G2')").error).toContain("'1A' no es una celda");
    expect(run("hoja.select('A1')").error).toContain('usa hoja.select("A1", "G6")');
    expect(run("pd.read_excel('inventario.xlsx')").error).toContain("el archivo 'inventario.xlsx' no existe. Archivos: 'entrega_distribuidor.xlsx'");
    expect(run("cursor.execute('SELECT 1')").error).toContain("la base de datos todavía está arrancando");
  });

  test("%s se traduce a $1, $2... sin tocar lo que va entre comillas", () => {
    expect(placeholders("INSERT INTO p (a, b) VALUES (%s, %s)")).toBe("INSERT INTO p (a, b) VALUES ($1, $2)");
    expect(placeholders("SELECT * FROM p WHERE n LIKE 'pa%s' AND c > %s")).toBe("SELECT * FROM p WHERE n LIKE 'pa%s' AND c > $1");
    expect(placeholders("SELECT $1")).toBe("SELECT $1");
  });
});
