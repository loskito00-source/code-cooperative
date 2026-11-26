import { SECURITY } from "./config.js";
import { CITIES, type Domain, freshIp, type HostKind, type InternetHost, ownerFor, type Port } from "./network.js";
import { Rng } from "./rng.js";
import type { Server } from "./servers.js";
import { LOGS, logLine, stamp, webStamp } from "./shell/system.js";
import type { World } from "./world.js";

/**
 * Ataques y casos de investigación (docs/servidores.md §5–§8).
 * CASO = tipo de ataque + escondites (0–2 proxies) + el error del atacante (la técnica) + señuelos.
 * Los ataques solo frenan (roban CPU, saturan la red): nunca borran el código ni los datos del jugador.
 */

export type Technique =
  | "vpn_caida" | "malware_strings" | "conexion_viva" | "sqli" | "phishing"
  | "foro" | "honeypot" | "horario" | "interno" | "dominio";

export type AttackKind = "fuerza_bruta" | "malware" | "ddos" | "sqli" | "phishing";
export type Decoy = "bandera_falsa" | "logs_borrados" | "ip_dinamica";

export interface TechniqueDef {
  id: Technique;
  name: string;
  attack: AttackKind;
  /** Proxies que puede tener la cadena (horario: ninguno, los sospechosos ya vienen dados). */
  proxies: boolean;
  decoys: Decoy[];
  hints: [string, string, string];
}

