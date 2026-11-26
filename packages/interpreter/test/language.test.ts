import { describe, expect, test } from "vitest";
import { errorOf, output, py } from "./helpers.js";

describe("expresiones", () => {
  test.each([
    ["print(1 + 2 * 3)", "7"],
    ["print((1 + 2) * 3)", "9"],
    ["print(7 // 2, 7 % 3, -7 // 2, -7 % 3)", "3 1 -4 2"],
    ["print(2 ** 3 ** 2)", "512"],
    ["print(-2 ** 2)", "-4"],
    ["print(10 / 4)", "2.5"],
    ["print(0.1 + 0.2)", "0.3"],
    ["print('ab' + 'cd', 'ja' * 3)", "abcd jajaja"],
    ["print(1 < 2 < 3, 3 > 2 > 2)", "True False"],
    ["print(1 == 1.0, 'a' != 'b')", "True True"],
    ["print(0 or 'x', 5 and 0, not None)", "x 0 True"],
    ["print('si' if 3 > 2 else 'no')", "si"],
    ["print(True + 1)", "2"],
    ["print(None, True, False)", "None True False"],
    ["print(3 in [1, 2, 3], 'a' not in 'casa', 5 in range(0, 10, 5))", "True False True"],
  ])("%s", (src, expected) => {
    expect(output(src)).toBe(expected);
  });

  test("textos con comillas y escapes", () => {
    expect(output(`print("hola\\tmundo", 'it\\'s')`)).toBe("hola\tmundo it's");
  });

  test("repr de colecciones", () => {
    expect(output("print([1, 'a', None, (1,), {'k': [True]}])")).toBe("[1, 'a', None, (1,), {'k': [True]}]");
  });
});

describe("variables y control", () => {
  test("asignación encadenada, aumentada y desempaquetado", () => {
    expect(
      output(py`
        a = b = 2
        a += 3
        b *= 10
        x, y = 1, 2
        x, y = y, x
        print(a, b, x, y)
      `),
    ).toBe("5 20 2 1");
  });

  test("if / elif / else", () => {
    const src = (n: number) => py`
      n = ${n}
      if n < 0:
          print("negativo")
      elif n == 0:
          print("cero")
      else:
          print("positivo")
    `;
    expect(output(src(-1))).toBe("negativo");
    expect(output(src(0))).toBe("cero");
    expect(output(src(5))).toBe("positivo");
  });

  test("while con break y continue", () => {
    expect(
      output(py`
        i = 0
        total = 0
        while True:
            i += 1
            if i % 2 == 0:
                continue
            if i > 9:
                break
            total += i
        print(total)
      `),
    ).toBe("25");
  });

  test("for sobre range, listas, textos y diccionarios", () => {
    expect(
      output(py`
        out = []
        for i in range(3):
            out.append(i)
        for c in "ab":
            out.append(c)
        for k in {"x": 1, "y": 2}:
            out.append(k)
        for i, v in enumerate(["p", "q"], 1):
            out.append(str(i) + v)
        print(out)
      `),
    ).toBe("[0, 1, 2, 'a', 'b', 'x', 'y', '1p', '2q']");
  });

  test("for en la misma línea y pass", () => {
    expect(output("for i in range(2): pass\nprint(i)")).toBe("1");
  });
});

describe("listas, tuplas y diccionarios", () => {
  test("métodos de lista", () => {
    expect(
      output(py`
        l = [3, 1, 2]
        l.append(5)
        l.insert(0, 9)
        l.remove(1)
        last = l.pop()
        l.sort()
        print(l, last, l.index(3), len(l), l[-1], l[1:3], l[:1])
      `),
    ).toBe("[2, 3, 9] 5 1 3 9 [3, 9] [2]");
  });

  test("lista += modifica la misma lista", () => {
    expect(output("a = [1]\nb = a\na += [2]\nprint(b)")).toBe("[1, 2]");
  });

  test("diccionarios", () => {
    expect(
      output(py`
        stock = {"pan": 3}
        stock["leche"] = 4
        stock["pan"] -= 1
        print(stock, stock.get("huevos", 0), "pan" in stock, len(stock))
        print(stock.keys(), stock.values(), stock.items())
        stock.pop("pan")
        print(stock)
      `),
    ).toBe(
      "{'pan': 2, 'leche': 4} 0 True 2\n['pan', 'leche'] [2, 4] [('pan', 2), ('leche', 4)]\n{'leche': 4}",
    );
  });

  test("tuplas como claves", () => {
    expect(output("d = {(1, 2): 'estante'}\nprint(d[(1, 2)])")).toBe("estante");
  });

  test("métodos de texto", () => {
    expect(output("print('a,b'.split(','), '-'.join(['x', 'y']), ' Hola '.strip().upper(), 'pan'.startswith('pa'))")).toBe(
      "['a', 'b'] x-y HOLA True",
    );
  });
});

