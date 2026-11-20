import { GameDB, type WarehouseSource } from "@cdb/db";
import { FEATURES, VM } from "@cdb/interpreter";
import { type ConsoleLine, DELIVERY, DELIVERY_PRODUCTS, NIGHT, PRODUCTS, type ProductName, type SimEvent, type Ticket, TICKS_PER_SECOND, UNLOCKS, World } from "@cdb/sim";
import { AudioEngine, type SongName } from "./audio.js";
import { CodeEditor } from "./editor.js";
import { COMMANDS } from "./help.js";
import { NightPanel, ObjectivesPanel, showLetterbox, showModal } from "./intro.js";
import { SheetWindow } from "./sheet.js";
import { SqlWindow } from "./sqlwindow.js";
import { MainMenu } from "./start.js";
import { Store3D } from "./store3d.js";
import { FloatingWindow, topInset } from "./windows.js";

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
#   db.execute("INSERT INTO ventas (total, pagado) VALUES ($1, $2)", total, pago)
while True:
    if has_customer():
        print("¡Llegó un cliente!")
        wait()
`,
  inventario: `# inventario.py: la mercancía que trajo el distribuidor.
# Aquí tienes Python completo, pandas y la conexión db a tu base de datos.
import pandas as pd

df = pd.read_excel("entrega_distribuidor.xlsx")
print(df)

# Antes de subir los datos, diseña tus tablas en la ventana Base de datos
# (CREATE TABLE ...). Luego limpia la hoja y súbela:
#   df.to_sql("nombre_de_tu_tabla", db)
`,
  shared: `# Librería compartida.