export const TECHNIQUES: TechniqueDef[] = [
  {
    id: "vpn_caida", name: "Se le cayó la VPN", attack: "fuerza_bruta", proxies: true, decoys: ["bandera_falsa", "logs_borrados", "ip_dinamica"],
    hints: [
      "Revisa /var/log/auth.log: ¿desde qué IPs intentaron entrar? (grep \"Failed\" ... | awk ... | sort | uniq -c)",
      "Casi todo viene de una VPN. ¿Hay algún intento con el MISMO usuario desde otra IP? whois te dice de quién es cada una.",
      "La IP buena es la de una conexión residencial que usó el mismo usuario que la VPN, a una hora rara de la madrugada.",
    ],
  },
  {
    id: "malware_strings", name: "Malware que habla", attack: "malware", proxies: true, decoys: ["bandera_falsa", "ip_dinamica"],
    hints: [
      "Algo se está comiendo la CPU. Mira top o ps aux: ¿hay un proceso que no reconoces? ¿Dónde está su archivo?",
      "Los programas guardan textos adentro: strings <archivo> (apt install binutils). Busca una dirección.",
      "Con dig sabes la IP del dominio; con nmap -sV ves qué puertos tiene; con nc <ip> <puerto> ves quién lo maneja.",
    ],
  },
  {
    id: "conexion_viva", name: "Conexión en vivo", attack: "malware", proxies: true, decoys: ["ip_dinamica"],
    hints: [
      "Hay un proceso raro conectado a internet AHORA MISMO. netstat -tunap (apt install net-tools) o ss -tunap.",
      "Esa IP es un servidor alquilado (whois). ¿Qué servicios tiene? nmap -sV <ip>",
      "Tiene un panel web: curl http://<ip>:8080 muestra el último acceso del administrador.",
    ],
  },
  {
    id: "sqli", name: "Inyección SQL", attack: "sqli", proxies: true, decoys: ["bandera_falsa", "logs_borrados", "ip_dinamica"],
    hints: [
      "Atacaron la página de pedidos en línea. Revisa /var/log/nginx/access.log.",
      "Busca peticiones con SQL raro: grep \"OR 1=1\" /var/log/nginx/access.log",
      "Cuenta por IP quién mandó más inyecciones: ... | awk '{print $1}' | sort | uniq -c | sort -nr",
    ],
  },
  {
    id: "phishing", name: "Correo de phishing", attack: "phishing", proxies: true, decoys: ["ip_dinamica"],
    hints: [
      "Llegó un correo que dice ser del distribuidor. Léelo: mail (o cat /var/mail/<usuario>).",
      "Las cabeceras Received: dicen por dónde pasó el correo. La de más abajo es el origen.",
      "El servidor de correo de la tienda es de fiar; la IP que importa es la que está entre corchetes en el primer salto.",
    ],
  },
  {
    id: "foro", name: "Se delató en un foro", attack: "fuerza_bruta", proxies: true, decoys: ["logs_borrados", "ip_dinamica"],
    hints: [
      "El atacante usó una VPN, pero su herramienta se presenta con un apodo. grep \"by\" /var/log/auth.log",
      "Los hackers presumen en foros. Busca ese apodo en foro.undernet.test (Navegador) o con curl.",
      "El perfil del foro muestra desde qué IP se conectó por última vez.",
    ],
  },
  {
    id: "honeypot", name: "Trampa (honeypot)", attack: "fuerza_bruta", proxies: true, decoys: ["ip_dinamica"],
    hints: [
      "Este atacante es cuidadoso: todo viene de una VPN. Hay que dejarlo entrar a una trampa.",
      "apt install cowrie y systemctl start cowrie. Luego espera a que vuelva a intentar.",
      "Revisa /var/log/cowrie/cowrie.log: ¿desde dónde descarga sus herramientas (wget)?",
    ],
  },
  {
    id: "horario", name: "Horario sospechoso", attack: "fuerza_bruta", proxies: false, decoys: ["logs_borrados"],
    hints: [
      "La policía tiene 4 sospechosos (mira el caso en la página de denuncias). El perfil dice a qué hora ataca.",
      "Saca las horas de los ataques de auth.log (awk '{print $3}') y la zona horaria de cada sospechoso con geoiplookup.",
      "La tienda está en UTC-5. Pasa cada hora del log a la hora local de cada sospechoso: solo uno encaja con el perfil.",
    ],
  },
  {
    id: "interno", name: "El enemigo está adentro", attack: "ddos", proxies: true, decoys: ["ip_dinamica"],
    hints: [
      "El tráfico viene de ADENTRO de la red de la tienda. Escanea tu red: nmap -sn 10.0.0.0/24",
      "Hay un aparato que no deberías tener. nmap -sV <ip> para ver qué es. Bloquéalo: ufw deny from <ip>",
      "Ese aparato obedece a alguien: nc <ip> 23 dice a qué controlador está conectado. Sigue el rastro.",
    ],
  },
  {
    id: "dominio", name: "Dominio registrado", attack: "ddos", proxies: true, decoys: ["logs_borrados", "ip_dinamica"],
    hints: [
      "Un DDoS: miles de peticiones en /var/log/nginx/access.log. Las IPs son de una botnet (personas inocentes).",
      "Todas las peticiones traen el mismo navegador falso con una dirección web. awk -F'\"' '{print $6}' ... | sort | uniq -c",
      "whois <dominio> muestra desde qué IP se registró ese dominio.",
    ],
  },
];

export const techniqueDef = (t: Technique) => TECHNIQUES.find((x) => x.id === t)!;

export interface Suspect {
  ip: string;
  city: string;
  tz: number;
}

export interface Case {
  id: number;
  day: number;
  serverId: string;
  technique: Technique;
  attack: AttackKind;
  level: 1 | 2 | 3;
  /** IP real del atacante (residencial). */
  realIp: string;
  /** Cadena desde la primera IP que encuentra la técnica hasta la real: [proxy1, proxy2, real]. */
  chain: string[];
  decoys: Decoy[];
  /** IP de un inocente plantada (bandera falsa). */
  innocentIp: string | null;
  /** VPN / C2 / botnet del caso (para explicar por qué una IP no es). */
  vpnIp: string | null;
  c2Ip: string | null;
  botnet: string[];
  domain: string | null;
  nick: string | null;
  suspects: Suspect[];
  /** "El atacante actúa a las HH:00 de su hora local" (horario). */
  profileHour: number | null;
  deviceIp: string | null;
  status: "abierto" | "resuelto" | "fallido" | "vencido";
  attempts: number;
  hints: number;
  /** Primera vez que sale esta técnica: el técnico regala la primera pista. */
  freeHint: boolean;
  expiresDay: number;
  bounty: number;
  /** Ataque en curso (fuerza bruta). */
  brute: { ip: string; ticks: number; tries: number; banned: boolean; succeeded: boolean } | null;
  honeypot: { progress: number; done: boolean } | null;
}

