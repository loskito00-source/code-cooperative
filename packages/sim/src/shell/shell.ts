import type { Server } from "../servers.js";
import type { World } from "../world.js";
import { COMMANDS, type CommandResult } from "./commands.js";
import { BASE_COMMANDS, initFs, logLine, LOGS, PACKAGES } from "./system.js";
import { VFS } from "./vfs.js";

/**
 * Terminal Linux simulada de un servidor (docs/servidores.md §4). No es un Linux de verdad: es un intérprete propio
 * con comandos reales (ls, grep, top, apt, systemctl, nmap...) que leen y cambian el estado de la simulación.
 * Soporta tuberías (|), && y ;, comillas, `sudo`, y comandos en vivo (top, tail -f) que la ventana refresca.
 */
export interface ShellOutput {
  lines: string[];
  clear?: boolean;
}

/** Algo que la terminal está preguntando (instalador, contraseña...). La próxima línea va a `answer`. */
export interface Pending {
  prompt: string;
  secret?: boolean;
  answer(text: string): string[];
}

/** Un comando que se sigue dibujando hasta Ctrl+C (top, tail -f). */
export interface Live {
  render(): string[];
}

export class Shell {
  /** Servidores por los que entró con ssh (para volver con exit). */
  private readonly stack: { serverId: string; cwd: string }[] = [];
  serverId: string;
  cwd = "/";
  readonly history: string[] = [];
  pending: Pending | null = null;
  live: Live | null = null;

  constructor(readonly world: World, serverId: string) {
    this.serverId = serverId;
    if (!this.server.os) this.startInstaller();
    else this.cwd = `/home/${this.server.os.user}`;
  }

  get server(): Server {
    const s = this.world.server(this.serverId);
    if (!s) throw new Error(`servidor desconocido: ${this.serverId}`);
    return s;
  }

  get user(): string {
    return this.server.os?.user ?? "root";
  }

  prompt(): string {
    if (this.pending) return this.pending.prompt;
    const home = `/home/${this.user}`;
    const where = this.cwd === home ? "~" : this.cwd.startsWith(home + "/") ? "~" + this.cwd.slice(home.length) : this.cwd;
    return `${this.user}@${this.server.hostname}:${where}$ `;
  }

  /** Lo que se ve al abrir la terminal. */
  welcome(): string[] {
    const s = this.server;
    if (!s.online) return ["El servidor está apagado."];
    if (!s.os) return this.installerIntro();
    return [`Linux de La Esquina 1.0 — ${s.hostname}${s.ip ? ` (${s.ip})` : " (sin red)"}`, "Escribe help para ver los comandos.", ""];
  }

  /** Ctrl+C: corta lo que esté corriendo o lo que se esté preguntando. */
  interrupt(): string[] {
    if (this.live) {
      this.live = null;
      return ["^C"];
    }
    if (this.pending && this.server.os) {
      this.pending = null;
      return ["^C"];
    }
    return ["^C"];
  }

