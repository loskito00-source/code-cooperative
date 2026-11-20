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
pnpm test        # vitest: intérprete, simulación, base de datos (167 tests; los de db arrancan PGlite, ~10 s)
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
| `packages/sim` | La **simulación** de la tienda (sin navegador): `World`, comandos de los robots (`api.ts`), clientes, caja, balance (`config.ts`), conexión `db` estilo asyncpg (`sqlapi.ts`), **pandas sencillo** (`pandas.ts`), hoja del distribuidor (`delivery.ts`). |
| `packages/db` | **PostgreSQL real** con PGlite: tablas del jugador (esquema `public`) + registro interno invisible (esquema `registro`), rol `jugador`, traducción de errores. |
| `apps/web` | Vite + **Three.js** (tienda 3D con modelos CC0 de Kenney) + **CodeMirror 6** en **ventanas flotantes**, audio procedural, intro, misión. |
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
  mientras la ventana está minimizada (ya hubo un bug así). Nunca dejes ventanas debajo del letrero: usa `topInset()`.
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
| `cdb.progress.v1` | `{ storeOpen, prepDone }`: si ya terminó la intro/misión y la primera noche |

**Cada recarga empieza la partida desde 0** (lo pidió el usuario): al cargar `main.ts` borra `cdb.scripts.v1`,
`cdb.progress.v1` y `cdb.queries.v1`, y la base PostgreSQL corre **en memoria** (antes estaba en IndexedDB). Solo se
conservan el audio y las ventanas. Para probar sin intro hay que poner `cdb.progress.v1` *después* de cargar y llamar
a `world.openStore()` (recargar lo borra).

## Estado y próximos pasos

Hecho: M0 (intérprete), M1 (prototipo local), 3D, ventanas flotantes, depurador, audio, base de datos, intro +
misión de inventario con pandas, almacén como cuarto aparte (estantes libres: el jugador elige qué va en cada uno; el almacén es su tabla de inventario) y
**ciclo de día (5 min de juego, con clientes) y noche (10 min reales, tienda cerrada, para programar)**: la primera
noche es la preparación; votos de los 2 jugadores para abrir antes (en local, un botón por jugador); cada día llegan
más clientes; luces y música cambian según la hora.

Pendiente (en orden aproximado):
1. **M2 online**: servidor autoritativo (Node + Colyseus o ws), salas con código de 4 letras, 2 jugadores, la
   simulación corre en el servidor. `packages/sim` y `packages/db` ya no dependen del navegador.
2. **M3**: edición colaborativa del código (Yjs), historial de versiones.
3. Guardar el estado completo de la partida.
4. Ideas aceptadas o propuestas: auditoría (comparar la tabla de ventas del jugador con el registro interno),
   etapas 2–7 del GDD, balance (playtest), meta final.