export interface ForumPost {
  user: string;
  text: string;
  day: number;
}

/** Aparato de la red local (cámara, caja registradora...). */
export interface LocalDevice {
  ip: string;
  name: string;
  ports: Port[];
  caseId: number | null;
  /** Bloqueado con ufw deny from (deja de atacar). */
  blocked: boolean;
}

export interface ReportResult {
  ok: boolean;
  title: string;
  message: string;
  bounty?: number;
  reputation?: number;
}

const NICKS = ["n3krom4ncer", "z3r0c00l", "d4rkp1x3l", "ph4nt0m_ar", "gh0stbyte", "r00tk1ng", "b1tr4ider", "cr4ckm4n"];
const FORUM_USERS = ["sysop_juan", "la_maga", "pixel99", "byteHunter", "ana_sec", "elprofe"];
const C2_WORDS = ["actualizar", "cdn", "update", "sync", "nube", "seguro", "pagos", "drive"];

export class Security {
  readonly rng: Rng;
  readonly hosts = new Map<string, InternetHost>();
  readonly domains = new Map<string, Domain>();
  readonly forum: ForumPost[] = [];
  readonly devices: LocalDevice[] = [{ ip: "10.0.0.40", name: "caja-registradora", ports: [{ port: 443, service: "https", version: "Terminal de pagos" }], caseId: null, blocked: false }];
  readonly cases: Case[] = [];
  readonly seen = new Set<Technique>();
  /** Perfiles del foro: apodo → última IP desde la que se conectó. */
  readonly profiles: Record<string, string> = {};
  /** Conexiones abiertas de los procesos de malware (pid → remoto), para netstat/ss. */
  readonly connections = new Map<number, { remote: string; local: string }>();
  /** Tick del próximo ataque (null = ninguno programado). */
  nextAttack: number | null = null;
  private readonly used = new Set<string>();
  private nextId = 1;

  constructor(seed: number) {
    this.rng = new Rng(seed ^ 0x5eca);
    for (const user of FORUM_USERS) {
      this.forum.push({ user, day: 0, text: this.rng.pick(["¿Alguien sabe configurar fail2ban?", "Vendo tarjeta gráfica usada.", "Mi servidor se calienta mucho, ¿ventiladores?", "Tutorial: nmap para principiantes."]) });
    }
  }

  private ip(): string {
    return freshIp(this.used, () => this.rng.next());
  }

  host(kind: HostKind, caseId: number | null, ports: Port[] = [], place?: { city: string; country: string; tz: number }): InternetHost {
    const where = place ?? this.rng.pick(CITIES);
    const h: InternetHost = { ip: this.ip(), kind, owner: ownerFor(kind, (xs) => this.rng.pick(xs)), city: where.city, country: where.country, tz: where.tz, ports, caseId };
    this.hosts.set(h.ip, h);
    return h;
  }

  openCases(): Case[] {
    return this.cases.filter((c) => c.status === "abierto");
  }

  case(id: number): Case | undefined {
    return this.cases.find((c) => c.id === id);
  }

  /** Elige la técnica: no repite la del caso anterior y prefiere las que no se han visto. */
  pickTechnique(): Technique {
    const last = this.cases.at(-1)?.technique;
    const pool = TECHNIQUES.map((t) => t.id).filter((t) => t !== last);
    const unseen = pool.filter((t) => !this.seen.has(t));
    return this.rng.pick(unseen.length ? unseen : pool);
  }

  levelFor(day: number): 1 | 2 | 3 {
    if (day <= SECURITY.easyUntilDay) return 1;
    if (day <= SECURITY.mediumUntilDay) return this.rng.next() < 0.7 ? 2 : 1;
    return this.rng.next() < 0.6 ? 3 : 2;
  }