# Cuando desbloqueen "import shared", cualquier robot puede usar
# lo que definan aquí, por ejemplo:
#
# def ir_a(x, y):
#     ...
`,
};

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

const world = new World(Date.now() % 100000);
world.customersEnabled = false; // abren cuando amanece después de la primera noche (ver openStore)
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
  if (speed > 0) {
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
ticketsWin.body.innerHTML = `<div class="ticket-list"><p class="empty-note">Aquí quedan los tiquetes de cada venta. Programa a Lupe para empezar a vender.</p></div>`;

const unlocksWin = new FloatingWindow(layer, { id: "unlocks", title: "Desbloqueos", className: "papel", x: window.innerWidth - 470, y: 70, width: 420, height: Math.min(640, H - 90), open: false });
unlocksWin.body.innerHTML = `<p class="paper-intro">Cada compra sale de la caja de la tienda. La sintaxis nueva sirve en cuanto vuelves a ejecutar.</p><div class="unlock-list"></div>`;
unlocksWin.onShow = () => renderUnlocks();

// base de datos: PostgreSQL (PGlite) con todo lo que pasa en la tienda
const db = new GameDB(world);
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
new SheetWindow(sheetWin, DELIVERY);

// ── inventario.py: un script (no es un robot) con toda la sintaxis, pandas y db ──
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
  <div class="pane-tabs"><button class="on">Salida</button><span class="pane-hint">print(df) muestra la tabla aquí</span></div>
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
$(".btn-stop", scriptWin.body).addEventListener("click", () => {
  if (scriptRun.vm && (scriptRun.vm.status === "running" || scriptRun.vm.status === "waiting")) {
    scriptRun.vm.stop();
    scriptLog("info", "■ Detenido");
  }
});

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

const helpWin = new FloatingWindow(layer, { id: "help", title: "Comandos", className: "papel", x: window.innerWidth - 500, y: 80, width: 460, height: Math.min(680, H - 100), open: false });
helpWin.onShow = () => renderHelp();

// ── barra de ventanas (dock) ─────────────────────────────────

const DOCK: { label: string; win: FloatingWindow; color?: string }[] = [
  { label: "Toño", win: codeWindows.get("tono")!.win, color: "cian" },
  { label: "Lupe", win: codeWindows.get("lupe")!.win, color: "naranja" },
  { label: "shared.py", win: sharedWin.win },
  { label: "inventario.py", win: scriptWin },
  { label: "Hoja", win: sheetWin },
  { label: "Tiquetes", win: ticketsWin },
  { label: "Desbloqueos", win: unlocksWin },
  { label: "Base de datos", win: dbWin },
  { label: "Comandos", win: helpWin },
];

const dock = $("#dock");
DOCK.forEach((d, i) => {
  if (d.label === "Tiquetes") dock.insertAdjacentHTML("beforeend", `<span class="sep"></span>`);
  const b = document.createElement("button");
  b.innerHTML = `${d.color ? `<span class="dot" style="background: var(--${d.color})"></span>` : ""}${d.label}`;
  b.addEventListener("click", () => {
    d.win.toggle();
    refreshDock();
  });
  d.win.el.querySelector(".win-close")!.addEventListener("click", refreshDock);
  d.win.el.querySelector(".win-min")!.addEventListener("click", refreshDock);
  dock.append(b);
});

function refreshDock(): void {
  dock.querySelectorAll("button").forEach((b, i) => b.classList.toggle("open", DOCK[i].win.isOpen));
}
refreshDock();

function select(id: string): void {
  selected = id;
  codeWindows.get(id)?.win.show();
  refreshDock();
  refreshUi(true);
}

// ── velocidad ────────────────────────────────────────────────

function setSpeed(s: number): void {
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
  cw.status.textContent = paused
    ? `${vm!.pauseReason === "punto" ? "punto de parada" : "pausado"} en la línea ${vm!.line}`
    : running && vm
      ? `línea ${vm.line}${vm.busyTicks ? " · ocupado" : ""}`
      : "Ctrl+Enter para ejecutar";

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

const ARTICLES: Record<string, [string, boolean]> = { pan: ["el", false], leche: ["la", false], huevos: ["los", true] };

function renderAlerts(): void {
  const items: { text: string; ok?: boolean }[] = [];
  for (const p of Object.keys(PRODUCTS) as ProductName[]) {
    const [art, plural] = ARTICLES[p] ?? ["el", false];
    const stock = world.shelfStock(p);
    if (!world.shelves.some((s) => s.product === p)) items.push({ text: `Ningún estante tiene ${p}` });
    else if (stock === 0) items.push({ text: `${plural ? "Se acabaron" : "Se acabó"} ${art} ${p}` });
    else if (stock <= 2) items.push({ text: `${plural ? "Quedan pocos" : art === "la" ? "Queda poca" : "Queda poco"} ${p} (${stock})` });
    if (world.warehouseStock[p] === 0) items.push({ text: `No hay ${p} en el almacén: el proveedor cobra` });
  }
  if (world.queue.length >= 3) items.push({ text: `Hay ${world.queue.length} clientes en la cola` });
  const left = world.dayTicksLeft;
  if (left <= 30 * TICKS_PER_SECOND) items.unshift({ text: `La tienda cierra en ${Math.ceil(left / TICKS_PER_SECOND)} s` });
  for (const r of world.robots) {
    if (r.vm?.status === "error") items.push({ text: `${r.name} se detuvo por un error` });
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
    <div class="t-head">LA ESQUINA · cliente ${t.customerId}</div>
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
  el.className = "ticket nuevo";
  el.innerHTML = ticketHtml(t);
  list.prepend(el);
  while (list.children.length > 30) list.lastElementChild!.remove();

  // aviso breve en la esquina (si la ventana de tiquetes está cerrada)
  if (ticketsWin.isOpen) return;
  const toasts = $("#toasts");
  const toast = document.createElement("article");
  toast.className = "ticket";
  toast.innerHTML = ticketHtml(t);
  toasts.prepend(toast);
  while (toasts.children.length > 2) toasts.lastElementChild!.remove();
  setTimeout(() => toast.remove(), 4100);
}

const audio = new AudioEngine();

function onEvents(events: SimEvent[]): void {
  for (const e of events) {
    if (e.type === "ticket") addTicket(e.ticket);
    else if (e.type === "sound") audio.play(e.name);
    else if (e.type === "record") db.ingest([e.record]);
    else if (e.type === "robot" && e.status === "paused") onRobotPaused(e.robotId);
    else if (e.type === "warehouse") warehouseTake(e.product, e.quantity);
    else if (e.type === "closed") showNight(e.summary);
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

// ── desbloqueos y comandos ───────────────────────────────────

function renderUnlocks(): void {
  $(".unlock-list", unlocksWin.body).innerHTML = UNLOCKS.map((u) => {
    const owned = world.unlocked.has(u.id);
    const blocked = !!u.requires && !world.unlocked.has(u.requires);
    const req = blocked ? ` Necesita: ${UNLOCKS.find((x) => x.id === u.requires)!.label}.` : "";
    const disabled = owned || blocked || world.money < u.cost;
    return `<div class="unlock ${owned ? "owned" : ""}"><h3>${u.label}</h3><p>${u.description}${req}</p>
      <button data-buy="${u.id}" ${disabled ? "disabled" : ""}>${owned ? "Comprado" : money(u.cost)}</button></div>`;
  }).join("");
}

unlocksWin.body.addEventListener("click", (e) => {
  const id = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-buy]")?.dataset.buy;
  if (!id || !world.buy(id).ok) return;
  renderUnlocks();
  renderHelp();
  for (const cw of codeWindows.values()) cw.editor.relint();
  refreshUi(true);
});
setInterval(() => unlocksWin.isOpen && renderUnlocks(), 500);

function renderHelp(): void {
  const groups = ["Moverse", "Reponer", "Caja", "Python"] as const;
  const syntax = `<h3>Sintaxis</h3><p>Ya tienes: ${[...world.features].map((f) => `<code>${f}</code>`).join(" ")}. Lo demás se compra en Desbloqueos.</p>`;
  const texto = `<h3>Unir texto y números</h3><dl>
    <dt>f"Total: {total}"</dt><dd>Mete el valor de una variable dentro del texto.</dd>
    <dt>f"{precio:,}"</dt><dd>Con separador de miles: 1,234,567.</dd>
    <dt>f"{x:.2f}"</dt><dd>Con 2 decimales: 2.50.</dd>
    <dt>"Total: " + str(total)</dt><dd>Para sumar texto con un número, primero conviértelo con str().</dd>
    <dt>print("Total:", total)</dt><dd>print() acepta varios valores separados por comas.</dd></dl>`;
  const debug = `<h3>Depurar</h3><dl>
    <dt>Punto de parada</dt><dd>Clic a la izquierda del número de línea: el robot se detiene antes de esa línea.</dd>
    <dt>⤵ Paso (F10)</dt><dd>Ejecuta una sola línea. Si el robot no está corriendo, lo arranca en la primera.</dd>
    <dt>⏸ Pausar / ▶ Continuar (F8)</dt><dd>Detiene al robot en la próxima línea o lo deja seguir.</dd>
    <dt>Variables</dt><dd>La pestaña Variables muestra el valor de cada variable en ese momento.</dd></dl>
    <p>Cuando un robot se detiene, el tiempo de la tienda se pausa para que revises con calma.</p>`;
  const dbHelp = `<h3>Base de datos desde Python (db)</h3><p>La conexión <code>db</code> ya está abierta, al estilo de asyncpg (sin await). Usa $1, $2... para los valores.</p><dl>
    <dt>db.execute(sql, *valores)</dt><dd>Ejecuta INSERT/UPDATE/DELETE/CREATE. Devuelve p. ej. "INSERT 0 1".</dd>
    <dt>db.fetch(sql, *valores)</dt><dd>Lista de filas; cada fila es un diccionario: fila["nombre"].</dd>
    <dt>db.fetchrow(sql, *valores)</dt><dd>Solo la primera fila (o None).</dd>
    <dt>db.fetchval(sql, *valores)</dt><dd>Un solo valor, p. ej. db.fetchval("SELECT precio FROM productos WHERE nombre = $1", "pan").</dd>
    <dt>db.executemany(sql, filas)</dt><dd>La misma sentencia para cada tupla de la lista.</dd></dl>`;
  const pandasHelp = `<h3>pandas</h3><p><code>import pandas as pd</code> (versión sencilla; el índice siempre es 0, 1, 2...)</p><dl>
    <dt>pd.read_excel("archivo.xlsx")</dt><dd>Lee una hoja de cálculo.</dd>
    <dt>df.head() · df.shape · df.columns</dt><dd>Primeras filas, (filas, columnas) y nombres de columnas.</dd>
    <dt>df["col"] · df[["a", "b"]]</dt><dd>Una columna (Series) o varias.</dd>
    <dt>df[df["Cantidad"] > 0]</dt><dd>Filtrar filas. Combina con & y |, con paréntesis.</dd>
    <dt>df.rename(columns={"viejo": "nuevo"})</dt><dd>Cambiar nombres de columnas (o df.columns = [...]).</dd>
    <dt>df["col"].str.strip().str.lower()</dt><dd>Limpiar textos: strip, lower, upper, title, replace, contains.</dd>
    <dt>df.drop_duplicates() · df.dropna() · df.drop(columns=[...])</dt><dd>Quitar repetidos, vacíos o columnas.</dd>
    <dt>df["nueva"] = df["a"] * df["b"]</dt><dd>Columnas calculadas.</dd>
    <dt>df.to_sql("tabla", db)</dt><dd>Inserta las filas en una tabla que ya exista (no la crea). if_exists="replace" la vacía antes.</dd>
    <dt>pd.read_sql(sql, db)</dt><dd>Una consulta SQL como DataFrame.</dd></dl>
    <p><button class="replay-intro">Repetir la intro</button></p>`;
  helpWin.body.innerHTML = `<div class="help-body">${syntax}${texto}${debug}${dbHelp}${pandasHelp}${groups
    .map((g) => `<h3>${g}</h3><dl>${COMMANDS.filter((c) => c.group === g).map((c) => `<dt>${escapeHtml(c.signature)}</dt><dd>${escapeHtml(c.description)}</dd>`).join("")}</dl>`)
    .join("")}</div>`;
}
renderHelp();
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
    let right = 0;
    for (const win of [...[...codeWindows.values()].map((cw) => cw.win), scriptWin]) {
      if (win.isOpen && win.el.offsetLeft < window.innerWidth / 2) right = Math.max(right, win.el.offsetLeft + win.el.offsetWidth);
    }
    return right;
  },
  onCue: (cue: string) => audio.cue(cue),
  advance: (delta: number) => {
    // la noche cuenta tiempo real: no se detiene con la pausa ni va más rápido con 4×
    const now = performance.now();
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
const WELCOME_LETTER = `Queridos muchachos:

