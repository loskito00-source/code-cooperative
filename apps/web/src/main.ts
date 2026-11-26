import { GameDB, type WarehouseSource } from "@cdb/db";
import { FEATURES, VM } from "@cdb/interpreter";
import { applyWorld, encodeWorld, type CodeSize, measureCode, slowdown as serverSlowdown, type Robot, type ConsoleLine, DELIVERY, DELIVERY_PRODUCTS, NIGHT, PRODUCT_NAMES, PRODUCTS, type ProductName, SUPPLIER, type SimEvent, type Ticket, TICKS_PER_SECOND, World } from "@cdb/sim";
import { AudioEngine, type SongName } from "./audio.js";
import { CodeEditor } from "./editor.js";
import { CommandsWindow } from "./commands.js";
import { UpgradesWindow } from "./upgrades.js";
import { type ModalOptions, NightPanel, ObjectivesPanel, showLetterbox, showModal } from "./intro.js";
import { SheetWindow } from "./sheet.js";
import { AssemblyView } from "./assembly.js";
import { BrowserWindow } from "./browser.js";
import { SqlWindow } from "./sqlwindow.js";
import { TerminalWindow } from "./terminal.js";
import { MainMenu } from "./start.js";
import { type PlaceKind, Store3D } from "./store3d.js";
import { FloatingWindow, leftInset, topInset } from "./windows.js";
import { Collab } from "./online/collab.js";
import { FORWARD, GuestSync, HostSync, isGuest, isOnline, session, wrapDb, wrapWorld } from "./online/gamesync.js";
import { loadPlayer } from "./online/player.js";
import type { OnlineChoice } from "./online/lobby.js";
import { nameNewRobot, nameRobotsTogether } from "./online/naming.js";
import { Room } from "./online/room.js";
import { getPartida, savePartida } from "./online/saves.js";

// ── scripts iniciales ────────────────────────────────────────

const DEFAULT_SCRIPTS: Record<string, string> = {
  tono: `# Toño, el reponedor.
# Empieza en el almacén: el cuarto de la izquierda. Ahí está la mercancía
# que trajo el distribuidor, y desde cualquier casilla del cuarto puede
# tomar cualquier producto con pick("pan"), pick("leche") o pick("huevos").
# La puerta del almacén está arriba, en (2, 5) -> (3, 5).
#
# Los estantes están arriba: (4, 5), (5, 5), (6, 5) y (7, 5).
# Empiezan vacíos y libres: el primer producto que pongas en un estante
# decide qué vende (cada estante tiene un solo producto). ¡Ustedes eligen!
#
# Este ejemplo lleva panes al primer estante una sola vez.
# ¿Cómo haces que surta los tres productos y lo repita para siempre?
pick("pan", 5)
move(East)
move(East)
place()
`,
  lupe: `# Lupe, la cajera.
# Está en la caja (adelante a la izquierda). Para cada cliente:
#   scan_item()          escanea el carrito y te da la lista de productos
#   price(producto)      cuánto cuesta
#   take_payment(total)  le cobra y te dice con cuánto pagó
#   give_change(monto)   le entrega la devuelta
#   next_customer()      lo despide
#
# Escribe aquí tu cajera. Si le cobras de más, el cliente se enoja.
#
# Para guardar cada venta en TU base de datos (la tabla la diseñas tú):
#   cursor.execute("INSERT INTO ventas (total, pagado) VALUES (%s, %s)", (total, pago))
while True:
    if has_customer():
        print("¡Llegó un cliente!")
        wait()
`,
  inventario: `# inventario.py: la mercancía que trajo el distribuidor.
# Aquí tienes Python completo, pandas y cursor (la conexión a tu base de datos).
import pandas as pd

hoja = pd.read_excel("entrega_distribuidor.xlsx")
print(hoja)

# Elige el rango de celdas, como en Excel. Te da una lista con un
# diccionario por fila; las claves son los encabezados de la fila 1.
filas = hoja.select("A1", "G6")
for fila in filas:
    print(fila)

# Ojo: la hoja no viene limpia. Arréglala tú con Python antes de subirla.
#
# Diseña tu tabla en la ventana Base de datos (CREATE TABLE ...) y sube
# cada fila con SQL:
#   cursor.execute("INSERT INTO productos (nombre, cantidad) VALUES (%s, %s)", (nombre, cantidad))
`,
  shared: `# Librería compartida.
# Con "import shared", cualquier robot puede usar
# lo que definan aquí, por ejemplo:
#
# def ir_a(x, y):
#     ...
`,
};

/** Código con que llega un robot comprado en Mejoras → Equipo (el jugador lo reemplaza). */
function hiredScript(r: Robot): string {
  if (r.role === "cajero") {
    const reg = world.registerAt(r.x, r.y);
    return `# ${r.name}, cajero de la caja ${reg?.id ?? "?"} (en ${r.x}, ${r.y}).
# Atiende igual que ${nm("lupe")}: scan_item(), price(), take_payment(),
# give_change() y next_customer(). Solo atiende a los de SU fila.
#
# De noche siempre llega un cliente de prueba: sirve para probar el código
# sin gastar plata ni productos.
while True:
    if has_customer():
        print("¡Llegó un cliente!")
    wait()
`;
  }
  return `# ${r.name}, reponedor. Llegó al almacén en (${r.x}, ${r.y}).
# Igual que ${nm("tono")}: pick("pan", 5) en el almacén, camina a un estante y place().
# Pónganse de acuerdo para que no surtan los mismos estantes.
pick("leche", 5)
`;
}

const STORAGE_KEY = "cdb.scripts.v1";

// Cada recarga empieza la partida desde 0 (lo pidió el usuario): se borran el progreso (intro/primera noche), el
// código de los robots, las consultas guardadas y la base de datos vieja. El volumen y la posición de las
// ventanas se conservan (son preferencias, no partida). La base de datos ahora vive solo en memoria.
try {
  for (const key of [STORAGE_KEY, "cdb.progress.v1", "cdb.queries.v1"]) localStorage.removeItem(key);
  indexedDB.deleteDatabase("/pglite/codigo-de-barras");
} catch {
  /* sin almacenamiento */
}

function loadScripts(): Record<string, string> {
  try {
    return { ...DEFAULT_SCRIPTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") };
  } catch {
    return { ...DEFAULT_SCRIPTS };
  }
}

function saveScripts(scripts: Record<string, string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(scripts));
  } catch {
    /* sin almacenamiento */
  }
}

// ── estado ───────────────────────────────────────────────────

// en una partida en línea el que no es anfitrión tiene un "espejo": el envoltorio reenvía sus acciones al anfitrión
const world = wrapWorld(new World(Date.now() % 100000));
world.customersEnabled = false; // abren cuando amanece después de la primera noche (ver openStore)
// los robots necesitan un servidor: la partida empieza con las piezas del primero en el almacén (se monta tras la misión)
world.startServerTutorial();
// el almacén es la tabla de inventario del jugador: lo que trae El Surtidor entra cuando migra su Excel
world.warehouseFromDb = true;
// el almacén arranca vacío: la mercancía aparece cuando la registran en su tabla de inventario (antes salía llena)
for (const p of PRODUCT_NAMES) world.warehouseStock[p] = 0;
const scripts = loadScripts();
for (const r of world.robots) world.setScript(r.id, scripts[r.id]);
world.sharedSource = scripts.shared;

let speed = 1;
let acc = 0;
let selected = "tono";
const TICK_MS = 1000 / TICKS_PER_SECOND;

const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const money = (n: number) => "$" + Math.round(n).toLocaleString("es-CO");
const layer = $("#windows");

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ── ventanas de código ───────────────────────────────────────

interface CodeWindow {
  id: string;
  pauseBtn: HTMLButtonElement;
  stepBtn: HTMLButtonElement;
  vars: HTMLElement;
  varsKey: string;
  pane: "console" | "vars";
  win: FloatingWindow;
  editor: CodeEditor;
  state: HTMLElement;
  status: HTMLElement;
  runBtn: HTMLButtonElement;
  stopBtn: HTMLButtonElement;
  console: HTMLElement;
  consoleKey: string;
}

const codeWindows = new Map<string, CodeWindow>();

function makeCodeWindow(id: string, title: string, color: string | null, box: { x: number; y: number; w: number; h: number }): CodeWindow {
  const extra = document.createElement("span");
  extra.style.display = "contents";
  extra.innerHTML = color ? `<span class="dot" style="background: var(--${color})"></span>` : "";
  const state = document.createElement("span");
  state.className = "state";
  const win = new FloatingWindow(layer, { id: `code-${id}`, title, titleExtra: extra, x: box.x, y: box.y, width: box.w, height: box.h, minWidth: 300, minHeight: 180 });
  win.titleEl.append(state);

  const isShared = id === "shared";
  win.body.innerHTML = `
    <div class="code-tools">
      <button class="btn-run">${isShared ? "▶ Ejecutar todos" : "▶ Ejecutar"}</button>
      <button class="btn-pause" title="Detener en la próxima línea (F8)" ${isShared ? "hidden" : ""}>⏸ Pausar</button>
      <button class="btn-step" title="Ejecutar una sola línea (F10)" ${isShared ? "hidden" : ""}>⤵ Paso</button>
      <button class="btn-stop">■ Detener</button>
      <span class="run-status"></span>
    </div>
    <div class="editor"></div>
    <div class="pane-tabs" ${isShared ? "hidden" : ""}>
      <button data-pane="console" class="on">Consola</button>
      <button data-pane="vars">Variables</button>
      <span class="pane-hint">Clic a la izquierda de un número de línea para poner un punto de parada</span>
    </div>
    <div class="console"></div>
    <div class="vars" hidden></div>`;

  const cw: CodeWindow = {
    id,
    win,
    pauseBtn: $(".btn-pause", win.body),
    stepBtn: $(".btn-step", win.body),
    vars: $(".vars", win.body),
    varsKey: "",
    pane: "console",
    state,
    editor: null as unknown as CodeEditor,
    status: $(".run-status", win.body),
    runBtn: $(".btn-run", win.body),
    stopBtn: $(".btn-stop", win.body),
    console: $(".console", win.body),
    consoleKey: "",
  };
  cw.editor = new CodeEditor({
    parent: $(".editor", win.body),
    doc: scripts[id],
    features: () => world.features,
    onChange: (text) => {
      scripts[id] = text;
      if (isShared) world.sharedSource = text;
      else world.setScript(id, text);
      saveScripts(scripts);
    },
    onRun: () => run(id),
    onBreakpoints: (lines) => {
      if (isShared) return;
      const bps = world.robot(id).breakpoints;
      bps.clear();
      lines.forEach((l) => bps.add(l));
      if (isGuest()) void session.room?.call("bp", { r: id, lines });
    },
  });
  cw.runBtn.addEventListener("click", () => run(id));
  cw.stopBtn.addEventListener("click", () => stop(id));
  cw.pauseBtn.addEventListener("click", () => togglePause(id));
  cw.stepBtn.addEventListener("click", () => stepLine(id));
  win.body.querySelectorAll<HTMLButtonElement>(".pane-tabs [data-pane]").forEach((b) =>
    b.addEventListener("click", () => showPane(cw, b.dataset.pane as CodeWindow["pane"])),
  );
  win.onFocus = () => {
    if (!isShared) selected = id;
  };
  codeWindows.set(id, cw);
  return cw;
}

function run(id: string): void {
  if (id === "shared") world.robots.forEach((r) => world.runRobot(r.id));
  else world.runRobot(id);
  endDebugPause();
  refreshUi(true);
}

function stop(id: string): void {
  if (id === "shared") world.robots.forEach((r) => world.stopRobot(r.id));
  else world.stopRobot(id);
  endDebugPause();
  refreshUi(true);
}

// ── depurador ────────────────────────────────────────────────

/** Velocidad que había antes de que un robot se detuviera en el depurador. */
let speedBeforeDebug: number | null = null;

function showPane(cw: CodeWindow, pane: CodeWindow["pane"]): void {
  cw.pane = pane;
  cw.win.body.querySelectorAll<HTMLButtonElement>(".pane-tabs [data-pane]").forEach((b) => b.classList.toggle("on", b.dataset.pane === pane));
  cw.console.hidden = pane !== "console";
  cw.vars.hidden = pane !== "vars";
  cw.varsKey = "";
  refreshUi(true);
}

/** Cuando un robot se detiene en el depurador, el mundo entero se pausa para revisar con calma. */
function onRobotPaused(id: string): void {
  if (speed > 0 && !isGuest()) {
    speedBeforeDebug = speed;
    setSpeed(0);
  }
  const cw = codeWindows.get(id);
  if (cw) {
    cw.win.show();
    if (cw.pane !== "vars") showPane(cw, "vars");
  }
  selected = id;
  refreshDock();
}

function endDebugPause(): void {
  const anyPaused = world.robots.some((r) => r.vm?.status === "paused");
  if (!anyPaused && speedBeforeDebug !== null && speed === 0) setSpeed(speedBeforeDebug);
  if (!anyPaused) speedBeforeDebug = null;
}

function togglePause(id: string): void {
  if (isGuest()) {
    void session.room?.call("debug", { op: "pause", r: id });
    return;
  }
  const vm = world.robot(id).vm;
  if (!vm) return;
  if (vm.status === "paused") {
    vm.resume();
    endDebugPause();
  } else {
    vm.pause();
    if (speed === 0) advanceUntilPaused(id);
  }
  refreshUi(true);
}