describe("funciones", () => {
  test("parámetros por defecto, argumentos con nombre y return", () => {
    expect(
      output(py`
        def precio(base, iva=0.19, descuento=0):
            return round(base * (1 + iva) - descuento)
        print(precio(1000), precio(1000, descuento=100), precio(base=2000, iva=0))
      `),
    ).toBe("1190 1090 2000");
  });

  test("recursión", () => {
    expect(
      output(py`
        def fib(n):
            if n < 2:
                return n
            return fib(n - 1) + fib(n - 2)
        print(fib(15))
      `),
    ).toBe("610");
  });

  test("closures leen variables de la función externa", () => {
    expect(
      output(py`
        def externo():
            x = 5
            def interno():
                return x * 2
            return interno()
        print(externo())
      `),
    ).toBe("10");
  });

  test("global", () => {
    expect(
      output(py`
        vendidos = 0
        def vender():
            global vendidos
            vendidos += 1
        vender()
        vender()
        print(vendidos)
      `),
    ).toBe("2");
  });

  test("sorted, min y max con key= de una función del jugador", () => {
    expect(
      output(py`
        def vence(p):
            return p[1]
        lotes = [("leche", 4), ("pan", 1), ("queso", 3)]
        print(sorted(lotes, key=vence)[0][0], max(lotes, key=vence)[0], sorted([3, 1, 2], reverse=True))
      `),
    ).toBe("pan leche [3, 2, 1]");
  });

  test("funciones incluidas", () => {
    expect(output("print(abs(-3), min(4, 2), max([1, 9]), sum([1, 2, 3]), int('42'), float('2.5'), str(7) + '!')")).toBe(
      "3 2 9 6 42 2.5 7!",
    );
    expect(output("print(round(2.5), round(3.5), round(2.345, 2), int(3.9), list(reversed([1, 2])))")).toBe(
      "2 4 2.35 3 [2, 1]",
    );
  });
});

describe("errores en español con línea", () => {
  test.each([
    ["x = 1\nprint(y)", "Línea 2: 'y' no existe"],
    ["total = 1\nprint(totl)", "Línea 2: 'totl' no existe. ¿Quisiste decir 'total'?"],
    ["pirnt(1)", "Línea 1: 'pirnt' no existe. ¿Quisiste decir 'print'?"],
    ["print('a' + 1)", "Línea 1: no se puede sumar texto y número. Usa str(...) para convertir a texto"],
    ["print(1 / 0)", "Línea 1: división por cero"],
    ["l = [1]\nprint(l[3])", "Línea 2: el índice 3 está fuera de la lista (tiene 1 elementos)"],
    ["d = {}\nd['pan']", "Línea 2: la clave 'pan' no existe en el diccionario"],
    ["[].apend(1)", "Línea 1: lista no tiene 'apend'. ¿Quisiste decir 'append'?"],
    ["x = 5\nx()", "Línea 2: número no se puede llamar como función"],
    ["break", "Línea 1: 'break' fuera de un bucle"],
    ["return 1", "Línea 1: 'return' fuera de una función"],
    ["def f(a):\n    return a\nf(1, 2)", "Línea 3: 'f' recibe 1 valor(es) pero le diste 2"],
    ["def f(a):\n    return a\nf()", "Línea 3: a 'f' le falta el valor de 'a'"],
    ["def f():\n    f()\nf()", "Línea 2: demasiadas llamadas anidadas (máximo 64). ¿Recursión infinita?"],
    ["x = 0\ndef f():\n    x += 1\nf()", "Línea 3: la variable 'x' se usa antes de darle un valor"],
    ["a, b = [1, 2, 3]", "Línea 1: se esperaban 2 valores pero hay 3"],
    ["print(1 < 'a')", "Línea 1: no se puede comparar número con texto"],
  ])("%s", (src, expected) => {
    expect(errorOf(src)).toBe(expected);
  });

  test.each([
    ["if True\n    pass", "Línea 1: se esperaba ':' pero encontré fin de línea"],
    ["if True:\npass", "Línea 2: se esperaba un bloque indentado después de ':'"],
    ["x = 1\n    y = 2", "Línea 2: indentación inesperada"],
    ["if True:\n    a = 1\n  b = 2", "Línea 3: la indentación no coincide con ningún bloque anterior"],
    ["print('hola)", "Línea 1: falta cerrar las comillas del texto"],
    ["print((1)", "Línea 1: hay un paréntesis o corchete sin cerrar"],
    ["class Robot:\n    pass", "Línea 1: 'class' no existe en este juego (todavía)"],
    ["x = = 2", "Línea 1: no entiendo '=' aquí"],
    ["else:\n    pass", "Línea 1: 'else' sin un 'if' antes"],
  ])("sintaxis: %s", (src, expected) => {
    expect(errorOf(src)).toBe(expected);
  });

  test("límite de memoria del robot", () => {
    expect(errorOf("l = []\nwhile True:\n    l.append(1)", { maxCollectionSize: 100 })).toBe(
      "Línea 3: la memoria del robot se llenó (máximo 100 elementos)",
    );
    expect(errorOf("x = [0] * 1000000")).toContain("la memoria del robot se llenó");
  });
});