Les dejo mi tiendita, La Esquina. Los muchachos del barrio ya no quieren trabajar aquí, pero en el sótano hay dos robots viejos, Toño y Lupe. Ustedes saben de computadores, ¿no?

Hoy llega el primer pedido de Distribuidora El Surtidor. Recíbanlo bien y lleven las cuentas en orden, que yo siempre lo anoté todo en mi cuaderno.`;

const MISSION_STEPS = `<ol class="gm-steps">
  <li><strong>Revisa la hoja del distribuidor</strong> (entrega_distribuidor.xlsx). Ojo: no es muy ordenado.</li>
  <li><strong>Diseña tu base de datos</strong> en la ventana Base de datos: crea tus tablas con <code>CREATE TABLE</code>.</li>
  <li><strong>En inventario.py</strong>, lee la hoja con pandas, límpiala y súbela con <code>df.to_sql("tu_tabla", db)</code>.</li>
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
    { label: "Sube pan, leche y huevos con <code>df.to_sql(...)</code>", done: all },
    { label: "Sin productos repetidos ni la fila TOTAL", done: clean },
  ];
  let hint: string | null = null;
  if (all && st.best) {
    const dup = DELIVERY_PRODUCTS.filter((p) => counts[p] > 1);
    if (dup.length) hint = `En <code>${st.best.table}</code> hay productos repetidos (${dup.join(", ")}): el distribuidor anotó algo dos veces. Pista: <code>df.drop_duplicates()</code>. Para volver a subir: <code>DELETE FROM ${st.best.table};</code>`;
    else if (st.best.hasTotalRow) hint = `Subiste la fila <strong>TOTAL</strong> de la hoja a <code>${st.best.table}</code>, pero no es un producto. Pista: <code>df[df["Producto"] != "TOTAL"]</code>.`;
  } else if (st.tables.length > 0 && !all) {
    hint = st.best ? `Tu tabla <code>${st.best.table}</code> todavía no tiene los tres productos.` : "Ya tienes tablas. Ahora sube los datos de la hoja con <code>df.to_sql(...)</code>.";
  }
  const newly = panel.update(items, hint);
  if (newly.length) audio.cue("check");
  if (clean && !boxesUnloaded) {
    boxesUnloaded = true;
    store.unloadBoxes();
  }
}