/** Ejecuta una línea. Si el robot no corre, lo arranca detenido en la primera línea. */
function stepLine(id: string): void {
  if (isGuest()) {
    void session.room?.call("debug", { op: "step", r: id });
    return;
  }
  const robot = world.robot(id);
  if (!world.isRunning(id)) {
    world.runRobot(id);
    robot.vm?.pause();
  } else if (robot.vm!.status === "paused") {
    robot.vm!.step();
  } else {
    robot.vm!.pause();
  }
  if (speed === 0) advanceUntilPaused(id);
  refreshUi(true);
}

/** Con el juego en pausa, avanza el mundo lo justo para que el robot llegue a la siguiente línea. */
function advanceUntilPaused(id: string): void {
  const vm = () => world.robot(id).vm;
  for (let i = 0; i < 600; i++) {
    const s = vm()?.status;
    if (s !== "running" && s !== "waiting") break;
    world.step();
  }
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "F10" && e.key !== "F8") return;
  e.preventDefault();
  if (e.key === "F10") stepLine(selected);
  else togglePause(selected);
});

// ── ventanas de papel ────────────────────────────────────────

const H = window.innerHeight;
const codeW = Math.min(720, Math.max(460, Math.round(window.innerWidth * 0.42)));
const codeH = Math.round((H - 90) / 2);

makeCodeWindow("tono", "Toño", "cian", { x: 14, y: 66, w: codeW, h: codeH });
makeCodeWindow("lupe", "Lupe", "naranja", { x: 14, y: 66 + codeH + 10, w: codeW, h: codeH });
const sharedWin = makeCodeWindow("shared", "shared.py", null, { x: codeW + 30, y: 90, w: 420, h: 300 });
if (!localStorage.getItem("cdb.windows.v1")?.includes("code-shared")) sharedWin.win.close();

const ticketsWin = new FloatingWindow(layer, { id: "tickets", title: "Tiquetes", className: "papel", x: window.innerWidth - 260, y: 170, width: 240, height: 420, open: false });
ticketsWin.body.innerHTML = `<div class="ticket-list"><p class="empty-note">Aquí quedan los tiquetes de cada venta. Programa a la cajera para empezar a vender.</p></div>`;

// Mejoras: el árbol de compras (antes "Desbloqueos", que vendía sintaxis; ahora toda la sintaxis viene desbloqueada)
const upgradesWin = new FloatingWindow(layer, {
  id: "upgrades", title: "Mejoras", className: "papel upg-win",
  x: Math.max(leftInset(), window.innerWidth - 1060), y: 70, width: Math.min(1020, window.innerWidth - 60), height: Math.min(760, H - 90),
  minWidth: 560, minHeight: 420, open: false,
});

// base de datos: PostgreSQL (PGlite) con todo lo que pasa en la tienda
const db = wrapDb(new GameDB(world));
const dbWin = new FloatingWindow(layer, {
  id: "db", title: "Base de datos", className: "dbwin", x: codeW + 30, y: 70,
  width: Math.min(980, window.innerWidth - codeW - 60), height: Math.min(600, H - 100), minWidth: 560, minHeight: 320, open: false,
});
const sqlWin = new SqlWindow(dbWin, db);
// las consultas de los robots, de pandas y de inventario.py corren como el rol jugador
world.sql = { query: (sql, params) => db.playerQuery(sql, params) };

const sheetWin = new FloatingWindow(layer, {
  id: "sheet", title: DELIVERY.filename, className: "papel sheetwin", x: window.innerWidth - 740, y: 70,
  width: 700, height: 340, minWidth: 420, minHeight: 200, open: false,
});
const sheet = new SheetWindow(sheetWin, DELIVERY);
/** Abre un Excel de la carpeta entregas (la primera entrega o el de un pedido). */
function openSheet(filename: string): void {
  const book = world.workbooks.find((b) => b.filename === filename);
  if (!book) return;
  sheet.setBook(book);
  sheetWin.show();
  refreshDock();
}

// ── inventario.py: un script (no es un robot) con toda la sintaxis, pandas y cursor ──
const ALL_FEATURES = new Set(FEATURES);
const scriptRun = { vm: null as VM | null, console: [] as ConsoleLine[], consoleKey: "", usedReadExcel: false };
const scriptState = document.createElement("span");
scriptState.className = "state";
const scriptWin = new FloatingWindow(layer, {
  id: "code-inventario", title: "inventario.py", x: 14, y: 66, width: codeW, height: H - 90, minWidth: 320, minHeight: 220, open: false,
});
scriptWin.titleEl.append(scriptState);
scriptWin.body.innerHTML = `
  <div class="code-tools">
    <button class="btn-run">▶ Ejecutar</button>
    <button class="btn-stop">■ Detener</button>
    <span class="run-status">Ctrl+Enter para ejecutar</span>
  </div>
  <div class="editor"></div>
  <div class="pane-tabs"><button class="on">Salida</button><span class="pane-hint">print(hoja) muestra la hoja aquí</span></div>
  <div class="console script-console"></div>`;
const scriptEditor = new CodeEditor({
  parent: $(".editor", scriptWin.body),
  doc: scripts.inventario,
  features: () => ALL_FEATURES,
  onChange: (text) => {
    scripts.inventario = text;
    saveScripts(scripts);
  },
  onRun: () => runScript(),
});

function scriptLog(kind: ConsoleLine["kind"], text: string): void {
  scriptRun.console.push({ kind, text, tick: world.tick });
  if (scriptRun.console.length > 300) scriptRun.console.splice(0, scriptRun.console.length - 300);
}

function runScript(): void {
  if (isGuest()) {
    void session.room?.call("script", { op: "run" });
    return;
  }
  scriptRun.vm?.stop();
  scriptRun.console = [];
  const libs = world.libraries();
  const vm = new VM(scriptEditor.text, {
    globals: libs.globals,
    nativeModules: libs.nativeModules,
    features: ALL_FEATURES,
    opsPerTick: 20_000,
    onPrint: (t) => scriptLog("print", t),
  });
  scriptRun.vm = vm;
  if (vm.status === "error") scriptLog("error", vm.error!.format());
  else scriptLog("info", "▶ Ejecutando inventario.py");
  refreshScript(true);
}

/** El script corre aunque el juego esté en pausa (no depende de la velocidad de la tienda). */
function tickScript(): void {
  if (isGuest()) return;
  const vm = scriptRun.vm;
  if (!vm || (vm.status !== "running" && vm.status !== "waiting")) return;
  for (let i = 0; i < 25; i++) {
    const st = vm.tick();
    if (st === "done") {
      scriptLog("info", "✓ inventario.py terminó");
      if (scriptEditor.text.includes("read_excel")) scriptRun.usedReadExcel = true;
      void missionCheck();
      void sqlWin.init();
      break;
    }
    if (st === "error") {
      scriptLog("error", vm.error!.format());
      void sqlWin.init();
      break;
    }
    if (vm.waitingAsync) break;
  }
}

$(".btn-run", scriptWin.body).addEventListener("click", runScript);
$(".btn-stop", scriptWin.body).addEventListener("click", () => stopScript());
function stopScript(): void {
  if (isGuest()) {
    void session.room?.call("script", { op: "stop" });
    return;
  }
  if (scriptRun.vm && (scriptRun.vm.status === "running" || scriptRun.vm.status === "waiting")) {
    scriptRun.vm.stop();
    scriptLog("info", "■ Detenido");
  }
}

function refreshScript(force = false): void {
  const vm = scriptRun.vm;
  const running = !!vm && (vm.status === "running" || vm.status === "waiting");
  scriptState.textContent = running ? "corriendo" : vm?.status === "error" ? "error" : vm?.status === "done" ? "terminó" : "";
  scriptState.className = `state ${running ? "running" : vm?.status === "error" ? "error" : ""}`;
  ($(".btn-stop", scriptWin.body) as HTMLButtonElement).disabled = !running;
  $(".run-status", scriptWin.body).textContent = running ? (vm!.waitingAsync ? "esperando a la base de datos…" : `línea ${vm!.line}`) : "Ctrl+Enter para ejecutar";
  if (running) scriptEditor.setMarks(vm!.line, null);
  else if (vm?.status === "error") scriptEditor.setMarks(null, vm.error!.line);
  else scriptEditor.setMarks(null, null);
  const box = $(".script-console", scriptWin.body);
  const key = `${scriptRun.console.length}:${scriptRun.console.at(-1)?.text.length ?? 0}`;
  if (!force && key === scriptRun.consoleKey) return;
  scriptRun.consoleKey = key;
  box.innerHTML = scriptRun.console.length
    ? scriptRun.console.map((l) => `<div class="line ${l.kind}">${escapeHtml(l.text)}</div>`).join("")
    : `<div class="line empty">Presiona ▶ Ejecutar para correr el script. Lo que imprimas con print() sale aquí.</div>`;
  box.scrollTop = box.scrollHeight;
}
setInterval(() => db.ready && void db.flush(), 1000);

// id "commands" (antes "help"): el rediseño necesita más ancho y no debe heredar el tamaño guardado de la versión vieja
const helpWin = new FloatingWindow(layer, { id: "commands", title: "Comandos", className: "papel cmd-win", x: Math.max(leftInset(), window.innerWidth - 820), y: 80, width: Math.min(780, window.innerWidth - 40), height: Math.min(720, H - 100), minWidth: 380, minHeight: 300, open: false });

// ── navegador (tienda en línea, denuncias, foro) y terminales de los servidores ──

const browserWin = new FloatingWindow(layer, {
  id: "browser", title: "Navegador", x: Math.round(window.innerWidth * 0.3), y: 80, width: Math.min(980, window.innerWidth - 120), height: Math.min(720, H - 100), minWidth: 520, minHeight: 360, open: false,
});
const browser = new BrowserWindow(browserWin, () => world, () => refreshUi(true), (f) => openSheet(f));

const terminals = new Map<string, TerminalWindow>();
/** La ventana de terminal de un servidor (se crea la primera vez). */
function terminalFor(serverId: string): TerminalWindow {
  let t = terminals.get(serverId);
  if (!t) {
    const n = terminals.size;
    const win = new FloatingWindow(layer, {
      id: `term-${serverId}`, title: "terminal", x: leftInset() + 30 + n * 30, y: 90 + n * 30, width: Math.min(820, window.innerWidth - 200), height: Math.min(520, H - 140), minWidth: 380, minHeight: 200, open: false,
    });
    const room = session.room;
    t = new TerminalWindow(
      win, world, serverId,
      () => {
        refreshUi(true);
        void serverMissionCheck();
      },
      // en línea: el anfitrión corre los comandos de los dos y publica la salida; el espejo manda lo que escribe
      !room ? {} : isGuest()
        ? { send: (input) => void room.call("term", { s: serverId, ...input }).catch((e: Error) => toast(e.message, "bad")) }
        : { publish: (out) => room.send("term-out", { s: serverId, out }) },
    );
    terminals.set(serverId, t);
    if (room && isGuest()) {
      // lo que ya estaba escrito en la terminal del anfitrión
      const tw = t;
      void room.call<{ lines: string[]; prompt: string; hostname: string }>("term", { s: serverId, hello: true }).then((r) => tw.show({ lines: r.lines, prompt: r.prompt, hostname: r.hostname }));
    }
    watchWindow(win);
  }
  return t;
}

function openTerminal(serverId: string): void {
  const t = terminalFor(serverId);
  t.win.show();
  t.focus();
  renderExplorer();
}

// ── explorador de archivos (barra lateral, como en VS Code) y barra de herramientas ──

type FileStatus = [text: string, cls: "running" | "paused" | "error" | "done"] | null;
interface FileEntry {
  label: string; win: FloatingWindow; icon: "py" | "xlsx" | "term" | "web"; color?: string; hint: string; status?: () => FileStatus;
  /** Para varios archivos que comparten ventana (los Excel): cómo abrirlo y si es el que se ve ahora. */
  open?: () => void; current?: () => boolean;
}
interface Folder { folder: string; files: FileEntry[] }

const vmStatus = (vm: VM | null | undefined): FileStatus => {
  const s = vm?.status;
  if (s === "paused") return ["pausado", "paused"];
  if (s === "running" || s === "waiting") return ["corriendo", "running"];
  if (s === "error") return ["error", "error"];
  return null;
};

/** El nombre actual de un robot (lo eligen los jugadores). */
const nm = (id: string): string => world.robots.find((r) => r.id === id)?.name ?? id;
const ROBOT_HINT: Record<string, () => string> = { tono: () => `${nm("tono")}, el que surte los estantes`, lupe: () => `${nm("lupe")}, la cajera` };
/** Un archivo .py por robot (también los que se compran después). */
function robotFiles(): FileEntry[] {
  return world.robots
    .filter((r) => codeWindows.has(r.id))
    .map((r) => ({
      label: `${r.name.toLowerCase()}.py`, win: codeWindows.get(r.id)!.win, icon: "py", color: r.color,
      hint: ROBOT_HINT[r.id]?.() ?? (r.role === "cajero" ? `${r.name}, cajero de la caja ${world.registerAt(r.x, r.y)?.id ?? ""}` : `${r.name}, reponedor`),
      status: () => vmStatus(world.robot(r.id).vm),
    }));
}

