# Código de Barras — guía para agentes

Juego web **cooperativo para 2 jugadores**: administran un supermercado ("La Esquina") **escribiendo código Python** que
controla robots, al estilo de *The Farmer Was Replaced* (TFWR). Incluye una base de datos **PostgreSQL real** en el
navegador, un **pandas sencillo** y una intro cinemática. Todavía es un prototipo local (un solo navegador): el modo
online es el siguiente hito.

Lee también: `docs/ARQUITECTURA.md` (cómo funciona por dentro, recetas para cambios comunes) y
`docs/DECISIONES.md` (qué pidió el usuario y por qué; **no deshagas decisiones sin leerlo**).

## Comandos

```bash
pnpm install
pnpm dev         # http://localhost:5173 (Vite). Si el puerto está ocupado, ya hay un servidor corriendo.
pnpm test        # vitest: intérprete, simulación, base de datos (212 tests; los de db arrancan PGlite, ~10 s)
pnpm typecheck   # tsc en los 4 paquetes
pnpm build       # build de producción (apps/web/dist). Los avisos "node:module externalized" de PGlite son normales.
```

**Despliegue en Vercel**: el proyecto de Vercel tiene Root Directory = `apps/web`; la config está en `apps/web/vercel.json`
(instala con pnpm, corre `pnpm build`, publica `dist`).
Es un sitio estático: todo (simulación, PostgreSQL, audio) corre en el navegador de cada jugador, no hay servidor.

Corre `pnpm typecheck && pnpm test` antes de dar algo por terminado. Para cambios visuales, verifica en el navegador
(ver "Verificar en el navegador").

## Estructura

| Carpeta | Qué es |
|---|---|
| `packages/interpreter` | Intérprete propio de un **subconjunto de Python** en TypeScript: ejecución por ticks (generadores), desbloqueos de sintaxis, depurador, f-strings, errores en español. Sin dependencias. |
| `packages/sim` | La **simulación** de la tienda (sin navegador): `World`, comandos de los robots (`api.ts`), clientes, caja, balance (`config.ts`), **servidores** (`servers.ts`, `hardware.ts`, `security.ts`, `network.ts`, terminal en `shell/`), conexión `cursor` (alias `db`, `sqlapi.ts`), **pandas mínimo** (`pandas.ts`: read_excel + select), hoja del distribuidor (`delivery.ts`). |
| `packages/db` | **PostgreSQL real** con PGlite: tablas del jugador (esquema `public`) + registro interno invisible (esquema `registro`), rol `jugador`, traducción de errores. |
| `apps/web` | Vite + **Three.js** (tienda 3D con modelos CC0 de Kenney) + **CodeMirror 6** en **ventanas flotantes**, audio procedural, intro, misiones, terminal (`terminal.ts`), navegador (`browser.ts`), montaje (`assembly.ts`). |
| `docs/gdd` | Documento de diseño (GDD). Fuente: `gdd_content.py`; se regenera con `build_gdd.py` (ver abajo). |
| `.claude/skills` | Skills instaladas por el usuario (vitest, three.js, PostgreSQL, audio, diseño de juegos...). `phaser-*` quedaron de una versión anterior: el juego ya **no** usa Phaser. |

## Reglas y preferencias del usuario (importantes)

- **Todo en español**: interfaz, mensajes de error del intérprete y de SQL, comentarios del código, documentación.
  **Los comandos del juego van en inglés** (`move`, `pick`, `scan_item`...), como en TFWR.
- El usuario escribe en español y espera respuestas en español.
- **Estilo visual = The Farmer Was Replaced**: 3D low-poly, tienda a pantalla completa a la derecha, código en
  **ventanas flotantes** a la izquierda. El pixel art 2D fue **rechazado** ("se ve demasiado feo").
- **Escala de letra única** en todas las ventanas: solo `--fs-code` (21px), `--fs-data` (18px), `--fs-ui` (16px),
  `--fs-sm` (14px), definidas en `:root` de `apps/web/src/style.css`. **No uses tamaños sueltos en px** dentro de las
  ventanas. Cada ventana tiene zoom propio (+/−) que reescala estas variables.
- **La base de datos del jugador empieza vacía**: él diseña sus tablas con `CREATE TABLE`. No muestres tablas que no
  creó él (el registro interno es invisible). **No vienen consultas guardadas de fábrica.**