async function runIntro(): Promise<void> {
  document.body.classList.add("cinematic");
  world.customersEnabled = false;
  for (const w of [...robotWindows(), scriptWin, sheetWin, dbWin, ticketsWin, unlocksWin, helpWin]) w.close();
  const lb = showLetterbox(() => store.skipIntro());
  await store.playIntro();
  lb.hide();
  await showModal({ kicker: "Una carta para ustedes", title: "¡Bienvenidos a La Esquina!", letter: WELCOME_LETTER, signature: "— La abuela", button: "Continuar ▸", step: 0, steps: 2, onOpen: () => audio.cue("welcome") });
  await showModal({ kicker: "Primera tarea", title: "Organiza tu inventario", letter: "El camión dejó la mercancía y la hoja de entrega. Antes de abrir la tienda hay que registrar todo en tu base de datos: tú decides cómo se llaman las tablas y qué columnas tienen.", html: MISSION_STEPS, button: "¡Manos a la obra! ▸", step: 1, steps: 2, onOpen: () => audio.cue("check") });
  document.body.classList.remove("cinematic");
  startMission();
}

function startMission(): void {
  // inventario.py a la izquierda; la hoja y la base de datos al centro; la misión a la derecha
  const W = window.innerWidth;
  const Hh = window.innerHeight;
  const left = Math.round(Math.min(620, Math.max(420, W * 0.36)));
  const midX = left + 28;
  const midW = Math.max(420, W - midX - 370);
  const sheetH = Math.round((Hh - 90) * 0.42);
  const top = topInset();
  const sheetH2 = Math.round((Hh - top - 20) * 0.42);
  scriptWin.setBox(14, top, left, Hh - top - 14);
  sheetWin.setBox(midX, top, midW, sheetH2);
  dbWin.setBox(midX, top + sheetH2 + 10, midW, Hh - top - sheetH2 - 24);
  void sheetH;
  scriptWin.show();
  sheetWin.show();
  dbWin.show();
  refreshDock();
  mission = new ObjectivesPanel("Organiza tu inventario", () => void openStore(true));
  void missionCheck();
  missionTimer = window.setInterval(() => void missionCheck(), 1500);
}