const STATIC_EXPLORER: (FileEntry | Folder)[] = [
  { folder: "robots", files: robotFiles() },
  { folder: "entregas", files: [] },
  { label: "inventario.py", win: scriptWin, icon: "py", hint: "Script con pandas y cursor", status: () => vmStatus(scriptRun.vm) },
  { label: "shared.py", win: sharedWin.win, icon: "py", hint: "Librería compartida (import shared)" },
];
/** El árbol incluye una carpeta "servidores" con la terminal de cada servidor encendido. */
let EXPLORER: (FileEntry | Folder)[] = STATIC_EXPLORER;
let FILES: FileEntry[] = [];
function rebuildExplorerTree(): void {
  const servers: FileEntry[] = world.servers.map((srv) => ({
    label: `${srv.hostname}`, win: terminalFor(srv.id).win, icon: "term", hint: `Terminal de ${srv.hostname}${srv.ip ? ` (${srv.ip})` : ""}`,
    status: () => (srv.malware && srv.malware.respawnAt === null) || srv.ddos ? ["alerta", "error"] : srv.load >= 0.8 ? [`${Math.round(srv.load * 100)}%`, "paused"] : null,
  }));
  const sheets: FileEntry[] = world.workbooks.map((b, i) => ({
    label: b.filename, win: sheetWin, icon: "xlsx",
    hint: i === 0 ? "La hoja del distribuidor (solo lectura)" : `Excel que dejó el repartidor de ${SUPPLIER.name}: migra los datos a tu inventario`,
    status: () => (i > 0 && !migrated.has(b.filename) ? ["nuevo", "paused"] : null),
    open: () => openSheet(b.filename), current: () => sheet.filename === b.filename,
  }));
  EXPLORER = [
    { folder: "robots", files: robotFiles() },
    ...(servers.length ? [{ folder: "servidores", files: servers }] : []),
    { folder: "entregas", files: sheets },
    ...STATIC_EXPLORER.slice(2),
  ];
  FILES = EXPLORER.flatMap((e) => ("folder" in e ? e.files : [e]));
}

const DOCK: { label: string; win: FloatingWindow }[] = [
  { label: "Navegador", win: browserWin },
  { label: "Tiquetes", win: ticketsWin },
  { label: "Mejoras", win: upgradesWin },
  { label: "Base de datos", win: dbWin },
  { label: "Comandos", win: helpWin },
];

const EXPLORER_KEY = "cdb.explorer.v1";
const explorer = $("#explorer");
const tree = explorer.querySelector<HTMLElement>(".ex-tree")!;
const openList = explorer.querySelector<HTMLElement>(".ex-open-list")!;
const explorerState: { collapsed: boolean; closedFolders: string[]; closedSections: string[] } = (() => {
  const base = { collapsed: false, closedFolders: [] as string[], closedSections: [] as string[] };
  try {
    return { ...base, ...JSON.parse(localStorage.getItem(EXPLORER_KEY) ?? "{}") };
  } catch {
    return base;
  }
})();
function saveExplorer(): void {
  try {
    localStorage.setItem(EXPLORER_KEY, JSON.stringify(explorerState));
  } catch {
    /* sin almacenamiento: solo no se recuerda */
  }
}

// íconos de tipo de archivo (dibujados aquí para no depender de una fuente de íconos)
const ICONS = {
  py: `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M7.9 1.5c-3 0-2.8 1.3-2.8 1.3v1.4h2.9v.5H3.9S2 4.5 2 7.6s1.6 3 1.6 3h1v-1.5s-.1-1.7 1.7-1.7h2.9s1.6 0 1.6-1.6V3.2S11 1.5 7.9 1.5Z" fill="#4b8bbe"/><path d="M8.1 14.5c3 0 2.8-1.3 2.8-1.3v-1.4H8v-.5h4.1S14 11.5 14 8.4s-1.6-3-1.6-3h-1v1.5s.1 1.7-1.7 1.7H6.8s-1.6 0-1.6 1.6v2.6S5 14.5 8.1 14.5Z" fill="#ffd43b"/><circle cx="6.3" cy="2.9" r=".6" fill="#fff"/><circle cx="9.7" cy="13.1" r=".6" fill="#5a4a00"/></svg>`,
  xlsx: `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="2" fill="#1f8a4c"/><path d="M2.5 6h11M2.5 10h11M6.5 2.5v11" stroke="#bff0cf" stroke-width="1" opacity=".85"/></svg>`,
  term: `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="#26313a" stroke="#7ee08f" stroke-width="1"/><path d="M4 6l2 2-2 2M8 10.5h4" fill="none" stroke="#7ee08f" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  web: `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6.3" fill="none" stroke="#6cb6ff" stroke-width="1.3"/><path d="M1.8 8h12.4M8 1.7c2 2 2 10.6 0 12.6M8 1.7c-2 2-2 10.6 0 12.6" fill="none" stroke="#6cb6ff" stroke-width="1.1"/></svg>`,
  folder: `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M1.5 4a1 1 0 0 1 1-1h3.6l1.5 1.5h5.9a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1Z" fill="#c8894f"/><path d="M1.5 6h13v6a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1Z" fill="#dea064"/></svg>`,
  folderOpen: `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M1.5 4a1 1 0 0 1 1-1h3.6l1.5 1.5h5.4a1 1 0 0 1 1 1V7H4.2L1.5 12Z" fill="#c8894f"/><path d="M4 7.2h11L12.6 13H1.6Z" fill="#e9b47a"/></svg>`,
};

const fileIcon = (f: FileEntry) => `<span class="ex-ico" aria-hidden="true">${ICONS[f.icon]}${f.color ? `<span class="ex-robot" style="--c: var(--${f.color})"></span>` : ""}</span>`;
const fileRow = (f: FileEntry) =>
  `<button class="ex-row ex-file" role="treeitem" data-file="${FILES.indexOf(f)}" title="${f.hint}">${fileIcon(f)}<span class="ex-name">${f.label}</span><span class="ex-status"></span></button>`;

function renderExplorer(): void {
  rebuildExplorerTree();
  tree.innerHTML = EXPLORER.map((e) => {
    if (!("folder" in e)) return fileRow(e);
    const open = !explorerState.closedFolders.includes(e.folder);
    return `<div class="ex-group${open ? " open" : ""}">
      <button class="ex-row ex-folder" role="treeitem" aria-expanded="${open}" data-folder="${e.folder}"><span class="ex-chev" aria-hidden="true"></span><span class="ex-ico" aria-hidden="true">${open ? ICONS.folderOpen : ICONS.folder}</span><span class="ex-name">${e.folder}</span></button>
      ${open ? `<div class="ex-children" role="group">${e.files.map(fileRow).join("")}</div>` : ""}
    </div>`;
  }).join("");
  explorer.querySelectorAll<HTMLElement>(".ex-section").forEach((sec) => {
    const closed = explorerState.closedSections.includes(sec.dataset.section!);
    sec.classList.toggle("closed", closed);
    sec.querySelector(".ex-sec-head")!.setAttribute("aria-expanded", String(!closed));
  });
  refreshDock();
}

explorer.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const toggleIn = (list: string[], v: string) => {
    const i = list.indexOf(v);
    if (i >= 0) list.splice(i, 1);
    else list.push(v);
    saveExplorer();
    renderExplorer();
  };
  const sec = t.closest<HTMLElement>(".ex-sec-head");
  if (sec) return toggleIn(explorerState.closedSections, sec.closest<HTMLElement>(".ex-section")!.dataset.section!);
  const folder = t.closest<HTMLElement>(".ex-folder");
  if (folder) return toggleIn(explorerState.closedFolders, folder.dataset.folder!);
  if (t.closest(".ex-fold-all")) {
    explorerState.closedFolders = EXPLORER.flatMap((x) => ("folder" in x ? [x.folder] : []));
    saveExplorer();
    return renderExplorer();
  }
  const close = t.closest<HTMLElement>(".ex-close");
  if (close) {
    FILES[Number(close.dataset.file)].win.close();
    return refreshDock();
  }
  const file = t.closest<HTMLElement>("[data-file]");
  if (file) {
    const f = FILES[Number(file.dataset.file)];
    if (f.open) f.open();
    else f.win.show();
    refreshDock();
  }
});

openList.addEventListener("keydown", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>(".ex-open");
  if (row && e.target === row && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    row.click();
  }
});

function setExplorerCollapsed(collapsed: boolean): void {
  explorerState.collapsed = collapsed;
  explorer.classList.toggle("collapsed", collapsed);
  explorer.querySelector(".ex-toggle")!.setAttribute("aria-expanded", String(!collapsed));
  saveExplorer();
  // las ventanas se corren para no quedar debajo (al final de la animación del ancho)
  window.dispatchEvent(new Event("resize"));
  setTimeout(() => window.dispatchEvent(new Event("resize")), 240);
}
explorer.querySelector(".ex-toggle")!.addEventListener("click", () => setExplorerCollapsed(!explorerState.collapsed));
explorer.querySelector(".ex-collapse")!.addEventListener("click", () => setExplorerCollapsed(true));
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
    e.preventDefault();
    setExplorerCollapsed(!explorerState.collapsed);
  }
});
explorer.classList.toggle("collapsed", explorerState.collapsed);
explorer.querySelector(".ex-toggle")!.setAttribute("aria-expanded", String(!explorerState.collapsed));

/** Estado en vivo de los archivos que corren (robots e inventario.py): punto y texto a la derecha. */
function refreshExplorerStatus(): void {
  let busy = 0;
  explorer.querySelectorAll<HTMLElement>("[data-file] .ex-status").forEach((el) => {
    const st = FILES[Number(el.closest<HTMLElement>("[data-file]")!.dataset.file)].status?.() ?? null;
    const cls = st ? `ex-status ${st[1]}` : "ex-status";
    if (el.className !== cls) el.className = cls;
    const txt = st ? st[0] : "";
    if (el.textContent !== txt) el.textContent = txt;
  });
  for (const f of FILES) if (f.status?.()?.[1] === "error") busy++;
  const badge = explorer.querySelector<HTMLElement>(".ex-badge")!;
  badge.hidden = busy === 0;
  badge.textContent = String(busy);
  badge.title = busy === 1 ? "Un archivo tiene un error" : `${busy} archivos tienen errores`;
}
setInterval(refreshExplorerStatus, 300);

const dock = $("#dock");
DOCK.forEach((d) => {
  const b = document.createElement("button");
  b.textContent = d.label;
  b.addEventListener("click", () => {
    d.win.toggle();
    refreshDock();
  });
  dock.append(b);
});
function watchWindow(w: FloatingWindow): void {
  w.el.querySelector(".win-close")!.addEventListener("click", refreshDock);
  w.el.querySelector(".win-min")!.addEventListener("click", refreshDock);
  w.el.addEventListener("pointerdown", refreshDock);
}
rebuildExplorerTree();
for (const w of [...FILES, ...DOCK].map((d) => d.win)) watchWindow(w);

/** Marca qué ventanas están abiertas: en la barra de herramientas, en el árbol y en la lista "Abiertos". */
function refreshDock(): void {
  dock.querySelectorAll("button").forEach((b, i) => b.classList.toggle("open", DOCK[i].win.isOpen));
  const isActive = (w: FloatingWindow) => w.isOpen && w.el.classList.contains("focused");
  const shown = (f: FileEntry) => f.current?.() ?? true;
  tree.querySelectorAll<HTMLElement>(".ex-file").forEach((b) => {
    const f = FILES[Number(b.dataset.file)];
    b.classList.toggle("open", f.win.isOpen && shown(f));
    b.classList.toggle("active", isActive(f.win) && shown(f));
  });
  const open = FILES.filter((f) => !f.win.el.hidden && shown(f));
  explorer.querySelector(".ex-count")!.textContent = open.length ? String(open.length) : "";
  openList.innerHTML = open.length
    ? open.map((f) => `<div class="ex-row ex-open${isActive(f.win) ? " active" : ""}${f.win.isOpen ? "" : " min"}" role="listitem" tabindex="0" data-file="${FILES.indexOf(f)}" title="${f.hint}">
        ${fileIcon(f)}<span class="ex-name">${f.label}</span><span class="ex-status"></span>
        <button class="ex-close" data-file="${FILES.indexOf(f)}" title="Cerrar" aria-label="Cerrar ${f.label}">×</button></div>`).join("")
    : `<p class="ex-empty">Ningún archivo abierto</p>`;
  refreshExplorerStatus();
}
renderExplorer();

function select(id: string): void {
  selected = id;
  codeWindows.get(id)?.win.show();
  refreshDock();
  refreshUi(true);
}

// ── velocidad ────────────────────────────────────────────────

function setSpeed(s: number): void {
  if (isGuest()) {
    void session.room?.call("speed", s);
    return;
  }
  showSpeed(s);
}
/** Marca la velocidad (también cuando la cambia el otro jugador). */
function showSpeed(s: number): void {
  speed = s;
  document.querySelectorAll<HTMLButtonElement>(".speed button").forEach((b) => b.classList.toggle("on", Number(b.dataset.speed) === s));
}
let lastSpeed = 1;
document.querySelectorAll<HTMLButtonElement>(".speed button").forEach((b) => b.addEventListener("click", () => setSpeed(Number(b.dataset.speed))));
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || (e.target as HTMLElement).closest(".cm-editor, button, input")) return;
  e.preventDefault();
  if (speed === 0) setSpeed(lastSpeed || 1);
  else {
    lastSpeed = speed;
    setSpeed(0);
  }
});

// ── HUD, ventanas de código, alertas ─────────────────────────

