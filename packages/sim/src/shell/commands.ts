import { SECURITY, SERVER } from "../config.js";
import { type InternetHost, isLocal, type Port } from "../network.js";
import { capacity, freeRam, type Server } from "../servers.js";
import type { Live, Shell } from "./shell.js";
import { strongPassword } from "./shell.js";
import { logLine, LOGS, PACKAGES } from "./system.js";
import { VFS } from "./vfs.js";

export interface CommandResult {
  lines: string[];
  clear?: boolean;
  failed?: boolean;
  live?: Live;
}

type Cmd = (sh: Shell, args: string[], stdin: string[] | null) => CommandResult;

const ok = (...lines: string[]): CommandResult => ({ lines });
const fail = (...lines: string[]): CommandResult => ({ lines, failed: true });

/** Separa opciones (-n 5, -la, --remove) de argumentos. */
function opts(args: string[], withValue: string[] = []): { flags: Set<string>; values: Record<string, string>; rest: string[] } {
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) flags.add(a);
    else if (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a)) {
      const name = a.slice(1);
      const v = withValue.find((w) => name.startsWith(w));
      if (v) values[v] = name.length > v.length ? name.slice(v.length) : args[++i] ?? "";
      else for (const ch of name) flags.add(ch);
    } else rest.push(a);
  }
  return { flags, values, rest };
}

/** Texto de un archivo o de la entrada (stdin). */
function input(sh: Shell, files: string[], stdin: string[] | null, cmd: string): string[] {
  if (!files.length) return stdin ?? [];
  const out: string[] = [];
  for (const f of files) {
    const p = sh.path(f);
    if (sh.server.fs.isDir(p)) throw new Error(`${f}: es una carpeta`);
    const t = sh.server.fs.read(p);
    if (t === null) throw new Error(`${f}: no existe el archivo`);
    if (sh.server.fs.get(p)?.type === "file" && (sh.server.fs.get(p) as { binary?: boolean }).binary && cmd !== "strings") {
      out.push(`${cmd}: ${f}: es un programa (binario). Prueba strings ${f}`);
      continue;
    }
    out.push(...splitLines(t));
  }
  return out;
}

const splitLines = (t: string) => {
  const l = t.split("\n");
  if (l.at(-1) === "") l.pop();
  return l;
};

// ── red ──────────────────────────────────────────────────────

interface AnyHost {
  ip: string;
  name: string;
  ports: Port[];
  internet: InternetHost | null;
  up: boolean;
}

function localHosts(sh: Shell): AnyHost[] {
  const w = sh.world;
  const out: AnyHost[] = [
    { ip: SERVER.gateway, name: "router", ports: [{ port: 53, service: "domain", version: "dnsmasq" }, { port: 80, service: "http", version: "Panel del router" }], internet: null, up: true },
  ];
  for (const s of w.servers) {
    if (!s.ip || !s.cable) continue;
    const ports: Port[] = [];
    if (s.services.has("ssh")) ports.push({ port: 22, service: "ssh", version: "OpenSSH 9.2" });
    if (s.services.has("cowrie")) ports.push({ port: 2222, service: "ssh", version: "OpenSSH 9.2 (cowrie)" });
    if (s.packages.has("robot-agent")) ports.push({ port: 80, service: "http", version: "nginx (pedidos en línea)" });
    if (s.services.has("robot-agent")) ports.push({ port: 7000, service: "robot-agent", version: "robot-agent 1.0" });
    out.push({ ip: s.ip, name: s.hostname, ports, internet: null, up: s.online });
  }
  for (const r of w.robots) out.push({ ip: r.ip, name: `${r.id}-robot (${r.name})`, ports: [{ port: 7001, service: "robot", version: `Robot ${r.name}` }], internet: null, up: true });
  for (const d of w.security.devices) out.push({ ip: d.ip, name: d.name, ports: d.ports, internet: null, up: true });
  return out;
}

function needLink(sh: Shell): string | null {
  const s = sh.server;
  if (!s.cable) return "Network is unreachable (no hay cable de red: conéctalo al switch)";
  if (!s.ip) return "Network is unreachable (eth0 no tiene IP: ip addr add 10.0.0.X/24 dev eth0)";
  return null;
}

function needInternet(sh: Shell): string | null {
  return needLink(sh) ?? (sh.server.gateway !== SERVER.gateway ? "Network is unreachable (falta la puerta de enlace: ip route add default via 10.0.0.1)" : null);
}