- `df.to_sql()` **no crea tablas** (a propósito: el jugador modela la base).
- Instalar skills con `npx skills add <owner/repo@skill> -y -a claude-code` (el usuario lo pidió); revisarlas antes de
  usarlas (buscar curl/wget/rm -rf) y preferir las de más instalaciones/fuentes conocidas.
- Al agregar o cambiar mecánicas, **actualiza el GDD** (`docs/gdd/gdd_content.py`) y regenera.
- No hagas commits salvo que el usuario lo pida (el repo no tiene commits todavía).

## Trampas conocidas

- **Imports con `.js`**: el código TS importa `./archivo.js` (moduleResolution Bundler). Mantener ese estilo.
- **CodeMirror**: los atajos propios (Ctrl+Enter) necesitan `Prec.highest(...)` o los pisa el keymap por defecto.
  Tab indenta gracias a `indentWithTab` + `indentUnit` de 4 espacios.
- **Ventanas flotantes** (`windows.ts`): la altura "normal" vive en `dataset.h`; no la recalcules desde `offsetHeight`
  mientras la ventana está minimizada (ya hubo un bug así). Nunca dejes ventanas debajo del letrero ni del explorador
  de archivos (barra lateral izquierda): usa `topInset()` y `leftInset()`.
- **CSS2DRenderer**: elementos que el usuario debe ver no deben depender solo de transiciones CSS (en el Chrome
  headless de pruebas a veces se congelan). En las modales se usa `visibility`, no `opacity` con transición.
- **PGlite** en Vite necesita `optimizeDeps.exclude: ["@electric-sql/pglite"]` (ya está en `vite.config.ts`).
  Cambiar `vite.config.ts` requiere reiniciar el servidor de desarrollo.
- **SQL del jugador**: siempre por `GameDB.run()` / `playerQuery()` (rol `jugador`, `search_path = public`).
  Nunca ejecutes SQL del jugador como superusuario. Se bloquean BEGIN/COMMIT/SET ROLE/RESET/COPY.
- **El navegador bloquea el audio** hasta un clic: por eso existe la pantalla de inicio ("Entrar a la tienda").
- Los tests de `packages/db` usan PostgreSQL real; si un test depende del registro interno, usa `db.systemRun()`.

## Verificar en el navegador

No hay Playwright en el proyecto. Se usa `playwright-core` instalado en el **scratchpad** de la sesión (no en el
repo) con el Chrome del sistema:

```js
import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: "/bin/google-chrome",
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" }); // "load" espera a PGlite y puede tardar
```

- **Menú principal**: siempre sale al cargar (está en `index.html`; lógica en `apps/web/src/start.ts`). Para pasarlo en
  pruebas: esperar `.menu.scene-ready` y hacer clic en `[data-action="play"]`. Las animaciones CSS casi no avanzan en el
  Chrome por software: usa `page.screenshot({ animations: "disabled" })` y `setDefaultTimeout(120000)`.
- Saltar la intro: `localStorage.setItem("cdb.progress.v1", JSON.stringify({ storeOpen: true }))` y recargar.
  La partida empieza **sin servidores** (`world.startServerTutorial()`): sin servidor los robots no corren. Para
  saltarse el montaje: `world.skipServerTutorial()` (o el botón Saltar de la misión "Monta tu servidor").
  Para probar el montaje: `window.assembly.screenPos("placa")` da dónde soltar cada pieza.
  La primera noche sale solo si no está `prepDone: true`; para abrir ya, `world.openStore()` o los dos "¡Listo!".
  Para saltar al cierre: `for (let i=0;i<3000;i++) world.step()` (un día = 3000 ticks).
- Playwright: usa `playwright-core` ≥ 1.55 (las versiones viejas lanzan `--headless=old`, que el Chrome actual ya no tiene).
- `window.world`, `window.db`, `window.store`, `window.scriptRun` están expuestos para pruebas
  (p. ej. `for (let i=0;i<3000;i++) world.step()` para adelantar 5 minutos).
- Escribir en CodeMirror: `page.keyboard.insertText(...)` (con `type()` el auto-indentado duplica sangrías).
- El render es por software: los screenshots tardan y las animaciones pueden ir lentas.

## Almacenamiento del navegador