let lastUi = 0;

function refreshUi(force = false): void {
  const now = performance.now();
  if (!force && now - lastUi < 120) return;
  lastUi = now;

  $("#money").textContent = money(world.money);
  $("#rep").textContent = String(world.reputation);
  $("#rep-fill").style.width = `${world.reputation}%`;
  $("#rate").textContent = money(world.moneyPerMinute());
  // reloj del juego: día y hora (de día 7:00 → 19:00 en 5 minutos; de noche 19:00 → 7:00 en 10)
  const c = world.clock;
  const hh = Math.floor(c.hour);
  const mm = Math.floor((c.hour - hh) * 60 / 5) * 5;
  $("#day-label").textContent = `Día ${c.day}`;
  $("#clock").textContent = world.cycle ? `${c.phase === "day" ? "☀️" : "🌙"} ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}` : "—";
  pickMusic();

  for (const cw of codeWindows.values()) refreshCodeWindow(cw);
  renderAlerts();
}

/** "×1,4" (más rápido) o "×0,6" (más lento): la velocidad es lo inverso del factor de duración. */
const speedText = (factor: number) => (1 / factor).toLocaleString("es-CO", { maximumFractionDigits: 1, minimumFractionDigits: 1 });

/** Tamaño del código actual de un robot (lo que tendría al ejecutar). Se recalcula solo si cambió el texto. */
const sizeCache = new Map<string, { key: string; size: CodeSize | null }>();
function codeSizeOf(id: string): CodeSize | null {
  const key = `${scripts[id]}\u0000${scripts.shared}`;
  const hit = sizeCache.get(id);
  if (hit?.key === key) return hit.size;
  const size = measureCode(scripts[id] ?? "", scripts.shared);
  sizeCache.set(id, { key, size });
  return size;
}

function refreshCodeWindow(cw: CodeWindow): void {
  if (cw.id === "shared") {
    const anyRunning = world.robots.some((r) => world.isRunning(r.id));
  cw.pauseBtn.disabled = true;
  cw.stepBtn.disabled = true;
    cw.stopBtn.disabled = !anyRunning;
    cw.status.textContent = "Se aplica al ejecutar los robots";
    renderConsole(cw, null);
    return;
  }
  const robot = world.robot(cw.id);
  const vm = robot.vm;
  const s = vm?.status;
  const paused = s === "paused";
  const running = s === "running" || s === "waiting";
  const alive = running || paused;
  const [text, cls] = paused ? ["pausado", "paused"] : running ? ["corriendo", "running"] : s === "error" ? ["error", "error"] : s === "done" ? ["terminó", ""] : ["detenido", ""];
  cw.state.textContent = text;
  cw.state.className = `state ${cls}`;
  cw.runBtn.textContent = alive ? "↻ Reiniciar" : "▶ Ejecutar";
  cw.stopBtn.disabled = !alive;
  cw.pauseBtn.disabled = !alive;
  cw.pauseBtn.textContent = paused ? "▶ Continuar" : "⏸ Pausar";
  cw.pauseBtn.classList.toggle("hot", paused);
  const srv = world.serverOf(robot);
  const slow = serverSlowdown(srv);
  // velocidad según el tamaño del código: la que corre (fija al ejecutar) o la que tendría el texto actual
  const size = alive ? robot.code : codeSizeOf(cw.id);
  const sizeText = size ? `${size.total} instrucciones${size.shared ? ` (${size.shared} de shared)` : ""} · velocidad ×${speedText(size.factor)}` : "";
  cw.status.textContent = paused
    ? `${vm!.pauseReason === "punto" ? "punto de parada" : "pausado"} en la línea ${vm!.line}`
    : running && vm
      ? `línea ${vm.line} · ${sizeText}${slow > 1.05 ? ` · ${srv?.hostname} saturado: ${slow.toFixed(1)}× más lento` : ""}`
      : sizeText || "Ctrl+Enter para ejecutar";
  cw.status.title = "Entre menos código tenga el robot, más rápido trabaja (ver Comandos → Velocidad).";
  cw.status.classList.toggle("slow", running && slow > 1.05);

  if (paused) cw.editor.setMarks(null, null, vm!.line);
  else if (vm && vm.file === "main" && running) cw.editor.setMarks(vm.line, null);
  else if (vm?.status === "error" && (vm.error?.file ?? "main") === "main") cw.editor.setMarks(null, vm.error!.line);
  else cw.editor.setMarks(null, null);

  if (cw.pane === "console") renderConsole(cw, robot.console);
  else renderVars(cw);
}

function renderVars(cw: CodeWindow): void {
  const vm = world.robot(cw.id).vm;
  const alive = vm && (vm.status === "running" || vm.status === "waiting" || vm.status === "paused");
  const vars = alive ? vm.inspect() : [];
  const key = alive ? `${vm.status}:${vm.line}:` + vars.map((v) => `${v.scope}${v.name}=${v.value}`).join("|") : "none";
  if (key === cw.varsKey) return;
  cw.varsKey = key;
  if (!alive) {
    cw.vars.innerHTML = `<p class="vars-empty">Ejecuta el robot (o usa ⤵ Paso) para ver sus variables.</p>`;
    return;
  }
  if (vars.length === 0) {
    cw.vars.innerHTML = `<p class="vars-empty">Todavía no hay variables.</p>`;
    return;
  }
  cw.vars.innerHTML = `<table><thead><tr><th>Variable</th><th>Valor</th><th>Tipo</th></tr></thead><tbody>${vars
    .map((v) => `<tr class="${v.scope}"><td>${escapeHtml(v.name)}${v.scope === "local" ? ' <span class="tag">local</span>' : ""}</td><td>${escapeHtml(v.value)}</td><td>${v.type}</td></tr>`)
    .join("")}</tbody></table>`;
}

function renderConsole(cw: CodeWindow, lines: ConsoleLine[] | null): void {
  const box = cw.console;
  const key = lines ? `${lines.length}:${lines.at(-1)?.tick ?? 0}` : "shared";
  if (key === cw.consoleKey) return;
  cw.consoleKey = key;
  if (!lines) {
    box.innerHTML = `<div class="line empty">shared.py no se ejecuta solo: los robots lo usan con import shared.</div>`;
    return;
  }
  if (lines.length === 0) {
    box.innerHTML = `<div class="line empty">Consola vacía. Usa print() para ver qué está pasando.</div>`;
    return;
  }
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
  box.innerHTML = lines.slice(-80).map((l) => `<div class="line ${l.kind}">${escapeHtml(l.text)}</div>`).join("");
  if (atBottom) box.scrollTop = box.scrollHeight;
}

const ARTICLES: Record<string, [string, boolean]> = {
  pan: ["el", false], leche: ["la", false], huevos: ["los", true], chocolate: ["el", false], queso: ["el", false], miel: ["la", false], aceite: ["el", false], vino: ["el", false],
};

function renderAlerts(): void {
  const items: { text: string; ok?: boolean }[] = [];
  for (const p of PRODUCT_NAMES) {
    const [art, plural] = ARTICLES[p] ?? ["el", false];
    const stock = world.shelfStock(p);
    const basic = PRODUCTS[p].basic;
    // lo premium solo avisa si la tienda lo vende (tiene estante)
    if (!basic && !world.shelves.some((s) => s.product === p)) continue;
    if (!world.shelves.some((s) => s.product === p)) items.push({ text: `Ningún estante tiene ${p}` });
    else if (stock === 0) items.push({ text: `${plural ? "Se acabaron" : "Se acabó"} ${art} ${p}` });
    else if (stock <= 2) items.push({ text: `${plural ? "Quedan pocos" : art === "la" ? "Queda poca" : "Queda poco"} ${p} (${stock})` });
    // antes de abrir (la mercancía todavía no está registrada) no se avisa que el almacén está vacío
    if (world.warehouseStock[p] === 0 && world.cycle) items.push({ text: basic ? `No hay ${p} en el almacén: el proveedor cobra` : `No hay ${p} en el almacén: pídelo a ${SUPPLIER.name}` });
  }
  if (world.queue.length >= 3) items.push({ text: `Hay ${world.queue.length} clientes en la cola` });
  const left = world.dayTicksLeft;
  if (left <= 30 * TICKS_PER_SECOND) items.unshift({ text: `La tienda cierra en ${Math.ceil(left / TICKS_PER_SECOND)} s` });
  for (const srv of world.servers) {
    if (srv.ddos) items.unshift({ text: `Tráfico anormal en ${srv.hostname}: la red está saturada` });
    if (srv.malware && srv.malware.respawnAt === null) items.unshift({ text: `Algo raro usa la CPU de ${srv.hostname} (mira top)` });
    if (srv.temp > 85) items.unshift({ text: `${srv.hostname} está muy caliente (${Math.round(srv.temp)} °C): va más lento` });
    if (!srv.online) items.unshift({ text: `El servidor ${srv.hostname} está apagado` });
    else if (srv.load >= 0.8) items.unshift({ text: `${srv.hostname} al ${Math.round(srv.load * 100)}% de CPU: los robots van más lento` });
  }
  const openCases = world.security.openCases().length;
  if (openCases) items.push({ text: `${openCases} caso${openCases === 1 ? "" : "s"} abierto${openCases === 1 ? "" : "s"} en la página de denuncias` });
  for (const r of world.robots) {
    if (!r.cpu.server) items.push({ text: `${r.name} no está conectado a ningún servidor` });
    else if (r.vm?.status === "error") items.push({ text: `${r.name} se detuvo por un error` });
    else if (!world.isRunning(r.id)) items.push({ text: `${r.name} no está ejecutando código` });
  }
  if (items.length === 0) items.push({ text: "Todo en orden", ok: true });
  const html = items.slice(0, 5).map((i) => `<li class="${i.ok ? "ok" : ""}">${escapeHtml(i.text)}</li>`).join("");
  const el = $("#alerts");
  if (el.innerHTML !== html) el.innerHTML = html;
}

// ── tiquetes ─────────────────────────────────────────────────

const RESULT: Record<Ticket["result"], [string, string]> = {
  ok: ["Cuentas claras 😊", "ok"],
  cobro_de_mas: ["Le cobraste de más 😡", "bad"],
  cobro_de_menos: ["La tienda perdió plata 😅", "meh"],
  sin_cobrar: ["Se fue sin pagar", "bad"],
};

function ticketHtml(t: Ticket): string {
  const [label, cls] = RESULT[t.result];
  const lost = t.result === "cobro_de_menos" ? ` (${money(t.total - (t.paid - t.change))})` : "";
  return `
    <div class="t-head">${t.test ? "🧪 PRUEBA · no cuenta" : `LA ESQUINA · cliente ${t.customerId}`}</div>
    ${t.items.map((i) => `<div class="row"><span>${i.product}</span><span>${money(i.price)}</span></div>`).join("")}
    <div class="sep"></div>
    <div class="row"><span>Total</span><span>${money(t.total)}</span></div>
    <div class="row"><span>Cobrado</span><span>${t.charged === null ? "—" : money(t.charged)}</span></div>
    <div class="row"><span>Pagó</span><span>${money(t.paid)}</span></div>
    <div class="row"><span>Devuelta</span><span>${money(t.change)}</span></div>
    <div class="res ${cls}">${label}${lost}</div>`;
}

function addTicket(t: Ticket): void {
  const list = $(".ticket-list", ticketsWin.body);
  list.querySelector(".empty-note")?.remove();
  const el = document.createElement("article");
  el.className = `ticket nuevo${t.test ? " test" : ""}`;
  el.innerHTML = ticketHtml(t);
  list.prepend(el);
  while (list.children.length > 30) list.lastElementChild!.remove();

  // aviso breve en la esquina (si la ventana de tiquetes está cerrada)
  if (ticketsWin.isOpen) return;
  const toasts = $("#toasts");
  const toast = document.createElement("article");
  toast.className = `ticket${t.test ? " test" : ""}`;
  toast.innerHTML = ticketHtml(t);
  toasts.prepend(toast);
  while (toasts.children.length > 2) toasts.lastElementChild!.remove();
  setTimeout(() => toast.remove(), 4100);
}

const audio = new AudioEngine();

function onEvents(events: SimEvent[]): void {
  if (hostSync) hostSync.queue(events);
  for (const e of events) {
    if (hostSync && (e.type === "closed" || e.type === "opened")) void saveOnline();
    if (e.type === "ticket") addTicket(e.ticket);
    else if (e.type === "hired") onHired(e.robotId);
    else if (e.type === "renamed") onRenamed(e.robotId);
    else if (e.type === "sound") audio.play(e.name);
    else if (e.type === "record" && !isGuest()) db.ingest([e.record]);
    else if (e.type === "robot" && e.status === "paused") onRobotPaused(e.robotId);
    else if (e.type === "warehouse" && !isGuest()) warehouseTake(e.product, e.quantity);
    else if (e.type === "closed") showNight(e.summary);
    else if (e.type === "security") {
      toast(e.text, e.tone);
      audio.cue(e.tone === "bad" ? "ui-back" : "check");
    } else if (e.type === "delivery") {
      toast(`🚚 Llegó tu pedido de TecnoMercado (${e.items.length} producto${e.items.length === 1 ? "" : "s"}). Las piezas están en el almacén: móntalas en el rack.`, "good");
    } else if (e.type === "goods") {
      stockAtArrival.set(e.order.file!, { ...world.warehouseStock });
      renderExplorer();
      const cases = e.order.lines.reduce((n, l) => n + l.cases, 0);
      toast(`🚚 Llegó el repartidor de ${SUPPLIER.name} con ${cases} caja${cases === 1 ? "" : "s"} y te dejó ${e.order.file}. La mercancía entra al almacén cuando la migres a tu inventario (pandas + cursor.execute).`, "good");
      audio.cue("check");
      openSheet(e.order.file!);
      void syncWarehouse();
    } else if (e.type === "server") {
      if (e.what === "encendido" || e.what === "instalado") renderExplorer();
      void serverMissionCheck();
    }
    else if (e.type === "opened") {
      nightPanel?.opened(e.reason, e.day);
      nightPanel = null;
      progress.prepDone = true; // la primera noche (la preparación) ya pasó: al recargar, abre de día
      saveProgress();
    }
  }
}