  /** Crea un caso y planta sus pistas en el servidor. */
  createCase(world: World, server: Server, technique: Technique, level: 1 | 2 | 3): Case {
    const def = techniqueDef(technique);
    const id = this.nextId++;
    const real = this.host("hogar", id);
    // escondites: proxies entre la primera pista y la IP real
    const nProxies = def.proxies ? level - 1 : 0;
    const chain: string[] = [real.ip];
    for (let i = 0; i < nProxies; i++) {
      const next = chain[0];
      const p = this.host("proxy", id, [
        { port: 3128, service: "http-proxy", version: "Squid 4.13 (proxy abierto)" },
        { port: 8080, service: "http", version: "Panel de estado del proxy", banner: `Proxy abierto — panel de estado\nConexiones activas: 1\nÚltimo cliente conectado: ${next}` },
      ]);
      chain.unshift(p.ip);
    }
    // señuelos según el nivel
    const decoys: Decoy[] = [];
    const options = [...def.decoys];
    for (let i = 0; i < level - 1 && options.length; i++) decoys.push(options.splice(this.rng.int(0, options.length - 1), 1)[0]);
    const c: Case = {
      id, day: world.day, serverId: server.id, technique, attack: def.attack, level, realIp: real.ip, chain, decoys,
      innocentIp: null, vpnIp: null, c2Ip: null, botnet: [], domain: null, nick: null, suspects: [], profileHour: null, deviceIp: null,
      status: "abierto", attempts: SECURITY.attempts, hints: 0, freeHint: !this.seen.has(technique),
      expiresDay: world.day + (decoys.includes("ip_dinamica") ? 1 : SECURITY.caseDays),
      bounty: SECURITY.bountyBase + SECURITY.bountyPerLevel * level + SECURITY.bountyPerProxy * nProxies,
      brute: null, honeypot: null,
    };
    if (decoys.includes("bandera_falsa")) c.innocentIp = this.host("hogar", id).ip;
    this.seen.add(technique);
    this.cases.push(c);
    plant(this, world, server, c);
    return c;
  }

  /** Clasifica una IP denunciada para explicar por qué no es. */
  explain(c: Case, ip: string): ReportResult {
    const h = this.hosts.get(ip);
    if (ip === c.realIp) return { ok: true, title: "", message: "" };
    if (/^10\.0\.0\.\d+$/.test(ip)) return { ok: false, title: "Esa IP es de tu propia red", message: "10.0.0.x es la red de la tienda. El atacante está afuera.", reputation: 0 };
    if (c.chain.includes(ip)) return { ok: false, title: "Es un proxy abierto", message: "El atacante pasó por ahí, pero no es él. Los proxies guardan quién se conectó: sigue el rastro.", reputation: 0 };
    if (ip === c.vpnIp || h?.kind === "vpn") return { ok: false, title: "Es un servicio de VPN", message: "Miles de personas usan esa VPN y no guarda registros. Busca el momento en que el atacante se descuidó.", reputation: 0 };
    if (ip === c.c2Ip || h?.kind === "vps") return { ok: false, title: "Es un servidor alquilado", message: "Es un servidor (de control o de correo) que el atacante usó, no la persona. ¿Quién lo maneja?", reputation: 0 };
    if (c.botnet.includes(ip) || h?.kind === "botnet") return { ok: false, title: "Es un equipo infectado", message: "Esa IP es de una persona inocente cuyo computador está infectado (botnet). Denunciarla fue un error.", reputation: -SECURITY.wrongReputation };
    if (h?.kind === "universidad") return { ok: false, title: "Es un escáner de investigación", message: "Una universidad escanea internet para estudiarlo. No tiene que ver con el ataque.", reputation: 0 };
    return { ok: false, title: "Acusaste a un inocente", message: "Esa persona no tiene nada que ver con el ataque. La policía no está contenta.", reputation: -SECURITY.wrongReputation };
  }
}

// ── tiempo de los logs ───────────────────────────────────────

/** Día de calendario y hora actuales (de noche, después de medianoche, ya es el día siguiente). */
export function nowCal(world: World): { day: number; hour: number } {
  const c = world.clock;
  if (c.phase === "night" && c.hour < 12) return { day: c.day + 1, hour: c.hour };
  return { day: c.day, hour: c.hour };
}