/** Busca un equipo por IP o dominio. */
function resolve(sh: Shell, target: string): AnyHost | null {
  const t = target.replace(/^https?:\/\//, "").replace(/[:/].*$/, "");
  const sec = sh.world.security;
  const ip = sec.domains.get(t)?.ip ?? (t === "foro.undernet.test" ? "203.0.113.250" : t);
  if (isLocal(ip)) return localHosts(sh).find((h) => h.ip === ip) ?? null;
  if (ip === "203.0.113.250") return { ip, name: "foro.undernet.test", ports: [{ port: 80, service: "http", version: "Foro UnderNet" }], internet: null, up: true };
  const h = sec.hosts.get(ip);
  return h ? { ip, name: ptr(h), ports: h.ports, internet: h, up: true } : null;
}

function ptr(h: InternetHost): string {
  const n = h.ip.split(".").at(-1);
  switch (h.kind) {
    case "vps": return `vps-${n}.nube.test`;
    case "proxy": return `proxy-${n}.hostingbarato.test`;
    case "vpn": return `salida-${n}.vpn.test`;
    case "universidad": return `escaner-${n}.universidad.test`;
    default: return `cliente-${n}.hogar.test`;
  }
}

const isIp = (s: string) => /^\d+\.\d+\.\d+\.\d+$/.test(s);

// ── procesos ─────────────────────────────────────────────────

interface Proc { pid: number; user: string; cpu: number; mem: number; cmd: string; kind: "sys" | "robot" | "malware" }

function procs(sh: Shell): Proc[] {
  const s = sh.server;
  const w = sh.world;
  const list: Proc[] = [{ pid: 1, user: "root", cpu: 0, mem: 0.4, cmd: "/sbin/init", kind: "sys" }];
  const svc: [string, number, string][] = [["ssh", 412, "sshd: /usr/sbin/sshd -D"], ["robot-agent", 501, "robot-agent --puerto 7000"], ["fail2ban", 620, "/usr/bin/fail2ban-server"], ["clamav-freshclam", 650, "freshclam -d"], ["cowrie", 700, "python3 cowrie (trampa SSH)"]];
  for (const [name, pid, cmd] of svc) if (s.services.has(name)) list.push({ pid, user: "root", cpu: 0.1, mem: 0.8, cmd, kind: "sys" });
  if (s.packages.has("robot-agent")) list.push({ pid: 530, user: "www-data", cpu: 0.1, mem: 0.5, cmd: "nginx: pedidos en línea", kind: "sys" });
  const cap = Math.max(1, capacity(s));
  for (const r of w.robotsOn(s)) {
    if (!w.isRunning(r.id)) continue;
    list.push({ pid: r.cpu.pid, user: s.os?.user ?? "root", cpu: Math.round((r.cpu.lastOps / cap) * 1000) / 10, mem: Math.round((SERVER.robotRamGb / s.ramGb) * 1000) / 10, cmd: `python3 ${r.id}.py`, kind: "robot" });
  }
  if (s.malware && s.malware.respawnAt === null) {
    list.push({ pid: s.malware.pid, user: "root", cpu: Math.round(s.malware.steal * 1000) / 10, mem: 2.1, cmd: s.malware.path, kind: "malware" });
  }
  return list;
}

function topScreen(sh: Shell): string[] {
  const s = sh.server;
  const list = procs(sh).sort((a, b) => b.cpu - a.cpu);
  const used = SERVER.osRamGb + sh.world.robotsOn(s).filter((r) => sh.world.isRunning(r.id)).length * SERVER.robotRamGb;
  const load = (s.load * s.cores).toFixed(2);
  return [
    `top - ${sh.world.logStamp().slice(7)} up ${Math.floor(sh.world.tick / 600)} min,  load average: ${load}, ${load}, ${load}`,
    `Tareas: ${list.length} en total  ·  Temperatura CPU: ${Math.round(s.temp)} °C${s.temp > SERVER.throttleTemp ? " ¡CALIENTE: bajando velocidad!" : ""}`,
    `%Cpu(s): ${(s.load * 100).toFixed(1)} us  ·  ${s.cores} núcleo(s)${s.ddos ? `  ·  red: ${Math.round(s.ddos.level * 100)}% saturada` : ""}`,
    `MiB Mem: ${s.ramGb * 1024} total, ${Math.round((s.ramGb - used) * 1024)} libre, ${Math.round(used * 1024)} usada`,
    "",
    "  PID USUARIO   %CPU %MEM COMANDO",
    ...list.map((p) => `${String(p.pid).padStart(5)} ${p.user.padEnd(9)} ${p.cpu.toFixed(1).padStart(5)} ${p.mem.toFixed(1).padStart(4)} ${p.cmd}`),
    "",
    "(Ctrl+C para salir)",
  ];
}

// ── texto ────────────────────────────────────────────────────

function awkProgram(prog: string, sep: string | null): (line: string) => string | null {
  const m = /^\s*(?:\/(.*)\/\s*)?\{\s*print\s*(.*?)\s*\}\s*$/.exec(prog);
  if (!m) throw new Error("solo entiendo programas como '{print $1}' o '/texto/ {print $2, $3}'");
  const re = m[1] ? new RegExp(m[1]) : null;
  const parts = m[2] ? m[2].split(",").map((x) => x.trim()) : ["$0"];
  return (line) => {
    if (re && !re.test(line)) return null;
    const fields = sep ? line.split(sep) : line.trim().split(/\s+/);
    return parts.map((p) => {
      const f = /^\$(\d+)$/.exec(p);
      if (f) return f[1] === "0" ? line : fields[Number(f[1]) - 1] ?? "";
      if (p === "NF") return String(fields.length);
      return p.replace(/^"(.*)"$/, "$1");
    }).join(" ");
  };
}

function hash(text: string): string {
  let h1 = 0x811c9dc5;
  let out = "";
  for (let k = 0; k < 8; k++) {
    for (let i = 0; i < text.length; i++) h1 = Math.imul(h1 ^ text.charCodeAt(i) ^ k, 16777619) >>> 0;
    out += h1.toString(16).padStart(8, "0");
  }
  return out;
}

// ── los comandos ─────────────────────────────────────────────

export const COMMANDS: Record<string, Cmd> = {
  help: (sh) => {
    const av = sh.available();
    const groups: [string, string[]][] = [
      ["Archivos", ["ls", "cd", "pwd", "cat", "head", "tail", "rm", "file", "strings", "sha256sum"]],
      ["Texto (con | se encadenan)", ["grep", "sort", "uniq", "wc", "awk", "cut", "echo"]],
      ["Sistema", ["top", "ps", "kill", "free", "df", "nproc", "lscpu", "sensors", "uptime", "date", "hostname", "passwd", "history", "clear"]],
      ["Servicios y paquetes", ["systemctl", "journalctl", "apt"]],
      ["Red", ["ip", "ping", "ssh", "curl", "nc", "ss", "netstat", "traceroute", "nmap", "whois", "dig", "geoiplookup", "tcpdump"]],
      ["Seguridad", ["ufw", "fail2ban-client", "clamscan", "freshclam", "last", "who", "mail"]],
      ["Robots", ["robot"]],
    ];
    const lines = ["Comandos disponibles (los grises se instalan con apt):", ""];
    for (const [name, cmds] of groups) lines.push(`${name}:`, "  " + cmds.map((c) => (av.has(c) ? c : `(${c})`)).join("  "));
    lines.push("", "Ejemplos: grep \"Failed\" /var/log/auth.log | awk '{print $11}' | sort | uniq -c", "          cat LEEME.txt");
    return ok(...lines);
  },
  clear: () => ({ lines: [], clear: true }),
  echo: (_sh, args) => ok(args.join(" ")),
  pwd: (sh) => ok(sh.cwd),
  whoami: (sh) => ok(sh.user),
  hostname: (sh, args) => {
    if (args[0]) return COMMANDS.hostnamectl(sh, ["set-hostname", args[0]], null);
    return ok(sh.server.hostname);
  },
  hostnamectl: (sh, args) => {
    if (args[0] === "set-hostname" && args[1]) {
      if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(args[1])) return fail("Nombre inválido: usa minúsculas, números y guiones.");
      sh.server.hostname = args[1];
      return ok();
    }
    return ok(`Nombre: ${sh.server.hostname}`, "Sistema: Linux de La Esquina 1.0");
  },
  date: (sh) => ok(sh.world.logStamp() + " -05 2026"),
  history: (sh) => ok(...sh.history.map((h, i) => `${String(i + 1).padStart(4)}  ${h}`)),
  exit: (sh) => {
    if (sh.leave()) return ok("Conexión cerrada.");
    return ok("(Para cerrar la terminal, cierra la ventana.)");
  },

  ls: (sh, args) => {
    const o = opts(args);
    const target = sh.path(o.rest[0] ?? ".");
    const fs = sh.server.fs;
    if (!fs.exists(target)) return fail(`ls: no existe '${o.rest[0]}'`);
    if (!fs.isDir(target)) return ok(VFS.base(target));
    const names = fs.list(target, o.flags.has("a"))!;
    if (o.flags.has("l")) {
      return ok(...names.map((n) => {
        const p = target === "/" ? `/${n}` : `${target}/${n}`;
        const dir = fs.isDir(p);
        const size = dir ? 4096 : (fs.read(p) ?? "").length;
        return `${dir ? "drwxr-xr-x" : "-rw-r--r--"} root root ${String(size).padStart(7)} ${n}${dir ? "/" : ""}`;
      }));
    }
    return ok(names.map((n) => (fs.isDir(target === "/" ? `/${n}` : `${target}/${n}`) ? n + "/" : n)).join("  "));
  },
  cd: (sh, args) => {
    const p = sh.path(args[0] ?? "~");
    if (!sh.server.fs.isDir(p)) return fail(`cd: ${args[0]}: no existe la carpeta`);
    sh.cwd = p;
    return ok();
  },
  cat: (sh, args, stdin) => ok(...input(sh, args, stdin, "cat")),
  less: (sh, args, stdin) => ok(...input(sh, args, stdin, "less")),
  more: (sh, args, stdin) => ok(...input(sh, args, stdin, "more")),
  head: (sh, args, stdin) => {
    const o = opts(args, ["n"]);
    const n = Number(o.values.n ?? 10);
    return ok(...input(sh, o.rest, stdin, "head").slice(0, n));
  },
  tail: (sh, args, stdin) => {
    const o = opts(args, ["n"]);
    const n = Number(o.values.n ?? 10);
    if (o.flags.has("f") && o.rest[0]) {
      const file = o.rest[0];
      input(sh, [file], null, "tail");
      return { lines: [], live: { render: () => [...input(sh, [file], null, "tail").slice(-n), "", `(siguiendo ${file} · Ctrl+C para salir)`] } };
    }
    return ok(...input(sh, o.rest, stdin, "tail").slice(-n));
  },
  grep: (sh, args, stdin) => {
    const o = opts(args);
    const [pattern, ...files] = o.rest;
    if (pattern === undefined) return fail("uso: grep [-i] [-v] [-c] [-E] texto [archivo...]");
    const src = o.flags.has("E") ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(src, o.flags.has("i") ? "i" : "");
    const lines = input(sh, files, stdin, "grep").filter((l) => re.test(l) !== o.flags.has("v"));
    if (o.flags.has("c")) return ok(String(lines.length));
    return { lines, failed: lines.length === 0 };
  },
  sort: (sh, args, stdin) => {
    const o = opts(args, ["k", "t"]);
    const lines = input(sh, o.rest, stdin, "sort");
    const key = (l: string) => (o.values.k ? (l.trim().split(o.values.t ?? /\s+/)[Number(o.values.k) - 1] ?? "") : l);
    const num = o.flags.has("n");
    const sorted = [...lines].sort((a, b) => (num ? parseFloat(key(a)) - parseFloat(key(b)) || key(a).localeCompare(key(b)) : key(a).localeCompare(key(b))));
    if (o.flags.has("r")) sorted.reverse();
    return ok(...(o.flags.has("u") ? [...new Set(sorted)] : sorted));
  },
  uniq: (sh, args, stdin) => {
    const o = opts(args);
    const out: [string, number][] = [];
    for (const l of input(sh, o.rest, stdin, "uniq")) {
      if (out.length && out.at(-1)![0] === l) out.at(-1)![1]++;
      else out.push([l, 1]);
    }
    return ok(...out.map(([l, n]) => (o.flags.has("c") ? `${String(n).padStart(7)} ${l}` : l)));
  },
  wc: (sh, args, stdin) => {
    const o = opts(args);
    const lines = input(sh, o.rest, stdin, "wc");
    if (o.flags.has("l")) return ok(String(lines.length));
    const words = lines.reduce((s, l) => s + l.split(/\s+/).filter(Boolean).length, 0);
    return ok(`${lines.length} ${words} ${lines.join("\n").length}`);
  },
  awk: (sh, args, stdin) => {
    const o = opts(args, ["F"]);
    const [prog, ...files] = o.rest;
    if (!prog) return fail("uso: awk '{print $1}' [archivo]");
    const f = awkProgram(prog, o.values.F ?? null);
    return ok(...input(sh, files, stdin, "awk").map(f).filter((x): x is string => x !== null));
  },
  cut: (sh, args, stdin) => {
    const o = opts(args, ["d", "f"]);
    const sep = o.values.d ?? "\t";
    const fields = (o.values.f ?? "1").split(",").map(Number);
    return ok(...input(sh, o.rest, stdin, "cut").map((l) => fields.map((n) => l.split(sep)[n - 1] ?? "").join(sep)));
  },
  rm: (sh, args) => {
    const o = opts(args);
    const out: string[] = [];
    for (const f of o.rest) {
      const p = sh.path(f);
      if (sh.server.fs.isDir(p) && !o.flags.has("r")) out.push(`rm: ${f}: es una carpeta (usa rm -r)`);
      else if (!sh.server.fs.remove(p) && !o.flags.has("f")) out.push(`rm: ${f}: no existe`);
      else sh.world.fileRemoved(sh.server, p);
    }
    return ok(...out);
  },
  file: (sh, args) => ok(...args.map((f) => {
    const n = sh.server.fs.get(sh.path(f));
    if (!n) return `${f}: no existe`;
    if (n.type === "dir") return `${f}: carpeta`;
    return `${f}: ${(n as { binary?: boolean }).binary ? "ELF 64-bit, programa ejecutable" : "texto"}`;
  })),
  strings: (sh, args) => {
    const lines = input(sh, args, null, "strings");
    return ok(...lines.filter((l) => /^[\x20-\x7e]{4,}$/.test(l)));
  },
  sha256sum: (sh, args) => ok(...args.map((f) => `${hash(sh.server.fs.read(sh.path(f)) ?? "")}  ${f}`)),

  // ── sistema ──
  top: (sh) => ({ lines: [], live: { render: () => topScreen(sh) } }),
  htop: (sh) => ({ lines: [], live: { render: () => topScreen(sh) } }),
  ps: (sh) => ok("  PID USUARIO   %CPU %MEM COMANDO", ...procs(sh).map((p) => `${String(p.pid).padStart(5)} ${p.user.padEnd(9)} ${p.cpu.toFixed(1).padStart(5)} ${p.mem.toFixed(1).padStart(4)} ${p.cmd}`)),
  kill: (sh, args) => {
    const pids = args.filter((a) => /^\d+$/.test(a)).map(Number);
    if (!pids.length) return fail("uso: kill <PID>   (el PID sale en ps o top)");
    const out: string[] = [];
    for (const pid of pids) {
      const p = procs(sh).find((x) => x.pid === pid);
      if (!p) out.push(`kill: (${pid}) - No existe ese proceso`);
      else if (p.kind === "sys") out.push(`kill: (${pid}) - Es del sistema: usa systemctl stop`);
      else if (p.kind === "robot") {
        const r = sh.world.robots.find((x) => x.cpu.pid === pid)!;
        sh.world.stopRobot(r.id);
      } else sh.world.killMalware(sh.server);
    }
    return ok(...out);
  },
  free: (sh) => {
    const s = sh.server;
    const procsN = sh.world.robotsOn(s).filter((r) => sh.world.isRunning(r.id)).length;
    const used = s.ramGb - freeRam(s, procsN);
    return ok("        total   usada   libre", `Mem:  ${String(s.ramGb).padStart(5)}G ${used.toFixed(1).padStart(6)}G ${(s.ramGb - used).toFixed(1).padStart(6)}G`);
  },
  df: () => ok("Disco          Tamaño  Usado  Libre  Uso%  Montado en", "/dev/sda1        256G    6G   250G    3%  /"),
  nproc: (sh) => ok(String(sh.server.cores)),
  lscpu: (sh) => ok(`CPU(s): ${sh.server.cores}`, `Capacidad por núcleo: ${capacity(sh.server) / sh.server.cores}`, `GPU: ${sh.server.gpu ? "sí" : "no"}`),
  sensors: (sh) => ok(`CPU:  +${sh.server.temp.toFixed(1)}°C  (alta = +${SERVER.throttleTemp}.0°C)`, `Ventiladores: ${sh.server.cooling}`),
  uptime: (sh) => ok(` ${sh.world.logStamp().slice(7)} up ${Math.floor(sh.world.tick / 600)} min, load average: ${(sh.server.load * sh.server.cores).toFixed(2)}`),
  passwd: (sh) => {
    sh.pending = {
      prompt: "Nueva contraseña: ", secret: true,
      answer: (p) => {
        if (p.length < 4) return ["Muy corta. No se cambió."];
        sh.pending = {
          prompt: "Repite la contraseña: ", secret: true,
          answer: (p2) => {
            if (p2 !== p) return ["No coinciden. No se cambió."];
            sh.server.os!.password = p;
            return strongPassword(p) ? ["Contraseña cambiada. Es fuerte. ✓"] : ["Contraseña cambiada, pero es débil (usa 10+ caracteres con letras y números)."];
          },
        };
        return [];
      },
    };
    return ok();
  },

  systemctl: (sh, args) => {
    const o = opts(args);
    const [action, unitRaw] = o.rest;
    const s = sh.server;
    if (!action) return fail("uso: systemctl start|stop|restart|status|enable|disable <servicio>");
    const unit = (unitRaw ?? "").replace(/\.service$/, "").replace(/^sshd$/, "ssh");
    const owner = Object.entries(PACKAGES).find(([, p]) => p.services?.includes(unit))?.[0];
    if (!owner) return fail(`Unit ${unitRaw}.service no existe.`);
    if (!s.packages.has(owner)) return fail(`Unit ${unit}.service no existe. (¿Instalaste el paquete? apt install ${owner})`);
    const start = () => {
      s.services.add(unit);
      logLine(s, LOGS.syslog, sh.world.logStamp(), "systemd[1]", `Started ${unit}.service.`);
      sh.world.emitServer(s, `servicio ${unit}`);
    };
    const stop = () => {
      s.services.delete(unit);
      logLine(s, LOGS.syslog, sh.world.logStamp(), "systemd[1]", `Stopped ${unit}.service.`);
      if (unit === "robot-agent") sh.world.stopRobotsOn(s, "se detuvo robot-agent");
    };
    switch (action) {
      case "start": start(); return ok();
      case "stop": stop(); return ok();
      case "restart": stop(); start(); return ok();
      case "enable":
        s.enabled.add(unit);
        if (o.flags.has("--now")) start();
        return ok(`Created symlink → ${unit}.service (arrancará solo al encender).`);
      case "disable":
        s.enabled.delete(unit);
        if (o.flags.has("--now")) stop();
        return ok(`Removed ${unit}.service.`);
      case "status": {
        const on = s.services.has(unit);
        return ok(`● ${unit}.service — ${PACKAGES[owner].about}`, `   Loaded: loaded (${s.enabled.has(unit) ? "enabled" : "disabled"})`, `   Active: ${on ? "active (running)" : "inactive (dead)"}`);
      }
      default: return fail(`systemctl: no conozco '${action}'`);
    }
  },
  journalctl: (sh, args) => {
    const o = opts(args, ["u", "n"]);
    let lines = input(sh, [LOGS.syslog], null, "journalctl");
    if (o.values.u) lines = lines.filter((l) => l.includes(o.values.u));
    return ok(...lines.slice(-Number(o.values.n ?? 50)));
  },
  apt: (sh, args) => apt(sh, args),
  "apt-get": (sh, args) => apt(sh, args),

  // ── red ──
  ip: (sh, args) => {
    const s = sh.server;
    const [obj, action, ...rest] = args;
    if (!obj || obj === "a" || obj === "addr" || obj === "address") {
      if (action === "add") {
        const m = /^(10\.0\.0\.(\d+))\/24$/.exec(rest[0] ?? "");
        if (!m || Number(m[2]) < 2 || Number(m[2]) > 254) return fail("uso: ip addr add 10.0.0.X/24 dev eth0   (X entre 2 y 254)");
        if (rest[1] !== "dev" || rest[2] !== "eth0") return fail("Falta la tarjeta: ip addr add 10.0.0.X/24 dev eth0");
        const taken = [SERVER.gateway, ...sh.world.servers.filter((x) => x !== s).map((x) => x.ip), ...sh.world.robots.map((r) => r.ip), ...sh.world.security.devices.map((d) => d.ip)];
        if (taken.includes(m[1])) return fail(`RTNETLINK: la dirección ${m[1]} ya la usa otro equipo de la red.`);
        s.ip = m[1];
        sh.world.emitServer(s, "red");
        return ok();
      }
      if (action === "del" || action === "flush") {
        s.ip = null;
        return ok();
      }
      return ok(
        "1: lo: <LOOPBACK,UP>", "    inet 127.0.0.1/8",
        `2: eth0: <${s.cable ? "BROADCAST,UP,LOWER_UP" : "NO-CARRIER (sin cable)"}>`,
        s.ip ? `    inet ${s.ip}/24 brd 10.0.0.255` : "    (sin dirección IP: ip addr add 10.0.0.X/24 dev eth0)",
      );
    }
    if (obj === "route" || obj === "r") {
      if (action === "add") {
        if (rest[0] !== "default" || rest[1] !== "via" || !rest[2]) return fail("uso: ip route add default via 10.0.0.1");
        if (rest[2] !== SERVER.gateway) return fail(`${rest[2]} no es el router de la tienda (es 10.0.0.1).`);
        if (!s.ip) return fail("Primero ponle una IP a eth0: ip addr add 10.0.0.X/24 dev eth0");
        s.gateway = rest[2];
        sh.world.emitServer(s, "red");
        return ok();
      }
      return ok(...(s.gateway ? [`default via ${s.gateway} dev eth0`] : []), ...(s.ip ? ["10.0.0.0/24 dev eth0 scope link"] : []));
    }
    if (obj === "link") return ok(`2: eth0: state ${s.cable ? "UP" : "DOWN (sin cable)"}`);
    return fail("uso: ip addr | ip addr add 10.0.0.X/24 dev eth0 | ip route add default via 10.0.0.1");
  },
  ping: (sh, args) => {
    const target = opts(args, ["c"]).rest[0];
    if (!target) return fail("uso: ping <ip o dominio>");
    const h = resolve(sh, target);
    const err = h && isLocal(h.ip) ? needLink(sh) : needInternet(sh);
    if (err) return fail(`ping: connect: ${err}`);
    if (!h || !h.up) return fail(`PING ${target}`, `From ${sh.server.ip} icmp_seq=1 Destination Host Unreachable`, "--- 0 recibidos, 100% de paquetes perdidos ---");
    const ms = isLocal(h.ip) ? 0.4 : 38;
    return ok(`PING ${target} (${h.ip})`, ...[1, 2, 3, 4].map((i) => `64 bytes from ${h.ip}: icmp_seq=${i} ttl=64 time=${(ms + i * 0.07).toFixed(1)} ms`), "--- 4 enviados, 4 recibidos, 0% perdidos ---");
  },
  ssh: (sh, args) => {
    const target = args.find((a) => !a.startsWith("-"));
    if (!target) return fail("uso: ssh usuario@10.0.0.X");
    const [user, host] = target.includes("@") ? target.split("@") : [sh.user, target];
    const err = needLink(sh);
    if (err) return fail(`ssh: ${err}`);
    const robot = sh.world.robots.find((r) => r.ip === host);
    if (robot) return fail(`${robot.name} es un robot: no tiene SSH. Para que use este servidor: robot attach ${host}`);
    const dest = sh.world.servers.find((x) => x.ip === host && x.cable);
    if (!dest || !dest.online) return fail(`ssh: connect to host ${host} port 22: No route to host`);
    if (!dest.services.has("ssh")) return fail(`ssh: connect to host ${host} port 22: Connection refused`);
    if (dest === sh.server) return fail("Ya estás en ese servidor.");
    sh.pending = {
      prompt: `${user}@${host}'s password: `, secret: true,
      answer: (p) => {
        if (!dest.os || user !== dest.os.user || p !== dest.os.password) {
          logLine(dest, LOGS.auth, sh.world.logStamp(), "sshd[1201]", `Failed password for ${user} from ${sh.server.ip} port 50122 ssh2`);
          return ["Permission denied, please try again."];
        }
        logLine(dest, LOGS.auth, sh.world.logStamp(), "sshd[1201]", `Accepted password for ${user} from ${sh.server.ip} port 50122 ssh2`);
        sh.enter(dest.id);
        return [`Conectado a ${dest.hostname}. (exit para volver)`];
      },
    };
    return ok();
  },
  curl: (sh, args) => {
    const url = args.find((a) => !a.startsWith("-"));
    if (!url) return fail("uso: curl http://<ip o dominio>[:puerto]/ruta");
    const m = /^(?:https?:\/\/)?([^/:]+)(?::(\d+))?(\/.*)?$/.exec(url);
    if (!m) return fail(`curl: URL inválida: ${url}`);
    const [, hostName, portRaw, path = "/"] = m;
    if (hostName === "foro.undernet.test") {
      const err = needInternet(sh);
      if (err) return fail(`curl: ${err}`);
      return ok(...forumPage(sh, path));
    }
    const h = resolve(sh, hostName);
    const err = h && isLocal(h.ip) ? needLink(sh) : needInternet(sh);
    if (err) return fail(`curl: ${err}`);
    const port = Number(portRaw ?? 80);
    const p = h?.ports.find((x) => x.port === port);
    if (!h || !p) return fail(`curl: (7) Failed to connect to ${hostName} port ${port}: Connection refused`);
    return ok(...(p.banner ?? `<html><body>${p.version}</body></html>`).split("\n"));
  },
  nc: (sh, args) => {
    const [host, portRaw] = args.filter((a) => !a.startsWith("-"));
    if (!host || !portRaw) return fail("uso: nc <ip> <puerto>");
    const h = resolve(sh, host);
    const err = h && isLocal(h.ip) ? needLink(sh) : needInternet(sh);
    if (err) return fail(`nc: ${err}`);
    const p = h?.ports.find((x) => x.port === Number(portRaw));
    if (!h || !p) return fail(`nc: connect to ${host} port ${portRaw} (tcp) failed: Connection refused`);
    return ok(...(p.banner ?? `${p.version}`).split("\n"));
  },
  ss: (sh) => netstat(sh),
  netstat: (sh) => netstat(sh),
  traceroute: (sh, args) => {
    const h = args[0] ? resolve(sh, args[0]) : null;
    const err = needInternet(sh);
    if (err) return fail(`traceroute: ${err}`);
    if (!h) return fail(`traceroute: ${args[0] ?? "?"}: no se encontró el equipo`);
    if (isLocal(h.ip)) return ok(`traceroute a ${h.ip}`, ` 1  ${h.ip}  0.4 ms`);
    return ok(`traceroute a ${h.ip}`, ` 1  10.0.0.1 (router)  0.5 ms`, ` 2  isp-borde.test  8.1 ms`, ` 3  * * *`, ` 4  ${h.ip} (${h.name})  41.2 ms`);
  },
  nmap: (sh, args) => {
    const o = opts(args, ["p"]);
    const target = o.rest[0];
    if (!target) return fail("uso: nmap [-sn] [-sV] [-p 22,80] <ip | 10.0.0.0/24 | dominio>");
    const sn = o.flags.has("s") && args.some((a) => a === "-sn");
    const sv = args.some((a) => a === "-sV");
    if (target.endsWith("/24")) {
      const err = needLink(sh);
      if (err) return fail(`nmap: ${err}`);
      if (!target.startsWith("10.0.0.")) return fail("nmap: solo puedes escanear tu red (10.0.0.0/24) o equipos de uno en uno.");
      const hosts = localHosts(sh).filter((h) => h.up);
      return ok(`Escaneando ${target}…`, ...hosts.map((h) => `Equipo activo: ${h.ip.padEnd(12)} ${h.name}`), `${hosts.length} equipos activos.`);
    }
    const h = resolve(sh, target);
    const err = h && isLocal(h.ip) ? needLink(sh) : needInternet(sh);
    if (err) return fail(`nmap: ${err}`);
    if (!h || !h.up) return fail(`Nmap: el equipo ${target} parece apagado o no existe.`);
    if (sn) return ok(`Equipo activo: ${h.ip} (${h.name})`);
    const only = o.values.p ? o.values.p.split(",").map(Number) : null;
    const ports = h.ports.filter((p) => !only || only.includes(p.port));
    if (!ports.length) return ok(`Informe de nmap para ${h.name} (${h.ip})`, "Todos los 1000 puertos escaneados están filtrados (un computador de casa no ofrece servicios).");
    return ok(`Informe de nmap para ${h.name} (${h.ip})`, `PUERTO     ESTADO  SERVICIO${sv ? "      VERSIÓN" : ""}`, ...ports.map((p) => `${`${p.port}/tcp`.padEnd(10)} open    ${p.service.padEnd(12)}${sv ? "  " + p.version : ""}`), ...(sv ? [] : ["(nmap -sV muestra qué programa hay en cada puerto)"]));
  },
  whois: (sh, args) => {
    const t = args[0];
    if (!t) return fail("uso: whois <ip o dominio>");
    const err = needInternet(sh);
    if (err) return fail(`whois: ${err}`);
    const sec = sh.world.security;
    const d = sec.domains.get(t);
    if (d) return ok(`Dominio: ${d.name}`, `Registrador: ${d.registrar}`, `Creado: ${d.created}`, `Registrado desde la IP: ${d.registeredFrom}`, "Titular: (privado)");
    if (!isIp(t)) return fail(`No se encontró ${t}.`);
    if (isLocal(t)) return ok("Dirección privada (red local de la tienda). No está en internet.");
    const h = sec.hosts.get(t);
    if (!h) return ok(`inetnum: ${t}`, "Titular: conexión residencial (sin más datos)");
    const lines = [`inetnum: ${h.ip}`, `Titular: ${h.owner}`, `País: ${h.country} · Ciudad: ${h.city}`];
    if (h.kind === "vpn") lines.push("Comentario: servicio de VPN. No guarda registros de sus clientes.");
    if (h.kind === "proxy") lines.push("Comentario: proxy abierto conocido. Cualquiera puede usarlo para esconder su IP.");
    if (h.kind === "vps") lines.push("Comentario: servidor virtual alquilado.");
    if (h.kind === "botnet") lines.push("Listas negras: reportado como equipo infectado (botnet) — su dueño probablemente no lo sabe.");
    if (h.kind === "hogar" || h.kind === "botnet") lines.push("Tipo: conexión de hogar (una persona)");
    return ok(...lines);
  },
  dig: (sh, args) => {
    const o = opts(args);
    const err = needInternet(sh);
    if (err) return fail(`dig: ${err}`);
    if (args.includes("-x")) {
      const ip = o.rest[0];
      const h = sh.world.security.hosts.get(ip);
      return ok(`;; ANSWER SECTION:`, h ? `${ip.split(".").reverse().join(".")}.in-addr.arpa. PTR ${ptr(h)}.` : ";; (sin nombre)");
    }
    const name = o.rest[0];
    if (!name) return fail("uso: dig <dominio>   o   dig -x <ip>");
    const d = sh.world.security.domains.get(name);
    if (name === "foro.undernet.test") return ok(";; ANSWER SECTION:", `${name}. 300 IN A 203.0.113.250`);
    return ok(";; ANSWER SECTION:", d ? `${name}. 300 IN A ${d.ip}` : `;; ${name}: NXDOMAIN (no existe)`);
  },
  nslookup: (sh, args) => COMMANDS.dig(sh, args, null),
  geoiplookup: (sh, args) => {
    const ip = args[0];
    if (!ip) return fail("uso: geoiplookup <ip>");
    if (isLocal(ip)) return ok("GeoIP: dirección privada (red local)");
    const h = sh.world.security.hosts.get(ip);
    if (!h) return ok("GeoIP: IP Address not found");
    const tz = h.tz >= 0 ? `+${h.tz}` : String(h.tz);
    return ok(`GeoIP Country Edition: ${h.country}`, `GeoIP City: ${h.city} · Zona horaria: UTC${tz}`);
  },
  geoip: (sh, args) => COMMANDS.geoiplookup(sh, args, null),
  tcpdump: (sh) => {
    const s = sh.server;
    const w = sh.world;
    const lines = ["tcpdump: escuchando en eth0 (10 paquetes)"];
    const t = w.logStamp().slice(7);
    const ownIp = s.ip ?? "0.0.0.0";
    const c = w.security.openCases().find((x) => x.serverId === s.id);
    for (let i = 0; i < 10; i++) {
      if (s.ddos && c?.deviceIp) lines.push(`${t}.${i}0 IP ${c.deviceIp}.${40000 + i} > ${ownIp}.80: Flags [S], length 0`);
      else if (s.ddos && c?.botnet.length) lines.push(`${t}.${i}0 IP ${c.botnet[i % c.botnet.length]}.${40000 + i} > ${ownIp}.80: Flags [S], length 0`);
      else if (s.malware && s.malware.respawnAt === null && w.security.connections.has(s.malware.pid)) {
        const conn = w.security.connections.get(s.malware.pid)!;
        lines.push(`${t}.${i}0 IP ${conn.local} > ${conn.remote}: Flags [P.], length ${64 + i}`);
      } else {
        const r = w.robotsOn(s)[i % Math.max(1, w.robotsOn(s).length)];
        lines.push(r ? `${t}.${i}0 IP ${ownIp}.7000 > ${r.ip}.7001: robot-agent, length 32` : `${t}.${i}0 IP 10.0.0.1.53 > ${ownIp}.53000: DNS, length 48`);
      }
    }
    return ok(...lines);
  },

  // ── seguridad ──
  ufw: (sh, args) => {
    const s = sh.server;
    const [action, ...rest] = args;
    if (action === "enable") {
      s.ufw.enabled = true;
      sh.world.emitServer(s, "firewall");
      return ok("El firewall está activo y arranca al encender.");
    }
    if (action === "disable") {
      s.ufw.enabled = false;
      return ok("Firewall detenido.");
    }
    if (action === "deny" && rest[0] === "from" && rest[1]) {
      s.ufw.deny.push(rest[1]);
      sh.world.blocked(s, rest[1]);
      return ok(`Regla agregada: bloquear todo lo que venga de ${rest[1]}${s.ufw.enabled ? "" : " (ojo: el firewall está apagado, ufw enable)"}`);
    }
    if ((action === "allow" || action === "deny") && rest[0]) return ok(`Regla agregada: ${action} ${rest[0]}`);
    if (action === "status" || !action) {
      return ok(`Estado: ${s.ufw.enabled ? "activo" : "inactivo"}`, ...s.ufw.deny.map((ip) => `Cualquiera  DENY  ${ip}`));
    }
    return fail("uso: ufw enable | disable | status | deny from <ip>");
  },
  "fail2ban-client": (sh) => {
    const s = sh.server;
    if (!s.services.has("fail2ban")) return fail("ERROR: fail2ban no está corriendo (systemctl start fail2ban)");
    return ok("Jail: sshd", `IPs bloqueadas: ${[...s.banned].join(" ") || "(ninguna)"}`);
  },
  freshclam: (sh) => {
    const err = needInternet(sh);
    if (err) return fail(`freshclam: ${err}`);
    sh.server.avDay = sh.world.day;
    return ok("Descargando firmas nuevas…", `✓ Firmas del antivirus al día (día ${sh.world.day}).`);
  },
  clamscan: (sh, args) => {
    const o = opts(args);
    const s = sh.server;
    const root = sh.path(o.rest[0] ?? ".");
    const lines: string[] = [];
    let found = 0;
    let scanned = 0;
    const visit = (p: string) => {
      if (s.fs.isDir(p)) {
        if (p !== root && !o.flags.has("r")) return;
        for (const n of s.fs.list(p, true) ?? []) visit(p === "/" ? `/${n}` : `${p}/${n}`);
        return;
      }
      scanned++;
      if (s.malware && s.malware.path === p) {
        if (s.avDay >= s.malware.day) {
          found++;
          lines.push(`${p}: Linux.Malware.${s.malware.name} FOUND`);
          if (o.flags.has("--remove")) {
            s.fs.remove(p);
            sh.world.fileRemoved(s, p);
            lines.push(`${p}: Removed.`);
          }
        } else lines.push(`${p}: OK`);
      }
    };
    visit(root);
    lines.push("", "----------- RESUMEN -----------", `Archivos revisados: ${scanned}`, `Infectados: ${found}`);
    if (s.avDay < sh.world.day) lines.push(`⚠ Las firmas son del día ${s.avDay || "?"}: el malware nuevo no se detecta. Actualiza con freshclam.`);
    return ok(...lines);
  },
  last: (sh) => ok(...input(sh, [LOGS.auth], null, "last").filter((l) => l.includes("Accepted")).map((l) => l.replace(/^.*Accepted password for (\S+) from (\S+).*$/, "$1  ssh  $2")), "", "wtmp empieza con la instalación"),
  who: (sh) => ok(`${sh.user}  pts/0  ${sh.world.logStamp()}`),
  mail: (sh) => {
    const t = sh.server.fs.read(`/var/mail/${sh.user}`) ?? "";
    return t.trim() ? ok(...splitLines(t)) : ok(`No hay correo para ${sh.user}`);
  },

  // ── robots ──
  robot: (sh, args) => {
    const s = sh.server;
    const w = sh.world;
    const [action, ip] = args;
    const list = () => w.robots.map((r) => `${r.ip.padEnd(11)} ${r.name.padEnd(5)} ${r.cpu.server ? `→ ${w.server(r.cpu.server)?.hostname ?? r.cpu.server}` : "sin servidor"}${w.isRunning(r.id) ? " · corriendo" : ""}`);
    if (!action || action === "list" || action === "status") return ok("IP          ROBOT  SERVIDOR", ...list());
    if (!s.services.has("robot-agent")) return fail("robot: el servicio robot-agent no está corriendo (systemctl enable --now robot-agent)");
    const err = needLink(sh);
    if (err) return fail(`robot: ${err}`);
    const r = w.robots.find((x) => x.ip === ip || x.id === ip);
    if (!r) return fail(`robot: no hay ningún robot en ${ip ?? "?"} (robot list)`);
    if (action === "attach") {
      w.attach(r.id, s.id);
      return ok(`✓ ${r.name} (${r.ip}) ahora ejecuta su código en ${s.hostname}.`);
    }
    if (action === "detach") {
      if (r.cpu.server !== s.id) return fail(`${r.name} no está conectado a ${s.hostname}.`);
      w.attach(r.id, null);
      return ok(`${r.name} quedó sin servidor.`);
    }
    return fail("uso: robot list | robot attach <ip> | robot detach <ip>");
  },
};