// ── controles de sonido ──────────────────────────────────────

const soundBtn = $("#sound-btn") as HTMLButtonElement;
const soundPanel = $("#sound-panel");
const musicIn = $("#vol-music") as HTMLInputElement;
const sfxIn = $("#vol-sfx") as HTMLInputElement;
const muteIn = $("#mute") as HTMLInputElement;
function renderSound(): void {
  musicIn.value = String(Math.round(audio.settings.music * 100));
  sfxIn.value = String(Math.round(audio.settings.sfx * 100));
  muteIn.checked = audio.settings.muted;
  soundBtn.textContent = audio.settings.muted ? "🔇" : "🔊";
  soundBtn.title = audio.settings.muted ? "Sonido apagado" : "Sonido";
}
soundBtn.addEventListener("click", () => (soundPanel.hidden = !soundPanel.hidden));
musicIn.addEventListener("input", () => audio.set({ music: Number(musicIn.value) / 100 }));
sfxIn.addEventListener("input", () => {
  audio.set({ sfx: Number(sfxIn.value) / 100 });
  audio.play("scan");
});
muteIn.addEventListener("change", () => {
  audio.set({ muted: muteIn.checked });
  renderSound();
});
document.addEventListener("pointerdown", (e) => {
  if (!(e.target as HTMLElement).closest(".sound")) soundPanel.hidden = true;
});
renderSound();

// ── mejoras y comandos ───────────────────────────────────

// ── colocar estantes y cajas comprados ──
const placeHint = document.createElement("div");
placeHint.className = "place-hint";
placeHint.hidden = true;
document.body.append(placeHint);
let placingKind: PlaceKind = "shelf";
placeHint.addEventListener("click", (e) => {
  if (!(e.target as HTMLElement).closest("button")) return;
  store.stopPlacement();
  endPlacement(placingKind);
});

const pendingOf = (kind: PlaceKind) => (kind === "shelf" ? world.shelvesToPlace : world.registersToPlace);

function renderPlaceHint(kind: PlaceKind, problem?: string): void {
  const n = pendingOf(kind);
  const what = kind === "shelf" ? "el estante" : "la caja";
  const help = kind === "shelf"
    ? "Clic en una casilla verde. Esc o clic derecho para dejarlo para después."
    : "La fila se hace hacia el este. Llega con su robot cajero. Esc o clic derecho: después.";
  placeHint.innerHTML = `<div><b>Elige dónde va ${what}${n > 1 ? ` (quedan ${n})` : ""}</b>
      <span>${problem ? `No se puede ahí: ${problem}.` : help}</span></div>
    <button>Después</button>`;
  placeHint.classList.toggle("bad", !!problem);
}

function startPlacement(kind: PlaceKind): void {
  if (pendingOf(kind) <= 0) return;
  placingKind = kind;
  upgradesWin.close(); // que se vea la tienda
  renderPlaceHint(kind);
  placeHint.hidden = false;
  store.startPlacement(kind);
}

function endPlacement(kind: PlaceKind): void {
  placeHint.hidden = true;
  upgrades.update(true);
  const n = pendingOf(kind);
  if (n > 0) toast(`Te ${n === 1 ? "queda" : "quedan"} ${n} ${kind === "shelf" ? "estante" : "caja"}${n === 1 ? "" : "s"} por colocar: hazlo cuando quieras desde Mejoras.`, "info");
}

function placeAt(kind: PlaceKind, x: number, y: number): string | null {
  const r = kind === "shelf" ? world.placeShelf(x, y) : world.placeRegister(x, y);
  if (!r.ok) {
    audio.play("error");
    renderPlaceHint(kind, r.reason);
    return r.reason;
  }
  refreshUi(true);
  if (pendingOf(kind) > 0) renderPlaceHint(kind);
  else {
    placeHint.hidden = true;
    toast(kind === "shelf" ? `Estante nuevo en (${x}, ${y}). Sale en get_shelves().` : `Caja nueva en (${x}, ${y}) con su cajero. Escríbele el código.`, "good");
  }
  return null;
}

/** Clic en una caja: la activa o la desactiva. */
function toggleRegister(id: number): void {
  const reg = world.registers.find((r) => r.id === id);
  if (!reg) return;
  world.setRegisterActive(id, !reg.active);
  audio.play(reg.active ? "open" : "close");
  toast(reg.active ? `Caja ${id} activa: recibe clientes.` : `Caja ${id} inactiva: no recibe clientes${world.registers.some((r) => r.active) ? "; su fila pasa a otra caja" : ". ¡No queda ninguna caja abierta!"}.`, reg.active ? "good" : "info");
}

/** Llegó un robot comprado: su ventana de código y su archivo en el explorador. */
function onHired(robotId: string): void {
  const r = world.robot(robotId);
  scripts[r.id] ??= hiredScript(r);
  world.setScript(r.id, scripts[r.id]);
  if (!codeWindows.has(r.id)) {
    const n = codeWindows.size;
    makeCodeWindow(r.id, r.name, r.color, { x: 40 + n * 26, y: 90 + n * 22, w: codeW, h: codeH });
  }
  const collab = session.collab;
  if (collab) {
    if (!isGuest()) collab.seed(r.id, scripts[r.id]);
    codeWindows.get(r.id)!.editor.attachCollab(collab.text(r.id), collab.awareness);
  }
  codeWindows.get(r.id)!.win.show();
  rebuildExplorerTree();
  renderExplorer();
  // los jugadores le ponen nombre (en línea, los dos lo ven y cualquiera confirma)
  void nameNewRobot(session.room, { id: r.id, role: r.role, name: r.name, color: r.color }).then((name) => {
    if (name !== world.robot(r.id).name) world.renameRobot(r.id, name);
    onRenamed(r.id);
    toast(`Llegó ${name}. Su código está en ${name.toLowerCase()}.py.`, "good");
  });
}

/** Le cambiaron el nombre a un robot: título de su ventana y su archivo en el explorador. */
function onRenamed(robotId: string): void {
  const cw = codeWindows.get(robotId);
  const name = nm(robotId);
  if (cw) {
    const title = [...cw.win.titleEl.childNodes].find((n) => n.nodeType === Node.TEXT_NODE);
    if (title) title.textContent = name;
    cw.win.el.setAttribute("aria-label", name);
  }
  rebuildExplorerTree();
  renderExplorer();
}

const upgrades = new UpgradesWindow(
  upgradesWin,
  () => world,
  (def) => {
    refreshUi(true);
    if (def.lot !== undefined) toast(`¡${def.label}! La tienda ahora mide ${world.openWidth} casillas de ancho.`, "good");
    else if (def.racks) toast(`Ahora caben ${world.rackCapacity} racks en la sala. El gabinete se compra en TecnoMercado.`, "good");
    else if (!def.shelves && !def.registers && !def.stockers) toast(`Compraste ${def.label}.`, "good");
    if (def.shelves) startPlacement("shelf");
    else if (def.registers) startPlacement("register");
  },
  (kind) => startPlacement(kind),
);
setInterval(() => upgradesWin.isOpen && upgrades.update(), 500);

const commands = new CommandsWindow(helpWin, () => world);
helpWin.body.addEventListener("click", (e) => {
  if (!(e.target as HTMLElement).closest(".replay-intro")) return;
  try {
    localStorage.removeItem("cdb.progress.v1");
  } catch {
    /* sin almacenamiento */
  }
  location.reload();
});

// ── juego ────────────────────────────────────────────────────

refreshUi(true);

let lastRealMs = performance.now();
const gameEl = $("#game");
const store = new Store3D(gameEl, {
  world: () => world,
  selected: () => selected,
  onSelect: (id: string) => select(id),
  onEvents,
  /** Parte izquierda de la pantalla tapada por las ventanas de código: la tienda se centra en el resto. */
  leftInset: () => {
    // el explorador de archivos también tapa la izquierda
    let right = leftInset() - 6;
    for (const win of [...[...codeWindows.values()].map((cw) => cw.win), scriptWin]) {
      if (win.isOpen && win.el.offsetLeft < window.innerWidth / 2) right = Math.max(right, win.el.offsetLeft + win.el.offsetWidth);
    }
    return right;
  },
  onCue: (cue: string) => audio.cue(cue),
  onRack: (slot: number) => void onRack(slot),
  onPlace: (kind: PlaceKind, x: number, y: number) => placeAt(kind, x, y),
  onPlaceCancel: (kind: PlaceKind) => endPlacement(kind),
  onRegister: (id: number) => toggleRegister(id),
  advance: (delta: number) => {
    const now = performance.now();
    if (isGuest()) {
      // el espejo no simula: muestra lo último que mandó el anfitrión
      lastRealMs = now;
      if (world.night && !nightPanel && progress.storeOpen) showNight(null);
      if (world.night) nightPanel?.update(world.night.remainingMs, [...world.night.votes]);
      refreshScript();
      refreshUi();
      return Math.min(1, (now - (guestSync?.lastViewAt ?? now)) / TICK_MS);
    }
    // la noche cuenta tiempo real: no se detiene con la pausa ni va más rápido con 4×
    world.updateNight(now - lastRealMs);
    lastRealMs = now;
    if (world.night) nightPanel?.update(world.night.remainingMs, [...world.night.votes]);
    tickScript();
    refreshScript();
    acc += Math.min(delta, 250) * speed;
    let steps = 0;
    while (acc >= TICK_MS && steps < 40) {
      world.step();
      acc -= TICK_MS;
      steps++;
    }
    if (steps === 40) acc = 0;
    refreshUi();
    return acc / TICK_MS;
  },
});

// ── la barra superior puede ocupar una o dos filas ──
const letrero = $(".letrero");
function syncTopInset(): void {
  document.documentElement.style.setProperty("--top-inset", `${topInset()}px`);
  window.dispatchEvent(new Event("resize")); // las ventanas se vuelven a acomodar debajo de la barra
}
new ResizeObserver(() => syncTopInset()).observe(letrero);
syncTopInset();

// ── progreso: intro, misión del inventario y apertura de la tienda ──

const PROGRESS_KEY = "cdb.progress.v1";
const progress: { storeOpen: boolean; prepDone: boolean } = (() => {
  try {
    return { storeOpen: false, prepDone: false, ...JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? "{}") };
  } catch {
    return { storeOpen: false, prepDone: false };
  }
})();
function saveProgress(): void {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  } catch {
    /* sin almacenamiento */
  }
}

const robotWindows = () => [...codeWindows.values()].map((cw) => cw.win);

/** Pantalla de inicio: el clic del jugador desbloquea el audio para la intro. */
const WELCOME_LETTER = () => `Queridos muchachos:

Les dejo mi tiendita, La Esquina. Los muchachos del barrio ya no quieren trabajar aquí, pero en el sótano hay dos robots viejos, ${nm("tono")} y ${nm("lupe")}. Ustedes saben de computadores, ¿no?

Hoy llega el primer pedido de Distribuidora El Surtidor. Recíbanlo bien y lleven las cuentas en orden, que yo siempre lo anoté todo en mi cuaderno.`;

const MISSION_STEPS = `<ol class="gm-steps">
  <li><strong>Revisa la hoja del distribuidor</strong> (entrega_distribuidor.xlsx). Ojo: no es muy ordenado.</li>
  <li><strong>Diseña tu base de datos</strong> en la ventana Base de datos: crea tus tablas con <code>CREATE TABLE</code>.</li>
  <li><strong>En inventario.py</strong>, lee la hoja con <code>pd.read_excel(...)</code> y <code>hoja.select("A1", "G6")</code>, límpiala con Python y sube cada fila con <code>cursor.execute("INSERT ...")</code>.</li>
</ol>`;

let mission: ObjectivesPanel | null = null;
let boxesUnloaded = false;

let missionTimer: number | null = null;