const FIRST_NIGHT_STEPS = `<ol class="gm-steps">
  <li><strong>Toño surte los estantes.</strong> Va al almacén (el cuarto de la izquierda), toma productos con <code>pick("leche")</code> y los pone en un estante con <code>place()</code>. Cada estante tiene un solo producto: el primero que pongan ahí decide cuál. ¡Ustedes eligen cómo repartirlos!</li>
  <li><strong>Lupe atiende la caja.</strong> Escanea el carrito, cobra y da la devuelta.</li>
  <li><strong>¿Terminaron antes?</strong> Voten los dos <em>¡Listo!</em> para abrir ya. Si se acaba el tiempo, amanece, la tienda abre igual y los clientes empiezan a llegar.</li>
  <li><strong>Cada día dura 5 minutos</strong> (de 7:00 a 19:00) y cada noche 10. Cada día vienen más clientes: usen las noches para mejorar el código.</li>
</ol>`;

const PLAYERS: Record<(typeof NIGHT.players)[number], string> = { j1: "Jugador 1", j2: "Jugador 2" };
let nightPanel: NightPanel | null = null;

/** Panel de la noche (la sim ya empezó la noche): cuenta regresiva, votos y el resumen del día que terminó. */
function showNight(report: typeof world.lastDay): void {
  lastRealMs = performance.now();
  nightPanel?.el.remove();
  nightPanel = new NightPanel(
    NIGHT.players.map((id) => ({ id, label: PLAYERS[id] })),
    { day: world.day, totalMs: world.night?.totalMs ?? NIGHT.ms, report },
    (player, ready) => world.vote(player as (typeof NIGHT.players)[number], ready),
  );
}

