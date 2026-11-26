import { FEATURES } from "@cdb/interpreter";
import { describe, expect, test } from "vitest";
import { type Case, describeCase, type Shell, type Technique, TECHNIQUES, World } from "../src/index.js";

const TOOLS = "nmap whois dnsutils net-tools tcpdump geoip-bin binutils cowrie";

function mundo(seed: number) {
  const w = new World(seed);
  for (const f of FEATURES) w.features.add(f);
  w.customersEnabled = false;
  w.day = 3;
  return w;
}

function out(t: Shell, line: string): string[] {
  return t.input(line).lines.slice(1);
}

/** Lee un log y su copia rotada (.1) si existe. */
function log(t: Shell, file: string): string[] {
  const files = [file, file + ".1"].filter((f) => t.server.fs.exists(f));
  return files.flatMap((f) => out(t, `cat ${f}`));
}

/** Sigue la cadena de proxies: whois → si es proxy, su panel dice el último cliente. */
function follow(t: Shell, ip: string): string {
  for (let i = 0; i < 5; i++) {
    const who = out(t, `whois ${ip}`).join("\n");
    if (!who.includes("proxy abierto")) return ip;
    const panel = out(t, `curl http://${ip}:8080`).join("\n");
    ip = /Último cliente conectado: ([\d.]+)/.exec(panel)![1];
  }
  return ip;
}

const count = (xs: string[]) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

/**
 * El solucionador: resuelve el caso SOLO con lo que vería un jugador en la terminal (y lo que dice la página de
 * denuncias). Si alguna técnica deja un caso sin solución, este test falla.
 */