function apt(sh: Shell, args: string[]): CommandResult {
  const s = sh.server;
  const [action, ...rest] = args.filter((a) => a !== "-y");
  if (action === "list") return ok(...[...s.packages].sort().map((p) => `${p} [instalado]`));
  if (action === "search") return ok(...Object.entries(PACKAGES).filter(([n, p]) => !rest[0] || n.includes(rest[0]) || p.about.toLowerCase().includes(rest[0].toLowerCase())).map(([n, p]) => `${n} — ${p.about}`));
  const err = needInternet(sh);
  if (err) return fail(`E: No se pudo conectar a deb.laesquina.test: ${err}`);
  if (action === "update") return ok("Obj:1 http://deb.laesquina.test estable InRelease", "Leyendo lista de paquetes… Hecho");
  if (action === "upgrade") return ok("Calculando la actualización… Hecho", "0 actualizados (todo está al día).");
  if (action === "install") {
    if (!rest.length) return fail("uso: apt install <paquete>");
    const out: string[] = [];
    for (const name of rest) {
      const p = PACKAGES[name];
      if (!p) {
        out.push(`E: No se encontró el paquete ${name}${name === "strings" ? " (está en binutils)" : name === "netstat" ? " (está en net-tools)" : name === "dig" ? " (está en dnsutils)" : ""}`);
        continue;
      }
      if (s.packages.has(name)) {
        out.push(`${name} ya está instalado.`);
        continue;
      }
      s.packages.add(name);
      if (name === "cowrie") s.fs.write(LOGS.cowrie, "");
      if (name === "clamav") s.avDay = Math.max(s.avDay, sh.world.day - 1);
      logLine(s, LOGS.syslog, sh.world.logStamp(), "apt", `instalado ${name}`);
      out.push(`Descargando ${name}… ✓`, `Configurando ${name}… ✓`);
      if (p.services?.length) out.push(`Para arrancarlo: systemctl enable --now ${p.services[0]}`);
      sh.world.emitServer(s, `paquete ${name}`);
    }
    return { lines: out, failed: out.some((l) => l.startsWith("E:")) };
  }
  if (action === "remove" || action === "purge") {
    for (const name of rest) {
      s.packages.delete(name);
      for (const svc of PACKAGES[name]?.services ?? []) s.services.delete(svc);
    }
    return ok("Hecho.");
  }
  return fail("uso: apt install|remove|update|upgrade|search|list <paquete>");
}

