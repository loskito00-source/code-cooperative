# -*- coding: utf-8 -*-
"""Contenido del GDD de Código de Barras. Editar aquí y volver a correr build_gdd.py."""

GAME = {
    "game_title": "Código de Barras",
    "tagline": "Tu supermercado. Tu código.",
    "genre": "Automatización con código, cooperativo",
    "platform": "Web (navegador de escritorio)",
    "audience": "2 amigos que quieren programar",
    "studio_name": "Proyecto personal",
    "version": "v0.1",
    "date": "Noviembre 2026",
    "lead_designer": "Diseño inicial",
    "monetization": "Ninguna (proyecto personal)",
    "team_size": "1 desarrollador (posiblemente 2)",
    "comparable_1": "The Farmer Was Replaced",
    "comparable_2": "Overcooked",
    "unique_hook": "Dos amigos programan juntos, en vivo, los robots de un mismo supermercado.",
    "sections": {},
}

S = GAME["sections"]

# ─────────────────────────────────────────────────────────────
S["executive_summary"] = """| Versión | Fecha | Autor | Cambios |
|---|---|---|---|
| 0.1 | 18 nov 2026 | Diseño inicial | Primera versión completa del GDD |

## Elevator pitch
Código de Barras es un juego web cooperativo para 2 jugadores en el que heredan un supermercado sin empleados y lo administran escribiendo código con sintaxis de Python para controlar robots. Juntos reponen estantes, cobran a los clientes, calculan la devuelta y hacen crecer un kiosco de barrio hasta convertirlo en un hipermercado, todo en tiempo real y compartiendo el mismo código.

## Propuesta de valor
- Programar es el control del juego: no hay botones de "reponer" ni "cobrar"; todo lo que pasa en la tienda lo hace un script escrito por los jugadores.
- Cooperación de verdad: los dos ven y editan cualquier script en vivo (como Google Docs), sus robots comparten pasillos y se tienen que coordinar con mensajes.
- Problemas de algoritmia disfrazados de tareas de tienda: el cambio de monedas, ordenar por fecha de caducidad (FIFO), rutas en un almacén y predicción de demanda aparecen solos al crecer el súper.

## Ficha rápida
| Campo | Valor |
|---|---|
| Género | Automatización por programación + simulación de tienda |
| Jugadores | Exactamente 2, cooperativo online |
| Plataforma | Navegador de escritorio (Chrome, Firefox, Edge) |
| Modo | Infinito, sin condición de victoria (por ahora) |
| Fallo | No hay quiebra: los errores solo cuestan ingresos y reputación |
| Lenguaje del jugador | Subconjunto de Python, comandos en inglés |
| Idioma de la interfaz | Español |
| Monetización | Ninguna, proyecto personal |
| Equipo | 1 desarrollador, posiblemente 2 |

## Juegos comparables
- The Farmer Was Replaced: misma base (dron + código + desbloqueos de sintaxis). Nosotros cambiamos la granja por un supermercado con clientes que reaccionan, y añadimos cooperación online.
- Overcooked: el caos cooperativo de una cocina. Nosotros lo trasladamos a "programa tu caos": la coordinación sucede en el código, no en los reflejos.
- Human Resource Machine / 7 Billion Humans: puzzles de programación con humor de oficina. Nosotros somos sandbox infinito en lugar de niveles cerrados.

## Por qué hacerlo
Es un proyecto para divertirse con un amigo y aprender. El alcance está pensado para 1 persona: modelos 3D gratuitos (Kenney, CC0), una sola pantalla principal y un servidor sencillo. La pieza técnica más arriesgada (el intérprete de Python) es también la más interesante de construir.
"""

# ─────────────────────────────────────────────────────────────
S["game_overview"] = """## High concept
Un supermercado donde todos los empleados son robots y la única forma de darles órdenes es programarlos, entre dos amigos y al mismo tiempo.

## Fantasía central
Ser el "ingeniero detrás de todo": ver cómo una tienda caótica se vuelve una máquina perfecta gracias a tu código y al de tu amigo. La satisfacción viene de ver a 6 robots moviéndose sin chocar mientras la cola de la caja nunca pasa de 2 clientes.

## Pilares de experiencia
Toda mecánica nueva debe apoyar al menos uno de estos 4 pilares:
1. Automatizar: si una tarea se repite, debe poder (y convenir) programarse.
2. Cooperar: el juego es mejor con dos cabezas; el diseño crea situaciones donde coordinarse rinde más que trabajar por separado.
3. Optimizar: siempre hay una versión más rápida del script, y el juego la recompensa con dinero medible.
4. Aprender jugando: cada concepto de programación se desbloquea cuando el jugador ya siente la necesidad de tenerlo.

## Flujo de una sesión
1. El jugador A abre la web, crea una sala y recibe un código de 4 letras (ej. KX7P). Se lo pasa a su amigo por chat.
2. El jugador B entra con el código. Ambos ven la tienda tal como la dejaron la última vez.
3. Revisan el panel de alertas: "Estante de leche vacío", "Cola de 5 clientes en caja 1".
4. A abre el script del cajero y arregla un bug con la devuelta; B ve su cursor en vivo y le sugiere usar una función de la librería compartida.
5. Presionan Ejecutar. Durante 20 minutos miran la tienda, ajustan scripts y compran una mejora (segunda caja).
6. Desbloquean "funciones" (def) y reescriben juntos los scripts para reutilizar código.
7. Salen; el servidor guarda el estado. La tienda queda en pausa hasta que alguien vuelva a entrar.

> 🎮 la tienda se pausa cuando no hay nadie conectado. Así ningún jugador "pierde" progreso por no estar, y no hace falta diseñar progresión offline.
"""

# ─────────────────────────────────────────────────────────────
S["core_gameplay_loop"] = """## Micro loop (2-5 minutos)
[DIAGRAM: Micro loop]
```
Observar la tienda -> Detectar problema -> Escribir/editar script -> Ejecutar
      ^                                                                |
      +---------- Ver resultado (dinero, emojis, tiquetes) <-----------+
```
El problema siempre es visible: un estante vacío parpadea en rojo, un cliente enojado muestra un emoji, el contador de dinero por minuto baja. El feedback de un cambio de código aparece en menos de 10 segundos de juego.

## Macro loop (20-60 minutos)
[DIAGRAM: Macro loop]
```
Ganar dinero -> Comprar desbloqueo (sintaxis, robot, producto, ampliación)
     ^                                    |
     +---- Nuevo problema que exige mejor código <---+
```
Cada desbloqueo cambia el tipo de problema. Ejemplo: comprar "Frescos" trae fruta que caduca, lo que rompe el script de reposición que solo miraba cantidades.

## Meta loop (semanas)
Llegar a la etapa Hipermercado, completar el árbol de desbloqueos y después optimizar la métrica de dinero por minuto. Como el modo es infinito, el meta loop final es superar su propio récord.

## Ganchos para volver
- "La próxima vez arreglamos el cajero": siempre queda un bug conocido pendiente.
- El siguiente desbloqueo está a la vista con su precio en la barra superior.
- Métrica de récord: dinero por minuto máximo alcanzado, visible en el lobby de la sala.
"""

