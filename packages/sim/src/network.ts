/**
 * La red del juego (docs/servidores.md §4 y §7). Red local 10.0.0.0/24 y un "internet" FICTICIO: todas las IPs de
 * afuera salen de los rangos reservados para documentación (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24), que no
 * pertenecen a nadie real. Las herramientas (nmap, whois, dig...) solo ven esta red.
 */

export type HostKind = "hogar" | "botnet" | "vpn" | "proxy" | "vps" | "universidad" | "empresa" | "isp";

export interface Port {
  port: number;
  service: string;
  version: string;
  /** Lo que responde al conectarse (nc / curl). */
  banner?: string;
}

export interface InternetHost {
  ip: string;
  kind: HostKind;
  /** Quién figura en el whois. */
  owner: string;
  city: string;
  country: string;
  /** Zona horaria (horas respecto a UTC). */
  tz: number;
  ports: Port[];
  /** Caso que lo creó (para saber de qué se trata al denunciarlo). */
  caseId: number | null;
  /** Texto extra del whois. */
  note?: string;
}

export interface Domain {
  name: string;
  ip: string;
  registrar: string;
  created: string;
  /** IP desde la que se registró (la guarda el registro: técnica 10). */
  registeredFrom: string;
}

/** Ciudades ficticias o genéricas para geoip (con su zona horaria). */
export const CITIES: { city: string; country: string; tz: number }[] = [
  { city: "Bogotá", country: "CO", tz: -5 },
  { city: "Lima", country: "PE", tz: -5 },
  { city: "Ciudad de México", country: "MX", tz: -6 },
  { city: "Buenos Aires", country: "AR", tz: -3 },
  { city: "Madrid", country: "ES", tz: 1 },
  { city: "Lagos", country: "NG", tz: 1 },
  { city: "Bucarest", country: "RO", tz: 2 },
  { city: "Moscú", country: "RU", tz: 3 },
  { city: "Nueva Delhi", country: "IN", tz: 5.5 },
  { city: "Yakarta", country: "ID", tz: 7 },
  { city: "Seúl", country: "KR", tz: 9 },
  { city: "Los Ángeles", country: "US", tz: -8 },
];

export const ISPS = ["Telered Hogar", "FibraNet Residencial", "Conecta Casa", "AireNet Hogar", "CableMundo"];

/** Lo que dice whois según el tipo de equipo. */
export function ownerFor(kind: HostKind, pick: <T>(xs: readonly T[]) => T): string {
  switch (kind) {
    case "hogar":
    case "botnet":
      return `${pick(ISPS)} (conexión residencial)`;
    case "vpn":
      return pick(["VPN Anónima S.A.", "SombraVPN Ltd.", "Túnel Privado Inc."]);
    case "proxy":
      return pick(["Hosting Barato S.R.L. (proxy abierto)", "Servidores del Puerto (proxy abierto)"]);
    case "vps":
      return pick(["NubeRápida VPS", "HostMundo Cloud", "Servidores Alquilados S.A."]);
    case "universidad":
      return "Universidad Técnica — Proyecto de escaneo de internet (investigación)";
    case "empresa":
      return pick(["Distribuidora El Surtidor", "Mercados Unidos S.A."]);
    case "isp":
      return "Proveedor de internet";
  }
}

/** IP de internet nueva (rangos de documentación), sin repetir. */
export function freshIp(used: Set<string>, next: () => number): string {
  const ranges = ["192.0.2", "198.51.100", "203.0.113"];
  for (let i = 0; i < 1000; i++) {
    const ip = `${ranges[Math.floor(next() * ranges.length)]}.${1 + Math.floor(next() * 254)}`;
    if (!used.has(ip)) {
      used.add(ip);
      return ip;
    }
  }
  throw new Error("se acabaron las IPs ficticias");
}

export const isLocal = (ip: string) => /^10\.0\.0\.\d+$/.test(ip);