/** La primera noche: diez minutos sin clientes para escribir el código de Toño y Lupe (o hasta que voten los dos). */
function startFirstNight(): void {
  world.startNight(NIGHT.ms);
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
  const next = warehouseChain.then(async () => {
    const src = await db.warehouseSource(DELIVERY_PRODUCTS);
    if (src && !src.qtyCol && !warehouseSrc) {
      console.warn(`La tabla ${src.table} no tiene una columna de cantidad: el almacén queda vacío.`);
    }
    warehouseSrc = src;
    for (const p of Object.keys(PRODUCTS) as ProductName[]) {
      world.warehouseStock[p] = Math.max(0, (src?.stock[p] ?? 0) - (warehousePending[p] ?? 0));
    }
  });
  warehouseChain = next.catch((err) => console.warn("No se pudo leer el inventario", err));
  return warehouseChain as Promise<void>;
}

async function openStore(animated: boolean): Promise<void> {
  progress.storeOpen = true;
  saveProgress();
  mission?.remove();
  mission = null;
  if (missionTimer !== null) clearInterval(missionTimer);
  if (animated) {
    audio.cue("open");
    for (const w of [scriptWin, sheetWin, dbWin]) w.close();
    await store.flyToStore();
    await showModal({
      kicker: "Cae la noche",
      title: "Mañana abren a las 7:00",
      letter: "La mercancía ya está guardada en el almacén. La tienda está cerrada: tienen 10 minutos de noche para programar a sus dos robots antes de que lleguen los clientes.",
      html: FIRST_NIGHT_STEPS,
      button: "¡A programar! ▸",
      step: 0,
      steps: 1,
      onOpen: () => audio.cue("check"),
    });
    for (const w of robotWindows().slice(0, 2)) w.show();
  }
  await Promise.race([syncWarehouse(), new Promise((r) => setTimeout(r, 15000))]); // sin base, no se traba
  window.setInterval(() => void syncWarehouse(), 2000);
  if (progress.prepDone) world.openStore();
  else startFirstNight();
  refreshDock();
}

// El menú principal ya está en pantalla desde el HTML; mientras se ve, cargan los modelos 3D detrás.
const menu = new MainMenu(audio);

store
  .load((done, total) => menu.setProgress(done / total))
  .then(async () => {
    store.showMenu();
    store.start();
    menu.setReady();
    // PostgreSQL arranca después de la tienda, en memoria: al recargar, la base vuelve a empezar vacía.
    db.start()
      .then(() => sqlWin.init())
      .catch((err) => console.error("No arrancó la base de datos", err));
    await menu.entered;
    renderSound(); // el volumen pudo cambiar en las opciones del menú
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