# ─────────────────────────────────────────────────────────────
S["game_mechanics"] = {
    "content": """Esta sección especifica cada sistema con el formato Entrada / Sistema / Feedback / Parámetros / Justificación. Los valores numéricos son iniciales y deben validarse jugando.""",
    "subsections": [
        {
            "title": "5.1 Tiempo, ticks y ejecución de scripts",
            "content": """Entrada: el jugador asigna un script a un robot y presiona Ejecutar (o Detener).

**Implementado (reemplaza a los ticks para el jugador):** la velocidad de cada robot depende del **tamaño de su código**. Se cuentan instrucciones (no líneas de texto; los comentarios y las líneas en blanco no cuentan). Con 20 instrucciones va a velocidad normal; cada instrucción de más o de menos cambia la duración de sus acciones un 2,5 % (de ×2 más rápido con 4 o menos, a ×0,4 con 80 o más). Para que no se pueda hacer trampa pasando el código a shared.py, también cuentan las funciones de shared que el robot usa (con `shared.f()` o `from shared import f`), las que esas llaman, y lo que shared ejecuta al importarse; si el robot usa el módulo de otra forma (lo guarda en una variable o lo pasa), cuenta todo shared. La velocidad se fija al presionar Ejecutar y se ve en la barra de cada ventana de robot. El servidor sigue frenando (bucle sin wait(), ataques, malware, calor). Ya no se muestran ticks en la interfaz y no hay mejoras de CPU en el árbol. Código: `packages/sim/src/codesize.ts`.

Diseño original (referencia): el servidor simula la tienda a 10 ticks por segundo. Cada robot ejecuta su script como una corrutina: en cada tick dispone de un presupuesto de operaciones para el intérprete (asignaciones, comparaciones, llamadas). Las acciones físicas (moverse, tomar, cobrar) consumen ticks enteros y bloquean al robot mientras duran.

Feedback: la línea en ejecución se resalta en el editor; el robot muestra una barra de progreso sobre la cabeza durante acciones largas.

| Parámetro | Valor inicial | Rango | Notas |
|---|---|---|---|
| Ticks por segundo | 10 | 10 fijo | Velocidad de simulación del servidor |
| Ops del intérprete por tick | 50 | 50-400 | Mejorable con "CPU" (ver Progresión) |
| move() | 4 ticks | 2-4 | Se reduce con mejora "Ruedas" |
| pick() / place() | 3 ticks | 1-3 | Por unidad, mejorable |
| scan (por producto) | 2 ticks | 1-2 | Mejora "Lector láser" |
| give_change() | 3 ticks | 3 | Fijo |
| mop() | 6 ticks | 3-6 | Limpiar derrame |
| Bucle infinito sin acciones | Permitido | - | Solo gasta su presupuesto de ops por tick; no bloquea el servidor |

> 🎮 igual que en The Farmer Was Replaced, separar "pensar" (ops baratas) de "actuar" (ticks caros) hace que optimizar signifique menos movimientos, no código más corto.

[PLAYTEST: Ajustar 50 ops/tick; si los scripts de principiante se sienten lentos por pensar, subir a 100]"""
        },
        {
            "title": "5.2 Robots y movimiento",
            "content": """Entrada: move(North|South|East|West), go_to(x, y) (desbloqueable), get_pos().

Sistema: la tienda es una cuadrícula. Cada casilla es Piso, Estante, Caja, Almacén o Entrada; entre dos casillas puede haber una pared (con puerta) que el robot no puede cruzar. El almacén es un cuarto aparte, al oeste de la tienda, que se conecta por una puerta. Solo 1 robot por casilla. Si un robot intenta entrar en una casilla ocupada, espera 1 tick y reintenta; tras 20 ticks bloqueado, move() devuelve False.

Feedback: robot con color de su "equipo" (cian o naranja según quien lo compró, solo estético). Signo "!" sobre robots bloqueados.

| Parámetro | Valor | Notas |
|---|---|---|
| Robots al inicio | 2 (1 reponedor, 1 cajero) | Compartidos |
| Robots máximos | 8 | Ampliable por etapa |
| Capacidad de carga | 5 unidades | Mejorable a 20 |
| Espera por bloqueo | 20 ticks | Luego move() devuelve False |

Los robots no tienen dueño: cualquiera de los 2 jugadores puede editar su script."""
        },
        {
            "title": "5.3 Reposición de estantes",
            "content": """Entrada: pick(product, n) en cualquier casilla del almacén, place() sobre un estante, warehouse_stock(product), shelf.stock(), shelf.product().

Sistema: el almacén es un cuarto con la mercancía que trajo el distribuidor, y su contenido ES la tabla de inventario que el jugador diseñó en la misión: las unidades salen de su columna de cantidad, cada pick() las descuenta de esa tabla y, si el jugador la edita con SQL, el almacén cambia. Si la tabla no tiene columna de cantidad, el almacén queda vacío. En cuanto el robot entra al cuarto puede tomar cualquier producto. Si un producto básico se acaba en el almacén, pick() lo pide al proveedor del barrio, que cobra el 60% del precio; los productos premium solo llegan pidiéndolos a El Surtidor (5.8).

Los estantes empiezan vacíos y libres. Cada estante tiene un solo producto: el primero que se ponga con place() lo define y queda así toda la partida (un estante de pan no acepta leche). Así los jugadores deciden cómo repartir los productos (p. ej. dos estantes de pan). Capacidad de 10 unidades por estante. Los clientes van al estante más cercano que tenga su producto; si no hay, se marca como "no encontrado".

Feedback: el estante llena sus 10 huecos según el stock real, muestra "Libre" mientras no tiene producto y "Sin pan" parpadeando al llegar a 0. Al pasar el mouse por un estante aparece su producto, cuántas unidades tiene y cuántas le caben (p. ej. "7 de 10 leche, caben 3 más"). En el almacén hay una estantería metálica por producto (cajas con franja de color: pan naranja, leche azul, huevos amarillo) que se vacía a medida que baja la tabla de inventario; al pasar el mouse dice cuántas unidades quedan.

La cámara mira la tienda de frente desde el sur, con una brújula: North arriba, East a la derecha, West a la izquierda y South abajo, igual que move().

| Parámetro | Valor | Notas |
|---|---|---|
| Capacidad por estante | 10 | Mejorable a 20 |
| Estantes en el Kiosco | 4, libres | El jugador elige qué va en cada uno |
| Productos al inicio | 3 (pan, leche, huevos) | Ver Contenido |
| Almacén al inicio | Lo que diga la tabla del jugador | Con la hoja bien limpia: pan 40, leche 30, huevos 36 |"""
        },
        {
            "title": "5.4 Clientes",
            "content": """Sistema: los clientes llegan por la Entrada con una lista de 1 a 8 productos, recorren los estantes, hacen fila en la caja con menos cola y pagan. En cada estante se quedan mirando 0,8 s antes de tomar el producto. Si ningún estante vende lo que buscan, igual caminan hasta uno a buscarlo (no se devuelven desde la puerta) y ahí se dan cuenta de que no hay.

Fórmula de llegada:
```
clientes_por_minuto = base_etapa * (0.2 + reputacion / 62.5)
Donde:
  base_etapa: 2 (Kiosco) ... 30 (Hipermercado)
  reputacion: 0-100, inicia en 50  -> multiplicador 0.2 a 1.8
```

| Parámetro | Valor | Notas |
|---|---|---|
| Productos por lista | 1-8 | Más en etapas altas |
| Paciencia en cola | 45 s | Se va sin pagar al agotarse |
| Productos no encontrados | -2 reputación por producto | |
| Abandono de cola | -4 reputación | |

Feedback: emoji sobre la cabeza (feliz, neutral, enojado) y globo con el producto que no encontró."""
        },
        {
            "title": "5.5 Robot Cajero (mecánica central)",
            "content": """Entrada: el jugador programa el cajero con has_customer(), scan_item(), price(item), take_payment(), give_change(amount) y next_customer().

Ejemplo mínimo:
```
while True:
    if has_customer():
        total = 0
        for item in scan_item():
            total = total + price(item)
        pago = take_payment(total)
        give_change(pago - total)
        next_customer()
```

Sistema: el juego no cobra solo. take_payment(total) informa al cliente cuánto cobrar y devuelve lo que el cliente entrega. El servidor compara lo cobrado y la devuelta con los valores correctos:

| Resultado | Consecuencia |
|---|---|
| Cobro y devuelta exactos | +1 reputación, cliente feliz |
| Cobra de más o devuelve de menos | -5 reputación, cliente furioso; el dinero de más se devuelve automáticamente |
| Cobra de menos o devuelve de más | La tienda pierde la diferencia; el cliente no se queja |
| Tarda más de 30 s por cliente | La cola crece y otros clientes pueden abandonar |
| give_change sin billetes suficientes | Error en consola; el cliente espera |

Feedback: tiquete impreso en pantalla con cada línea (producto, precio, total, pagó, devuelta). Al final de cada día de juego aparece el Cuadre de caja: esperado vs real.

### Billetes y monedas (desde la etapa 3)
La caja tiene una gaveta con cantidades limitadas de cada denominación. give_change() recibe un diccionario o lista de denominaciones en lugar de un número:
```
give_change({1000: 2, 500: 1})   # devuelve 2500
```
| Denominación | Tipo | Cantidad inicial en gaveta |
|---|---|---|
| 50, 100, 200, 500, 1000 | Moneda | 20 de cada una |
| 2000, 5000, 10000 | Billete | 10 de cada uno |
| 20000, 50000 | Billete | 5 de cada uno (casi siempre los entrega el cliente) |

Los billetes que entrega el cliente se suman a la gaveta. request_change(denominacion, n) pide cambio al banco: tarda 300 ticks y cobra 1% de comisión.

### Escalado de dificultad
| Etapa | Reto nuevo | Concepto |
|---|---|---|
| 1-2 | Sumar precios, pago exacto | variables, for |
| 2 | Calcular la devuelta como número | aritmética |
| 3 | Gaveta con denominaciones limitadas | algoritmo greedy, listas |
| 4 | Faltan monedas: el greedy falla | problema del cambio de monedas |
| 4 | Fruta por peso: price(item) * item.weight | floats y redondeo a 50 |
| 5 | Ofertas 2x1 y % de descuento, IVA 19% | funciones, condicionales |
| 6 | Tarjeta y cupones; caja rápida (máximo 10 productos) | diccionarios, coordinación |

> 🎮 el salto de la etapa 3 a la 4 es nuestro equivalente a ordenar cactus en The Farmer Was Replaced: un problema algorítmico clásico que aparece como "se acabaron las monedas de 100".

[OPEN QUESTION: ¿El redondeo de precios con decimales (fruta por peso) debe ser al múltiplo de 50 más cercano o siempre hacia arriba?]"""
        },
        {
            "title": "5.6 Perecederos",
            "content": """Sistema: lácteos, fruta y carne tienen fecha de caducidad en días de juego. 1 día de juego = 10 minutos reales con alguien conectado. Un producto vencido en estante: si el cliente lo compra, -8 reputación. item.expires_in() devuelve los días restantes.

| Producto | Vida útil |
|---|---|
| Pan | 2 días |
| Leche | 4 días |
| Fruta | 3 días |
| Carne (refrigerado) | 2 días; 0.5 días si pasa más de 60 ticks fuera de nevera |

El reto natural es ordenar FIFO: reponer primero lo que vence antes y retirar lo vencido con discard()."""
        },
        {
            "title": "5.7 Derrames y limpieza",
            "content": """Sistema: cada minuto hay 5% de probabilidad por pasillo de que aparezca un derrame. Un cliente que pisa un derrame: -3 reputación. Un robot que lo pisa queda resbalando 10 ticks. get_spills() devuelve sus posiciones; mop() limpia la casilla actual."""
        },
        {
            "title": "5.8 Proveedores y pedidos",
            "content": """Implementado (prototipo): la página de la Distribuidora El Surtidor en el Navegador del juego (elsurtidor.test, sitio ficticio). Es el mismo distribuidor del camión de la intro.

Entrada: el jugador elige cuántas cajas (de 10 unidades, máximo 9 por producto) pide de cada producto y paga al pedir. El repartidor llega 1 minuto de juego después y deja un Excel pedido_N.xlsx en la carpeta entregas del explorador.

Migración: la mercancía NO entra sola al almacén. El almacén es la tabla de inventario del jugador, así que hay que migrar el Excel: pd.read_excel("pedido_1.xlsx"), hoja.select("A1", hoja.last_cell), limpiar con Python y subir con cursor.execute (INSERT si el producto es nuevo, UPDATE cantidad = cantidad + n si ya estaba). El Excel tiene SIEMPRE la misma estructura que entrega_distribuidor.xlsx (mismas columnas, la fila TOTAL al final, nombres desordenados y a veces una fila anotada dos veces), así que el mismo script sirve para todos los pedidos. hoja.last_cell da la última celda porque el número de filas cambia.

| Producto | Precio | Costo (El Surtidor) | Demanda | Tipo |
| --- | --- | --- | --- | --- |
| pan, leche, huevos | $2.000 / $4.500 / $3.800 | 50% (mayorista) | 1 | Básico |
| chocolate | $9.000 | $4.500 | 2,2 | Premium |
| queso | $16.000 | $8.000 | 2 | Premium |
| miel | $22.000 | $11.000 | 1,8 | Premium |
| aceite | $26.000 | $13.000 | 1,8 | Premium |
| vino | $48.000 | $24.000 | 1,6 | Premium |

Productos premium: cuestan más pero se venden mucho mejor. (1) Los clientes los piden según su demanda: un producto con demanda 2 sale el doble de veces que el pan. (2) Cada producto premium con unidades en los estantes trae 12% más clientes. Los clientes solo piden lo premium que la tienda vende (que tiene estante), así que con 4 estantes el jugador decide qué vender. Los básicos los sigue trayendo el proveedor del barrio desde pick() (60% del precio); lo premium no: si se acaba, hay que pedirlo otra vez.

En el almacén 3D, las estanterías premium (pared oeste) aparecen cuando llega su primera mercancía migrada.

Pendiente (diseño original): get_sales_history(product, dias), descuento por volumen, perecederos que se pierden si se pide de más."""
        },
        {
            "title": "5.9 Comunicación entre robots",
            "content": """Entrada: send(robot_name, mensaje), receive() (devuelve None si no hay mensajes), broadcast(mensaje), y la librería compartida shared.py importable con import shared.

Sistema: cada robot tiene una bandeja de hasta 20 mensajes; los más viejos se descartan. Los mensajes son texto, números, listas o diccionarios simples.

Uso esperado: el reponedor avisa al cajero que repuso; el cajero pide al reponedor más bolsas; dos robots reservan pasillos para no chocar."""
        },
    ],
}