/** Hora del calendario `hoursAgo` horas antes de ahora. */
export function ago(world: World, hoursAgo: number): { day: number; hour: number } {
  const n = nowCal(world);
  let h = n.hour - hoursAgo;
  let d = n.day;
  while (h < 0) {
    h += 24;
    d--;
  }
  return { day: Math.max(1, d), hour: h };
}

const st = (t: { day: number; hour: number }, sec = 0) => stamp(t.day, t.hour, sec);

// ── pistas de cada técnica ───────────────────────────────────

function plant(sec: Security, world: World, s: Server, c: Case): void {
  const r = sec.rng;
  const user = s.os?.user ?? "admin";
  const authFile = c.decoys.includes("logs_borrados") ? LOGS.auth + ".1" : LOGS.auth;
  const nginxFile = c.decoys.includes("logs_borrados") ? LOGS.nginx + ".1" : LOGS.nginx;
  const rotated = () => {
    if (!c.decoys.includes("logs_borrados")) return;
    // el atacante borró los logs actuales, pero quedó la copia rotada (.1)
    for (const f of [LOGS.auth, LOGS.nginx]) s.fs.write(f, "");
    logLine(s, LOGS.syslog, st(nowCal(world)), "rsyslogd", "logs borrados por root (¿quién fue?)");
  };
  const port = () => r.int(30000, 65000);
  const vpn = () => {
    const v = sec.host("vpn", c.id, [{ port: 1194, service: "openvpn", version: "OpenVPN" }, { port: 443, service: "https", version: "VPN gateway" }]);
    c.vpnIp = v.ip;
    return v.ip;
  };
  const c2 = (ports: Port[]) => {
    const v = sec.host("vps", c.id, ports);
    c.c2Ip = v.ip;
    return v.ip;
  };
  const failed = (when: { day: number; hour: number }, who: string, ip: string, secs = 0) =>
    s.fs.append(authFile, `${st(when, secs)} ${s.hostname} sshd[${r.int(1000, 9999)}]: Failed password for ${who} from ${ip} port ${port()} ssh2`);

  switch (c.technique) {
    case "vpn_caida": {
      const v = vpn();
      const victimUser = r.pick(["root", "admin", "soporte"]);
      for (let i = 0; i < r.int(25, 40); i++) failed(ago(world, 3 - i * 0.05), victimUser, v, i);
      // el descuido: un intento sin VPN a la madrugada
      failed({ ...ago(world, 6), hour: 3 + r.next() * 0.9 }, victimUser, c.chain[0]);
      const uni = sec.host("universidad", c.id);
      s.fs.append(authFile, `${st(ago(world, 4))} ${s.hostname} sshd[${r.int(1000, 9999)}]: Connection closed by ${uni.ip} port ${port()} [preauth]`);
      if (c.innocentIp) failed(ago(world, 7), "invitado", c.innocentIp);
      sortLog(s, authFile);
      c.brute = { ip: v, ticks: SECURITY.bruteTicks, tries: 0, banned: false, succeeded: false };
      break;
    }
    case "foro": {
      const v = vpn();
      const nick = r.pick(NICKS);
      c.nick = nick;
      for (let i = 0; i < r.int(15, 25); i++) failed(ago(world, 3 - i * 0.1), "root", v, i);
      s.fs.append(authFile, `${st(ago(world, 3.5))} ${s.hostname} sshd[${r.int(1000, 9999)}]: Bad protocol version identification 'SSH-2.0-KrakenSSH_3.1 (by ${nick})' from ${v} port ${port()}`);
      sortLog(s, authFile);
      sec.forum.push({ user: nick, day: world.day, text: "jaja hoy le tumbé el servidor a una tiendita de barrio 😎 KrakenSSH nunca falla" });
      sec.forum.push({ user: r.pick(FORUM_USERS), day: world.day, text: `@${nick} eso es delito, parcero.` });
      sec.profiles[nick] = c.chain[0];
      c.brute = { ip: v, ticks: SECURITY.bruteTicks, tries: 0, banned: false, succeeded: false };
      break;
    }
    case "honeypot": {
      const v = vpn();
      for (let i = 0; i < r.int(20, 30); i++) failed(ago(world, 2 - i * 0.05), "root", v, i);
      sortLog(s, authFile);
      c.honeypot = { progress: 0, done: false };
      c.brute = { ip: v, ticks: SECURITY.bruteTicks, tries: 0, banned: false, succeeded: false };
      break;
    }
    case "horario": {
      const v = vpn();
      // 4 sospechosos en zonas horarias distintas; el perfil: ataca a las 23:00 de su hora local
      const places = [...CITIES].sort(() => r.next() - 0.5);
      const zones = new Set<number>();
      const picked: (typeof CITIES)[number][] = [];
      for (const p of places) if (!zones.has(p.tz) && picked.length < 4) (zones.add(p.tz), picked.push(p));
      const realIdx = r.int(0, 3);
      const realHost = sec.hosts.get(c.realIp)!;
      Object.assign(realHost, { city: picked[realIdx].city, country: picked[realIdx].country, tz: picked[realIdx].tz });
      c.suspects = picked.map((p, i) => (i === realIdx ? { ip: c.realIp, city: p.city, tz: p.tz } : { ip: sec.host("hogar", c.id, [], p).ip, city: p.city, tz: p.tz }));
      c.profileHour = 23;
      // hora de la tienda (UTC-5) cuando son las 23:00 donde vive el atacante
      const storeHour = (((23 - (picked[realIdx].tz - -5)) % 24) + 24) % 24;
      for (let d = 3; d >= 1; d--) {
        for (let i = 0; i < r.int(4, 7); i++) failed({ day: Math.max(1, nowCal(world).day - d), hour: storeHour + i * 0.05 }, "root", v, i);
      }
      sortLog(s, authFile);
      c.brute = { ip: v, ticks: SECURITY.bruteTicks / 2, tries: 0, banned: false, succeeded: false };
      break;
    }
    case "malware_strings": {
      const word = `${r.pick(C2_WORDS)}-${r.pick(C2_WORDS)}${r.int(1, 99)}.test`;
      const ip = c2([
        { port: 3333, service: "stratum", version: "Pool de minería" },
        { port: 6667, service: "irc", version: "Panel de control (IRC)", banner: `:panel 001 * Bienvenido al panel\n:panel NOTICE * Bots conectados: ${r.int(40, 300)}\n:panel NOTICE * botmaster conectado desde ${c.chain[0]}` },
      ]);
      c.domain = word;
      sec.domains.set(word, { name: word, ip, registrar: "Registros Baratos", created: stamp(Math.max(1, world.day - 20), 12), registeredFrom: sec.host("vpn", c.id).ip });
      const path = r.pick(["/tmp/.kworkerd", "/tmp/.X11-unix/.sshd", "/var/tmp/.cache-update"]);
      const lines = ["\x7fELF", "GLIBC_2.17", "libpthread.so.0", "--donate-level=0", `stratum+tcp://${word}:3333`, "worker=bot", "irc_channel=#bots", `irc_server=${word}:6667`];
      if (c.innocentIp) lines.push(`// hecho por ${c.innocentIp} jaja`);
      s.fs.write(path, lines.join("\n"), true);
      s.malware = { pid: s.nextPid++, name: VFSbase(path).replace(/^\./, ""), path, steal: SECURITY.minerSteal, day: world.day, respawnAt: null, caseId: c.id };
      break;
    }
    case "conexion_viva": {
      const ip = c2([
        { port: 4444, service: "control", version: "Control remoto (troyano)" },
        { port: 8080, service: "http", version: "Panel de administración", banner: `<h1>Panel</h1>\nBots en línea: ${r.int(20, 150)}\nÚltimo acceso del administrador: ${c.chain[0]}` },
      ]);
      const path = r.pick(["/usr/bin/.sysupd", "/tmp/.dbus-helper"]);
      s.fs.write(path, ["\x7fELF", "GLIBC_2.17", "connect", "recv", "sh -c"].join("\n"), true);
      s.malware = { pid: s.nextPid++, name: VFSbase(path).replace(/^\./, ""), path, steal: SECURITY.minerSteal, day: world.day, respawnAt: null, caseId: c.id, };
      sec.connections.set(s.malware.pid, { remote: `${ip}:4444`, local: `${s.ip ?? "10.0.0.10"}:${port()}` });
      break;
    }
    case "sqli": {
      const normal = Array.from({ length: 12 }, () => sec.host("hogar", null).ip);
      const write = (ip: string, path: string, when: { day: number; hour: number }, secs: number, status = 200) =>
        s.fs.append(nginxFile, `${ip} - - [${webStamp(when.day, when.hour, secs)}] "GET ${path} HTTP/1.1" ${status} ${r.int(200, 4000)} "-" "Mozilla/5.0"`);
      for (let i = 0; i < 40; i++) write(r.pick(normal), r.pick(["/pedidos", "/pedidos?id=" + r.int(1, 90), "/productos", "/"]), ago(world, 3 - i * 0.05), i);
      for (let i = 0; i < r.int(8, 15); i++) write(c.chain[0], r.pick(["/pedidos?id=1' OR 1=1 --", "/pedidos?id=1' OR 1=1 UNION SELECT usuario, clave FROM usuarios --", "/pedidos?id=1' OR 1=1; DROP TABLE pedidos --"]), ago(world, 2 - i * 0.02), i, 500);
      if (c.innocentIp) write(c.innocentIp, "/pedidos?id=1' OR 1=1 --", ago(world, 2.5), 0, 500);
      sortLog(s, nginxFile);
      s.ddos = { base: SECURITY.sqliLevel, level: SECURITY.sqliLevel, ticks: SECURITY.sqliTicks, caseId: c.id };
      break;
    }
    case "phishing": {
      const relay = sec.host("vps", c.id, [{ port: 25, service: "smtp", version: "Postfix" }]);
      const mail = [
        `From pagos@surtidor-pagos.test  ${st(ago(world, 1))}`,
        `Received: from mx.laesquina.test (10.0.0.1) by ${s.hostname} with SMTP; ${st(ago(world, 1))}`,
        `Received: from smtp-${r.int(1, 9)}.correo-rapido.test ([${relay.ip}]) by mx.laesquina.test with ESMTP; ${st(ago(world, 1.02))}`,
        `Received: from portatil-casa ([${c.chain[0]}]) by smtp.correo-rapido.test with ESMTPA; ${st(ago(world, 1.05))}`,
        "From: Distribuidora El Surtidor <pagos@surtidor-pagos.test>",
        `To: ${user}@laesquina.test`,
        "Subject: URGENTE: su pedido fue retenido",
        "",
        "Estimado cliente: su pedido fue retenido por falta de pago.",
        "Ingrese aquí para actualizar sus datos bancarios: http://surtidor-pagos.test/actualizar",
        "",
        "Atentamente, El Surtidor",
        "",
      ];
      c.c2Ip = relay.ip;
      s.fs.write(`/var/mail/${user}`, (s.fs.read(`/var/mail/${user}`) ?? "") + mail.join("\n"));
      break;
    }
    case "interno": {
      const ip = c2([{ port: 6667, service: "irc", version: "Panel de botnet", banner: `:panel NOTICE * Dispositivos IoT: ${r.int(100, 900)}\n:panel NOTICE * operador conectado desde ${c.chain[0]}` }]);
      const used = new Set([...sec.devices.map((d) => d.ip), ...world.servers.map((x) => x.ip), ...world.robots.map((x) => x.ip)]);
      let n = r.int(50, 99);
      while (used.has(`10.0.0.${n}`)) n++;
      const dev: LocalDevice = {
        ip: `10.0.0.${n}`, name: "camara-entrada", caseId: c.id, blocked: false,
        ports: [
          { port: 23, service: "telnet", version: "BusyBox telnetd (Cámara IP, firmware 2014)", banner: `Cámara IP v1.0 (contraseña de fábrica: admin)\nConectada al controlador ${ip}:6667` },
          { port: 80, service: "http", version: "Cámara IP — panel web" },
        ],
      };
      c.deviceIp = dev.ip;
      sec.devices.push(dev);
      for (let i = 0; i < 20; i++) s.fs.append(LOGS.ufw, `${st(ago(world, 0.5 - i * 0.02), i)} ${s.hostname} kernel: [UFW AUDIT] IN=eth0 SRC=${dev.ip} DST=${s.ip ?? "10.0.0.10"} PROTO=TCP SPT=${port()} DPT=80 SYN`);
      s.ddos = { base: SECURITY.ddosLevel, level: SECURITY.ddosLevel, ticks: Number.POSITIVE_INFINITY, caseId: c.id };
      break;
    }
    case "dominio": {
      const dom = `${r.pick(C2_WORDS)}-stress${r.int(1, 99)}.test`;
      c.domain = dom;
      const host = c2([{ port: 80, service: "http", version: "StressBot (servicio de ataques)" }]);
      sec.domains.set(dom, { name: dom, ip: host, registrar: "Registros Baratos", created: stamp(Math.max(1, world.day - 5), 14), registeredFrom: c.chain[0] });
      c.botnet = Array.from({ length: r.int(15, 25) }, () => sec.host("botnet", c.id).ip);
      for (let i = 0; i < 120; i++) {
        const when = ago(world, 0.4 - i * 0.003);
        s.fs.append(nginxFile, `${r.pick(c.botnet)} - - [${webStamp(when.day, when.hour, i)}] "GET /?${r.int(1000, 99999)} HTTP/1.1" 503 0 "-" "Mozilla/5.0 (compatible; StressBot/2.1; +http://${dom}/)"`);
      }
      s.ddos = { base: SECURITY.ddosLevel, level: SECURITY.ddosLevel, ticks: SECURITY.ddosTicks, caseId: c.id };
      break;
    }
  }
  if (c.technique === "sqli" || c.technique === "dominio") sortLog(s, nginxFile);
  rotated();
}