| Clave | Qué guarda |
|---|---|
| `cdb.scripts.v1` | Código de Toño, Lupe, `shared.py` e `inventario.py` |
| `cdb.windows.v1` | Posición, tamaño, zoom y estado de cada ventana |
| `cdb.queries.v1` | Consultas SQL guardadas por el jugador |
| `cdb.audio.v1` | Volumen de música/efectos y silencio |
| `cdb.commands.v1` | Última categoría abierta en la ventana Comandos |
| `cdb.explorer.v1` | Explorador de archivos: `{ collapsed, closedFolders, closedSections }` (se conserva al recargar) |
| `cdb.player.v1` | En línea: `{ id, name, color }` de este jugador |
| `cdb.progress.v1` | `{ storeOpen, prepDone }`: si ya terminó la intro/misión y la primera noche |

**Cada recarga empieza la partida desde 0** (lo pidió el usuario): al cargar `main.ts` borra `cdb.scripts.v1`,
`cdb.progress.v1` y `cdb.queries.v1`, y la base PostgreSQL corre **en memoria** (antes estaba en IndexedDB). Solo se
conservan el audio, las ventanas y el explorador. Para probar sin intro hay que poner `cdb.progress.v1` *después* de cargar y llamar
a `world.openStore()` (recargar lo borra).

## Estado y próximos pasos

Hecho: M0 (intérprete), M1 (prototipo local), 3D, ventanas flotantes, depurador, audio, base de datos, intro +
misión de inventario con pandas, almacén como cuarto aparte (estantes libres: el jugador elige qué va en cada uno; el almacén es su tabla de inventario) y
**ciclo de día (5 min de juego, con clientes) y noche (10 min reales, tienda cerrada, para programar)**: la primera
noche es la preparación; votos de los 2 jugadores para abrir antes (en local, un botón por jugador); cada día llegan
más clientes; luces y música cambian según la hora.

**Servidores, hardware y ciberseguridad** (las 8 fases hechas; detalle y mapa del código en `docs/servidores.md`):
cuarto de servidores, montaje en 1ª persona, terminal Linux simulada, red/IPs, TecnoMercado, ataques (solo frenan),
10 técnicas de rastreo, denuncias con bug bounty, temperatura y GPU.

**Proveedor y productos premium**: pestaña El Surtidor del Navegador (pedidos por cajas, `World.orderGoods`); el
repartidor deja `pedido_N.xlsx` (misma estructura que la primera entrega) que el jugador migra con pandas +
`cursor.execute`; `hoja.last_cell`. Para probar sin esperar: `for (let i=0;i<600;i++) world.step()`.

**Árbol de Mejoras** (ventana Mejoras, `apps/web/src/upgrades.ts`): toda la sintaxis viene desbloqueada; se compran
estantes (el jugador elige la casilla: `world.placeShelf`, modo colocar en `Store3D.startPlacement`), ampliar el local
(lotes del terreno al este, sin cambiar coordenadas), marketing (más clientes y paciencia) y el centro de datos (CPU y
espacio para racks). Rama Equipo: cajas nuevas que el jugador coloca (`world.placeRegister`, llegan con robot cajero),
más reponedores (aparecen en el almacén; evento `hired` → la web les abre ventana de código). Clic en una caja la
activa/desactiva. De noche cada caja activa recibe un cliente de prueba (`Customer.test`) que no cuenta para nada.

**Velocidad por tamaño del código** (no hay ticks para el jugador): `packages/sim/src/codesize.ts` (`measureCode`)
cuenta instrucciones del robot y lo que usa de `shared.py`; `World.slowdown(robot)` = freno del servidor × factor del
código. Clic en un rack con servidor → terminal o rack (`World.openCase` / `removePart`; el montaje deja sacar piezas).

**En línea (Supabase)**: `apps/web/src/online/` (sala/presence/rpc en `room.ts`, Yjs en `collab.ts`, espejo y
anfitrión en `gamesync.ts`, guardado en `saves.ts`, lobby y nombres). El anfitrión corre todo; el otro jugador tiene un
mundo espejo (`wrapWorld`/`wrapDb` reenvían sus acciones). Guardar/cargar el mundo: `packages/sim/src/persist.ts`;
la base del jugador: `GameDB.exportState/importState` (pg_dump). Tabla: `supabase/schema.sql`.
**La clave secreta de Supabase nunca va en el código.** Para probar dos jugadores: dos contextos de Playwright con
`cdb.player.v1` distinto y `#partida=ABCD` en la URL.

Pendiente (en orden aproximado):
1. Probar a fondo el modo en línea con dos personas reales (latencia, reconexión).
2. Historial de versiones del código.
4. Ideas aceptadas o propuestas: auditoría (comparar la tabla de ventas del jugador con el registro interno),
   etapas 2–7 del GDD, balance (playtest), meta final.