# ─────────────────────────────────────────────────────────────
S["game_mechanics"]["subsections"].append({
    "title": "5.10 Base de datos de la tienda (SQL)",
    "content": """Entrada: el jugador abre la ventana Base de datos y escribe consultas SQL (PostgreSQL real, vía PGlite en el navegador).

Sistema: la base de datos del jugador empieza VACÍA: él diseña todas las tablas (CREATE TABLE) y decide qué guardar. Aparte, el juego lleva un registro interno (invisible para el jugador) con la hora del juego, que usa para verificar y que en el futuro puede servir para auditorías ("¿cuadra tu tabla de ventas con lo que pasó de verdad?"). Tablas del registro interno:

| Tabla | Qué guarda |
|---|---|
| products | Productos, precio, costo, stock en estantes y en el almacén, y su primer estante |
| customers | Cada cliente: llegada, salida, lista de compras (TEXT[]), resultado y ánimo |
| sales | Cada cobro: total, cobrado, pagó, devuelta, resultado y cajero |
| sale_items | Cada producto de cada venta |
| stockouts | Veces que un cliente encontró el estante vacío |
| supplier_purchases | Compras al proveedor (pick) con costo total calculado |
| restocks | Productos puestos en el estante (place) |
| robots | Estado actual de cada robot |

Feedback: resultados en tabla, número de filas y milisegundos; errores de PostgreSQL traducidos al español (con el original debajo).

Consultas guardadas: el jugador escribe sus propias consultas, les pone nombre y las ejecuta con un clic. El juego no trae consultas de fábrica: armarlas es parte del reto.

> 🎮 Nota de diseño: la base de datos convierte la tienda en un problema de análisis de datos: ¿qué producto falta más?, ¿a qué hora se vende más?, ¿cuánta plata perdió la caja? Más adelante los robots podrán consultar la misma base (sql() desde Python) para decidir qué reponer.

[OPEN QUESTION: ¿Los robots deberían poder ejecutar SQL desde su código, como desbloqueo de etapa 6?]"""
})