  input(raw: string): ShellOutput {
    if (!this.server.online) return { lines: ["El servidor está apagado."] };
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      return { lines: [p.prompt + (p.secret ? "" : raw), ...p.answer(raw.trim())] };
    }
    const line = raw.trim();
    const echo = this.prompt() + raw;
    if (!line) return { lines: [echo] };
    this.history.push(line);
    if (this.history.length > 200) this.history.shift();
    const out = this.run(line);
    return { lines: [echo, ...out.lines], clear: out.clear };
  }

  /** Ejecuta una línea (con ; y &&) y devuelve la salida. */
  run(line: string): ShellOutput {
    const lines: string[] = [];
    let clear = false;
    for (const seq of splitTop(line, ";")) {
      for (const part of splitTop(seq, "&&")) {
        const r = this.pipeline(part);
        if (r.clear) {
          clear = true;
          lines.length = 0;
        }
        lines.push(...r.lines);
        if (r.failed) break;
      }
    }
    return { lines, clear };
  }

  private pipeline(text: string): { lines: string[]; clear?: boolean; failed?: boolean } {
    const stages = splitTop(text, "|");
    let stdin: string[] | null = null;
    let last: CommandResult = { lines: [] };
    for (const stage of stages) {
      const argv = tokenize(stage);
      if (!argv.length) continue;
      if (argv[0] === "sudo") argv.shift();
      if (!argv.length) continue;
      last = this.exec(argv, stdin);
      stdin = last.lines;
    }
    if (last.live) {
      this.live = last.live;
      return { lines: last.live.render() };
    }
    return { lines: last.lines, clear: last.clear, failed: last.failed };
  }

  /** Comandos disponibles ahora (los de base + los de los paquetes instalados). */
  available(): Set<string> {
    const set = new Set(BASE_COMMANDS);
    for (const p of this.server.packages) for (const c of PACKAGES[p]?.commands ?? []) set.add(c);
    return set;
  }

  private exec(argv: string[], stdin: string[] | null): CommandResult {
    const [cmd, ...args] = argv;
    const fn = COMMANDS[cmd];
    if (!fn || !this.available().has(cmd)) {
      const pkg = Object.entries(PACKAGES).find(([, p]) => p.commands.includes(cmd))?.[0];
      return { lines: [`${cmd}: orden no encontrada${pkg ? `. Instálala con: apt install ${pkg}` : ". Escribe help para ver los comandos."}`], failed: true };
    }
    try {
      return fn(this, args, stdin);
    } catch (e) {
      return { lines: [`${cmd}: ${(e as Error).message}`], failed: true };
    }
  }

  // ── rutas ────────────────────────────────────────────────────

  path(p: string): string {
    if (p === "~" || p.startsWith("~/")) p = `/home/${this.user}` + p.slice(1);
    return VFS.normalize(p, this.cwd);
  }

  // ── ssh ──────────────────────────────────────────────────────

  enter(serverId: string): void {
    this.stack.push({ serverId: this.serverId, cwd: this.cwd });
    this.serverId = serverId;
    this.cwd = `/home/${this.user}`;
  }

  leave(): boolean {
    const prev = this.stack.pop();
    if (!prev) return false;
    this.serverId = prev.serverId;
    this.cwd = prev.cwd;
    return true;
  }

  get remote(): boolean {
    return this.stack.length > 0;
  }

  // ── instalador de Linux (primer arranque) ───────────────────

  private installerIntro(): string[] {
    return [
      "╔══════════════════════════════════════════╗",
      "║   Instalador de Linux de La Esquina 1.0  ║",
      "╚══════════════════════════════════════════╝",
      "El disco está vacío. Vamos a instalar el sistema.",
      "",
    ];
  }

  private startInstaller(): void {
    const ask = (prompt: string, next: (v: string) => string[], secret = false) => {
      this.pending = { prompt, secret, answer: next };
    };
    const conf: { hostname: string; user: string } = { hostname: "", user: "" };
    ask("Nombre del servidor (por ejemplo srv-01): ", (v) => {
      if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(v)) {
        this.startInstaller();
        return ["Usa minúsculas, números y guiones (por ejemplo srv-01)."];
      }
      if (this.world.servers.some((x) => x !== this.server && x.hostname === v)) {
        this.startInstaller();
        return [`Ya hay un servidor llamado ${v}. Elige otro nombre.`];
      }
      conf.hostname = v;
      const askUser = (): string[] => {
        ask("Usuario administrador: ", (u) => {
          if (!/^[a-z][a-z0-9_]{1,20}$/.test(u)) return [...["Usa minúsculas y números, empezando con letra."], ...askUser()];
          conf.user = u;
          const askPass = (): string[] => {
            ask("Contraseña: ", (p) => {
              if (p.length < 4) return ["Muy corta (mínimo 4 caracteres).", ...askPass()];
              ask("Repite la contraseña: ", (p2) => {
                if (p2 !== p) return ["No coinciden. Otra vez.", ...askPass()];
                return this.install(conf.hostname, conf.user, p);
              }, true);
              return [];
            }, true);
            return [];
          };
          return askPass();
        });
        return [];
      };
      return askUser();
    });
  }

  private install(hostname: string, user: string, password: string): string[] {
    const s = this.server;
    s.hostname = hostname;
    s.os = { user, password };
    s.packages.add("openssh-server");
    s.services.add("ssh");
    s.enabled.add("ssh");
    initFs(s, this.world.logStamp());
    logLine(s, LOGS.syslog, this.world.logStamp(), "systemd[1]", "Started OpenBSD Secure Shell server (ssh).");
    this.cwd = `/home/${user}`;
    this.world.emitServer(s, "instalado");
    const weak = !strongPassword(password);
    return [
      "Particionando el disco…            ✓",
      "Copiando el sistema…               ✓",
      "Configurando el usuario…           ✓",
      "Instalando el servidor SSH…        ✓",
      "",
      `¡Listo! Linux quedó instalado en ${hostname}.`,
      ...(weak ? ["⚠ Tu contraseña es débil: un atacante podría adivinarla. Cámbiala luego con passwd (10+ caracteres, letras y números)."] : []),
      `Lee los siguientes pasos: cat LEEME.txt`,
      "",
    ];
  }
}

export function strongPassword(p: string): boolean {
  return p.length >= 10 && /[a-zA-Z]/.test(p) && /\d/.test(p);
}

/** Separa por un operador que no esté entre comillas. */
export function splitTop(text: string, op: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === q) q = null;
      cur += ch;
    } else if (ch === "'" || ch === '"') {
      q = ch;
      cur += ch;
    } else if (text.startsWith(op, i) && !(op === "|" && text[i + 1] === "|")) {
      out.push(cur);
      cur = "";
      i += op.length - 1;
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Palabras de un comando, respetando comillas simples y dobles ('-F"' + '{print $1}'...). */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let q: string | null = null;
  for (const ch of text) {
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      q = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else cur += ch;
  }
  if (has || cur) out.push(cur);
  return out;
}
