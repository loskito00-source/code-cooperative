import { VM } from "@cdb/interpreter";
import { describe, expect, test } from "vitest";
import { World } from "../src/index.js";

function run(source: string) {
  const out: string[] = [];
  const libs = new World(1).libraries();
  const vm = new VM("import pandas as pd\ndf = pd.read_excel('entrega_distribuidor.xlsx')\n" + source, {
    globals: libs.globals, nativeModules: libs.nativeModules, opsPerTick: 100_000, onPrint: (t) => out.push(t),
  });
  for (let i = 0; i < 100 && vm.status === "running"; i++) vm.tick();
  return { out: out.join("\n"), error: vm.error?.format() ?? null };
}

describe("pandas sencillo", () => {
  test("read_excel y print muestran la tabla como pandas", () => {
    const r = run("print(df.shape)\nprint(df[['Producto', 'Cantidad']])");
    expect(r.error).toBeNull();
    expect(r.out).toBe(
      ["(5, 7)", "   Producto  Cantidad", "0      Pan         40", "1     Leche        30", "2    HUEVOS        36", "3     Leche        30", "4     TOTAL       136"].join("\n"),
    );
  });

  test("limpieza: rename, str.strip/lower, filtro, drop_duplicates", () => {
    const r = run(`
df = df.rename(columns={"Producto": "nombre", "Cantidad": "cantidad"})
df["nombre"] = df["nombre"].str.strip().str.lower()
limpio = df[df["nombre"] != "total"].drop_duplicates()
print(limpio["nombre"].tolist(), len(limpio), limpio["cantidad"].sum())
`);
    expect(r.error).toBeNull();
    expect(r.out).toBe("['pan', 'leche', 'huevos'] 3 106");
  });

  test("filtros combinados con & y |, columnas calculadas y df.columns = [...]", () => {
    const r = run(`
df.columns = ["codigo", "nombre", "categoria", "cantidad", "precio", "costo", "vence"]
df["margen"] = df["precio"] - df["costo"]
caros = df[(df["precio"] > 2000) & (df["cantidad"] > 30)]
print(caros["nombre"].tolist(), caros["margen"].tolist())
print(df[(df["nombre"] == "Pan ") | (df["nombre"] == "HUEVOS")]["codigo"].tolist())
`);
    expect(r.error).toBeNull();
    expect(r.out).toBe("['HUEVOS'] [1520]\n['P-001', 'P-003']");
  });

  test("iterrows, to_dict, dtypes, value_counts y apply", () => {
    const r = run(`
def doble(x):
    return x * 2
for i, fila in df.head(2).iterrows():
    print(i, fila["Producto"].strip())
print(df.dtypes["Cantidad"], df.dtypes["Producto"])
print(df["Producto"].value_counts()["Leche"])
print(df["Cantidad"].apply(doble).tolist()[0])
print(df.to_dict()[1]["Código"])
`);
    expect(r.error).toBeNull();
    expect(r.out).toBe("0 Pan\n1 Leche\nint64 object\n2\n80\nP-002");
  });

  test("errores útiles en español", () => {
    expect(run("df['producto']").error).toBe("Línea 3: la columna 'producto' no existe. ¿Quisiste decir 'Producto'?");
    expect(run("pd.read_excel('inventario.xlsx')").error).toContain("el archivo 'inventario.xlsx' no existe. Archivos: 'entrega_distribuidor.xlsx'");
    expect(run("df.columns = ['a']").error).toContain("la tabla tiene 7 columnas y le diste 1 nombres");
    expect(run("df.to_sql('x', db)").error).toContain("la base de datos todavía está arrancando");
  });
});