async function missionCheck(): Promise<void> {
  const panel = mission;
  if (!panel || !db.ready) return;
  const st = await db.inventoryStatus(DELIVERY_PRODUCTS);
  if (mission !== panel) return; // la tienda se abrió mientras se revisaba
  const counts = st.best?.counts ?? {};
  const all = DELIVERY_PRODUCTS.every((p) => (counts[p] ?? 0) > 0);
  const clean = all && DELIVERY_PRODUCTS.every((p) => counts[p] === 1) && !st.best!.hasTotalRow;
  if (all) scriptRun.usedReadExcel = true;
  const items = [
    { label: "Lee la hoja con pandas: <code>pd.read_excel(...)</code>", done: scriptRun.usedReadExcel },
    { label: "Crea tus tablas con <code>CREATE TABLE</code>", done: st.tables.length > 0 },
    { label: "Sube pan, leche y huevos con <code>cursor.execute(\"INSERT ...\")</code>", done: all },
    { label: "Sin productos repetidos ni la fila TOTAL", done: clean },
  ];
  let hint: string | null = null;
  if (all && st.best) {
    const dup = DELIVERY_PRODUCTS.filter((p) => counts[p] > 1);
    if (dup.length) hint = `En <code>${st.best.table}</code> hay productos repetidos (${dup.join(", ")}): el distribuidor anotó algo dos veces. Pista: antes del INSERT, guarda en una lista los nombres que ya subiste y salta los que estén. Para volver a subir: <code>DELETE FROM ${st.best.table};</code>`;
    else if (st.best.hasTotalRow) hint = `Subiste la fila <strong>TOTAL</strong> de la hoja a <code>${st.best.table}</code>, pero no es un producto. Pista: sáltala con un <code>if</code> (o elige un rango que no la incluya).`;
  } else if (st.tables.length > 0 && !all) {
    hint = st.best ? `Tu tabla <code>${st.best.table}</code> todavía no tiene los tres productos.` : "Ya tienes tablas. Ahora sube los datos de la hoja con <code>cursor.execute(\"INSERT ...\")</code>.";
  }
  const newly = panel.update(items, hint);
  if (newly.length) audio.cue("check");
  if (clean && !boxesUnloaded) {
    boxesUnloaded = true;
    store.unloadBoxes();
  }
}

/**
 * "Saltar" en la misión de inventario: si el jugador todavía no tiene un inventario limpio, se crea por él la tabla
 * `inventario` con la hoja ya limpia (sin repetidos ni TOTAL), para que el almacén tenga mercancía. Luego sigue a la
 * primera noche como si hubiera terminado la misión.
 */
async function skipMission(): Promise<void> {
  if (!isGuest()) await fillInventory();
  if (!boxesUnloaded) {
    boxesUnloaded = true;
    store.unloadBoxes();
  }
  await openStore(true);
}

/** Crea la tabla `inventario` limpia si el jugador todavía no tiene una (la usa "Saltar"). */
async function fillInventory(): Promise<void> {
  try {
    const st = await db.inventoryStatus(DELIVERY_PRODUCTS);
    const counts = st.best?.counts ?? {};
    const clean = DELIVERY_PRODUCTS.every((p) => counts[p] === 1) && !st.best?.hasTotalRow;
    if (!clean) {
      let table = "inventario";
      for (let n = 2; st.tables.includes(table); n++) table = `inventario_${n}`;
      const seen = new Set<string>();
      const values: string[] = [];
      const lit = (v: string | number | null) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`);
      for (const r of DELIVERY.sheets[0].rows) {
        const name = String(r[1] ?? "").trim().toLowerCase();
        if (!DELIVERY_PRODUCTS.includes(name) || seen.has(name)) continue;
        seen.add(name);
        values.push(`(${[r[0], name, r[2], r[3], r[4], r[5], r[6]].map(lit).join(", ")})`);
      }
      // si el jugador ya tenía una tabla con los productos (sucia), se vacía para que el almacén lea la nueva
      if (st.best) await db.run(`DELETE FROM "${st.best.table.replace(/"/g, '""')}"`);
      const res = await db.run(
        `CREATE TABLE ${table} (codigo TEXT PRIMARY KEY, nombre TEXT NOT NULL UNIQUE, categoria TEXT, cantidad INT NOT NULL, precio INT NOT NULL, costo INT NOT NULL, vence DATE);
         INSERT INTO ${table} VALUES ${values.join(", ")};`,
      );
      if (!res.ok) console.warn("Saltar: no se pudo crear el inventario", res.message);
      await sqlWin.init();
    }
  } catch (err) {
    console.warn("Saltar: la base de datos no respondió", err);
  }
}

// ── historia compartida: en línea, "Continuar", "Saltar" y los botones de las misiones avanzan a los dos ──

/** Ventanas ya cerradas (por cualquiera) y pasos ya hechos: si llegan tarde, no se vuelven a mostrar ni a correr. */
const closedModals = new Set<string>();
const openModals = new Map<string, () => void>();
const flowsDone = new Set<string>();
let introBox: { skip: () => void } | null = null;

/** Una ventana de la historia: si cualquiera presiona Continuar, se cierra para los dos. */
function sharedModal(o: ModalOptions): Promise<void> {
  const key = `modal:${o.title}`;
  if (closedModals.has(key)) return Promise.resolve();
  return showModal({
    ...o,
    register: (close) => openModals.set(key, close),
    onClose: (byUser) => {
      openModals.delete(key);
      closedModals.add(key);
      if (byUser) session.room?.send("flow", { k: key });
    },
  });
}

/** Pasos de la historia que dispara un jugador y hacen los dos. */
const FLOWS: Record<string, () => void> = {
  "intro-skip": () => {
    if (introBox) introBox.skip();
    else store.skipIntro();
  },
  openStore: () => void openStore(true),
  skipMission: () => void skipMission(),
  finishServer: () => void finishServerMission(),
  skipServer: () => {
    const s = isGuest() ? null : world.skipServerTutorial();
    renderExplorer();
    store.unloadBoxes();
    void finishServerMission(s?.id);
  },
};

/** Este jugador hizo algo de la historia: se lo cuenta al otro y lo hace. */
function trigger(k: string): void {
  if (flowsDone.has(k)) return;
  flowsDone.add(k);
  session.room?.send("flow", { k });
  FLOWS[k]?.();
}

/** Llegó un paso de la historia del otro jugador. */
function onRemoteFlow(k: string): void {
  if (k.startsWith("modal:")) {
    closedModals.add(k);
    openModals.get(k)?.();
    return;
  }
  if (flowsDone.has(k)) return;
  flowsDone.add(k);
  FLOWS[k]?.();
}

async function runIntro(): Promise<void> {
  document.body.classList.add("cinematic");
  world.customersEnabled = false;
  for (const w of [...robotWindows(), scriptWin, sheetWin, dbWin, ticketsWin, upgradesWin, helpWin]) w.close();
  const lb = showLetterbox(() => {
    if (!flowsDone.has("intro-skip")) trigger("intro-skip");
    else store.skipIntro();
  });
  introBox = { skip: () => store.skipIntro() };
  await store.playIntro();
  introBox = null;
  lb.hide();
  await sharedModal({ kicker: "Una carta para ustedes", title: "¡Bienvenidos a La Esquina!", letter: WELCOME_LETTER(), signature: "— La abuela", button: "Continuar ▸", step: 0, steps: 2, onOpen: () => audio.cue("welcome") });
  await sharedModal({ kicker: "Primera tarea", title: "Organiza tu inventario", letter: "El camión dejó la mercancía y la hoja de entrega. Antes de abrir la tienda hay que registrar todo en tu base de datos: tú decides cómo se llaman las tablas y qué columnas tienen.", html: MISSION_STEPS, button: "¡Manos a la obra! ▸", step: 1, steps: 2, onOpen: () => audio.cue("check") });
  document.body.classList.remove("cinematic");
  startMission();
}

function startMission(): void {
  // inventario.py a la izquierda; la hoja y la base de datos al centro; la misión a la derecha
  const x0 = leftInset();
  const W = window.innerWidth - x0;
  const Hh = window.innerHeight;
  const left = Math.round(Math.min(620, Math.max(400, W * 0.36)));
  const midX = x0 + left + 14;
  const midW = Math.max(380, window.innerWidth - midX - 370);
  const sheetH = Math.round((Hh - 90) * 0.42);
  const top = topInset();
  const sheetH2 = Math.round((Hh - top - 20) * 0.42);
  scriptWin.setBox(x0, top, left, Hh - top - 14);
  sheetWin.setBox(midX, top, midW, sheetH2);
  dbWin.setBox(midX, top + sheetH2 + 10, midW, Hh - top - sheetH2 - 24);
  void sheetH;
  scriptWin.show();
  sheetWin.show();
  dbWin.show();
  refreshDock();
  mission = new ObjectivesPanel("Organiza tu inventario", () => trigger("openStore"), () => trigger("skipMission"));
  void missionCheck();
  missionTimer = window.setInterval(() => void missionCheck(), 1500);
}

const FIRST_NIGHT_STEPS = () => `<ol class="gm-steps">
  <li><strong>${escapeHtml(nm("tono"))} surte los estantes.</strong> Va al almacén (el cuarto de la izquierda), toma productos con <code>pick("leche")</code> y los pone en un estante con <code>place()</code>. Cada estante tiene un solo producto: el primero que pongan ahí decide cuál. ¡Ustedes eligen cómo repartirlos!</li>
  <li><strong>${escapeHtml(nm("lupe"))} atiende la caja.</strong> Escanea el carrito, cobra y da la devuelta.</li>
  <li><strong>Sus robots corren en el servidor srv-01</strong>, que tiene un solo núcleo. Si un bucle pregunta sin parar y sin <code>wait()</code>, satura la CPU y <em>los dos</em> robots se vuelven lentos.</li>
  <li><strong>¿Terminaron antes?</strong> Voten los dos <em>¡Listo!</em> para abrir ya. Si se acaba el tiempo, amanece, la tienda abre igual y los clientes empiezan a llegar.</li>
  <li><strong>Cada día dura 5 minutos</strong> (de 7:00 a 19:00) y cada noche 10 (esta primera, 20). Cada día vienen más clientes: usen las noches para mejorar el código.</li>
</ol>`;

const PLAYERS: Record<(typeof NIGHT.players)[number], string> = { j1: "Jugador 1", j2: "Jugador 2" };
/** En línea: j1 es el anfitrión y j2 el otro jugador (con sus nombres). */
function playerLabel(id: (typeof NIGHT.players)[number]): string {
  const room = session.room;
  if (!room) return PLAYERS[id];
  const sorted = [...room.peers].sort((a, b) => a.joinedAt - b.joinedAt);
  return sorted[id === "j1" ? 0 : 1]?.name ?? PLAYERS[id];
}
/** ¿Este botón de voto es el mío? (solo en línea y con los dos conectados; si no, se pueden usar los dos) */
function myVote(id: (typeof NIGHT.players)[number]): boolean {
  const room = session.room;
  if (!room || room.peers.length < 2) return true;
  return (id === "j1") === room.isHost;
}
let nightPanel: NightPanel | null = null;

/** Panel de la noche (la sim ya empezó la noche): cuenta regresiva, votos y el resumen del día que terminó. */
function showNight(report: typeof world.lastDay): void {
  lastRealMs = performance.now();
  nightPanel?.el.remove();
  nightPanel = new NightPanel(
    NIGHT.players.map((id) => ({ id, label: playerLabel(id), mine: myVote(id) })),
    { day: world.day, totalMs: world.night?.totalMs ?? NIGHT.ms, report },
    (player, ready) => world.vote(player as (typeof NIGHT.players)[number], ready),
  );
  if (report) {
    const bad = report.sales - report.ok;
    toast(`Cerró el día ${report.day}: ${report.sales} ventas, ${money(report.revenue)}${report.lost ? `, ${report.lost} se fueron sin comprar` : ""}${bad ? `, ${bad} cobros mal` : ""}. Abren a las 7:00.`, "info");
  }
}

/** La primera noche: veinte minutos sin clientes para escribir el código de Toño y Lupe (o hasta que voten los dos). */
function startFirstNight(): void {
  world.startNight(NIGHT.firstMs);
  showNight(null);
}

/** La música cambia según el momento: misión, mañana, tarde, noche o prisa (cola larga / a punto de cerrar). */
function pickMusic(): void {
  let song: SongName;
  if (document.body.classList.contains("menu-open")) song = "portada";
  else if (document.body.classList.contains("cinematic")) song = "mañana";
  else if (!world.cycle) song = "inventario";
  else if (world.night) song = "noche";
  else if (world.queue.length >= 4 || world.dayTicksLeft <= 30 * TICKS_PER_SECOND) song = "prisa";
  else song = world.clock.hour < 13 ? "mañana" : "tarde";
  audio.setMusic(song);
}

// ── el almacén es la base de datos del jugador ──
// Las unidades del almacén salen de su tabla de inventario (la de la misión). Lo que saca Toño se descuenta de esa
// tabla, y si el jugador cambia la tabla a mano, el almacén cambia también (se relee cada 2 s).
let warehouseSrc: WarehouseSource | null = null;
/** Excel de pedidos que el jugador ya migró a su inventario (el explorador marca los demás como "nuevo"). */
const migrated = new Set<string>();
/** Unidades que había en el inventario cuando llegó cada pedido (para saber cuándo se migró). */
const stockAtArrival = new Map<string, Record<string, number>>();
/** Cola de escrituras/lecturas a la base, en orden, para que una lectura nunca pise una resta pendiente. */
let warehouseChain: Promise<unknown> = Promise.resolve();
/** Unidades sacadas en el juego que todavía no se escribieron en la base. */
const warehousePending: Record<string, number> = {};

function warehouseTake(product: ProductName, quantity: number): void {
  const src = warehouseSrc;
  if (!src) return;
  warehousePending[product] = (warehousePending[product] ?? 0) + quantity;
  warehouseChain = warehouseChain
    .then(() => db.takeFromWarehouse(src, product, quantity))
    .catch((err) => console.warn("No se pudo descontar del inventario", err))
    .finally(() => (warehousePending[product] -= quantity));
}