S["game_mechanics"]["subsections"].append({
    "title": "5.11 Llegada del distribuidor e inventario (pandas + SQL)",
    "content": """Inicio de partida: pantalla de inicio (el clic activa el audio), cinemática en el callejón detrás de la tienda: llega el camión de Distribuidora El Surtidor, se estaciona y abre las puertas con las cajas adentro. Luego, la carta de bienvenida de la abuela y la misión "Organiza tu inventario".

La hoja del distribuidor (entrega_distribuidor.xlsx) viene desordenada a propósito: encabezados con tildes y espacios ("Precio Unitario"), nombres con mayúsculas y espacios ("Pan ", "HUEVOS"), la leche anotada dos veces y una fila TOTAL.

| Paso de la misión | Cómo se comprueba |
|---|---|
| Leer la hoja con pandas | inventario.py usó pd.read_excel y terminó sin error |
| Crear tablas | hay al menos una tabla en el esquema public |
| Subir pan, leche y huevos | una tabla del jugador contiene los tres nombres |
| Sin repetidos ni TOTAL | cada producto aparece una vez y no hay una fila "total" |

El panel tiene un botón Saltar (con confirmación): crea por el jugador la tabla inventario con la hoja ya limpia y pasa directo a la primera noche.

Al completar la misión, las cajas del camión "entran" al almacén y se habilita Abrir la tienda: la cámara vuela del callejón a la tienda y cae la primera noche (5.12).

pandas del juego (a propósito, solo dos comandos): pd.read_excel(archivo) devuelve la hoja (print la muestra con letras de columna y números de fila) y hoja.select("A1", "G6") devuelve las celdas del rango como una lista de diccionarios, uno por fila, con los encabezados de la fila 1 como claves. Limpiar (quitar repetidos, saltar la fila TOTAL, strip/lower) lo hace el jugador con Python normal, y sube cada fila con SQL: cursor.execute("INSERT INTO ... VALUES (%s, %s)", (a, b)). Nada crea tablas por él: diseña el esquema con CREATE TABLE.

Base de datos desde el código (sin await): cursor.execute, cursor.fetch, cursor.fetchrow, cursor.fetchval y cursor.executemany con parámetros %s (o $1, $2...) en una tupla. Por ejemplo, la cajera puede registrar cada venta en la tabla que el jugador diseñó.

Permisos: el jugador (rol jugador de PostgreSQL) solo tiene su esquema public; el registro interno del juego (esquema registro) no existe para él. Las tablas del jugador se guardan en el navegador (IndexedDB)."""
})

S["game_mechanics"]["subsections"].append({
    "title": "5.12 Día y noche",
    "content": """La tienda vive en ciclos de día y noche. Cada día es como un nivel nuevo: llegan más clientes (y más adelante, eventos).

| Fase | Duración | Qué pasa |
|---|---|---|
| Día | 5 minutos de juego (de 7:00 a 19:00) | La tienda abierta: llegan clientes (y en el futuro, proveedores) |
| Noche | 10 minutos reales (de 19:00 a 7:00) | La tienda cerrada: no llegan clientes ni proveedores. Es el momento de escribir código y probar mecánicas nuevas (y en el futuro, encargar productos) |

Reglas:

| Regla | Valor |
|---|---|
| Primera noche | Llega al terminar la misión del inventario: es la preparación (10 min para programar a Toño y Lupe) |
| Abrir antes | Los 2 jugadores votan "¡Listo!" (se puede retirar el voto) y amanece de inmediato |
| Fin de la noche | Amanece a las 7:00 y la tienda abre igual: si el código no está listo, es problema de ellos |
| 19:00 | La tienda cierra: no entran más clientes; los que ya estaban adentro terminan de comprar |
| Más clientes cada día | +25% por día sobre la tasa base |
| Reloj | El día corre con la velocidad del juego (2× y 4× lo aceleran); la noche cuenta tiempo real (la pausa no la alarga) |
| Al recargar | La simulación no se guarda: si ya pasó la primera noche, empieza el día 1 directo |

Feedback: el letrero muestra "Día N" y la hora (☀️ de día, 🌙 de noche). La luz cambia: amanecer anaranjado, día, atardecer y noche azul oscura con las lámparas de la tienda encendidas. Aviso "La tienda cierra en 30 s". Cada noche muestra un panel con la cuenta regresiva, los votos y el resumen del día que terminó (ventas, plata, clientes perdidos, cobros mal). En la base de datos, las horas del registro interno son las del reloj del juego (el día 1 es el 5 de enero de 2026).

Música (toda procedural): "inventario" durante la misión (pensativa), "mañana" de 7:00 a 13:00 (alegre), "tarde" después (lo-fi tranquilo), "noche" con la tienda cerrada (pads lentos y campanitas) y "prisa" cuando hay 4 o más clientes en la cola o faltan 30 s para cerrar. Al cerrar suenan campanitas de cuna; al amanecer, la fanfarria de apertura.

[PLAYTEST: ¿10 minutos de noche es mucho cuando el código ya está listo? Se puede abrir antes votando.]"""
})

