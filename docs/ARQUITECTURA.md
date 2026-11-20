# Arquitectura

Cómo funciona cada pieza y cómo se conectan. Para reglas y preferencias del usuario, ver `CLAUDE.md`; para el porqué
de las decisiones, `docs/DECISIONES.md`.

```
apps/web (navegador)
  main.ts ── crea World, GameDB, ventanas, flujo de intro/misión, HUD
    │  ├─ store3d.ts   Three.js: tienda, callejón, camión, robots, clientes, cámara
    │  ├─ windows.ts   ventanas flotantes (arrastrar, tamaño, zoom, minimizar)
    │  ├─ editor.ts    CodeMirror (Python): lint de desbloqueos, breakpoints, autocompletado
    │  ├─ sqlwindow.ts ventana Base de datos     ├─ sheet.ts  hoja tipo Excel
    │  ├─ intro.ts     modales, franjas de cine, panel de misión
    │  └─ audio.ts     música y efectos procedurales (Web Audio)
    ▼
packages/sim ── World.step() (10 ticks/s): robots (VM), clientes, caja, eventos
    │  api.ts (comandos de los robots) · sqlapi.ts (db) · pandas.ts · delivery.ts · config.ts
    ▼                                   ▲ SqlAdapter (world.sql)
packages/interpreter ── VM de Python    │
packages/db ── GameDB (PGlite) ─────────┘  esquema public (jugador) + registro (interno)
```

## 1. Intérprete (`packages/interpreter`)

**Pipeline:** `lexer.ts` (tokens + INDENT/DEDENT, `"""` multilínea, f-strings) → `parser.ts` (AST en `ast.ts`) →
`features.ts` (rechaza sintaxis no desbloqueada) → `vm.ts` (ejecuta).

**Ejecución por pasos.** El evaluador es un árbol de **generadores** (`*exec`, `*eval`). Cada sentencia y cada nodo de
expresión cuentan 1 operación (`op()`); al superar `opsPerTick` el generador hace `yield PAUSE` y sigue en el próximo
`vm.tick()`. Por eso un `while True` infinito nunca bloquea: solo gasta su presupuesto. `opsPerTick` es la mejora
"CPU" y se puede cambiar en caliente.

**Acciones.** Una función del juego (`PyBuiltin`) puede devolver `new Action(ticks, complete)`: el robot queda ocupado
`ticks` ticks (contando el de la llamada) y `complete()` se llama al reanudar; su valor es el resultado de la llamada.
`Action.async(ticks, promise)` además espera una promesa (consultas SQL): mientras no resuelva, `vm.waitingAsync` es
`true` y el estado es `waiting`. Si la promesa falla, el error aparece en la línea que llamó.

**Valores** (`values.ts`): number (sin distinción int/float al imprimir), string, bool, None, `PyList`, `PyTuple`,
`PyDict` (clave hash), `PyRange`, `PyFunction`, `PyBuiltin`, `PyModule`, `HostObject`.
`HostObject` es un objeto del juego; con `protocol` (`HostProtocol`) soporta `obj[k]`, `len`, `for`, `print`,
operadores, comparaciones elementales y atributos calculados (así están hechos DataFrame y Series).

**Módulos.** `modules` = código Python importable (`shared`). `nativeModules` = objetos del juego (`pandas`).
`import x as y` y `from x import a as b` funcionan. Solo `import shared` requiere el desbloqueo "import".

**Desbloqueos** (`FEATURES`): while, if, variables, for, lists, functions, import, dicts. `check()` da los errores
sin ejecutar (lo usa el lint del editor). Los scripts de `inventario.py` usan todas.

**Depurador.** `breakpoints` (Set de líneas, editable en vivo), `pause()`, `step()`, `resume()`, `inspect()`.
Se detiene antes de cada sentencia y en la cabecera de los bucles; solo en el script principal (no dentro de shared).

**Errores** (`PyError`): mensaje en español + línea + archivo; `format()` → `"Línea 4: ..."` o `"shared.py, línea 2: ..."`.
Sugerencias "¿Quisiste decir...?" con distancia de edición (`errors.ts`).

## 2. Simulación (`packages/sim`)

`World` (`world.ts`) es la fuente de verdad. `step()` = 1 tick (0,1 s de juego):
1. `vm.tick()` de cada robot (en orden). Estados `paused`/`error`/`done` generan eventos.
2. Clientes: caminan 1 casilla cada 5 ticks, toman productos, hacen fila, pierden paciencia.
3. Llegada de clientes (`clientes_por_minuto = base * (0.2 + reputación / 62.5)`), si `customersEnabled`. El primero
   llega 3 s después de `openedTick`.