function syncWarehouse(): Promise<void> {
  if (isGuest() || !db.ready) return Promise.resolve();
  const next = warehouseChain.then(async () => {
    const src = await db.warehouseSource(PRODUCT_NAMES);
    if (src && !src.qtyCol && !warehouseSrc) {
      console.warn(`La tabla ${src.table} no tiene una columna de cantidad: el almacén queda vacío.`);
    }
    warehouseSrc = src;
    for (const p of PRODUCT_NAMES) {
      world.warehouseStock[p] = Math.max(0, (src?.stock[p] ?? 0) - (warehousePending[p] ?? 0));
    }
    // un Excel de pedido cuenta como migrado cuando todo lo suyo ya está en la tabla de inventario
    for (const o of world.goodsOrders) {
      if (!o.file || migrated.has(o.file)) continue;
      // (con margen: los robots pueden haber sacado algo mientras tanto)
      const before = stockAtArrival.get(o.file) ?? {};
      if (o.lines.every((l) => (src?.stock[l.product] ?? 0) - (before[l.product] ?? 0) >= l.cases * SUPPLIER.caseUnits * 0.5)) {
        migrated.add(o.file);
        toast(`✓ ${o.file} migrado: la mercancía ya está en el almacén.`, "good");
      }
    }
  });
  warehouseChain = next.catch((err) => console.warn("No se pudo leer el inventario", err));
  return warehouseChain as Promise<void>;
}

let storeOpening = false;
async function openStore(animated: boolean): Promise<void> {
  if (storeOpening) return;
  storeOpening = true;
  progress.storeOpen = true;
  saveProgress();
  mission?.remove();
  mission = null;
  if (missionTimer !== null) clearInterval(missionTimer);
  if (animated) {
    audio.cue("open");
    for (const w of [scriptWin, sheetWin, dbWin]) w.close();
    await store.flyToStore();
  }
  await Promise.race([syncWarehouse(), new Promise((r) => setTimeout(r, 15000))]); // sin base, no se traba
  if (progress.prepDone) {
    if (!serverReady()) world.skipServerTutorial();
    world.openStore();
  } else {
    startFirstNight();
    if (serverReady()) await startProgramming();
    else await startServerMission(animated);
  }
  renderExplorer();
  refreshDock();
}

// ── la primera noche: primero el servidor, después el código ──

const SERVER_STEPS = `<ol class="gm-steps">
  <li><strong>Monta el servidor.</strong> En el cuarto <em>🖥 Servidores</em> (a la izquierda de la tienda), haz clic en un puesto libre del rack. Arrastra cada pieza a su lugar y conecta los cables.</li>
  <li><strong>Instala Linux.</strong> Al encender se abre la terminal con el instalador.</li>
  <li><strong>Conecta la red y los robots.</strong> Sigue el archivo <code>LEEME.txt</code> del servidor: <code>ip addr</code>, <code>apt install robot-agent</code> y <code>robot attach</code>.</li>
</ol>`;

/** ¿Hay un servidor listo con los dos robots conectados? */
function serverReady(): boolean {
  return world.robots.every((r) => {
    const s = world.serverOf(r);
    return !!s && !!s.os && !!s.ip && s.services.has("robot-agent");
  });
}

let serverMission: ObjectivesPanel | null = null;

async function startServerMission(animated: boolean): Promise<void> {
  if (animated) {
    await sharedModal({
      kicker: "Cae la noche",
      title: "Primero, el servidor",
      letter: `La mercancía ya está en el almacén. Pero los robots no piensan solos: su código corre en un servidor, y el técnico solo dejó las piezas. Esta primera noche tienen 20 minutos: monten el servidor, conecten a ${nm("tono")} y a ${nm("lupe")}, y después a programar.`,
      html: SERVER_STEPS,
      button: "¡A montar! ▸",
      step: 0,
      steps: 1,
      onOpen: () => audio.cue("check"),
    });
  }
  serverMission = new ObjectivesPanel("Monta tu servidor", () => trigger("finishServer"), () => trigger("skipServer"), "¡A programar! ▸");
  void serverMissionCheck();
}

async function serverMissionCheck(): Promise<void> {
  const panel = serverMission;
  if (!panel) return;
  const srv = world.servers[0] ?? null;
  const attached = srv ? world.robots.filter((r) => r.cpu.server === srv.id).length : 0;
  const items = [
    { label: "Monta las piezas en el rack (clic en un puesto libre de <strong>🖥 Servidores</strong>)", done: !!srv },
    { label: "Enciéndelo e instala Linux", done: !!srv?.os },
    { label: "Configura la red: <code>ip addr add</code> e <code>ip route add</code>", done: !!srv?.ip && !!srv.gateway },
    { label: "Instala y arranca <code>robot-agent</code>", done: !!srv?.services.has("robot-agent") },
    { label: `Conecta a ${escapeHtml(nm("tono"))} y ${escapeHtml(nm("lupe"))}: <code>robot attach</code>`, done: attached === world.robots.length },
  ];
  const next = items.findIndex((i) => !i.done);
  const hints = [
    world.racks.some(Boolean) ? "Sigue montando: haz clic en el puesto del rack que empezaste." : null,
    "Escribe en la terminal lo que te pregunta el instalador (nombre, usuario y contraseña).",
    "En la terminal: <code>ip addr add 10.0.0.10/24 dev eth0</code> y <code>ip route add default via 10.0.0.1</code>",
    "<code>apt install robot-agent</code> y luego <code>systemctl enable --now robot-agent</code>",
    `<code>robot attach 10.0.0.21</code> (${escapeHtml(nm("tono"))}) y <code>robot attach 10.0.0.22</code> (${escapeHtml(nm("lupe"))})`,
  ];
  const newly = panel.update(items, next >= 0 ? hints[next] : null);
  if (newly.length) audio.cue("check");
}
setInterval(() => void serverMissionCheck(), 1000);

let serverMissionDone = false;
async function finishServerMission(serverId?: string): Promise<void> {
  if (serverMissionDone) return;
  serverMissionDone = true;
  serverMission?.remove();
  serverMission = null;
  void serverId;
  await startProgramming();
}

async function startProgramming(): Promise<void> {
  await sharedModal({
    kicker: "¡Servidor listo!",
    title: "Ahora, a programar",
    letter: `${nm("tono")} y ${nm("lupe")} ya corren en el servidor. Mañana abren a las 7:00: usen lo que queda de la noche para escribir su código.`,
    html: FIRST_NIGHT_STEPS(),
    button: "¡A programar! ▸",
    step: 0,
    steps: 1,
    onOpen: () => audio.cue("check"),
  });
  for (const w of robotWindows().slice(0, 2)) w.show();
  refreshDock();
}

// ── cuarto de servidores: clic en el rack ──

const assembly = new AssemblyView(() => world, (name) => (name === "place" ? audio.play("place") : audio.cue(name)));
let assembling = false;
(window as unknown as { assembly: AssemblyView }).assembly = assembly;

async function onRack(slot: number): Promise<void> {
  if (assembling) return;
  if (slot >= world.rackCapacity) {
    upgradesWin.show();
    toast("Ese espacio todavía no es parte de la sala. Amplíala en Mejoras → Centro de datos.", "info");
    return;
  }
  if (slot >= world.racksOwned) {
    browser.open("tienda");
    toast("Ese espacio no tiene rack. Compra un gabinete de rack (y sus piezas) en TecnoMercado: llega mañana.", "info");
    return;
  }
  const srv = world.rackServer(slot);
  if (srv && !srv.maintenance) {
    const choice = await chooseRackAction(srv);
    if (choice === "terminal") return openTerminal(srv.id);
    if (choice !== "rack") return;
    world.openCase(srv.id);
    toast(`${srv.hostname} se apagó para abrirlo: sus robots se detuvieron.`, "info");
  }
  if (!srv && !world.racks[slot] && world.parts.length === 0) {
    browser.open("tienda");
    toast("Ese puesto está libre, pero no tienes piezas. Cómpralas en TecnoMercado: llegan mañana.", "info");
    return;
  }
  session.room?.send("asm-open", { slot, name: session.room.me.name });
  await enterAssembly(slot, !!srv);
}

/**
 * Montaje en primera persona de un puesto del rack. En línea lo ven los dos: si uno lo abre, al otro también se
 * le abre, y lo que monta cualquiera aparece en vivo.
 */
async function enterAssembly(slot: number, wasServer: boolean): Promise<void> {
  assembling = true;
  document.body.classList.add("assembling");
  await store.focusRack(slot);
  const { server } = await assembly.open(slot);
  document.body.classList.remove("assembling");
  await store.flyToStore();
  assembling = false;
  renderExplorer();
  const now = world.rackServer(slot);
  if (wasServer) {
    // era un servidor al que le cambiaron piezas
    if (server) toast(`${server.hostname} volvió a encender con sus piezas nuevas. Vuelvan a ejecutar a sus robots.`, "good");
    else if (now?.maintenance) toast(`${now.hostname} sigue abierto y apagado. Clic en su rack para terminar.`, "info");
  } else {
    // recién montado: se abre su terminal para instalar Linux (también si lo encendió el otro jugador)
    const on = server ?? (now && !now.maintenance ? now : null);
    if (on) openTerminal(on.id);
  }
  void serverMissionCheck();
}

/** El montaje en línea: lo que hace uno lo ve el otro. */
function linkAssembly(room: Room): void {
  assembly.link = {
    hold: (label) => room.send("asm-hold", { label, name: room.me.name }),
    posted: (post, ok) => room.send("asm-post", { slot: assembly.openSlot, post, ok }),
  };
  room.on("asm-open", ({ slot, name }: { slot: number; name: string }) => {
    if (assembling) return;
    toast(`${name} abrió el montaje del puesto ${slot + 1}: entras con él.`, "info");
    void (async () => {
      // si abrió un servidor encendido, se espera a que de este lado ya esté apagado y abierto
      for (let i = 0; i < 30; i++) {
        const srv = world.rackServer(slot);
        if (!srv || srv.maintenance) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const srv = world.rackServer(slot);
      if (srv && !srv.maintenance) return;
      await enterAssembly(slot, !!srv);
    })();
  });
  room.on("asm-hold", ({ label, name }: { label: string | null; name: string }) => assembly.setRemote(label ? { name, label } : null));
  room.on("asm-post", ({ slot, post }: { slot: number; post: Parameters<AssemblyView["showRemotePost"]>[0] }) => {
    if (assembly.openSlot !== slot) return;
    // el servidor puede tardar un momento en aparecer en el espejo
    setTimeout(() => assembly.showRemotePost(post, post.ok ? (world.rackServer(slot) ?? null) : null), post.ok ? 600 : 0);
  });
}

/** Clic en un rack con un servidor: ¿abrir la terminal o abrir el chasis para cambiar piezas? */
function chooseRackAction(srv: { hostname: string; ip: string | null }): Promise<"terminal" | "rack" | null> {
  return new Promise((resolve) => {
    const box = document.createElement("div");
    box.className = "rack-choice";
    box.innerHTML = `<div class="rc-card" role="dialog" aria-modal="true" aria-labelledby="rc-title">
        <h2 id="rc-title">${escapeHtml(srv.hostname)}</h2>
        <p class="rc-sub">${srv.ip ? `IP ${escapeHtml(srv.ip)} · ` : ""}¿Qué quieres hacer?</p>
        <div class="rc-options">
          <button data-c="terminal"><span class="rc-ico" aria-hidden="true">&gt;_</span><b>Abrir la terminal</b><span>Comandos de Linux, red, seguridad y robots.</span></button>
          <button data-c="rack"><span class="rc-ico" aria-hidden="true">🔧</span><b>Abrir el rack</b><span>Cambiar o agregar piezas. El servidor se apaga mientras está abierto y sus robots se detienen.</span></button>
        </div>
        <button class="rc-cancel" data-c="">Cancelar</button>
      </div>`;
    const done = (c: string | null) => {
      box.remove();
      window.removeEventListener("keydown", onKey);
      resolve((c || null) as "terminal" | "rack" | null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && done(null);
    box.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-c]");
      if (b) done(b.dataset.c ?? null);
      else if (e.target === box) done(null);
    });
    window.addEventListener("keydown", onKey);
    document.body.append(box);
    box.querySelector<HTMLButtonElement>("[data-c=terminal]")!.focus();
  });
}

/** Aviso corto abajo a la derecha (ataques, entregas, montaje). */
function toast(text: string, tone: "bad" | "good" | "info"): void {
  const toasts = $("#toasts");
  const el = document.createElement("article");
  el.className = `note ${tone}`;
  el.textContent = text;
  toasts.prepend(el);
  while (toasts.children.length > 3) toasts.lastElementChild!.remove();
  setTimeout(() => el.remove(), 7000);
}

// ── partida en línea ─────────────────────────────────────────

let hostSync: HostSync | null = null;
let guestSync: GuestSync | null = null;
/** "naming" mientras le ponen nombre a los robots al crear la partida. */
let onlinePhase: "naming" | "playing" = "playing";
const knownPlayers = new Set<string>();

/** Toño y Lupe, para la pantalla de nombres. */
function startingRobots() {
  return world.robots.filter((r) => r.id === "tono" || r.id === "lupe").map((r) => ({ id: r.id, role: r.role, name: r.name, color: r.color }));
}

