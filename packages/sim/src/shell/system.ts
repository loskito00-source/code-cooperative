import { GAME_START_MS } from "../config.js";
import type { Server } from "../servers.js";

/** Paquetes que se pueden instalar con apt: qué comandos y servicios traen. */
export const PACKAGES: Record<string, { commands: string[]; services?: string[]; about: string }> = {
  "robot-agent": { commands: ["robot"], services: ["robot-agent"], about: "Agente que ejecuta el código de los robots" },
  "openssh-server": { commands: [], services: ["ssh"], about: "Servidor SSH" },
  nmap: { commands: ["nmap"], about: "Escáner de red y de puertos" },
  whois: { commands: ["whois"], about: "Quién es el dueño de una IP o un dominio" },
  dnsutils: { commands: ["dig", "nslookup"], about: "Consultas DNS" },
  "net-tools": { commands: ["netstat"], about: "netstat: conexiones de red" },
  tcpdump: { commands: ["tcpdump"], about: "Captura de tráfico de red" },
  traceroute: { commands: ["traceroute"], about: "Ruta de los paquetes hasta un equipo" },
  "geoip-bin": { commands: ["geoiplookup", "geoip"], about: "País, ciudad y zona horaria de una IP" },
  binutils: { commands: ["strings"], about: "strings: textos dentro de un programa" },
  fail2ban: { commands: ["fail2ban-client"], services: ["fail2ban"], about: "Bloquea IPs que fallan la contraseña muchas veces" },
  clamav: { commands: ["clamscan", "freshclam"], services: ["clamav-freshclam"], about: "Antivirus (clamscan) y sus firmas (freshclam)" },
  cowrie: { commands: [], services: ["cowrie"], about: "Trampa (honeypot) SSH que registra todo lo que hace el atacante" },
};

/** Comandos que trae Linux recién instalado. */
export const BASE_COMMANDS = [
  "help", "ls", "cd", "pwd", "cat", "less", "more", "head", "tail", "grep", "sort", "uniq", "wc", "awk", "cut", "echo", "clear",
  "whoami", "hostname", "hostnamectl", "date", "uptime", "history", "rm", "file", "sha256sum", "top", "htop", "ps", "kill",
  "free", "df", "nproc", "lscpu", "sensors", "systemctl", "journalctl", "apt", "apt-get", "passwd", "ip", "ping", "ssh", "exit",
  "curl", "nc", "ss", "ufw", "last", "who", "mail",
];

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** Fecha y hora estilo syslog ("ene  6 03:12:44") del día `day` del juego a la hora `hour` (7.5 = 7:30). */
export function stamp(day: number, hour: number, sec = 0): string {
  const d = new Date(GAME_START_MS + (day - 1) * 86_400_000 + Math.floor(hour * 3600 + sec) * 1000);
  const dd = String(d.getUTCDate()).padStart(2, " ");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${MESES[d.getUTCMonth()]} ${dd} ${hh}:${mm}:${ss}`;
}

/** Fecha estilo nginx ("06/ene/2026:03:12:44 -0500"). */
export function webStamp(day: number, hour: number, sec = 0): string {
  const d = new Date(GAME_START_MS + (day - 1) * 86_400_000 + Math.floor(hour * 3600 + sec) * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${MESES[d.getUTCMonth()]}/${d.getUTCFullYear()}:${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} -0500`;
}

export const LOGS = {
  auth: "/var/log/auth.log",
  syslog: "/var/log/syslog",
  ufw: "/var/log/ufw.log",
  nginx: "/var/log/nginx/access.log",
  fail2ban: "/var/log/fail2ban.log",
  cowrie: "/var/log/cowrie/cowrie.log",
};

/** Escribe una línea en un log con el formato de syslog. */
export function logLine(s: Server, file: string, when: string, proc: string, text: string): void {
  s.fs.append(file, `${when} ${s.hostname} ${proc}: ${text}`);
}

/** Archivos de un Linux recién instalado. */
export function initFs(s: Server, when: string): void {
  const fs = s.fs;
  for (const d of ["/etc", "/home", "/root", "/tmp", "/usr/bin", "/var/log/nginx", "/var/mail", "/proc", "/opt"]) fs.mkdir(d);
  const user = s.os!.user;
  fs.mkdir(`/home/${user}`);
  fs.write(`/home/${user}/LEEME.txt`, [
    "Bienvenido a tu servidor.",
    "",
    "1. Configura la red:     ip addr add 10.0.0.10/24 dev eth0",
    "                         ip route add default via 10.0.0.1",
    "2. Prueba la conexión:   ping 10.0.0.1",
    "3. Instala el agente:    apt install robot-agent",
    "4. Arráncalo:            systemctl enable --now robot-agent",
    "5. Conecta los robots:   robot attach 10.0.0.21   (Toño)",
    "                         robot attach 10.0.0.22   (Lupe)",
    "",
    "Escribe help para ver todos los comandos.",
  ].join("\n"));
  fs.write("/etc/hostname", () => s.hostname + "\n");
  fs.write("/etc/os-release", 'NAME="Linux de La Esquina"\nVERSION="1.0"\n');
  fs.write("/proc/cpuinfo", () => Array.from({ length: s.cores }, (_, i) => `processor\t: ${i}\nmodel name\t: CPU del servidor\n`).join("\n"));
  fs.write("/proc/meminfo", () => `MemTotal:       ${s.ramGb * 1024 * 1024} kB\n`);
  for (const f of Object.values(LOGS)) if (f !== LOGS.cowrie) fs.write(f, "");
  fs.write(`/var/mail/${user}`, "");
  logLine(s, LOGS.syslog, when, "systemd[1]", "Linux de La Esquina 1.0 arrancó.");
}