function netstat(sh: Shell): CommandResult {
  const s = sh.server;
  const w = sh.world;
  const ip = s.ip ?? "0.0.0.0";
  const lines = ["Proto Dirección local        Dirección remota       Estado       PID/Programa"];
  if (s.services.has("ssh")) lines.push(`tcp   0.0.0.0:22               0.0.0.0:*              LISTEN       412/sshd`);
  if (s.packages.has("robot-agent")) lines.push(`tcp   0.0.0.0:80               0.0.0.0:*              LISTEN       530/nginx`);
  if (s.services.has("robot-agent")) lines.push(`tcp   0.0.0.0:7000             0.0.0.0:*              LISTEN       501/robot-agent`);
  if (s.services.has("cowrie")) lines.push(`tcp   0.0.0.0:2222             0.0.0.0:*              LISTEN       700/cowrie`);
  for (const r of w.robotsOn(s)) if (w.isRunning(r.id)) lines.push(`tcp   ${`${ip}:7000`.padEnd(24)} ${`${r.ip}:7001`.padEnd(22)} ESTABLISHED  501/robot-agent`);
  if (s.malware && s.malware.respawnAt === null) {
    const conn = w.security.connections.get(s.malware.pid);
    const c = w.security.case(s.malware.caseId ?? -1);
    const remote = conn?.remote ?? (c?.domain ? `${w.security.domains.get(c.domain)?.ip}:3333` : null);
    if (remote) lines.push(`tcp   ${`${ip}:${conn ? conn.local.split(":")[1] : 51544}`.padEnd(24)} ${remote.padEnd(22)} ESTABLISHED  ${s.malware.pid}/${s.malware.name}`);
  }
  const c = w.security.openCases().find((x) => x.serverId === s.id);
  if (s.ddos && c) {
    const from = c.deviceIp ? [c.deviceIp] : c.botnet.length ? c.botnet : [];
    for (const src of from.slice(0, 8)) lines.push(`tcp   ${`${ip}:80`.padEnd(24)} ${`${src}:${40000 + src.length}`.padEnd(22)} SYN_RECV     -`);
  }
  return ok(...lines);
}

/** El foro de hackers (ficticio): portada, perfiles y búsqueda. */
export function forumPage(sh: Shell, path: string): string[] {
  const sec = sh.world.security;
  const user = /^\/u\/([\w-]+)/.exec(path)?.[1] ?? /[?&]q=([\w-]+)/.exec(path)?.[1];
  if (user) {
    const posts = sec.forum.filter((p) => p.user === user);
    if (!posts.length) return [`Foro UnderNet — no hay ningún usuario "${user}".`];
    return [
      `Foro UnderNet — perfil de ${user}`,
      `Mensajes: ${posts.length}`,
      `Última conexión desde: ${sec.profiles[user] ?? "(oculta)"}`,
      "",
      ...posts.map((p) => `[día ${p.day}] ${p.text}`),
    ];
  }
  return ["Foro UnderNet — últimos mensajes", "", ...sec.forum.slice(-10).reverse().map((p) => `${p.user}: ${p.text}`), "", "Perfiles: /u/<usuario>"];
}

export { SECURITY };
