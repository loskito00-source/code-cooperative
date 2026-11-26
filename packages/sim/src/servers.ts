import { CPU_OPS, SERVER } from "./config.js";
import { type Build, emptyBuild } from "./hardware.js";
import { VFS } from "./shell/vfs.js";

/**
 * Servidores del cuarto de servidores (docs/servidores.md).
 * El código de los robots corre en un servidor: la CPU se reparte entre sus robots. Si la carga pasa de
 * SERVER.slowFrom, TODOS sus robots van más lentos. También frenan: un DDoS (red saturada), un minero (malware que
 * roba CPU) y la temperatura alta. Un robot sin servidor listo no puede ejecutar código.
 */
export interface Server {
  id: string;
  hostname: string;
  /** IP en la red de la tienda (null = sin configurar). */
  ip: string | null;
  gateway: string | null;
  /** Puesto del rack donde está montado (-1 = servidor de prueba sin hardware). */
  rack: number;
  build: Build;
  /** Núcleos de la CPU: cada robot usa como mucho uno. */
  cores: number;
  /** Velocidad de la CPU (índice de CPU_OPS): operaciones por tick de cada núcleo. */
  cpuLevel: number;
  ramGb: number;
  gpu: boolean;
  /** Ventiladores dentro del chasis. */
  cooling: number;
  /** Tiene el cable de red conectado al switch. */
  cable: boolean;
  /** Encendido. */
  online: boolean;
  /** Con la tapa abierta para cambiar piezas (apagado): su montaje vuelve a estar en el puesto del rack. */
  maintenance?: boolean;
  /** Linux instalado (null = arranca al instalador). */
  os: { user: string; password: string } | null;
  packages: Set<string>;
  /** Servicios corriendo. */
  services: Set<string>;
  /** Servicios que arrancan solos al encender. */
  enabled: Set<string>;
  ufw: { enabled: boolean; deny: string[] };
  fs: VFS;
  /** Carga de CPU suavizada (0 = libre, 1 = al 100%). */
  load: number;
  /** Operaciones que usaron sus robots en el último tick. */
  lastOps: number;
  /** Temperatura en °C (suavizada). */
  temp: number;
  /** Malware corriendo (un minero que roba CPU). */
  malware: Malware | null;
  /** DDoS en curso: fracción de la red saturada (0 = nada) y ticks que le quedan. */
  ddos: { base: number; level: number; ticks: number; caseId: number | null } | null;
  /** Día de las firmas del antivirus (freshclam): detecta malware de ese día o anterior. */
  avDay: number;
  /** Intentos fallidos recientes por IP (fail2ban bloquea al llegar a 5). */
  failed: Map<string, number>;
  banned: Set<string>;
  nextPid: number;
}

export interface Malware {
  pid: number;
  name: string;
  path: string;
  /** Fracción de la CPU que roba (0..1). */
  steal: number;
  /** Día en que apareció (el antivirus necesita firmas de ese día). */
  day: number;
  /** Si se mata el proceso pero el archivo sigue, vuelve a arrancar en este tick. */
  respawnAt: number | null;
  /** Caso de investigación que lo trajo. */
  caseId: number | null;
}

/** Lo que el mundo guarda de cada robot para repartir la CPU. */
export interface RobotCpu {
  /** Servidor donde corre su código (null = desconectado). */
  server: string | null;
  /** Operaciones que usó en el último tick que pensó. */
  lastOps: number;
  /** Presupuesto que tenía en ese tick (si lo gastó todo, quiere más). */
  lastBudget: number;
  /** Acumulador para ir más lento: cuando el servidor está saturado, no piensa todos los ticks. */
  clock: number;
  pid: number;
}

/** Un servidor recién montado: encendido, pero sin Linux ni red. */
export function makeBlankServer(id: string, rack: number, build: Build, spec: { cores: number; speed: number; ramGb: number; gpu: boolean; cooling: number; cable: boolean }): Server {
  return {
    id, hostname: "localhost", ip: null, gateway: null, rack, build,
    cores: spec.cores, cpuLevel: spec.speed, ramGb: spec.ramGb, gpu: spec.gpu, cooling: spec.cooling, cable: spec.cable,
    online: true, os: null, packages: new Set(), services: new Set(), enabled: new Set(), ufw: { enabled: false, deny: [] },
    fs: new VFS(), load: 0, lastOps: 0, temp: 30, malware: null, ddos: null, avDay: 0, failed: new Map(), banned: new Set(), nextPid: 2000,
  };
}