**Día y noche** (`DAY`, `NIGHT` en `config.ts`): `cycle` se activa con la primera noche. `startNight(ms)` cierra la
tienda (`night = { remainingMs, totalMs, votes }`); `updateNight(msReales)` descuenta **tiempo real** (lo llama la web
en cada cuadro con `performance.now()`, así no lo afectan la pausa ni 4×; en el modo online lo llamará el servidor);
`vote("j1" | "j2", listo)`. Cuando votan todos o llega a 0 → `openStore(motivo)`: amanece (`dayStartTick`, `today`
en cero), evento `opened`, sonido `open`. El día dura `DAY.ticks` (5 min de juego); al cumplirse, `closeStore()`:
`lastDay = today`, evento `closed` (con el resumen), sonido `close`, `day++` y `startNight()`. Los clientes que ya
estaban adentro terminan. Cada día llegan `DAY.customerGrowth` (+25%) más clientes.
`clock` → `{ day, phase, hour }` (día 7→19 por ticks, noche 19→7 por tiempo real); `now` (hora ISO para la base) usa
ese reloj: el día N es el 5 de enero de 2026 + N−1. Sin ciclo (tests de la sim sola), la tienda está siempre abierta.

**Coordenadas:** cuadrícula `KIOSCO_MAP` (`config.ts`), **y crece hacia el norte** (fila de arriba del texto = norte).
9×6 casillas: `A` almacén = cuarto de x 0..2 (toda la columna), `S` estantes (4..7, 5), `E` entrada (8, 5), `C` caja (3, 0).
Entre casillas: `|` = pared, `:` = puerta (no ocupan casilla; `world.walls` guarda las aristas, `wallBetween()`).
`WAREHOUSE` = la casilla del almacén junto a la puerta (2, 5). La cola va al este de la caja.

**Almacén y estantes:** `warehouseStock` = la tabla de inventario del jugador (en la web: `syncWarehouse()` en
`main.ts` lo lee con `GameDB.warehouseSource()` cada 2 s; cada `pick` emite el evento `warehouse` y
`GameDB.takeFromWarehouse()` descuenta en la tabla; lecturas y escrituras van en una sola cola). En la simulación
sola (tests) empieza con `WAREHOUSE_START`;
`pick()` funciona en **cualquier** casilla del almacén, saca primero de ahí y, si se acabó, compra al proveedor (60%).
Los estantes empiezan **libres** (`product: null`, stock 0): el primer `place()` define su producto para siempre
(decisión del usuario: "cada estantería tiene un solo producto y el jugador elige cómo distribuirlos").
Los clientes van al estante más cercano con su producto (`shelfFor`); `shelfStock(p)` suma todos los de un producto.

**Eventos** (`drainEvents()`, los consume la web cada cuadro): `float` (texto flotante), `ticket` (venta),
`robot` (cambio de estado), `sound`, `record` (fila para el registro interno de la base), `prep` (votos),
`night` (votos), `opened` (amaneció), `closed` (19:00, con el resumen del día), `warehouse` (se sacó mercancía del
almacén).

**Comandos de los robots** (`api.ts`, `makeApi`): `move`, `get_pos`, `wait`, `pick`, `place`, `cargo`,
`cargo_product`, `warehouse_stock`, `get_shelf(s)`, `has_customer`, `queue_length`, `scan_item` (devuelve la **lista** del carrito),
`price`, `take_payment`, `give_change`, `next_customer` y las constantes `North/South/East/West`, `WAREHOUSE`,
`REGISTER`, `ENTRANCE`. Cada acción pone `robot.action` (el globo sobre el robot en 3D).
Errores de uso "blandos" (pick fuera del almacén) → aviso en consola + `Action(1)`; errores de programa → `PyError`.

**Caja** (`finishCheckout`): compara lo pagado menos la devuelta con el total real →
`ok` (+1 rep), `cobro_de_mas` (−5 rep, se devuelve la diferencia), `cobro_de_menos` (la tienda pierde), `sin_cobrar`.

**Librerías** (`world.libraries()`): `db` (`sqlapi.ts`, estilo asyncpg: `execute/fetch/fetchrow/fetchval/executemany`
con `$1`) y `pandas` (`pandas.ts`). Usan `world.sql` (un `SqlAdapter`), que la web conecta a `GameDB.playerQuery`.

**Balance**: todos los números en `config.ts` (precios, ticks por acción, paciencia, desbloqueos y su costo, CPU).

## 3. Base de datos (`packages/db`)

`GameDB` envuelve PGlite (PostgreSQL 17 en WASM). En el navegador persiste en `idb://codigo-de-barras`.