/** Pone los nombres elegidos (y los cambia en el código de ejemplo de cada robot). */
function applyNames(names: Record<string, string>): void {
  for (const [id, name] of Object.entries(names)) {
    const old = nm(id);
    if (!name.trim() || name.trim() === old) continue;
    world.renameRobot(id, name);
    const now = nm(id);
    for (const key of ["tono", "lupe"]) scripts[key] = scripts[key].replaceAll(old, now);
  }
  for (const key of ["tono", "lupe"]) {
    const cw = codeWindows.get(key);
    if (cw && cw.editor.text !== scripts[key]) cw.editor.view.dispatch({ changes: { from: 0, to: cw.editor.view.state.doc.length, insert: scripts[key] } });
    onRenamed(key);
  }
  saveScripts(scripts);
}

/** Lo que el anfitrión manda además del mundo: velocidad, progreso y la salida de inventario.py. */
function onlineMeta(): Record<string, unknown> {
  const vm = scriptRun.vm;
  return {
    speed, progress: { ...progress }, phase: onlinePhase, story: [...closedModals, ...flowsDone],
    script: {
      console: scriptRun.console.slice(-80),
      vm: vm ? { status: vm.status, line: vm.line, waitingAsync: vm.waitingAsync, error: vm.error ? { line: vm.error.line, text: vm.error.format() } : null } : null,
    },
  };
}

/** El espejo recibe lo extra del anfitrión. */
function applyMeta(meta: Record<string, unknown>): void {
  if (typeof meta.speed === "number" && meta.speed !== speed) showSpeed(meta.speed);
  if (meta.progress) Object.assign(progress, meta.progress);
  // lo que el anfitrión ya pasó de la historia (por si este jugador entró tarde)
  for (const k of (meta.story as string[] | undefined) ?? []) {
    if (k.startsWith("modal:")) {
      if (!closedModals.has(k)) onRemoteFlow(k);
    } else flowsDone.add(k);
  }
  const sc = meta.script as { console: ConsoleLine[]; vm: { status: string; line: number; waitingAsync: boolean; error: { line: number; text: string } | null } | null } | undefined;
  if (sc) {
    scriptRun.console = sc.console;
    scriptRun.vm = sc.vm ? ({ ...sc.vm, error: sc.vm.error ? { line: sc.vm.error.line, format: () => sc.vm!.error!.text } : null } as unknown as VM) : null;
  }
}

/** Ventanas de código para los robots que no tienen (al cargar una partida con robots comprados). */
function ensureRobotWindows(): void {
  for (const r of world.robots) {
    if (codeWindows.has(r.id)) continue;
    scripts[r.id] ??= hiredScript(r);
    const n = codeWindows.size;
    makeCodeWindow(r.id, r.name, r.color, { x: 40 + n * 26, y: 90 + n * 22, w: codeW, h: codeH }).win.close();
  }
  for (const r of world.robots) onRenamed(r.id);
}

/** Conecta cada editor a su texto compartido. El anfitrión pone el código inicial si el texto está vacío. */
function attachEditors(collab: Collab, seed: boolean): void {
  for (const [id, cw] of codeWindows) {
    if (seed) collab.seed(id, scripts[id] ?? "");
    cw.editor.attachCollab(collab.text(id), collab.awareness);
  }
  if (seed) collab.seed("inventario", scripts.inventario);
  scriptEditor.attachCollab(collab.text("inventario"), collab.awareness);
}

/** Lo que el anfitrión hace cuando se lo pide el otro jugador. */
function registerHostHandlers(room: Room): void {
  const DB_OK = new Set(["run", "tables", "inventoryStatus", "warehouseSource", "resetPlayerSchema", "playerQuery"]);
  room.handle("phase", () => onlinePhase);
  room.handle("world", ({ m, a }: { m: string; a: unknown[] }) => {
    if (!FORWARD.has(m)) throw new Error(`acción no permitida: ${m}`);
    (world as unknown as Record<string, (...x: unknown[]) => unknown>)[m](...a);
    refreshUi(true);
    return true;
  });
  room.handle("db", ({ m, a }: { m: string; a: unknown[] }) => {
    if (!DB_OK.has(m)) throw new Error(`consulta no permitida: ${m}`);
    return (db as unknown as Record<string, (...x: unknown[]) => unknown>)[m](...a);
  });
  room.handle("speed", (s: number) => showSpeed(s));
  room.handle("bp", ({ r, lines }: { r: string; lines: number[] }) => {
    const bps = world.robot(r).breakpoints;
    bps.clear();
    lines.forEach((l) => bps.add(l));
  });
  room.handle("debug", ({ op, r }: { op: string; r: string }) => (op === "step" ? stepLine(r) : togglePause(r)));
  room.handle("script", ({ op }: { op: string }) => (op === "run" ? runScript() : stopScript()));
  room.handle("term", ({ s, text, ctrl, hello }: { s: string; text?: string; ctrl?: string; hello?: boolean }) => {
    const t = terminalFor(s);
    if (hello) return { lines: t.recent.slice(-200), prompt: t.shell!.prompt(), hostname: t.shell!.server.hostname };
    if (ctrl) t.interrupt();
    else t.exec(text ?? "");
    return true;
  });
}

let saving = false;
let saveWarned = false;
/** El anfitrión guarda la partida en Supabase (mundo, código y base del jugador). */
async function saveOnline(): Promise<void> {
  const room = session.room;
  const partida = session.partida;
  if (!room || !partida || isGuest() || saving || onlinePhase !== "playing") return;
  saving = true;
  try {
    world.meta.progress = { ...progress };
    for (const p of room.peers) knownPlayers.add(p.name);
    const estado = encodeWorld(world, { vfs: true, workbooks: true, tickets: true });
    const base = db.ready ? await db.exportState() : null;
    const err = await savePartida(partida.id, {
      estado, codigo: session.collab?.snapshot() ?? null, base, dia: world.day, plata: Math.round(world.money), jugadores: [...knownPlayers],
    });
    if (err && !saveWarned) {
      saveWarned = true;
      toast(`No se pudo guardar la partida: ${err}`, "bad");
    }
  } catch (e) {
    console.warn("No se pudo guardar", e);
  } finally {
    saving = false;
  }
}

/** Pantalla de "Conectando…" mientras se entra a la sala. */
function connecting(text: string): { set: (t: string) => void; fail: (t: string) => void; remove: () => void } {
  const el = document.createElement("div");
  el.className = "connecting";
  el.innerHTML = `<div class="cn-card"><span class="cn-spin" aria-hidden="true"></span><p></p><button hidden>Volver al menú</button></div>`;
  const p = el.querySelector("p")!;
  p.textContent = text;
  el.querySelector("button")!.addEventListener("click", () => {
    location.hash = "";
    location.reload();
  });
  document.body.append(el);
  return {
    set: (t) => (p.textContent = t),
    fail: (t) => {
      p.textContent = t;
      el.classList.add("failed");
      el.querySelector<HTMLButtonElement>("button")!.hidden = false;
    },
    remove: () => el.remove(),
  };
}

/** Entra a una partida en línea como anfitrión o como espejo. Devuelve false si no se pudo. */
async function startOnline(choice: OnlineChoice): Promise<boolean> {
  const screen = connecting(`Entrando a ${choice.nombre}…`);
  const room = new Room(choice.id, choice.player);
  try {
    await room.join();
  } catch (e) {
    screen.fail((e as Error).message);
    return false;
  }
  session.room = room;
  session.partida = { id: choice.id, nombre: choice.nombre };
  const collab = new Collab(room, choice.player);
  session.collab = collab;
  room.on("flow", ({ k }: { k: string }) => onRemoteFlow(k));
  linkAssembly(room);
  knownPlayers.add(choice.player.name);
  location.hash = `partida=${choice.id}`;
  document.title = `${choice.nombre} · Código de Barras`;

  const ok = room.isHost ? await startAsHost(room, collab, choice, screen) : await startAsGuest(room, collab, choice, screen);
  if (!ok) return false;
  watchPeers(room);
  renderExplorer();
  refreshDock();
  return true;
}

async function startAsHost(room: Room, collab: Collab, choice: OnlineChoice, screen: ReturnType<typeof connecting>): Promise<boolean> {
  session.mode = "host";
  registerHostHandlers(room);
  screen.set("Cargando la partida…");
  const saved = await getPartida(choice.id);
  if (!saved.ok && !/No existe/.test(saved.reason)) toast(`${saved.reason} La partida no se va a guardar.`, "bad");
  const save = saved.ok ? saved.save : null;
  if (saved.ok) saved.info.jugadores.forEach((j) => knownPlayers.add(j));
  if (save?.estado) {
    applyWorld(world, save.estado as Parameters<typeof applyWorld>[1]);
    Object.assign(progress, (world.meta.progress as typeof progress | undefined) ?? { storeOpen: false, prepDone: false });
    if (save.codigo) collab.load(save.codigo);
    // el código guardado manda sobre el de ejemplo
    for (const r of world.robots) {
      const t = collab.text(r.id).toString();
      if (t) scripts[r.id] = t;
    }
    ensureRobotWindows();
  }
  hostSync = new HostSync(room, world, onlineMeta);
  screen.remove();
  if (!save?.estado) {
    onlinePhase = "naming";
    applyNames(await nameRobotsTogether(room, startingRobots(), choice.id));
  }
  onlinePhase = "playing";
  attachEditors(collab, true);
  for (const r of world.robots) world.setScript(r.id, collab.text(r.id).toString() || scripts[r.id]);
  world.sharedSource = collab.text("shared").toString() || scripts.shared;
  await db.start();
  if (save?.base) {
    try {
      await db.importState(save.base);
    } catch (e) {
      toast("No se pudo cargar la base de datos guardada.", "bad");
      console.warn(e);
    }
  }
  await sqlWin.init();
  void saveOnline();
  window.setInterval(() => void saveOnline(), 45_000);
  toast(`Partida ${choice.id}: tu compañero entra con este código desde "Jugar en línea".`, "info");
  return true;
}

async function startAsGuest(room: Room, collab: Collab, choice: OnlineChoice, screen: ReturnType<typeof connecting>): Promise<boolean> {
  session.mode = "guest";
  screen.set("Esperando al anfitrión…");
  const phase = await room.call<string>("phase", null, 8000).catch(() => "playing");
  guestSync = new GuestSync(room, world, applyMeta);
  room.on("term-out", ({ s, out }: { s: string; out: Parameters<TerminalWindow["show"]>[0] }) => terminalFor(s).show(out));
  if (phase === "naming") {
    screen.remove();
    await nameRobotsTogether(room, startingRobots(), choice.id);
  }
  const got = await guestSync.ready();
  if (!got) {
    screen.fail("El anfitrión no responde. Vuelve a intentarlo en un momento.");
    return false;
  }
  screen.remove();
  ensureRobotWindows();
  attachEditors(collab, false);
  collab.requestSync();
  await sqlWin.init();
  return true;
}

/** Avisos cuando alguien entra o sale; si se va el anfitrión, el espejo sigue desde el último guardado. */
function watchPeers(room: Room): void {
  let names = new Map(room.peers.map((p) => [p.id, p.name]));
  const prev = room.onPeers;
  room.onPeers = (peers) => {
    prev?.(peers);
    for (const p of peers) if (!names.has(p.id)) toast(`${p.name} entró a la partida.`, "good");
    for (const [id, name] of names) if (!peers.some((p) => p.id === id)) toast(`${name} salió de la partida.`, "info");
    names = new Map(peers.map((p) => [p.id, p.name]));
    for (const p of peers) knownPlayers.add(p.name);
    if (session.mode === "guest" && room.isHost) {
      // el anfitrión se fue: este navegador pasa a correr la tienda, desde lo último que se guardó
      const screen = connecting("El anfitrión salió. Tú sigues la partida desde el último guardado…");
      setTimeout(() => location.reload(), 1800);
      void screen;
    }
    if (nightPanel && world.night) showNight(null); // los nombres de los botones de voto
  };
}

// El menú principal ya está en pantalla desde el HTML; mientras se ve, cargan los modelos 3D detrás.
const menu = new MainMenu(audio);

store
  .load((done, total) => menu.setProgress(done / total))
  .then(async () => {
    store.showMenu();
    store.start();
    menu.setReady();
    // #partida=ABCD en la dirección: entra directo (al recargar, o si el anfitrión se fue)
    const auto = location.hash.match(/partida=([A-Z]{4})/);
    const me = loadPlayer();
    if (auto && me.name) menu.joinNow({ player: me, id: auto[1], nombre: auto[1], created: false });
    // PostgreSQL arranca después de la tienda, en memoria: al recargar, la base vuelve a empezar vacía.
    db.start()
      .then(() => sqlWin.init())
      .catch((err) => console.error("No arrancó la base de datos", err));
    await menu.entered;
    renderSound(); // el volumen pudo cambiar en las opciones del menú
    window.setInterval(() => void syncWarehouse(), 2000);
    if (menu.onlineChoice) {
      const ok = await startOnline(menu.onlineChoice);
      if (!ok) return;
    } else if (!progress.storeOpen) {
      // partida local nueva: los jugadores le ponen nombre a los robots
      applyNames(await nameRobotsTogether(null, startingRobots(), null));
    }
    if (progress.storeOpen) {
      document.body.classList.remove("booting");
      await openStore(false);
    } else {
      document.body.classList.add("cinematic");
      document.body.classList.remove("booting");
      store.prepareIntro();
      await runIntro();
    }
  })
  .catch((err) => {
    console.error(err);
    menu.fail("No se pudieron cargar los modelos 3D. Recarga la página.");
  });

Object.assign(window, { store, world, db, scriptRun });