function solve(w: World, c: Case): string {
  const t = w.shell(c.serverId);
  out(t, `apt install ${TOOLS}`);
  switch (c.technique) {
    case "vpn_caida": {
      const tries = log(t, "/var/log/auth.log").map((l) => /Failed password for (\S+) from (\S+)/.exec(l)).filter((m): m is RegExpExecArray => !!m);
      const [vpn] = count(tries.map((m) => m[2]))[0];
      const user = tries.find((m) => m[2] === vpn)![1];
      const others = [...new Set(tries.filter((m) => m[1] === user && m[2] !== vpn).map((m) => m[2]))];
      const homes = others.filter((ip) => out(t, `whois ${ip}`).join("\n").includes("conexión de hogar") || out(t, `whois ${ip}`).join("\n").includes("proxy abierto"));
      expect(homes).toHaveLength(1);
      return follow(t, homes[0]);
    }
    case "foro": {
      const nick = /\(by (\S+)\)/.exec(log(t, "/var/log/auth.log").find((l) => l.includes("(by "))!)![1];
      const page = out(t, `curl http://foro.undernet.test/u/${nick}`).join("\n");
      return follow(t, /Última conexión desde: ([\d.]+)/.exec(page)![1]);
    }
    case "honeypot": {
      out(t, "systemctl start cowrie");
      for (let i = 0; i < 400; i++) w.step();
      const wget = out(t, "cat /var/log/cowrie/cowrie.log").find((l) => l.includes("wget"))!;
      return follow(t, /http:\/\/([\d.]+)\//.exec(wget)![1]);
    }
    case "horario": {
      const info = describeCase(c, t.server.hostname).lines;
      const suspects = info.filter((l) => /^\s+· /.test(l)).map((l) => l.trim().slice(2));
      const profile = Number(/a las (\d+):00/.exec(info.join(" "))![1]);
      const times = log(t, "/var/log/auth.log").filter((l) => l.includes("Failed")).map((l) => l.split(/\s+/)[2]);
      const minutes = times.map((x) => Number(x.slice(0, 2)) * 60 + Number(x.slice(3, 5)));
      const fits = suspects.filter((ip) => {
        const tz = Number(/UTC([+-][\d.]+)/.exec(out(t, `geoiplookup ${ip}`).join(" "))![1]);
        return minutes.every((m) => {
          const local = (((m + (tz + 5) * 60) % 1440) + 1440) % 1440;
          return Math.floor(local / 60) === profile;
        });
      });
      expect(fits).toHaveLength(1);
      return fits[0];
    }
    case "malware_strings": {
      // el proceso raro: un programa escondido (archivo que empieza con punto)
      const proc = out(t, "ps").find((l) => /\s\/\S*\/\.[^/\s]+$/.test(l))!;
      const path = proc.trim().split(/\s+/).at(-1)!;
      const irc = out(t, `strings ${path}`).find((l) => l.startsWith("irc_server="))!;
      const domain = irc.slice("irc_server=".length).split(":")[0];
      const c2 = /IN A ([\d.]+)/.exec(out(t, `dig ${domain}`).join("\n"))![1];
      expect(out(t, `nmap -sV ${c2}`).join("\n")).toContain("6667/tcp");
      const panel = out(t, `nc ${c2} 6667`).join("\n");
      return follow(t, /botmaster conectado desde ([\d.]+)/.exec(panel)![1]);
    }
    case "conexion_viva": {
      const est = out(t, "ss -tunap").find((l) => l.includes("ESTABLISHED") && !l.includes("robot-agent"))!;
      const c2 = est.trim().split(/\s+/)[2].split(":")[0];
      expect(out(t, `nmap -sV ${c2}`).join("\n")).toContain("8080/tcp");
      const panel = out(t, `curl http://${c2}:8080`).join("\n");
      return follow(t, /Último acceso del administrador: ([\d.]+)/.exec(panel)![1]);
    }
    case "sqli": {
      const inj = log(t, "/var/log/nginx/access.log").filter((l) => l.includes("OR 1=1")).map((l) => l.split(" ")[0]);
      return follow(t, count(inj)[0][0]);
    }
    case "phishing": {
      const received = out(t, "mail").filter((l) => l.startsWith("Received:"));
      return follow(t, /\[([\d.]+)\]/.exec(received.at(-1)!)![1]);
    }
    case "interno": {
      const cam = out(t, "nmap -sn 10.0.0.0/24").find((l) => l.includes("camara"))!;
      const ip = /(10\.0\.0\.\d+)/.exec(cam)![1];
      out(t, `ufw deny from ${ip}`);
      expect(w.server(c.serverId)!.ddos).toBeNull();
      const ctrl = /controlador ([\d.]+):(\d+)/.exec(out(t, `nc ${ip} 23`).join("\n"))!;
      const panel = out(t, `nc ${ctrl[1]} ${ctrl[2]}`).join("\n");
      return follow(t, /operador conectado desde ([\d.]+)/.exec(panel)![1]);
    }
    case "dominio": {
      const ua = log(t, "/var/log/nginx/access.log").map((l) => /\+http:\/\/([^/]+)\//.exec(l)?.[1]).filter(Boolean) as string[];
      const domain = count(ua)[0][0];
      return follow(t, /Registrado desde la IP: ([\d.]+)/.exec(out(t, `whois ${domain}`).join("\n"))![1]);
    }
  }
}

describe("casos de investigación: todos tienen solución", () => {
  for (const def of TECHNIQUES) {
    test(`${def.name} (${def.id}): niveles 1–3, 40 semillas`, () => {
      for (let seed = 1; seed <= 40; seed++) {
        const level = ((seed % 3) + 1) as 1 | 2 | 3;
        const w = mundo(seed * 7919);
        const c = w.launchAttack(def.id as Technique, level, "srv-01")!;
        expect(c.level).toBe(level);
        const ip = solve(w, c);
        expect(ip, `semilla ${seed}, nivel ${level}`).toBe(c.realIp);
        const res = w.report(c.id, ip);
        expect(res.ok).toBe(true);
        expect(res.bounty).toBeGreaterThan(0);
      }
    });
  }
});

describe("ataques y defensas (solo frenan)", () => {
  test("fuerza bruta con contraseña débil: entra y deja un minero que frena a los robots; kill solo no basta", () => {
    const w = mundo(11);
    const s = w.server("srv-01")!;
    s.os!.password = "1234";
    const c = w.launchAttack("vpn_caida", 1, "srv-01")!;
    for (let i = 0; i < 400; i++) w.step();
    expect(s.malware).not.toBeNull();
    expect(c.brute!.succeeded).toBe(true);
    const t = w.shell("srv-01");
    expect(out(t, "last").join("\n")).toContain(c.vpnIp!);
    const pid = s.malware!.pid;
    out(t, `kill ${pid}`);
    expect(s.malware!.respawnAt).not.toBeNull();
    for (let i = 0; i < 200; i++) w.step();
    expect(s.malware!.respawnAt).toBeNull(); // volvió a arrancar: el archivo seguía ahí
    out(t, "apt install clamav");
    expect(out(t, "clamscan -r /tmp").join("\n")).toContain("Actualiza con freshclam");
    out(t, "freshclam");
    expect(out(t, "clamscan -r --remove /tmp").join("\n")).toContain("FOUND");
    out(t, `kill ${s.malware!.pid}`);
    expect(s.malware).toBeNull();
  });

  test("fuerza bruta con fail2ban: bloquea la IP a los 5 intentos y no entra", () => {
    const w = mundo(12);
    const s = w.server("srv-01")!;
    s.os!.password = "1234";
    const t = w.shell("srv-01");
    out(t, "apt install fail2ban");
    out(t, "systemctl start fail2ban");
    const c = w.launchAttack("foro", 1, "srv-01")!;
    for (let i = 0; i < 400; i++) w.step();
    expect(s.malware).toBeNull();
    expect(c.brute!.banned).toBe(true);
    expect(out(t, "fail2ban-client status sshd").join("\n")).toContain(c.vpnIp!);
  });

  test("contraseña fuerte: la fuerza bruta no entra", () => {
    const w = mundo(13);
    const c = w.launchAttack("honeypot", 1, "srv-01")!;
    for (let i = 0; i < 600; i++) w.step();
    expect(c.brute!.succeeded).toBe(false);
    expect(w.server("srv-01")!.malware).toBeNull();
  });

  test("DDoS: frena a los robots; el firewall y la protección anti-DDoS lo bajan", () => {
    const w = mundo(14);
    w.launchAttack("dominio", 1, "srv-01");
    const s = w.server("srv-01")!;
    w.step();
    expect(w.slowdown(w.robot("tono"))).toBeGreaterThan(2);
    w.shell("srv-01").input("ufw enable");
    w.services.add("antiddos");
    w.step();
    expect(s.ddos!.level).toBeCloseTo(0.8 * 0.7 * 0.3);
    expect(w.slowdown(w.robot("tono"))).toBeLessThan(1.5);
  });

  test("denunciar a un inocente baja la reputación; 3 errores cierran el caso", () => {
    const w = mundo(15);
    const c = w.launchAttack("dominio", 2, "srv-01")!;
    const rep = w.reputation;
    const r1 = w.report(c.id, c.botnet[0]);
    expect(r1).toMatchObject({ ok: false, title: "Es un equipo infectado" });
    expect(w.reputation).toBe(rep - 3);
    expect(w.report(c.id, c.chain[0]).title).toBe("Es un proxy abierto");
    expect(w.report(c.id, "10.0.0.21").message).toContain("Se acabaron los intentos");
    expect(c.status).toBe("fallido");
    expect(w.report(c.id, c.realIp).title).toContain("ya está fallido");
  });

  test("pistas: la primera vez de cada técnica es gratis; las pedidas descuentan del bounty", () => {
    const w = mundo(16);
    const c = w.launchAttack("sqli", 1, "srv-01")!;
    expect(c.freeHint).toBe(true);
    expect(w.shownHints(c)).toHaveLength(1);
    expect(w.hint(c.id)).toContain("OR 1=1");
    expect(w.hint(c.id)).toContain("uniq -c");
    expect(w.hint(c.id)).toBeNull();
    const before = w.money;
    const res = w.report(c.id, c.realIp, `línea: ${c.chain[0]} - - "GET /pedidos?id=1' OR 1=1 --"`);
    expect(res.ok).toBe(true);
    expect(w.money - before).toBe(Math.round((c.bounty * 0.6 * 1.25) / 100) * 100);
    const c2 = w.launchAttack("sqli", 1, "srv-01")!;
    expect(c2.freeHint).toBe(false);
  });

  test("la técnica no se repite en dos casos seguidos y prefiere las no vistas", () => {
    const w = mundo(17);
    const seen: string[] = [];
    for (let i = 0; i < 10; i++) seen.push(w.launchAttack(undefined, 1, "srv-01")!.technique);
    expect(new Set(seen).size).toBe(10);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toBe(seen[i - 1]);
  });

  test("los ataques empiezan el día 2 y solo contra servidores conectados", () => {
    const w = mundo(18);
    w.day = 1;
    w.startNight(10);
    w.updateNight(10);
    expect(w.security.nextAttack).toBeNull();
    w.day = 2;
    w.startNight(10);
    w.updateNight(10);
    expect(w.security.nextAttack).not.toBeNull();
    for (let i = 0; i < 3000 && w.security.cases.length === 0; i++) w.step();
    expect(w.security.cases.length).toBeGreaterThan(0);
  });

  test("todas las IPs de internet son de rangos de documentación", () => {
    const w = mundo(19);
    for (const def of TECHNIQUES) w.launchAttack(def.id as Technique, 3, "srv-01");
    for (const ip of w.security.hosts.keys()) expect(ip).toMatch(/^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$/);
  });
});