/** Un servidor ya listo (Linux, red y robot-agent): el de las pruebas y el de "Saltar". */
export function makeServer(id: string, hostname: string, ip: string, cores: number, ramGb: number): Server {
  const s = makeBlankServer(id, -1, emptyBuild(), { cores, speed: 0, ramGb, gpu: false, cooling: 0, cable: true });
  s.hostname = hostname;
  s.ip = ip;
  s.gateway = SERVER.gateway;
  s.os = { user: "admin", password: "tienda-la-esquina-2026" };
  for (const p of ["robot-agent", "openssh-server"]) s.packages.add(p);
  for (const svc of ["robot-agent", "ssh"]) {
    s.services.add(svc);
    s.enabled.add(svc);
  }
  return s;
}

/** Por qué un robot no puede correr en este servidor (null = puede). */
export function notReady(s: Server): string | null {
  if (s.maintenance) return `el servidor ${s.hostname} está abierto para cambiarle piezas`;
  if (!s.online) return `el servidor ${s.hostname} está apagado`;
  if (!s.os) return `el servidor ${s.hostname} no tiene Linux instalado`;
  if (!s.packages.has("robot-agent")) return `${s.hostname} no tiene instalado robot-agent (apt install robot-agent)`;
  if (!s.services.has("robot-agent")) return `el servicio robot-agent no está corriendo en ${s.hostname} (systemctl start robot-agent)`;
  return null;
}

/** Operaciones por tick de un núcleo. */
export const opsPerCore = (s: Server): number => CPU_OPS[Math.min(s.cpuLevel, CPU_OPS.length - 1)];

/** Operaciones por tick de todo el servidor. */
export const capacity = (s: Server): number => s.cores * opsPerCore(s);

/** Cuánto más lento van los robots del servidor: 1 = normal, 2 = a la mitad de velocidad... */
export function slowdown(s: Server | null): number {
  if (!s) return 1;
  let f = 1;
  if (s.load > SERVER.slowFrom) {
    const k = Math.min(1, (s.load - SERVER.slowFrom) / (1 - SERVER.slowFrom));
    f = 1 + k * (SERVER.maxSlowdown - 1);
  }
  // red saturada: cada orden al robot tarda más en llegar
  if (s.ddos) f = Math.max(f, 1 + s.ddos.level * (SERVER.maxSlowdown - 1));
  // CPU caliente: baja su velocidad sola para no quemarse
  if (s.temp > SERVER.throttleTemp) f *= SERVER.thermalSlowdown;
  return f;
}

/** RAM que queda libre si corren `procs` robots. */
export const freeRam = (s: Server, procs: number): number => s.ramGb - SERVER.osRamGb - procs * SERVER.robotRamGb;

/**
 * Presupuesto de operaciones de cada robot para este tick. Si lo que piden todos cabe en la CPU, cada uno puede usar
 * un núcleo entero; si no, la CPU se reparte en proporción a lo que pidieron (un bucle sin wait() pide todo).
 * `reserved` es CPU que ya se llevó otro (el malware).
 */
export function shareCpu(s: Server, robots: RobotCpu[], reserved = 0): number[] {
  const perCore = opsPerCore(s);
  const demand = robots.map((r) => (r.lastBudget > 0 && r.lastOps >= r.lastBudget ? perCore : Math.max(1, r.lastOps)));
  const total = demand.reduce((a, b) => a + b, 0);
  const cap = Math.max(1, capacity(s) - reserved);
  if (total <= cap) return robots.map(() => perCore);
  return demand.map((d) => Math.max(1, Math.min(perCore, Math.floor((cap * d) / total))));
}

/** Actualiza la carga suavizada (≈ 1 segundo de memoria) con las operaciones del último tick. */
export function updateLoad(s: Server, opsUsed: number): void {
  s.lastOps = opsUsed;
  const now = Math.min(1, opsUsed / Math.max(1, capacity(s)));
  s.load += (now - s.load) * SERVER.smoothing;
  if (s.load < 0.001) s.load = 0;
}

/** La temperatura sigue a la carga; los ventiladores y el aire acondicionado la bajan. */
export function updateTemp(s: Server, aircon: boolean): void {
  const target = s.online
    ? SERVER.tempIdle + s.load * SERVER.tempPerLoad + (s.gpu ? 8 : 0) - s.cooling * SERVER.fanCooling - (aircon ? SERVER.airconCooling : 0)
    : 22;
  s.temp += (target - s.temp) * 0.01;
}