- **Esquema `public`**: del jugador. Empieza vacío. Dueño: rol `jugador`.
- **Esquema `registro`**: registro interno (products, customers, sales, sale_items, stockouts, supplier_purchases,
  restocks, robots). Se **recrea en cada partida** (`SCHEMA_SQL`) y el rol `jugador` **no tiene acceso**: para el
  jugador no existe. Lo llena `ingest()` + `flush()` (cada 1 s) con los `record` de la simulación.
- `run(sql)`: ventana Base de datos (varias sentencias). `playerQuery(sql, params)`: desde Python (una sentencia,
  `$1`). Ambas corren en una transacción con `SET LOCAL ROLE jugador; search_path = public; statement_timeout`.
  `checkAllowed()` rechaza BEGIN/COMMIT/ROLLBACK, SET/RESET ROLE, SESSION AUTHORIZATION y COPY.
- `systemRun(sql)`: superusuario sobre `registro` (tests y lógica interna). **Nunca con SQL del jugador.**
- `inventoryStatus(products)`: busca en las tablas del jugador los nombres de productos (normalizados) para la misión.
- `translateError()`: errores de PostgreSQL más comunes → español.

## 4. Web (`apps/web`)

**`main.ts`** arma todo: `World`, `GameDB`, ventanas (robots, `shared.py`, `inventario.py`, Hoja, Tiquetes,
Desbloqueos, Base de datos, Comandos), el dock de la barra superior, HUD, depurador, audio y el flujo de inicio:

```
cargan los modelos → ¿progress.storeOpen?
   sí → openStore(false)
   no → prepareIntro() → startScreen() (clic = desbloquea audio) → runIntro():
        letterbox → store.playIntro() → modal bienvenida → modal misión → startMission():
        ventanas en columnas + ObjectivesPanel; missionCheck() cada 1,5 s
        misión completa → store.unloadBoxes() → "Abrir la tienda" → openStore(true): store.flyToStore()
openStore → (si es animado: modal "Cae la noche") → syncWarehouse() → si no progress.prepDone:
        startFirstNight(): world.startNight() + NightPanel (intro.ts); si ya se hizo: world.openStore() (día 1)
        → votos o fin del tiempo → evento opened → NightPanel.opened() → día (5 min) → evento closed →
        showNight(resumen) → noche → ...
pickMusic() (en refreshUi) elige la canción: inventario / mañana / tarde / noche / prisa (AudioEngine.setMusic;
el cambio entra en el próximo compás). Las canciones son procedurales: SONGS + musicStep() en audio.ts.
```

El bucle del juego lo maneja `Store3D` (`setAnimationLoop`); cada cuadro llama `hooks.advance(ms)`, que corre
`inventario.py`, avanza `world.step()` según la velocidad (máx. 40 ticks por cuadro) y refresca la UI (cada 120 ms).

**`store3d.ts`**: escena Three.js r187. Modos de cámara: `intro` (cinemática), `alley` (mirando el camión),
`flying` (vuelo a la tienda), `store` (normal, con OrbitControls). En `store` la cámara se encuadra sola
(`frameCamera`: busca la distancia en que las esquinas de la tienda caben a la derecha de las ventanas) y
`setViewOffset` corre la imagen. Robots y clientes son modelos animados de Kenney (`SkeletonUtils.clone`,
`AnimationMixer`); los estantes muestran el stock real llenando los 10 huecos del modelo `shelf-boxes`
(`fillShelf()` los rellena cuando el estante recibe su producto; si está libre muestra "Libre"). `buildWarehouse()` arma el
cuarto: una estantería metálica por producto contra su pared norte (las cajas se vacían con `warehouseStock`), línea
amarilla, franja de seguridad en la puerta, estibas, carretilla y letrero; las paredes interiores
(`world.walls`) son bajitas para que se vea adentro, con dos columnas como marco de la puerta.
Etiquetas y textos flotantes con `CSS2DRenderer`. `alley.ts` construye el callejón y el camión con geometría propia.

**Día y noche en 3D**: `updateDaylight()` lee `world.clock` y mezcla luz del sol/luna, hemisferio, exposición, el
cielo de fondo (gradiente del contenedor) y 4 lámparas `PointLight` que se prenden de noche. La transición se suaviza
en tiempo real. Antes de que empiece el ciclo (intro y misión) siempre es de día.

**Cámara de frente** (`Store3D.VIEW_DIR`): mira desde el sur, así en pantalla North = arriba, East = derecha, igual que
`move()`. `frameCamera()` siempre usa esa dirección (el jugador puede girar después). `buildCompass()` pone las cuatro
direcciones alrededor de la tienda. **Información al pasar el mouse**: `hoverTargets` (estantes y estanterías del
almacén) + raycast en `pointermove`; el cuadro `.hover-tip` se refresca cada cuadro mientras el mouse está encima.

