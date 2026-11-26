/**
 * Hardware de los servidores (fases 4 y 5 de docs/servidores.md): catálogo de la tienda en línea, piezas compradas,
 * montaje en un puesto del rack y la prueba de encendido (POST).
 * Solo dos reglas de compatibilidad: el socket de la CPU coincide con el de la placa, y la fuente alcanza.
 */

export type PartKind = "placa" | "cpu" | "disipador" | "ram" | "ssd" | "fuente" | "gpu" | "ventilador";
/** Cables que se conectan a mano en el montaje. */
export type CableId = "atx24" | "cpu8" | "sata" | "red";

export interface PartDef {
  id: string;
  kind: PartKind;
  name: string;
  price: number;
  /** Texto corto para la tienda. */
  blurb: string;
  socket?: "AM-1" | "LGA-2";
  cores?: number;
  /** Velocidad de cada núcleo (índice de CPU_OPS). */
  speed?: number;
  ramGb?: number;
  /** Lo que gasta (vatios) o lo que da la fuente. */
  watts?: number;
  /** Lo que enfría (ventiladores). */
  cooling?: number;
}

/** Servicios y mejoras del cuarto (no van dentro del chasis). */
export interface ServiceDef {
  id: "rack" | "aire" | "antiddos";
  name: string;
  price: number;
  blurb: string;
}

export const PARTS: PartDef[] = [
  { id: "placa-am1", kind: "placa", name: "Placa madre Básica AM-1", price: 6000, socket: "AM-1", watts: 30, blurb: "Socket AM-1 · 2 ranuras de RAM · 1 PCIe" },
  { id: "placa-lga2", kind: "placa", name: "Placa madre Pro LGA-2", price: 14000, socket: "LGA-2", watts: 40, blurb: "Socket LGA-2 · 2 ranuras de RAM · 1 PCIe" },
  { id: "cpu-c1", kind: "cpu", name: "CPU Chispa 1 (1 núcleo)", price: 4000, socket: "AM-1", cores: 1, speed: 0, watts: 45, blurb: "AM-1 · 1 núcleo · 50 op/tick" },
  { id: "cpu-r2", kind: "cpu", name: "CPU Rayo 2 (2 núcleos)", price: 9000, socket: "AM-1", cores: 2, speed: 0, watts: 65, blurb: "AM-1 · 2 núcleos · 50 op/tick cada uno" },
  { id: "cpu-r4", kind: "cpu", name: "CPU Rayo 4 (4 núcleos)", price: 22000, socket: "AM-1", cores: 4, speed: 1, watts: 95, blurb: "AM-1 · 4 núcleos · 100 op/tick cada uno" },
  { id: "cpu-t8", kind: "cpu", name: "CPU Trueno 8 (8 núcleos)", price: 60000, socket: "LGA-2", cores: 8, speed: 2, watts: 150, blurb: "LGA-2 · 8 núcleos · 200 op/tick cada uno" },
  { id: "cooler", kind: "disipador", name: "Disipador de torre", price: 2500, blurb: "Obligatorio: sin él la CPU no arranca" },
  { id: "ram-2", kind: "ram", name: "Memoria RAM 2 GB", price: 2000, ramGb: 2, watts: 5, blurb: "2 GB · 3 robots" },
  { id: "ram-4", kind: "ram", name: "Memoria RAM 4 GB", price: 4000, ramGb: 4, watts: 5, blurb: "4 GB · 7 robots" },
  { id: "ram-8", kind: "ram", name: "Memoria RAM 8 GB", price: 7500, ramGb: 8, watts: 5, blurb: "8 GB" },
  { id: "ssd", kind: "ssd", name: "Disco SSD 256 GB", price: 5000, watts: 5, blurb: "Para instalar Linux" },
  { id: "psu-300", kind: "fuente", name: "Fuente de poder 300 W", price: 4000, watts: 300, blurb: "300 W" },
  { id: "psu-600", kind: "fuente", name: "Fuente de poder 600 W", price: 8000, watts: 600, blurb: "600 W · necesaria con GPU" },
  { id: "gpu", kind: "gpu", name: "Tarjeta gráfica (GPU)", price: 35000, watts: 220, blurb: "Visión por computador: scan_item() el doble de rápido" },
  { id: "fan", kind: "ventilador", name: "Ventilador de chasis", price: 1500, watts: 5, cooling: 1, blurb: "Baja la temperatura" },
];

export const SERVICES: ServiceDef[] = [
  { id: "rack", name: "Gabinete de rack 42U", price: 15000, blurb: "Un puesto más en la sala para montar otro servidor (máximo 3)" },
  { id: "aire", name: "Aire acondicionado para el cuarto", price: 25000, blurb: "Todos los servidores se calientan mucho menos" },
  { id: "antiddos", name: "Protección anti-DDoS (plan mensual)", price: 18000, blurb: "Filtra la mayoría del tráfico de un DDoS" },
];

/** Las piezas que trae el camión para el primer servidor (el tutorial de montaje). */
export const STARTER_KIT = ["placa-am1", "cpu-c1", "cooler", "ram-2", "ssd", "psu-300"];

export const partDef = (id: string): PartDef => {
  const p = PARTS.find((x) => x.id === id);
  if (!p) throw new Error(`pieza desconocida: ${id}`);
  return p;
};

/** Una pieza comprada (en el almacén o montada). */
export interface PartItem {
  uid: number;
  def: string;
}

/** Lo que está montado en un puesto del rack. */
export interface Build {
  placa: PartItem | null;
  cpu: PartItem | null;
  disipador: PartItem | null;
  ram: PartItem[];
  ssd: PartItem | null;
  fuente: PartItem | null;
  gpu: PartItem | null;
  ventilador: PartItem | null;
  cables: Set<CableId>;
}