S["progression_system"] = """La progresión se compra con dinero en el **árbol de Mejoras** (ventana Mejoras). Toda la sintaxis de Python viene desbloqueada desde el inicio: lo que se compra es la tienda.

## Árbol de Mejoras (implementado)
Tres ramas. Cada mejora se une a las que necesita; las que ya se pueden comprar brillan con el color de su rama.
| Rama | Mejora | Costo | Necesita | Efecto |
|---|---|---|---|---|
| La tienda | Estante nuevo | $4.000 | - | +1 estante; el jugador elige la casilla en la tienda |
| La tienda | Dos estantes | $9.000 | Estante nuevo | +2 estantes |
| La tienda | Ampliar el local | $25.000 | Estante nuevo | Abre el terreno 1: 3 columnas al este; caben 4 clientes más |
| La tienda | Tres estantes | $20.000 | Ampliar el local, Dos estantes | +3 estantes |
| La tienda | Supermercado | $60.000 | Ampliar el local | Abre el terreno 2: otras 3 columnas; 4 clientes más |
| La tienda | Cuatro estantes | $40.000 | Supermercado, Tres estantes | +4 estantes |
| Marketing | Volantes | $3.000 | - | 15 % más clientes |
| Marketing | Música ambiental | $8.000 | Volantes | 50 % más paciencia en la fila |
| Marketing | Letrero luminoso | $12.000 | Volantes | 20 % más clientes |
| Marketing | Cuña en la radio | $30.000 | Letrero | 30 % más clientes |
| Marketing | Redes sociales | $70.000 | Radio | 40 % más clientes |
| Equipo | Segunda caja | $20.000 | - | Otra caja con su robot cajero (Memo); el jugador elige dónde ponerla |
| Equipo | Tercera caja | $45.000 | Segunda caja | Otra caja con su cajera (Kika) |
| Equipo | Robot reponedor | $15.000 | - | Un robot como Toño (Chucho) aparece en el almacén |
| Equipo | Otro reponedor | $35.000 | Robot reponedor | Otro reponedor (Rosa) |
| Centro de datos | Sala más grande | $12.000 | - | Caben 2 racks (el gabinete se compra en TecnoMercado) |
| Centro de datos | Centro de datos | $35.000 | Sala más grande | Caben 3 racks |

Cajas: cada caja tiene su propia fila hacia el este (5 casillas donde no caben estantes) y su cajero solo atiende esa fila. Cada cliente se forma en la caja activa con menos fila. Clic en una caja la activa o la desactiva: una caja inactiva no recibe clientes y su fila (los que no han empezado a ser atendidos) pasa a otra caja activa. Con todas cerradas no entra nadie. Para colocar una caja se necesitan 2 casillas libres al este; el cajero llega parado en ella con una ventana de código propia.

Mantenimiento de servidores: clic en un rack con servidor pregunta si abrir la terminal o el rack. Abrir el rack apaga el servidor (sus robots se detienen) y vuelve a mostrar su montaje: clic en una pieza montada la saca al almacén (lo que va encima hay que sacarlo antes; los cables que dependen de ella se sueltan). Al cerrar la tapa y pasar el POST vuelve a encender con su Linux, su red y sus archivos, y con las especificaciones nuevas.

Cliente de prueba (noche): mientras la tienda está cerrada, a cada caja activa llega siempre un cliente de prueba con 1 a 3 productos. Se atiende con el mismo código, pero no mueve plata, no gasta productos, no cambia la reputación ni queda en la base de datos; el tiquete sale marcado "PRUEBA" y un globo dice si cobró bien. Al despedirlo llega otro en 3 s. Al amanecer se van.

Robots nuevos: cada robot corre en el mismo servidor que los demás y ocupa RAM y CPU, así que comprar robots empuja a mejorar el centro de datos.

Colocar estantes: al comprarlos, la tienda entra en modo colocar (casillas válidas en verde, un estante fantasma sigue al mouse). No se puede en la fila de la caja, frente a la entrada, frente a la puerta del almacén ni en terreno sin comprar. Esc o clic derecho lo deja para después (botón "Colocar en la tienda" en Mejoras). get_shelves() los devuelve de oeste a este.

Terreno por ampliar: el mapa ya tiene el tamaño final (15 x 6) y las columnas sin comprar se ven como obra con cinta amarilla; los robots no pueden entrar. Las coordenadas nunca cambian al ampliar, así que el código de los jugadores sigue sirviendo.

[PLAYTEST: costos del árbol y cuánto pesa el marketing frente a la reputación.]

## Diseño original (referencia)
Hay 4 tipos de desbloqueo: sintaxis, comandos, contenido (productos, robots) y mejoras numéricas.

## Etapas de la tienda
| Etapa | Tamaño | base_etapa | Se requiere | Problema nuevo |
|---|---|---|---|---|
| 1. Kiosco | 6x6 | 2 | Inicio | Reponer a mano es lento |
| 2. Almacén de barrio | 10x8 | 4 | $20.000 | Caja y clientes reales |
| 3. Minimercado | 14x10 | 8 | $80.000 | Muchos productos, gaveta de billetes |
| 4. Frescos | 16x12 | 12 | $250.000 | Caducidad, fruta por peso, falta de monedas |
| 5. Equipo | 20x14 | 16 | $600.000 | Más robots, choques, mensajes |
| 6. Supermercado | 24x18 | 22 | $1.500.000 | Proveedores, ofertas, IVA |
| 7. Hipermercado | 32x24 | 30 | $4.000.000 | Almacén grande, rutas óptimas |

## Árbol de sintaxis (descartado: ahora toda la sintaxis viene desbloqueada)
Diseño anterior: al inicio solo existían llamadas a funciones del juego y while True. Lo demás se compraba:
| Desbloqueo | Costo | Etapa mínima |
|---|---|---|
| if / else | $1.000 | 1 |
| Variables | $2.500 | 1 |
| for + range | $6.000 | 2 |
| Listas | $15.000 | 3 |
| def (funciones) | $40.000 | 3 |
| import shared | $60.000 | 4 |
| Diccionarios | $120.000 | 5 |
| send / receive | $150.000 | 5 |
| Clases (opcional) | $900.000 | 6 |

## Mejoras numéricas
| Mejora | Niveles | Costo nivel 1 | Escalado | Efecto |
|---|---|---|---|---|
| CPU | 4 | $5.000 | x3 | 50 -> 100 -> 200 -> 400 ops/tick |
| Ruedas | 2 | $10.000 | x4 | move 4 -> 3 -> 2 ticks |
| Lector láser | 1 | $30.000 | - | scan 2 -> 1 tick |
| Canasta grande | 3 | $8.000 | x3 | carga 5 -> 10 -> 15 -> 20 |
| Nuevo robot | 6 | $15.000 | x2 | Hasta 8 robots |

## Ritmo estimado
| Perfil | Tiempo por semana | Llega a Hipermercado |
|---|---|---|
| Casual | 1 sesión de 1 h | ~8 semanas |
| Normal | 3 sesiones de 1 h | ~3 semanas |
| Intenso | 2 h diarias | ~1 semana |

[PLAYTEST: Todos los costos y tiempos son iniciales; medir el tiempo real hasta la etapa 3 en el primer prototipo]
"""

# ─────────────────────────────────────────────────────────────
S["content_design"] = """## Catálogo de productos (lanzamiento: 20)
| Producto | Precio | Etapa | Especial |
|---|---|---|---|
| Pan | 2.000 | 1 | Perecedero (2 días) |
| Leche | 4.500 | 1 | Perecedero (4 días) |
| Huevos (x6) | 3.800 | 1 | - |
| Arroz | 3.200 | 2 | - |
| Café | 12.500 | 2 | - |
| Gaseosa | 3.000 | 2 | Combo con papas |
| Papas fritas | 2.500 | 2 | Combo con gaseosa |
| Jabón | 4.000 | 3 | - |
| Papel higiénico | 9.800 | 3 | Voluminoso (ocupa 2 de carga) |
| Atún | 5.500 | 3 | - |
| Banano | 2.800/kg | 4 | Por peso |
| Manzana | 7.000/kg | 4 | Por peso |
| Tomate | 4.200/kg | 4 | Por peso |
| Queso | 9.000 | 4 | Refrigerado |
| Pollo | 14.000/kg | 4 | Refrigerado, por peso |
| Helado | 11.000 | 5 | Congelado |
| Cerveza | 3.500 | 5 | Requiere verificar edad |
| Cereal | 10.500 | 6 | - |
| Aceite | 15.000 | 6 | - |
| Pañales | 42.000 | 6 | Caro: tienta a robar (futuro) |

## Tipos de cliente
| Tipo | Etapa | Comportamiento |
|---|---|---|
| Vecino | 1 | Lista corta, paga con billete pequeño |
| Apurado | 2 | Paciencia 20 s, 1-3 productos |
| Familia | 3 | Lista de 6-8, paga con 50.000 |
| Exacto | 3 | Siempre paga justo (pruebas fáciles) |
| Cazaofertas | 6 | Solo compra en oferta |

## Eventos aleatorios (1 cada 2-3 días de juego)
- Hora pico: x2 clientes durante 2 minutos.
- Corte de luz: las neveras se apagan 60 segundos.
- Inspección sanitaria: +10 reputación si no hay vencidos, -15 si los hay.
- Camión retrasado: el pedido llega 1 día tarde.

## Criterio para contenido nuevo
Un producto o evento nuevo solo entra si obliga a cambiar al menos un script existente. Si se puede ignorar sin consecuencias, no aporta.
"""