const VFSbase = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** Ordena un log por la fecha de cada línea (para que las pistas plantadas queden intercaladas). */
function sortLog(s: Server, file: string): void {
  const text = s.fs.read(file);
  if (!text) return;
  const key = (l: string) => {
    const m = /\[(\d\d)\/(\w+)\/(\d+):(\d\d:\d\d:\d\d)/.exec(l);
    if (m) return `${m[2]}${m[1]}${m[4]}`;
    return l.slice(0, 15);
  };
  const MES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const norm = (k: string) => {
    const m = /^(\w{3})\s+(\d{1,2}) (\d\d:\d\d:\d\d)/.exec(k) ?? /^(\w{3})(\d\d)(\d\d:\d\d:\d\d)/.exec(k);
    return m ? `${String(MES.indexOf(m[1])).padStart(2, "0")}${m[2].padStart(2, "0")}${m[3]}` : k;
  };
  const lines = text.split("\n").filter(Boolean);
  lines.sort((a, b) => norm(key(a)).localeCompare(norm(key(b))));
  s.fs.write(file, lines.join("\n") + "\n");
}

/** Lo que muestra la página de denuncias de un caso. */
export function describeCase(c: Case, hostname: string): { title: string; lines: string[] } {
  const what: Record<AttackKind, string> = {
    fuerza_bruta: `Intentaron entrar por SSH a ${hostname} adivinando la contraseña.`,
    malware: `${hostname} va lento: algo que no son los robots se está comiendo la CPU.`,
    ddos: `Tráfico anormal contra ${hostname}: la red está saturada.`,
    sqli: `Peticiones raras contra la página de pedidos en línea de ${hostname}.`,
    phishing: `Llegó un correo sospechoso al servidor ${hostname}.`,
  };
  const lines = [what[c.attack]];
  if (c.suspects.length) {
    lines.push(`Perfil del atacante: siempre ataca a las ${c.profileHour}:00 de su hora local.`, "Sospechosos:", ...c.suspects.map((x) => `  · ${x.ip}`));
  }
  if (c.decoys.includes("ip_dinamica")) lines.push("Ojo: el atacante cambia de IP pronto. Este caso vence mañana.");
  return { title: `Caso #${c.id} — ${techniqueLabel(c)} (día ${c.day}, nivel ${c.level})`, lines };
}

const techniqueLabel = (c: Case) => ({ fuerza_bruta: "Fuerza bruta SSH", malware: "Malware", ddos: "DDoS", sqli: "Inyección SQL", phishing: "Phishing" })[c.attack];