**`windows.ts`** (`FloatingWindow`): arrastrar por la barra, tamaño por la esquina, minimizar (▁ o doble clic),
cerrar, zoom (− % +) que reescala `--fs-*` y el tamaño de la ventana, `setBox()`, posición guardada.

**Modelos 3D**: `apps/web/public/models/{shop,chars,food}` (Kenney CC0, ver `CREDITS.md`). Cada kit tiene su
`Textures/colormap.png`: no mezclar carpetas.

### Rendimiento (`apps/web/src/perf.ts`)

- **Piezas fijas fundidas**: al terminar `Store3D.build()`, el piso, las paredes, la base y el callejón se funden en
  una malla por material (`mergeStatic`). Bajó de ~690 a ~250 dibujos por cuadro. Si agregas algo fijo a esa parte,
  se funde solo; si algo de ahí tiene que moverse, esconderse o responder al ratón, sácalo de la lista `statics`.
  Lo plano (pisos, asfalto) no proyecta sombra.
- **Resolución dinámica** (`QualityGovernor`): resolución máxima 1.5×; si los cuadros tardan más de 22 ms la baja
  (hasta 0.6×) y si sobra la sube. Si aun así va lento, apaga las sombras.
- **Luces**: cada `PointLight` se calcula en cada píxel. Solo hay dos: la lámpara de adentro (de noche) y la del
  callejón. No agregues más; usa materiales emisivos para lo que brilla.
- Nada de `backdrop-filter` ni `mix-blend-mode` sobre la escena 3D: obligan al navegador a recomponer todo cada cuadro.

## Recetas

**Agregar un comando para los robots**
1. `packages/sim/src/api.ts`: nueva entrada en el objeto que devuelve `makeApi` (`fn(name, impl)`; para acciones,
   `act(etiqueta, ticks, complete)`).
2. Costos en `config.ts` (`TICKS`). 3. Test en `packages/sim/test/world.test.ts`.
4. Ayuda y autocompletado: `apps/web/src/help.ts` (`COMMANDS`). 5. GDD (apéndice de la API).

**Agregar un producto**: `PRODUCTS` y `WAREHOUSE_START` (`config.ts`) (los estantes son libres: no hay letra por producto); modelo en
`PRODUCT_MODEL` y emoji en `PRODUCT_EMOJI` (`store3d.ts`); artículo en `ARTICLES` (`main.ts`); fila en `DELIVERY`
si llega en el camión. Revisa los tests de posiciones del mapa.

**Agregar un desbloqueo**: `UNLOCKS` en `config.ts` (con `feature` o `cpuLevel`). Si es sintaxis nueva, agrégala a
`FEATURES` y a `checkFeatures()`.

**Agregar algo de pandas**: método en `makeDataFrame` / `makeSeries` (`pandas.ts`), test en
`packages/sim/test/pandas.test.ts`, ayuda en `renderHelp()` de `main.ts`.

**Agregar una ventana**: `new FloatingWindow(layer, { id, title, x, y, width, height, className? })`, contenido en
`win.body`, entrada en `DOCK` (`main.ts`). Usa solo las variables `--fs-*` para el texto.

**Agregar un sonido**: `SoundName` en `world.ts` + `world.sound(...)` donde ocurra + `case` en `AudioEngine.play()`
(`audio.ts`). Para la intro/UI: `audio.cue(nombre)`.

**Regenerar el GDD**: `cd docs/gdd && ../../.claude/skills/game-design-document/.venv/bin/python build_gdd.py`
(si no existe el venv: `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt` dentro de
`.claude/skills/game-design-document`). Genera `.docx` y `.pdf` (este con LibreOffice) en `docs/gdd/output`.

## Tests

| Archivo | Cubre |
|---|---|
| `interpreter/test/language.test.ts` | Sintaxis, funciones, colecciones, errores, `"""` |
| `interpreter/test/runtime.test.ts` | Ticks, acciones, desbloqueos, módulos, el cajero del GDD |
| `interpreter/test/debugger.test.ts` | f-strings y depurador |
| `interpreter/test/native.test.ts` | `import as`, módulos nativos, `HostProtocol`, acciones asíncronas |
| `sim/test/world.test.ts` | Mapa, robots, caja, tienda completa 10 min, desbloqueos, sonidos, depurador |
| `sim/test/pandas.test.ts` | pandas sencillo |
| `db/test/gamedb.test.ts` | Registro interno vs. tiquetes, permisos, errores, parámetros, inventario |
| `db/test/inventory.test.ts` | Misión completa: pandas → CREATE TABLE → to_sql → SQL desde la cajera |