# ─────────────────────────────────────────────────────────────
S["narrative_world"] = """Narrativa ligera e intencionalmente de fondo.

La abuela de los jugadores les deja en herencia "Supermercado La Esquina", un kiosco de barrio. Junto a la herencia hay una nota: "Los muchachos del barrio ya no quieren trabajar aquí, pero en el sótano dejé dos robots viejos. Ustedes saben de computadores, ¿no?"

Tono: humor cálido de barrio. Los clientes tienen frases cortas ("¿No hay leche otra vez?"). Los robots tienen nombres que se pueden cambiar (por defecto Toño y Lupe).

La narrativa sirve para el tutorial (carta de bienvenida al llegar el primer pedido de Distribuidora El Surtidor) y para mensajes al cambiar de etapa. No hay diálogos ramificados.
"""

# ─────────────────────────────────────────────────────────────
S["ux_interface"] = """## Pantallas
| Pantalla | Entra desde | Acción principal | Sale a |
|---|---|---|---|
| Inicio | URL | Crear sala / Unirse con código | Lobby |
| Lobby de sala | Inicio | Esperar al amigo, ver récord | Juego |
| Juego | Lobby | Ver tienda + editar código | Lobby (salir) |
| Árbol de Mejoras | Juego (botón Mejoras) | Comprar, colocar estantes | Juego |
| Cuadre del día | Automático al final del día | Leer y cerrar | Juego |

## Layout de la pantalla de juego
Inspirado en The Farmer Was Replaced: el juego ocupa toda la pantalla y el código vive en ventanas flotantes.
```
+------------------------------------------------------------------+
| Letrero: $ | Rep | $/min | Reloj | Velocidad | [Navegador][Tiquetes][Mejoras][Base de datos][Comandos]
+---------------------+--------------------------------------------+
| Ventana: Toño       |                                   alertas  |
|  [Ejecutar][Detener]|                                            |
|  editor             |        Tienda 3D (pantalla completa)       |
|  consola            |                                            |
+---------------------+                                            |
| Ventana: Lupe       |                                   tiquete  |
+---------------------+--------------------------------------------+
```
- Cada ventana se arrastra por su barra, cambia de tamaño por la esquina, se minimiza (doble clic en la barra) y se cierra. Las posiciones se guardan.
- Hacer clic en un robot en la tienda abre su ventana y la trae al frente.
- La tienda se centra sola en el espacio que dejan libre las ventanas.

## Edición colaborativa
- Los dos pueden editar el mismo script a la vez; cursores de colores.
- Los cambios se aplican al robot solo al presionar Ejecutar.
- Historial: las últimas 20 versiones ejecutadas de cada script, con botón Restaurar.

## Depurador
- Punto de parada: clic a la izquierda del número de línea (punto rojo). El robot se detiene antes de ejecutar esa línea.
- Botones por ventana: Ejecutar/Reiniciar, Pausar/Continuar (F8), Paso (F10, una línea), Detener.
- Al detenerse un robot, solo se detiene ese robot: la tienda sigue corriendo (los clientes siguen llegando).
- La consola y las variables se agrandan o se achican arrastrando la barra que tienen encima.
- Pestaña Variables: nombre, valor y tipo de cada variable (locales de la función y globales del script).
- La línea pausada se marca en amarillo y el robot muestra un globo "⏸ línea N" en la tienda.

## Comprensión de listas
Se puede usar como en Python: [x * 2 for x in numeros], con if al final para filtrar y varios for encadenados. La variable del for solo existe dentro de los corchetes. Ejemplo en la caja: total = sum([price(p) for p in scan_item()]).

## Texto con valores
f-strings de Python: f"Total: {total}", con formato {x:.2f}, {x:,}, {x:>8}, {x:%}. Sumar texto y número ("a" + 5) es error, igual que en Python, con la pista de usar str().

## Tutorial (FTUE)
| Minuto | Qué pasa |
|---|---|
| 0-1 | Nota de la abuela. Toño está quieto junto a un estante vacío de pan |
| 1-3 | Se pide escribir move(East) y pick("pan", 5): el primer pan aparece en el estante |
| 3-6 | Llega el primer cliente; se escribe el cajero con pago exacto |
| 6-10 | Se compra while para no repetir a mano; primer dinero pasivo |
| 10-15 | Se desbloquea if: "solo reponer si el estante está vacío" |

## Accesibilidad
- Texto del editor mínimo 14 px, zoom de la tienda con la rueda del ratón.
- Estados de estante con icono y color, nunca solo color.
- Los errores del intérprete se muestran en español con número de línea.
"""

# ─────────────────────────────────────────────────────────────
S["art_direction"] = """## Estilo
3D low-poly, limpio y de colores vivos, inspirado en la presentación de The Farmer Was Replaced: la tienda es una maqueta que flota sobre un fondo de cielo suave, vista en diagonal desde arriba, con luz cálida y sombras suaves. (Antes era pixel art 2D; se cambió el 18 nov 2026 por decisión del jugador.)

## Modelos
Todos de Kenney, licencia CC0 (dominio público), en formato GLB:
| Kit | Uso |
|---|---|
| Mini Shop 2.1 | Piso, paredes, puerta, estantes, caja registradora, carretilla, carritos y canastas |
| Mini Characters 2.0 | Clientes (13 variantes) y los robots (character-robot teñido de cian y naranja); 32 animaciones cada uno |
| Food Kit 2.0 | Productos en los estantes y en las manos de los robots: pan, leche, huevos (y fruta, queso y carne para etapas futuras) |

Los estantes muestran el stock real: los 10 huecos del modelo se llenan o vacían según la cantidad.

## Cámara
Diagonal desde arriba (perspectiva, 30°). Se puede girar y acercar con el ratón. Al inicio se encuadra sola para llenar la zona libre a la derecha de las ventanas de código.

## Paleta de la interfaz
| Uso | Color |
|---|---|
| Letrero (barra superior) | Amarillo #F6C945 con tinta #3A1F0F |
| Ventanas de código (pizarra) | Verde pizarra #1E2923 con marco de madera #8A5A32 |
| Ventanas de papel (tiquetes, mejoras, comandos) | Papel #FBF8EF |
| Dinero y éxito | Verde #3FA34D |
| Alertas | Rojo #E2483D |
| Robot equipo A / B | Cian #2EC4D6 / Naranja #F28C28 |

## Animaciones clave
- Robots y clientes: caminar, quieto, interactuar (cobrar, tomar, poner), emote sí/no.
- Productos que aparecen y desaparecen del estante uno por uno.
- Textos flotantes (+$6.500, -5 rep) y tiquetes que se imprimen.
"""

# ─────────────────────────────────────────────────────────────
S["audio_design"] = """Todo el audio es procedural (Web Audio API): no hay archivos de sonido.

- Música: lo-fi tranquilo de tienda a 78 BPM con swing (Fmaj7 - Em7 - Dm7 - Cmaj7): piano eléctrico, bajo, bombo, escobilla y una melodía pentatónica ocasional.
- Efectos: bip del escáner, ka-ching de la caja, monedas de la devuelta, campanita de la puerta, cliente enojado, producto que falta, error del robot, carga y descarga de productos, fanfarria al desbloquear y aviso de pausa del depurador.
- Controles: volumen de música, volumen de efectos y silenciar todo (se guardan en el navegador).
- El audio se activa con el primer clic o tecla (regla de los navegadores). Máximo de voces simultáneas y límite de repetición por efecto para que a velocidad 4x no sature.
"""