describe("textos de varias líneas", () => {
  test('"""...""" conserva los saltos de línea y lo que sigue en la línea', () => {
    expect(output('sql = """SELECT *\nFROM productos\nWHERE id = 1"""\nprint(sql)\nprint(len("""a\nb"""), 2)')).toBe("SELECT *\nFROM productos\nWHERE id = 1\n3 2");
  });
  test("dentro de una función, con indentación libre adentro", () => {
    expect(output('def f():\n    return """\n  hola\n"""\nprint(f().strip())')).toBe("hola");
  });
  test("sin cerrar: error claro", () => {
    expect(errorOf('x = """hola')).toBe('Línea 1: falta cerrar el texto con """');
  });
});

describe("comprensión de listas", () => {
  test.each([
    ["print([x * 2 for x in [1, 2, 3]])", "[2, 4, 6]"],
    ["print([x for x in range(10) if x % 2 == 0])", "[0, 2, 4, 6, 8]"],
    ["print([x for x in range(20) if x % 2 == 0 if x > 10])", "[12, 14, 16, 18]"],
    ["print([(x, y) for x in range(2) for y in 'ab'])", "[(0, 'a'), (0, 'b'), (1, 'a'), (1, 'b')]"],
    ["print([a + b for a, b in [(1, 2), (3, 4)]])", "[3, 7]"],
    ["print(['par' if n % 2 == 0 else 'impar' for n in range(3)])", "['par', 'impar', 'par']"],
    ["print([[c for c in range(r)] for r in range(3)])", "[[], [0], [0, 1]]"],
    ["print(sum([p for p in [2000, 4500]]), len([1 for _ in range(4)]))", "6500 4"],
    ["print([], [1], [1, 2,])", "[] [1] [1, 2]"],
  ])("%s", (src, expected) => {
    expect(output(src)).toBe(expected);
  });

  test("la variable del for no se sale de la comprensión y se ven las de afuera", () => {
    expect(output(py`
      x = "afuera"
      factor = 3
      nums = [x * factor for x in range(3)]
      print(nums, x)
    `)).toBe("[0, 3, 6] afuera");
  });

  test("dentro de una función ve los parámetros y las variables locales", () => {
    expect(output(py`
      def precios(productos, extra):
          base = 100
          return [base + extra for p in productos if p != "x"]
      print(precios(["pan", "x", "leche"], 5))
    `)).toBe("[105, 105]");
  });

  test("la variable no existe afuera después", () => {
    expect(errorOf(py`
      cuadrados = [i * i for i in range(3)]
      print(i)
    `)).toContain("'i' no existe");
  });
});