export const RAM_SLOTS = 2;
export const RACK_SLOTS = 3;

export const emptyBuild = (): Build => ({
  placa: null, cpu: null, disipador: null, ram: [], ssd: null, fuente: null, gpu: null, ventilador: null, cables: new Set(),
});

/** En qué orden se puede montar cada pieza: qué tiene que estar antes. */
export function canInstall(build: Build, def: PartDef): string | null {
  if (def.kind !== "placa" && !build.placa) return "Primero va la placa madre: todo se conecta a ella.";
  switch (def.kind) {
    case "placa":
      return build.placa ? "Ya hay una placa madre." : null;
    case "cpu": {
      if (build.cpu) return "Ya hay una CPU en el socket.";
      const board = partDef(build.placa!.def);
      return def.socket !== board.socket ? `Esta CPU es ${def.socket} y la placa es ${board.socket}: no entra en el socket.` : null;
    }
    case "disipador":
      return !build.cpu ? "El disipador va encima de la CPU: primero pon la CPU." : build.disipador ? "Ya hay un disipador." : null;
    case "ram":
      return build.ram.length >= RAM_SLOTS ? "Las dos ranuras de RAM están ocupadas." : null;
    case "gpu":
      return build.gpu ? "Ya hay una tarjeta gráfica." : null;
    default:
      return build[def.kind] ? `Ya hay ${def.name.toLowerCase().startsWith("disco") ? "un disco" : "una pieza de ese tipo"}.` : null;
  }
}

export function install(build: Build, item: PartItem): void {
  const def = partDef(item.def);
  if (def.kind === "ram") build.ram.push(item);
  else build[def.kind] = item;
}

/** Cables que se pueden conectar con lo que está montado (y lo que necesita cada uno). */
export function cableNeeds(cable: CableId): PartKind[] {
  return cable === "atx24" ? ["placa", "fuente"] : cable === "cpu8" ? ["cpu", "fuente"] : cable === "sata" ? ["ssd", "fuente"] : ["placa"];
}

export const CABLE_NAMES: Record<CableId, string> = {
  atx24: "Cable de 24 pines (fuente → placa)",
  cpu8: "Cable de 8 pines (fuente → CPU)",
  sata: "Cable de poder SATA (fuente → disco)",
  red: "Cable de red (placa → switch)",
};

export function wattsNeeded(build: Build): number {
  const items = [build.placa, build.cpu, build.ssd, build.gpu, build.ventilador, ...build.ram].filter((x): x is PartItem => !!x);
  return items.reduce((s, i) => s + (partDef(i.def).watts ?? 0), 0);
}

export interface PostResult {
  ok: boolean;
  /** Mensajes de la pantalla de arranque, en orden. */
  lines: string[];
  /** Advertencias que no impiden arrancar (p. ej. sin cable de red). */
  warnings: string[];
}

/** La prueba de encendido: qué falta o qué está mal, con mensajes claros. */
export function post(build: Build): PostResult {
  const lines: string[] = [];
  const warnings: string[] = [];
  const fail = (msg: string): PostResult => ({ ok: false, lines: [...lines, `✗ ${msg}`], warnings });
  if (!build.fuente) return fail("No enciende: no hay fuente de poder.");
  if (!build.placa) return fail("No enciende: no hay placa madre.");
  if (!build.cables.has("atx24")) return fail("No enciende: falta el cable de 24 pines de la fuente a la placa.");
  const psu = partDef(build.fuente.def).watts!;
  const need = wattsNeeded(build);
  lines.push(`Fuente: ${need} W de ${psu} W`);
  if (need > psu) return fail(`La fuente no alcanza: las piezas necesitan ${need} W y la fuente da ${psu} W.`);
  if (!build.cpu) return fail("No se detecta la CPU.");
  if (!build.cables.has("cpu8")) return fail("La CPU no recibe energía: falta el cable de 8 pines.");
  if (!build.disipador) return fail("¡La CPU se calienta! Falta el disipador: se apagó para protegerse.");
  const cpu = partDef(build.cpu.def);
  lines.push(`CPU: ${cpu.name}`);
  if (build.ram.length === 0) return fail("No se detecta memoria RAM (pitidos: ··· ···).");
  lines.push(`Memoria: ${build.ram.reduce((s, r) => s + partDef(r.def).ramGb!, 0)} GB`);
  if (!build.ssd) return fail("No hay disco: no hay dónde instalar el sistema.");
  if (!build.cables.has("sata")) return fail("El disco no recibe energía: falta el cable SATA.");
  lines.push("Disco: SSD 256 GB");
  if (build.gpu) lines.push("GPU: detectada");
  if (!build.cables.has("red")) warnings.push("Sin cable de red: el servidor no tendrá conexión.");
  lines.push("✓ Todo en orden. Arrancando…");
  return { ok: true, lines, warnings };
}

/** Lo que el servidor saca de su hardware. */
export function specs(build: Build): { cores: number; speed: number; ramGb: number; gpu: boolean; cooling: number; cable: boolean } {
  const cpu = build.cpu ? partDef(build.cpu.def) : null;
  return {
    cores: cpu?.cores ?? 0,
    speed: cpu?.speed ?? 0,
    ramGb: build.ram.reduce((s, r) => s + partDef(r.def).ramGb!, 0),
    gpu: !!build.gpu,
    cooling: build.ventilador ? partDef(build.ventilador.def).cooling ?? 0 : 0,
    cable: build.cables.has("red"),
  };
}