# ─────────────────────────────────────────────────────────────
S["multiplayer_design"] = """## Modelo
Servidor autoritativo dedicado. El servidor es el único que ejecuta los scripts y la simulación. Los navegadores solo envían intenciones (editar código, ejecutar, comprar) y reciben el estado.

| Parámetro | Valor |
|---|---|
| Jugadores por sala | 2 |
| Tick de simulación | 10/s |
| Envío de estado al cliente | 10/s, solo diferencias |
| Interpolación en cliente | 100 ms |
| Latencia objetivo | < 150 ms (los juegos de programación toleran mucha latencia) |

## Salas
- Código de 4 letras sin caracteres ambiguos (sin O/0, I/1).
- La sala persiste en la base de datos; se puede volver con el mismo código.
- Sin cuentas: cada navegador guarda un token en localStorage para recuperar su puesto. [OPEN QUESTION: ¿hace falta una contraseña de sala opcional?]

## Edición colaborativa
CRDT (Yjs) por cada script, sincronizado a través del mismo servidor. Al presionar Ejecutar, el servidor toma la versión actual del documento y la compila.

## Desconexiones
- Si un jugador se desconecta, la tienda sigue mientras el otro esté conectado.
- Si se desconectan ambos, la simulación se pausa y se guarda.
- Reconexión: el cliente pide el estado completo y sigue normalmente.

## Social
- Chat de texto simple dentro de la sala.
- Ping en el mapa: clic derecho en una casilla para señalarla al amigo.
"""

# ─────────────────────────────────────────────────────────────
S["economy_design"] = """## Recursos
| Recurso | Fuente (faucet) | Gasto (sink) |
|---|---|---|
| Dinero | Ventas | Pedidos a proveedor (60% del precio), desbloqueos, robots, comisión de cambio |
| Reputación (0-100) | Cobros exactos (+1), inspección limpia (+10) | Productos faltantes, colas, vencidos, derrames, cobros de más |
| Stock | Pedidos | Ventas, caducidad |

## Margen
Cada venta deja un 40% de margen bruto. Un cliente promedio en etapa 1 compra 2,5 productos de unos 3.400, es decir ~3.400 de ganancia por cliente.

## Balance
- La reputación es el regulador: un mal script no te quiebra, pero reduce la llegada de clientes hasta un 80% (multiplicador mínimo 0,2).
- No hay quiebra: el dinero nunca baja de 0; si no alcanza para un pedido, el pedido se rechaza.
- Sink de largo plazo: los niveles de CPU y robots escalan x2-x3 para que siempre haya algo que comprar.

[PLAYTEST: Verificar que un script básico y correcto en etapa 1 genere ~$1.000/min y que la etapa 2 llegue en 15-20 min]
"""

# ─────────────────────────────────────────────────────────────
S["technical_requirements"] = """## Stack propuesto
| Capa | Tecnología | Por qué |
|---|---|---|
| Lenguaje | TypeScript en todo el proyecto | Un solo lenguaje para cliente, servidor e intérprete |
| Intérprete | Propio: subconjunto de Python (lexer, parser, evaluador por pasos) | Control de ticks, bloqueo de sintaxis no desbloqueada, sandbox seguro, determinista |
| En línea (implementado) | Supabase Realtime (broadcast + presence) | Sin servidor propio: el navegador del anfitrión corre la tienda |
| Render | Three.js r187 | Escena 3D con modelos GLB de Kenney, sombras y animaciones |
| Editor | CodeMirror 6 + y-codemirror | Resaltado Python y edición colaborativa |
| Colaboración | Yjs | CRDT probado |
| Persistencia (implementado) | Supabase (tabla partidas): mundo en JSON, código Yjs y base del jugador con pg_dump | Partidas públicas, se guardan cada 45 s |
| Hosting | Sitio estático en Vercel | Todo corre en el navegador |

## Modo en línea (implementado)
- Lobby en el menú: tu nombre y color, abrir una tienda nueva, entrar con un código de 4 letras y la lista de tiendas guardadas (todas públicas).
- El anfitrión (el que lleva más tiempo en la sala) corre la simulación, PostgreSQL, las terminales e inventario.py. El otro jugador ve un espejo que se actualiza unas 7 veces por segundo; sus acciones se aplican al tiro y se le piden al anfitrión.
- Todo es en tiempo real: el código (Yjs, con el cursor y el nombre del otro), la tienda, la terminal, los votos de la noche, las ventanas de la historia (si uno presiona Continuar, avanzan los dos) y el montaje del rack (si uno lo abre, al otro también; las piezas aparecen en vivo).
- Los dos les ponen nombre a los robots al crear la partida y a cada robot o caja que compran.
- Si el anfitrión se va, el otro sigue desde el último guardado.

## Intérprete (pieza crítica)
- Soporta: int, float, str, bool, None, listas, diccionarios, if/elif/else, while, for-in, range, def, return, break, continue, import shared y operadores básicos.
- No soporta (al menos al inicio): clases, excepciones, comprensiones, lambdas, ni librerías estándar.
- Ejecución por pasos: el evaluador es una máquina que se puede pausar entre operaciones (generadores o pila explícita), para repartir ops por tick y suspender durante acciones físicas.
- Límites: presupuesto de ops por tick (un bucle infinito nunca bloquea el servidor); profundidad de recursión 64; memoria máxima 10.000 elementos por robot.
- Diferencia con Python: los números no distinguen int/float al imprimir (4 / 2 se muestra como 2).
- Los errores se muestran en español: "Línea 4: la variable 'totl' no existe. ¿Quisiste decir 'total'?".

## Estructura del repositorio propuesta
```
/packages/interpreter   intérprete Python (sin dependencias, con tests)
/packages/sim           simulación de la tienda (pura, determinista, con tests)
/apps/web               Three.js + CodeMirror + ventanas flotantes
/docs                   este GDD
```

## Rendimiento
- 8 robots x 400 ops x 10 ticks = 32.000 ops/s por sala: trivial para Node.
- 60 FPS en el cliente con hasta 60 clientes de la tienda en pantalla.
"""

# ─────────────────────────────────────────────────────────────
S["competitive_analysis"] = """No es un producto comercial, así que esta sección compara referencias de diseño en lugar de mercado.

| Juego | Qué tomamos | Qué hacemos distinto |
|---|---|---|
| The Farmer Was Replaced | Código + dron + desbloqueo de sintaxis + optimización por ticks | Clientes que reaccionan; cooperación online; problemas de caja y dinero |
| Overcooked | Cooperación con caos y comunicación | La coordinación ocurre en el código, sin presión de reflejos |
| Human Resource Machine | Problemas de programación con humor | Sandbox infinito, no niveles cerrados |
| Screeps | Scripts que corren en un servidor persistente | Mucho más accesible: Python, 3D amigable y solo 2 jugadores |
| Factorio | Satisfacción de ver una máquina funcionando sola | Escala pequeña y legible; el "cinturón" es el código |

## Lecciones
- De TFWR: mostrar la línea en ejecución es clave para entender el código.
- De Screeps: un lenguaje complejo y un servidor siempre activo intimidan; por eso empezamos con sintaxis mínima y pausamos sin jugadores.
- De Overcooked: los momentos más divertidos son los errores compartidos; el historial de versiones y los tiquetes hacen visibles (y graciosos) los errores.
"""

# ─────────────────────────────────────────────────────────────
S["development_roadmap"] = """| Hito | Alcance | Criterio para avanzar |
|---|---|---|
| M0: Intérprete | Subconjunto de Python ejecutando por pasos, con tests | 100+ tests pasan; while/if/for/def funcionan con conteo de ops |
| M1: Prototipo local | Tienda Kiosco, 1 robot, reponer y cobrar, en un solo navegador | Se juega 10 minutos y se gana dinero con un script |
| M2: Online | Servidor autoritativo, salas con código, 2 jugadores ven lo mismo | Dos navegadores en distintos PC sincronizados |
| M3: Colaborativo | Yjs en el editor, historial, chat | Editar el mismo script a la vez sin conflictos |
| M4: Vertical slice | Etapas 1-3, gaveta de billetes, árbol de sintaxis, guardado | Una sesión de 1 h con el amigo es divertida |
| M5: Contenido | Etapas 4-7, perecederos, proveedores, eventos | Árbol completo |
| M6: Pulido | Arte propio, audio, tutorial, balance | Lista de bugs vacía |

Riesgo en la ruta crítica: M0. Si el intérprete se complica, todo lo demás se retrasa. Por eso va primero y aislado.
"""

# ─────────────────────────────────────────────────────────────
S["risk_assessment"] = """| Riesgo | Categoría | Probabilidad | Impacto | Mitigación |
|---|---|---|---|---|
| El intérprete propio toma demasiado tiempo | Técnico | Media | Alta | Empezar con subconjunto mínimo; tests desde el día 1; plan B: Skulpt/Brython en servidor con límite de pasos |
| Desincronización entre jugadores | Técnico | Baja | Alta | Servidor autoritativo; el cliente nunca simula |
| Scripts maliciosos o infinitos tumban el servidor | Técnico | Media | Media | El intérprete no tiene acceso al sistema; límites de ops, memoria y recursión |
| Balance aburrido (demasiado lento o rápido) | Diseño | Alta | Media | Parámetros en un archivo de configuración; probar etapa por etapa |
| El amigo se frustra si no sabe programar | Diseño | Media | Alta | Tutorial gradual, errores en español, ejemplos en shared.py |
| Alcance crece demasiado (proyecto personal) | Equipo | Alta | Media | Respetar los hitos; nada nuevo antes de terminar M4 |
| Perder motivación | Equipo | Media | Alta | Jugar con el amigo desde M2, aunque sea feo |
"""

# ─────────────────────────────────────────────────────────────
S["appendices"] = {
    "content": "",
    "subsections": [
        {
            "title": "A. Referencia de la API (borrador)",
            "content": """| Función | Etapa | Ticks | Descripción |
|---|---|---|---|
| move(dir) | 1 | 4 | Mueve 1 casilla: North, South, East, West. Devuelve True/False |
| move(x, y) | 1 | 4/casilla | Camina solo hasta la casilla (x, y) por el camino más corto; rodea paredes y espera si otro robot estorba. Pasar el mouse por la tienda muestra la coordenada de cada casilla |
| get_pos() | 1 | 0 | Devuelve (x, y) |
| pick(product, n) | 1 | 3/u | Toma n unidades en cualquier casilla del almacén (si se acabó, el proveedor cobra) |
| place() | 1 | 3/u | Pone lo que carga en el estante (un estante libre queda para ese producto) |
| return_product() | 1 | 3/u | En el almacén: devuelve todo lo que carga el robot (vuelve a lo guardado y a la tabla de inventario) |
| warehouse_stock(product) | 1 | 0 | Unidades de un producto que quedan en el almacén |
| get_shelves() | 2 | 0 | Lista de estantes |
| shelf.stock() / shelf.product() / shelf.pos() | 2 | 0 | Datos del estante |
| has_customer() | 1 | 0 | ¿Hay cliente en esta caja? |
| scan_item() | 1 | 2/u | Escanea el carrito y devuelve la lista de productos (siempre el carrito completo, aunque se vuelva a escanear) |
| price(item) | 1 | 0 | Precio unitario (o por kg) |
| take_payment(total) | 1 | 2 | Cobra; devuelve lo que entrega el cliente |
| give_change(x) | 2 | 3 | Devuelve un número (etapa 2) o un dict de denominaciones (etapa 3+) |
| get_drawer() | 3 | 0 | Dict con billetes y monedas de la gaveta |
| request_change(d, n) | 4 | 300 | Pide cambio al banco (1% de comisión) |
| next_customer() | 1 | 1 | Libera al cliente |
| queue_length() | 2 | 0 | Clientes en cola |
| item.expires_in() | 4 | 0 | Días hasta vencer |
| discard() | 4 | 2 | Bota producto vencido |
| get_spills() / mop() | 3 | 0 / 6 | Derrames |
| go_to(x, y) | 5 | 4/casilla | Pathfinding automático (mejora cara) |
| send(name, msg) / receive() / broadcast(msg) | 5 | 1 | Mensajes |
| order(product, n) | 6 | 1 | Pedido a proveedor |
| get_sales_history(product, dias) | 6 | 0 | Ventas por día |
| print(x) | 1 | 0 | Escribe en la consola |"""
        },
        {
            "title": "B. Glosario",
            "content": """- Tick: unidad de tiempo de la simulación (1/10 s).
- Op: operación del intérprete (asignación, comparación, llamada).
- Gaveta: el cajón de la caja con billetes y monedas.
- Devuelta: el cambio que se le entrega al cliente.
- Cuadre de caja: reporte de fin de día con lo cobrado esperado vs real.
- shared.py: librería de funciones compartida por los dos jugadores.
- Etapa: tamaño/nivel de la tienda (Kiosco ... Hipermercado)."""
        },
        {
            "title": "C. Preguntas abiertas",
            "content": """- [OPEN QUESTION: ¿Habrá meta final más adelante (p. ej. "abrir una sucursal")?]
- [OPEN QUESTION: ¿Robos como mecánica futura (robot de seguridad)?]
- [OPEN QUESTION: ¿Precios dinámicos controlados por código (set_price)?]
- [OPEN QUESTION: ¿Contraseña opcional de sala?]
- [OPEN QUESTION: ¿Redondeo de precios por peso: al 50 más cercano o hacia arriba?]"""
        },
    ],
}

S["game_mechanics"]["subsections"].append({
    "title": "5.13 Servidores, hardware y ciberseguridad",
    "content": """El código de los robots corre en servidores de un cuarto de la tienda. La partida empieza con srv-01 (10.0.0.10, 1 núcleo, 2 GB). La CPU se reparte entre los robots: un bucle sin wait() la satura y, desde el 80% de carga, TODOS los robots del servidor van más lento (hasta 2,5× al 100%). La RAM limita cuántos robots corren (0,5 GB el sistema + 0,5 GB por robot). Sin servidor o con el servidor apagado, los robots se detienen.

Después de la misión del inventario, la misión "Monta tu servidor": en la sala de servidores (anexo al oeste de la tienda; empieza con 1 gabinete de rack y caben 3: los otros se compran en TecnoMercado) los jugadores montan el primer servidor a mano en primera persona (arrastrar placa, CPU, disipador, RAM, disco, fuente y los 4 cables; pantalla POST con mensajes claros), instalan Linux en la terminal (instalador: nombre, usuario, contraseña), configuran la red (ip addr, ip route), instalan robot-agent con apt y conectan a Toño y Lupe con robot attach. Por eso la primera noche dura 20 minutos. Ataques desde el día 2. Temperatura: un servidor al 100% sin ventilador pasa de 85 °C y va 1,5× más lento; el aire acondicionado lo evita. GPU: scan_item() el doble de rápido.

Más adelante: tienda en línea de componentes (llegan en el camión al día siguiente), ataques que solo frenan (escaneo, fuerza bruta SSH, DDoS, malware) con defensas (firewall, fail2ban, antivirus), logs y rastreo del atacante con 10 técnicas distintas que rotan (VPN caída, strings del malware, conexiones en vivo, inyección SQL, phishing, OSINT en un foro, honeypot, horarios, aparato infectado en la red, registro de dominio), con capas y señuelos. La denuncia con la IP real da un bug bounty; acusar a un inocente baja la reputación. Todas las IPs son ficticias (rangos de documentación).

| Fase | Contenido | Estado |
|---|---|---|
| 1 | Modelo de servidores (CPU, RAM, lentitud) | Hecho |
| 2 | Terminal + Linux + logs | Hecho |
| 3 | Red e IPs (ping, ssh, robot attach) | Hecho |
| 4 | Tienda en línea (TecnoMercado) | Hecho |
| 5 | Montaje en primera persona | Hecho |
| 6 | Ataques y defensas | Hecho |
| 7 | Rastreo, denuncia y bounty | Hecho |
| 8 | GPU (scan_item el doble de rápido), temperatura | Hecho; balance en playtest |

Detalle completo: docs/servidores.md."""
})

