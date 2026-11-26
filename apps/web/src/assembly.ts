import {
  type Build, CABLE_NAMES, type CableId, canInstall, cableNeeds, partDef, type PartKind, type PostResult, type Server, type World,
} from "@cdb/sim";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

/**
 * Montaje del servidor en primera persona (fase 5 de docs/servidores.md). La cámara mira dentro del chasis abierto;
 * las piezas compradas están en una bandeja abajo. Se arrastran (o se elige una y se hace clic) y encajan solas en
 * su lugar: el lugar correcto brilla, el equivocado explica por qué no. Clic en una pieza montada la saca (vuelve al
 * almacén): así se cambian piezas de un servidor que ya estaba encendido.
 *
 * Se ve con luz de estudio (RoomEnvironment como IBL), sombras suaves y texturas dibujadas en canvas (circuito,
 * etiquetas, rejillas): nada de cajas planas.
 */

type Target = PartKind | CableId;

interface SlotDef {
  /** Centro y tamaño de la zona donde se suelta (y del brillo). */
  pos: [number, number, number];
  size: [number, number, number];
  label: string;
}

const SLOTS: Record<Target, SlotDef> = {
  placa: { pos: [-0.65, 0.06, 0], size: [2.5, 0.06, 2.6], label: "placa madre" },
  cpu: { pos: [-0.9, 0.16, -0.35], size: [0.55, 0.08, 0.55], label: "socket de la CPU" },
  disipador: { pos: [-0.9, 0.55, -0.35], size: [0.7, 0.7, 0.7], label: "encima de la CPU" },
  ram: { pos: [0.05, 0.3, -0.35], size: [0.35, 0.45, 1.5], label: "ranuras de RAM" },
  gpu: { pos: [-0.75, 0.35, 0.85], size: [1.9, 0.5, 0.2], label: "ranura PCIe" },
  ssd: { pos: [1.45, 0.12, -0.9], size: [0.8, 0.12, 0.6], label: "bahía del disco" },
  fuente: { pos: [1.45, 0.4, 0.85], size: [0.95, 0.75, 0.95], label: "lugar de la fuente" },
  ventilador: { pos: [-2.02, 0.75, -0.4], size: [0.12, 0.9, 0.9], label: "pared trasera" },
  atx24: { pos: [0.5, 0.2, -1.0], size: [0.3, 0.3, 0.55], label: "conector de 24 pines (borde derecho de la placa)" },
  cpu8: { pos: [-1.62, 0.2, -0.95], size: [0.4, 0.3, 0.4], label: "conector de 8 pines (arriba a la izquierda de la CPU)" },
  sata: { pos: [1.45, 0.24, -0.62], size: [0.4, 0.25, 0.25], label: "conector del disco (borde del SSD)" },
  red: { pos: [-1.98, 0.35, 0.5], size: [0.25, 0.3, 0.35], label: "puerto de red (pared izquierda del chasis)" },
};

const CABLES: CableId[] = ["atx24", "cpu8", "sata", "red"];

/** Íconos de la bandeja (SVG de línea, 24×24). */
const SVG: Record<string, string> = {
  placa: `<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="7" y="7" width="5" height="5" rx="1"/><path d="M15 6v12M18 6v12M7 16h5M3 9h2M3 14h2"/>`,
  cpu: `<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>`,
  disipador: `<rect x="4" y="15" width="16" height="5" rx="1"/><path d="M6 15V5M9 15V4M12 15V4M15 15V4M18 15V5"/>`,
  ram: `<rect x="2" y="7" width="20" height="9" rx="1"/><rect x="5" y="9" width="3" height="4"/><rect x="10.5" y="9" width="3" height="4"/><rect x="16" y="9" width="3" height="4"/><path d="M4 16v2M8 16v2M12 16v2M16 16v2M20 16v2"/>`,
  ssd: `<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 15h10M7 9h4"/><circle cx="17" cy="9" r="1"/>`,
  fuente: `<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="12" cy="12" r="5"/><path d="M12 8.5l-1.5 3.5h3L12 15.5"/>`,
  gpu: `<rect x="2" y="6" width="20" height="11" rx="2"/><circle cx="8" cy="11.5" r="3"/><circle cx="16" cy="11.5" r="3"/><path d="M5 17v2h6v-2"/>`,
  ventilador: `<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="12" cy="12" r="1.5"/><path d="M12 10.5C12 6 15 5.5 16 7.5M13.5 12c4.5 0 5 3 3 4M12 13.5c0 4.5-3 5-4 3M10.5 12C6 12 5.5 9 7.5 8"/>`,
  atx24: `<path d="M4 18c4 0 4-12 8-12s4 12 8 12"/><rect x="2" y="16" width="4" height="4" rx="1"/><rect x="18" y="16" width="4" height="4" rx="1"/>`,
  cpu8: `<path d="M4 18c4 0 4-12 8-12s4 12 8 12"/><rect x="2" y="16" width="4" height="4" rx="1"/><rect x="18" y="16" width="4" height="4" rx="1"/>`,
  sata: `<path d="M4 18c4 0 4-12 8-12s4 12 8 12"/><rect x="2" y="16" width="4" height="4" rx="1"/><path d="M18 16h4v4h-4z"/>`,
  red: `<rect x="7" y="13" width="10" height="8" rx="1"/><path d="M9 13v-2h6v2M12 11V3M10 17h4"/>`,
};
const icon = (k: string) => `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SVG[k] ?? ""}</svg>`;

const KIND_NAME: Record<PartKind, string> = {
  placa: "Placa madre", cpu: "CPU", disipador: "Disipador", ram: "Memoria RAM", ssd: "Disco", fuente: "Fuente", gpu: "GPU", ventilador: "Ventilador",
};

export interface AssemblyResult {
  server: Server | null;
}

/** En línea: lo que pasa en el montaje se le cuenta al otro jugador. */
export interface AssemblyLink {
  /** Tomé una pieza (o la solté: null). */
  hold?: (label: string | null) => void;
  /** Encendí: el otro ve la misma prueba de encendido. */
  posted?: (post: PostResult, ok: boolean) => void;
}

// ── texturas dibujadas (canvas) ─────────────────────────────────

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, srgb = true): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Número pseudoaleatorio fijo (las texturas salen siempre iguales). */
function seeded(seed: number): () => number {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

const TEX = {
  wood: () =>
    canvasTex(1024, 512, (g) => {
      const rnd = seeded(7);
      g.fillStyle = "#6e4a2f";
      g.fillRect(0, 0, 1024, 512);
      for (let p = 0; p < 6; p++) {
        const y = (p * 512) / 6;
        g.fillStyle = `hsl(26, ${38 + rnd() * 10}%, ${26 + rnd() * 8}%)`;
        g.fillRect(0, y, 1024, 512 / 6 - 3);
        g.strokeStyle = "rgba(30, 15, 5, 0.28)";
        for (let i = 0; i < 26; i++) {
          g.lineWidth = 0.6 + rnd() * 1.6;
          g.beginPath();
          const yy = y + rnd() * (512 / 6);
          g.moveTo(0, yy);
          for (let x = 0; x <= 1024; x += 64) g.lineTo(x, yy + Math.sin(x / 90 + i) * 3 + rnd() * 2);
          g.stroke();
        }
        g.fillStyle = "rgba(0,0,0,0.45)";
        g.fillRect(0, y + 512 / 6 - 3, 1024, 3);
      }
    }),
  pcb: () =>
    canvasTex(1024, 1024, (g) => {
      const rnd = seeded(3);
      g.fillStyle = "#0e4a32";
      g.fillRect(0, 0, 1024, 1024);
      // pistas en ángulos de 90° y 45°
      g.lineCap = "round";
      for (let i = 0; i < 160; i++) {
        g.strokeStyle = rnd() < 0.8 ? "rgba(46, 140, 92, 0.55)" : "rgba(214, 178, 90, 0.5)";
        g.lineWidth = 2 + rnd() * 3;
        let x = rnd() * 1024;
        let y = rnd() * 1024;
        g.beginPath();
        g.moveTo(x, y);
        for (let k = 0; k < 3; k++) {
          const d = 40 + rnd() * 160;
          const dir = Math.floor(rnd() * 4);
          if (dir === 0) x += d;
          else if (dir === 1) y += d;
          else if (dir === 2) { x += d * 0.7; y += d * 0.7; } else { x -= d * 0.7; y += d * 0.7; }
          g.lineTo(x, y);
        }
        g.stroke();
        g.fillStyle = "#d9b45a";
        g.beginPath();
        g.arc(x, y, 3.5, 0, Math.PI * 2);
        g.fill();
      }
      // serigrafía
      g.fillStyle = "rgba(240, 240, 230, 0.85)";
      g.font = "bold 34px sans-serif";
      g.fillText("LA ESQUINA  AM-1", 610, 980);
      g.font = "22px sans-serif";
      g.fillText("CPU1", 300, 175);
      g.fillText("DIMM_A1  DIMM_B1", 770, 120);
      g.fillText("PCIE_X16", 330, 800);
      g.strokeStyle = "rgba(240, 240, 230, 0.6)";
      g.lineWidth = 2;
      g.strokeRect(250, 215, 210, 210);
    }),
  ihs: (name: string) =>
    canvasTex(256, 256, (g) => {
      const grd = g.createLinearGradient(0, 0, 256, 256);
      grd.addColorStop(0, "#d9dde2");
      grd.addColorStop(1, "#a9afb7");
      g.fillStyle = grd;
      g.fillRect(0, 0, 256, 256);
      g.fillStyle = "rgba(40, 44, 50, 0.75)";
      g.font = "bold 30px sans-serif";
      g.textAlign = "center";
      g.fillText(name.toUpperCase(), 128, 120);
      g.font = "18px sans-serif";
      g.fillText("LA ESQUINA SILICON", 128, 150);
      g.beginPath();
      g.moveTo(18, 238);
      g.lineTo(38, 238);
      g.lineTo(18, 218);
      g.fill();
    }),
  label: (title: string, sub: string, accent: string) =>
    canvasTex(512, 256, (g) => {
      g.fillStyle = "#1d2126";
      g.fillRect(0, 0, 512, 256);
      g.fillStyle = accent;
      g.fillRect(0, 0, 512, 18);
      g.fillStyle = "#f2f2ee";
      g.font = "bold 64px sans-serif";
      g.fillText(title, 28, 120);
      g.fillStyle = "#9aa3ad";
      g.font = "30px sans-serif";
      g.fillText(sub, 30, 178);
    }),
  grille: () =>
    canvasTex(512, 512, (g) => {
      g.fillStyle = "#26292e";
      g.fillRect(0, 0, 512, 512);
      g.fillStyle = "#0b0c0e";
      const r = 13;
      for (let row = 0; row < 22; row++) {
        for (let col = 0; col < 20; col++) {
          const x = col * 27 + (row % 2) * 13.5 + 6;
          const y = row * 24 + 8;
          g.beginPath();
          for (let k = 0; k < 6; k++) {
            const a = (Math.PI / 3) * k + Math.PI / 6;
            g.lineTo(x + Math.cos(a) * r * 0.78, y + Math.sin(a) * r * 0.78);
          }
          g.fill();
        }
      }
    }),
  backdrop: () =>
    canvasTex(512, 512, (g) => {
      const grd = g.createRadialGradient(256, 200, 40, 256, 256, 380);
      grd.addColorStop(0, "#2d3d38");
      grd.addColorStop(1, "#0e1513");
      g.fillStyle = grd;
      g.fillRect(0, 0, 512, 512);
    }),
};

export class AssemblyView {
  private readonly el: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
  private readonly raycaster = new THREE.Raycaster();
  private readonly glows = new Map<Target, THREE.Mesh>();
  private readonly placed = new THREE.Group();
  private readonly drops: { obj: THREE.Object3D; to: THREE.Vector3; t: number }[] = [];
  /** Aspas que giran (ventiladores). */
  private readonly spinners: { obj: THREE.Object3D; axis: "x" | "y" | "z"; speed: number }[] = [];
  private slot = 0;
  private running = false;
  private resolve: ((r: AssemblyResult) => void) | null = null;
  /** Lo que el jugador tiene "en la mano" (arrastrando o elegido con clic). */
  private holding: { target: Target; uid: number | null; label: string } | null = null;
  private ghost: HTMLElement;
  private hover: Target | null = null;
  /** Pieza montada bajo el mouse (sin nada en la mano): se puede sacar con clic. */
  private hoverPlaced: THREE.Object3D | null = null;
  private zoom = 0;
  private mouse = new THREE.Vector2();
  private readonly mats = new Map<string, THREE.Material>();
  /** Firma de lo montado y de la bandeja: si cambia por otro lado (el otro jugador), se redibuja. */
  private sig = "";
  private lastSigCheck = 0;
  /** Lo que tiene en la mano el otro jugador (en línea). */
  private remote: { name: string; label: string } | null = null;
  link: AssemblyLink = {};

  constructor(private readonly world: () => World, private readonly cue: (name: string) => void) {
    this.el = document.createElement("div");
    this.el.className = "assembly";
    this.el.hidden = true;
    this.el.innerHTML = `
      <div class="as-stage"></div>
      <header class="as-top">
        <div class="as-heading"><span class="as-kicker">Cuarto de servidores</span><h2 class="as-title"></h2></div>
        <p class="as-help" aria-live="polite"></p>
        <p class="as-remote" hidden></p>
        <button class="as-exit">Salir</button>
      </header>
      <footer class="as-tray">
        <section class="as-group as-group-parts"><h3>Piezas en el almacén <span class="as-count"></span></h3><div class="as-parts"></div></section>
        <section class="as-group as-group-cables"><h3>Cables</h3><div class="as-cables"></div></section>
        <button class="as-power"><span class="as-power-ico" aria-hidden="true">⏻</span><span>Cerrar tapa<br>y encender</span></button>
      </footer>
      <div class="as-post" hidden><pre></pre><button class="as-post-ok">Continuar</button></div>`;
    document.body.append(this.el);
    this.ghost = document.createElement("div");
    this.ghost.className = "as-ghost";
    this.ghost.hidden = true;
    document.body.append(this.ghost);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.el.querySelector(".as-stage")!.append(this.renderer.domElement);
    this.buildScene();

    this.el.querySelector(".as-exit")!.addEventListener("click", () => this.close(null));
    this.el.querySelector(".as-power")!.addEventListener("click", () => this.powerOn());
    this.el.querySelector(".as-tray")!.addEventListener("pointerdown", (e) => this.pickFromTray(e as PointerEvent));
    window.addEventListener("pointermove", (e) => this.move(e));
    window.addEventListener("pointerup", (e) => this.drop(e));
    this.renderer.domElement.addEventListener("click", (e) => this.clickStage(e));
    window.addEventListener("resize", () => this.resize());
    window.addEventListener("keydown", (e) => {
      if (!this.el.hidden && e.key === "Escape") {
        if (this.holding) this.release();
        else this.close(null);
      }
    });
  }

  /** Abre el montaje de un puesto del rack. Termina cuando el jugador sale o enciende el servidor. */
  open(slot: number): Promise<AssemblyResult> {
    this.slot = slot;
    this.el.hidden = false;
    const srv = this.world().rackServer(slot);
    this.el.querySelector(".as-title")!.textContent = srv?.maintenance ? `Cambiar piezas de ${srv.hostname}` : `Montaje del puesto ${slot + 1}`;
    this.el.querySelector<HTMLElement>(".as-post")!.hidden = true;
    this.zoom = 0;
    this.sig = this.signature();
    this.setRemote(null);
    this.rebuildPlaced();
    this.renderTray();
    this.help();
    this.resize();
    if (!this.running) {
      this.running = true;
      const loop = (t: number) => {
        if (this.el.hidden) {
          this.running = false;
          return;
        }
        this.frame(t);
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }
    return new Promise((r) => (this.resolve = r));
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  /** El puesto que se está montando (o -1). */
  get openSlot(): number {
    return this.el.hidden ? -1 : this.slot;
  }

  /** Sale del montaje (en línea: el otro jugador encendió el servidor). */
  closeFromRemote(server: Server | null): void {
    if (!this.el.hidden) this.close(server);
  }

  /** El otro jugador tomó una pieza (o la soltó). */
  setRemote(r: { name: string; label: string } | null): void {
    this.remote = r;
    const el = this.el.querySelector<HTMLElement>(".as-remote")!;
    el.hidden = !r;
    if (r) el.textContent = `${r.name} tiene en la mano: ${r.label}`;
  }

  /** El otro jugador encendió: se ve la misma prueba de encendido. */
  showRemotePost(post: PostResult, server: Server | null): void {
    if (this.el.hidden) return;
    this.release();
    this.showPost(post, server, !!server?.os, false);
  }

  /** ¿El puesto ya es un servidor encendido? (el montaje terminó, quizás por el otro jugador) */
  private finished(): boolean {
    const srv = this.world().rackServer(this.slot);
    return !!srv && !srv.maintenance;
  }

  /** Lo montado + las piezas del almacén, en texto (para saber si cambió). */
  private signature(): string {
    const w = this.world();
    if (this.finished()) return "listo";
    const b = w.racks[this.slot];
    const items = b ? [b.placa, b.cpu, b.disipador, b.ssd, b.fuente, b.gpu, b.ventilador, ...b.ram].map((x) => x?.uid ?? "-").join(",") + [...b.cables].join(",") : "vacío";
    return `${items}|${w.parts.map((p) => p.uid).join(",")}`;
  }

  private close(server: Server | null): void {
    this.release();
    this.el.hidden = true;
    this.resolve?.({ server });
    this.resolve = null;
  }

  private build(): Build {
    return this.world().rackBuild(this.slot);
  }

  /** Posición en pantalla de una zona (para las pruebas automáticas). */
  screenPos(target: Target): { x: number; y: number } {
    const v = new THREE.Vector3(...SLOTS[target].pos).project(this.camera);
    return { x: ((v.x + 1) / 2) * window.innerWidth, y: ((1 - v.y) / 2) * window.innerHeight };
  }

  // ── materiales y formas ──

  /** Material PBR cacheado por clave. */
  private mat(key: string, make: () => THREE.Material): THREE.Material {
    let m = this.mats.get(key);
    if (!m) this.mats.set(key, (m = make()));
    return m;
  }

  private std(color: number, roughness = 0.5, metalness = 0, extra: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
    return this.mat(`${color}|${roughness}|${metalness}|${extra.map ? (extra.map as THREE.Texture).uuid : ""}`, () =>
      new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra })) as THREE.MeshStandardMaterial;
  }

  /** Caja con bordes redondeados. */
  private rbox(w: number, h: number, d: number, mat: THREE.Material, r = 0.02, x = 0, y = 0, z = 0, parent?: THREE.Object3D): THREE.Mesh {
    const radius = Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001);
    const m = new THREE.Mesh(radius > 0.002 ? new RoundedBoxGeometry(w, h, d, 2, radius) : new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent?.add(m);
    return m;
  }

  private cyl(r: number, h: number, mat: THREE.Material, x = 0, y = 0, z = 0, parent?: THREE.Object3D, seg = 20): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent?.add(m);
    return m;
  }

  /** Ventilador: marco, buje y aspas que giran. Mira hacia +y (se rota después). */
  private fan(size: number, frameColor: number, bladeColor: number, parent: THREE.Object3D): THREE.Group {
    const g = new THREE.Group();
    const frame = this.std(frameColor, 0.55, 0.1);
    const t = size * 0.08;
    this.rbox(size, size * 0.18, t, frame, 0.01, 0, 0, size / 2 - t / 2, g);
    this.rbox(size, size * 0.18, t, frame, 0.01, 0, 0, -size / 2 + t / 2, g);
    this.rbox(t, size * 0.18, size, frame, 0.01, size / 2 - t / 2, 0, 0, g);
    this.rbox(t, size * 0.18, size, frame, 0.01, -size / 2 + t / 2, 0, 0, g);
    const rotor = new THREE.Group();
    const blade = this.std(bladeColor, 0.45, 0.05);
    for (let i = 0; i < 7; i++) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(size * 0.36, size * 0.02, size * 0.13), blade);
      b.position.x = size * 0.21;
      b.rotation.x = 0.45;
      const arm = new THREE.Group();
      arm.rotation.y = (i / 7) * Math.PI * 2;
      arm.add(b);
      rotor.add(arm);
    }
    this.cyl(size * 0.12, size * 0.1, this.std(0x16181b, 0.4, 0.2), 0, 0.01, 0, rotor);
    g.add(rotor);
    this.spinners.push({ obj: rotor, axis: "y", speed: 0.012 });
    parent.add(g);
    return g;
  }

  // ── escena ──

  private buildScene(): void {
    const s = this.scene;
    s.background = TEX.backdrop();
    // luz de estudio para los reflejos del metal (IBL), más una luz principal con sombra y una lámpara cálida
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    s.environment = pmrem.fromScene(room, 0.04).texture;
    s.environmentIntensity = 0.55;
    room.dispose();
    pmrem.dispose();
    s.add(new THREE.HemisphereLight(0xdfe9ff, 0x3a2c20, 0.5));
    const key = new THREE.DirectionalLight(0xfff1de, 2.4);
    key.position.set(2.5, 7, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { near: 1, far: 20, left: -4.5, right: 4.5, top: 4, bottom: -4 });
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    s.add(key);
    const lamp = new THREE.PointLight(0xffd9a8, 5, 9, 1.6);
    lamp.position.set(-1.2, 2.8, 1.6);
    s.add(lamp);

    // mesa de madera
    const wood = TEX.wood();
    wood.wrapS = wood.wrapT = THREE.RepeatWrapping;
    wood.repeat.set(1.4, 1.4);
    const desk = this.rbox(11, 0.24, 7, this.std(0xffffff, 0.72, 0, { map: wood }), 0.06, 0, -0.2, 0, s);
    desk.castShadow = false;

    // chasis: piso de acero oscuro, paredes de lámina con borde redondeado y separadores dorados
    const floorMat = this.std(0x3a4047, 0.42, 0.75);
    this.rbox(4.2, 0.05, 3.2, floorMat, 0.02, 0, 0, 0, s);
    const wallMat = this.std(0xa9b1ba, 0.34, 0.7);
    // la pared del frente es bajita (la tapa lateral está quitada) para ver bien adentro
    for (const [x, z, w, d, h] of [[0, -1.6, 4.2, 0.06, 1.4], [0, 1.6, 4.2, 0.06, 0.32], [-2.1, 0, 0.06, 3.2, 1.4], [2.1, 0, 0.06, 3.2, 1.4]] as const) {
      this.rbox(w, h, d, wallMat, 0.025, x, h / 2, z, s);
    }
    // ranuras de ventilación en la pared trasera
    const slotMat = this.std(0x1a1d21, 0.6, 0.3);
    for (let i = 0; i < 12; i++) this.rbox(0.22, 0.05, 0.065, slotMat, 0.02, 0.95 + (i % 4) * 0.28, 0.55 + Math.floor(i / 4) * 0.2, -1.6, s);
    const brass = this.std(0xc8a24a, 0.3, 0.9);
    for (const [x, z] of [[-1.75, -1.15], [0.45, -1.15], [-1.75, 1.15], [0.45, 1.15], [-0.65, 0]]) this.cyl(0.04, 0.05, brass, x, 0.05, z, s, 10);

    // puerto de red (RJ45) en la pared izquierda del chasis
    this.rbox(0.07, 0.14, 0.18, this.std(0x2b2f35, 0.4, 0.6), 0.01, -2.07, 0.35, 0.5, s);
    this.rbox(0.072, 0.075, 0.11, new THREE.MeshBasicMaterial({ color: 0x0b0d0f }), 0, -2.07, 0.34, 0.5, s);

    // switch de red afuera del chasis, a la izquierda, con sus luces
    this.rbox(0.9, 0.2, 1.4, this.std(0x23323b, 0.35, 0.55), 0.04, -3.1, 0.1, 0.5, s);
    for (let i = 0; i < 6; i++) {
      this.rbox(0.05, 0.04, 0.05, new THREE.MeshBasicMaterial({ color: i % 2 ? 0x3fd06a : 0xf3c04c }), 0, -2.66, 0.16, 0.0 + i * 0.2, s);
      this.rbox(0.03, 0.08, 0.12, this.std(0x0d0f11, 0.6, 0.2), 0, -2.66, 0.08, 0.0 + i * 0.2, s);
    }

    s.add(this.placed);
    // zonas donde se sueltan las piezas: brillan cuando sirven
    for (const [target, def] of Object.entries(SLOTS) as [Target, SlotDef][]) {
      const glow = new THREE.Mesh(
        new RoundedBoxGeometry(...def.size, 2, Math.min(0.04, ...def.size.map((v) => v / 2 - 0.001))),
        // se ve por encima de todo (si una pieza lo tapa, igual se sabe dónde va)
        new THREE.MeshBasicMaterial({ color: 0x3fd06a, transparent: true, opacity: 0, depthWrite: false, depthTest: false }),
      );
      glow.renderOrder = 10;
      glow.position.set(...def.pos);
      glow.userData.target = target;
      this.glows.set(target, glow);
      s.add(glow);
    }
  }

  /** Malla de una pieza ya montada. `defId` decide detalles (nombre de la CPU, color de la RAM...). */
  private partMesh(kind: Target, index = 0, defId?: string): THREE.Object3D {
    const def = SLOTS[kind];
    const g = new THREE.Group();
    g.userData.kind = kind;
    g.userData.index = index;
    switch (kind) {
      case "placa": {
        const pcbTex = this.mat("pcbtex", () => new THREE.MeshStandardMaterial({ map: TEX.pcb(), roughness: 0.55, metalness: 0.1 }));
        this.rbox(2.5, 0.05, 2.6, pcbTex, 0.015, 0, 0, 0, g);
        // socket con su palanca
        this.rbox(0.56, 0.05, 0.56, this.std(0xe8e0c8, 0.5), 0.01, -0.25, 0.045, -0.35, g);
        this.rbox(0.44, 0.051, 0.44, this.std(0x2a2d33, 0.6, 0.2), 0.005, -0.25, 0.047, -0.35, g);
        this.rbox(0.03, 0.03, 0.5, this.std(0xc9ced4, 0.3, 0.9), 0.01, 0.06, 0.075, -0.35, g);
        // disipadores de los VRM alrededor del socket
        const vrm = this.std(0x5a6470, 0.35, 0.8);
        this.rbox(0.62, 0.14, 0.14, vrm, 0.02, -0.25, 0.1, -0.78, g);
        this.rbox(0.14, 0.14, 0.5, vrm, 0.02, -0.72, 0.1, -0.35, g);
        // ranuras de RAM con sus pestañas
        for (const x of [0.65, 0.8]) {
          this.rbox(0.07, 0.1, 1.5, this.std(0x16181b, 0.6), 0.01, x, 0.07, -0.35, g);
          for (const z of [-1.12, 0.42]) this.rbox(0.08, 0.13, 0.06, this.std(0xe4e4e0, 0.5), 0.01, x, 0.09, z, g);
        }
        // PCIe con traba y chipset con disipador
        this.rbox(1.9, 0.09, 0.12, this.std(0x16181b, 0.6), 0.01, -0.1, 0.065, 0.85, g);
        this.rbox(0.08, 0.1, 0.13, this.std(0xe4e4e0, 0.5), 0.01, 0.85, 0.07, 0.85, g);
        this.rbox(0.42, 0.08, 0.42, this.std(0x5a6470, 0.35, 0.8), 0.03, 0.5, 0.06, 0.35, g);
        // condensadores
        const cap = this.std(0x1d2026, 0.35, 0.6);
        for (let i = 0; i < 6; i++) this.cyl(0.035, 0.1, cap, -0.75 + i * 0.09, 0.07, -0.02, g, 14);
        // conectores de energía: 24 pines (borde derecho) y 8 pines (arriba a la izquierda de la CPU)
        this.rbox(0.13, 0.11, 0.44, this.std(0xf2f2ee, 0.5), 0.015, 1.15, 0.07, -1.0, g);
        for (let i = 0; i < 6; i++) this.rbox(0.07, 0.112, 0.04, this.std(0x1d1d1d, 0.6), 0, 1.15, 0.071, -1.17 + i * 0.07, g);
        this.rbox(0.23, 0.11, 0.13, this.std(0xf2f2ee, 0.5), 0.015, -0.97, 0.07, -0.95, g);
        this.rbox(0.16, 0.112, 0.06, this.std(0x1d1d1d, 0.6), 0, -0.97, 0.071, -0.95, g);
        // panel trasero de puertos
        this.rbox(0.18, 0.22, 0.7, this.std(0xb7bec6, 0.35, 0.8), 0.02, -1.15, 0.12, 0.5, g);
        break;
      }
      case "cpu": {
        const name = defId ? partDef(defId).name.replace(/^CPU\s+/, "").replace(/\s*\(.*\)$/, "") : "CPU";
        this.rbox(0.48, 0.03, 0.48, this.std(0x1f6b3a, 0.5, 0.1), 0.01, 0, -0.01, 0, g);
        const ihs = this.mat(`ihs-${name}`, () => new THREE.MeshStandardMaterial({ map: TEX.ihs(name), roughness: 0.28, metalness: 0.85 }));
        this.rbox(0.4, 0.04, 0.4, ihs, 0.02, 0, 0.02, 0, g);
        break;
      }
      case "disipador": {
        const copper = this.std(0xc7744a, 0.3, 0.95);
        const alu = this.std(0xd5dbe1, 0.28, 0.9);
        this.rbox(0.5, 0.06, 0.5, copper, 0.015, 0, -0.3, 0, g);
        for (const x of [-0.12, 0, 0.12]) {
          this.cyl(0.025, 0.55, copper, x, -0.04, -0.05, g, 12);
        }
        for (let i = 0; i < 12; i++) this.rbox(0.62, 0.012, 0.56, alu, 0.004, 0, -0.18 + i * 0.038, 0, g);
        this.rbox(0.64, 0.04, 0.58, this.std(0x23262b, 0.4, 0.5), 0.015, 0, 0.29, 0, g);
        const fan = this.fan(0.6, 0x23262b, 0x3d434b, g);
        fan.rotation.x = Math.PI / 2;
        fan.position.set(0, 0.03, 0.34);
        break;
      }
      case "ram": {
        const big = defId ? (partDef(defId).ramGb ?? 2) : 2;
        const spreader = big >= 8 ? 0xb3262e : big >= 4 ? 0x2b5fb8 : 0x2e3238;
        const x = index === 0 ? -0.07 : 0.08;
        this.rbox(0.03, 0.36, 1.42, this.std(0x1f5a3a, 0.5, 0.1), 0.005, x, -0.02, 0, g);
        this.rbox(0.06, 0.3, 1.38, this.std(spreader, 0.35, 0.6), 0.02, x, 0.02, 0, g);
        this.rbox(0.062, 0.05, 1.3, this.std(0xd9dde2, 0.25, 0.9), 0.015, x, 0.19, 0, g);
        this.rbox(0.032, 0.05, 1.36, this.std(0xd8b04a, 0.25, 1), 0, x, -0.19, 0, g);
        break;
      }
      case "gpu": {
        // tarjeta vertical en la ranura PCIe, los ventiladores miran a la cámara
        this.rbox(1.85, 0.45, 0.04, this.std(0x15161a, 0.5, 0.3), 0.01, 0, 0, -0.06, g);
        const shroud = this.std(0x2a2d34, 0.35, 0.55);
        this.rbox(1.85, 0.47, 0.12, shroud, 0.05, 0, 0, 0.02, g);
        this.rbox(1.6, 0.03, 0.125, this.std(0x3fd06a, 0.3, 0.2, { emissive: 0x1d6b33, emissiveIntensity: 0.6 }), 0.01, 0.05, 0.2, 0.02, g);
        for (const fx of [-0.45, 0.45]) {
          const f = this.fan(0.4, 0x1a1c20, 0x4a5058, g);
          f.rotation.x = Math.PI / 2;
          f.position.set(fx, -0.02, 0.09);
        }
        this.rbox(0.25, 0.06, 0.13, this.std(0xc9ced4, 0.3, 0.9), 0.01, 0.95, 0.12, 0.02, g);
        break;
      }
      case "ssd": {
        const lbl = this.mat("ssd-label", () => new THREE.MeshStandardMaterial({ map: TEX.label("SSD", "256 GB · La Esquina", "#2ec4d6"), roughness: 0.5 }));
        this.rbox(0.75, 0.07, 0.55, this.std(0x3a3f46, 0.35, 0.7), 0.02, 0, 0, 0, g);
        this.rbox(0.55, 0.002, 0.36, lbl, 0, 0, 0.037, 0, g);
        this.rbox(0.24, 0.06, 0.05, this.std(0x15161a, 0.5), 0.008, 0, 0.02, 0.29, g);
        break;
      }
      case "fuente": {
        const watts = defId ? partDef(defId).watts ?? 300 : 300;
        this.rbox(0.92, 0.72, 0.92, this.std(0x202328, 0.6, 0.4), 0.04, 0, 0, 0, g);
        const grille = this.mat("grille", () => new THREE.MeshStandardMaterial({ map: TEX.grille(), roughness: 0.5, metalness: 0.5 }));
        const top = new THREE.Mesh(new THREE.CircleGeometry(0.36, 40), grille);
        top.rotation.x = -Math.PI / 2;
        top.position.y = 0.362;
        g.add(top);
        const f = this.fan(0.62, 0x15171a, 0x2f343a, g);
        f.position.y = 0.33;
        f.scale.y = 0.4;
        const lbl = this.mat(`psu-${watts}`, () => new THREE.MeshStandardMaterial({ map: TEX.label(`${watts} W`, "Fuente de poder", "#f3c04c"), roughness: 0.5 }));
        const side = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.3), lbl);
        side.position.set(0, 0.02, 0.462);
        g.add(side);
        break;
      }
      case "ventilador": {
        const f = this.fan(0.85, 0x2b2f35, 0x7f8a96, g);
        f.rotation.z = Math.PI / 2;
        break;
      }
      default: {
        // cable: una curva con funda trenzada desde la fuente (o desde la tarjeta de red al switch) hasta el conector
        const from = kind === "red" ? new THREE.Vector3(-2.02, 0.35, 0.5) : new THREE.Vector3(1.1, 0.55, 0.7);
        const to = kind === "red" ? new THREE.Vector3(-2.66, 0.12, 0.4) : new THREE.Vector3(...def.pos);
        const mid = from.clone().lerp(to, 0.5).add(new THREE.Vector3(0, 0.65, 0));
        const curve = new THREE.QuadraticBezierCurve3(from, mid, to);
        const color = kind === "red" ? 0x2e86de : kind === "sata" ? 0xd94f3d : kind === "atx24" ? 0x2a2d33 : 0x3a3f46;
        const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, kind === "atx24" ? 0.065 : 0.038, 12), this.std(color, 0.55, 0.1));
        tube.castShadow = true;
        g.add(tube);
        // las puntas: el conector a cada lado
        const plug = this.std(kind === "red" ? 0xdfe6ec : 0x15161a, 0.45, 0.2);
        for (const [p, t] of [[from, 0.02], [to, 0.98]] as const) {
          const head = this.rbox(kind === "atx24" ? 0.16 : 0.11, 0.1, kind === "atx24" ? 0.3 : 0.12, plug, 0.015, p.x, p.y, p.z, g);
          head.lookAt(curve.getPointAt(t === 0.02 ? 0.1 : 0.9));
        }
        g.userData.cable = true;
      }
    }
    if (!g.userData.cable) g.position.set(...def.pos);
    return g;
  }

  private rebuildPlaced(): void {
    if (this.finished()) return;
    // las aspas de las piezas que se van dejan de girar
    this.spinners.length = 0;
    this.placed.clear();
    const b = this.build();
    const kinds: Exclude<PartKind, "ram">[] = ["placa", "cpu", "disipador", "ssd", "fuente", "gpu", "ventilador"];
    for (const k of kinds) {
      const item = b[k];
      if (item) this.placed.add(this.partMesh(k, 0, item.def));
    }
    b.ram.forEach((r, i) => this.placed.add(this.partMesh("ram", i, r.def)));
    for (const c of b.cables) this.placed.add(this.partMesh(c));
  }

  // ── bandeja ──

  private renderTray(): void {
    if (this.finished()) return;
    const w = this.world();
    const b = this.build();
    const parts = w.parts;
    this.el.querySelector(".as-count")!.textContent = parts.length ? String(parts.length) : "";
    this.el.querySelector(".as-parts")!.innerHTML = parts.length
      ? parts.map((p) => {
          const def = partDef(p.def);
          const why = canInstall(b, def);
          const state = why ? `<span class="as-state later">${why}</span>` : `<span class="as-state ready">Lista para montar</span>`;
          return `<button class="as-item ${why ? "later" : "ready"}" data-uid="${p.uid}" data-kind="${def.kind}" data-k="${def.kind}" title="${why ?? "Arrástrala a su lugar"}">
              <span class="as-ico">${icon(def.kind)}</span>
              <span class="as-text"><span class="as-kind">${KIND_NAME[def.kind]}</span><span class="as-name">${def.name.replace(/^(Placa madre|Memoria RAM|Disco SSD|Fuente de poder)\s*/, "")}</span>${state}</span>
            </button>`;
        }).join("")
      : `<p class="as-empty">No hay piezas en el almacén. Se compran en TecnoMercado (Navegador).</p>`;
    this.el.querySelector(".as-cables")!.innerHTML = CABLES.map((c) => {
      const done = b.cables.has(c);
      const missing = cableNeeds(c).filter((k) => (k === "ram" ? !b.ram.length : !b[k as Exclude<PartKind, "ram">]));
      const [name, route] = CABLE_NAMES[c].split(" (");
      const cls = done ? "done" : missing.length ? "later" : "ready";
      return `<button class="as-item cable ${cls}" data-cable="${c}" data-k="${c}" ${done ? "disabled" : ""} title="${done ? "Conectado (clic en el cable para soltarlo)" : missing.length ? `Primero: ${missing.join(", ")}` : "Arrástralo a su conector"}">
          <span class="as-ico">${icon(c)}</span>
          <span class="as-text"><span class="as-name">${name.replace(/^Cable de /, "")}</span><span class="as-route">${route?.replace(")", "") ?? ""}</span></span>
          ${done ? '<span class="as-check" aria-label="Conectado">✓</span>' : ""}
        </button>`;
    }).join("");
  }

  /** Texto de ayuda: qué sigue. */
  private help(text?: string, tone: "info" | "bad" | "ok" = "info"): void {
    const el = this.el.querySelector<HTMLElement>(".as-help")!;
    el.className = `as-help ${tone}`;
    if (text) {
      el.textContent = text;
      return;
    }
    if (this.finished()) return;
    const b = this.build();
    const next = !b.placa ? "Empieza por la placa madre: arrástrala al fondo del chasis."
      : !b.cpu ? "Pon la CPU en el socket (el cuadrado de la placa)."
      : !b.disipador ? "El disipador va encima de la CPU: sin él se calienta."
      : !b.ram.length ? "La RAM va en las ranuras largas junto al socket."
      : !b.ssd ? "El disco va en la bahía de la derecha."
      : !b.fuente ? "La fuente de poder va abajo a la derecha."
      : CABLES.find((c) => !b.cables.has(c)) ? `Ahora los cables: ${CABLE_NAMES[CABLES.find((c) => !b.cables.has(c))!]}.`
      : "¡Todo conectado! Cierra la tapa y enciéndelo. (Clic en una pieza montada para sacarla.)";
    el.textContent = next;
  }

  private pickFromTray(e: PointerEvent): void {
    const item = (e.target as HTMLElement).closest<HTMLElement>(".as-item");
    if (!item || item.hasAttribute("disabled")) return;
    e.preventDefault();
    const target = (item.dataset.cable ?? item.dataset.kind) as Target;
    const uid = item.dataset.uid ? Number(item.dataset.uid) : null;
    const label = item.querySelector(".as-name")?.textContent ?? "";
    this.holding = { target, uid, label };
    this.link.hold?.(label);
    this.ghost.innerHTML = `${item.querySelector(".as-ico")!.innerHTML}<span>${label}</span>`;
    this.ghost.hidden = false;
    this.moveGhost(e);
    this.el.classList.add("holding");
    this.cue("ui-move");
    this.help(`${item.dataset.cable ? "Suelta el cable en" : "Suelta la pieza en"}: ${SLOTS[target].label}.`);
  }

  private release(): void {
    if (this.holding) this.link.hold?.(null);
    this.holding = null;
    this.ghost.hidden = true;
    this.hover = null;
    this.el.classList.remove("holding");
  }

  private moveGhost(e: PointerEvent): void {
    this.ghost.style.left = `${e.clientX + 14}px`;
    this.ghost.style.top = `${e.clientY + 14}px`;
  }

  private ndc(e: { clientX: number; clientY: number }): THREE.Vector2 {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  }

  private targetAt(e: { clientX: number; clientY: number }): Target | null {
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const hits = this.raycaster.intersectObjects([...this.glows.values()]);
    // si hay varias zonas, gana la que corresponde a lo que tengo en la mano
    const want = this.holding?.target;
    const match = hits.find((h) => h.object.userData.target === want);
    return (match ?? hits[0])?.object.userData.target ?? null;
  }

  /** La pieza montada bajo el mouse (la más cercana). */
  private placedAt(e: { clientX: number; clientY: number }): THREE.Object3D | null {
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const hit = this.raycaster.intersectObjects(this.placed.children, true)[0];
    let o: THREE.Object3D | null = hit?.object ?? null;
    while (o && o.parent !== this.placed) o = o.parent;
    return o;
  }

  private move(e: PointerEvent): void {
    if (this.el.hidden) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    if (!this.holding) {
      const over = (e.target as HTMLElement).closest?.(".as-tray, .as-top") ? null : this.placedAt(e);
      if (over !== this.hoverPlaced) {
        this.hoverPlaced = over;
        this.renderer.domElement.style.cursor = over ? "pointer" : "";
      }
      return;
    }
    this.moveGhost(e);
    this.hover = this.targetAt(e);
  }

  private drop(e: PointerEvent): void {
    if (!this.holding || this.el.hidden) return;
    const over = (e.target as HTMLElement).closest(".as-tray");
    if (over) return; // soltó en la bandeja: queda "en la mano" para hacer clic en el lugar
    this.place(this.targetAt(e));
  }

  private clickStage(e: MouseEvent): void {
    if (this.holding) return this.place(this.targetAt(e));
    // sin nada en la mano: clic en una pieza montada la saca
    const obj = this.placedAt(e);
    if (obj) this.takeOut(obj.userData.kind as Target, obj.userData.index as number);
  }

  /** Saca una pieza montada (o desconecta un cable) y la devuelve al almacén. */
  private takeOut(kind: Target, index: number): void {
    const w = this.world();
    if ((CABLES as string[]).includes(kind)) {
      w.disconnectCable(this.slot, kind as CableId);
      this.help(`Desconectaste el ${CABLE_NAMES[kind as CableId].toLowerCase()}.`, "info");
    } else {
      const r = w.removePart(this.slot, kind as PartKind, index);
      if (!r.ok) {
        this.help(r.reason, "bad");
        this.cue("ui-back");
        return;
      }
      this.help(`Sacaste: ${KIND_NAME[kind as PartKind].toLowerCase()}. Quedó en la bandeja.`, "info");
    }
    this.cue("pick");
    this.hoverPlaced = null;
    this.renderer.domElement.style.cursor = "";
    this.rebuildPlaced();
    this.renderTray();
    this.sig = this.signature();
  }

  /** Intenta montar lo que está en la mano en la zona `target`. */
  private place(target: Target | null): void {
    const h = this.holding;
    if (!h) return;
    const w = this.world();
    if (target !== h.target) {
      this.help(target ? `Ahí va ${SLOTS[target].label}, no esto. Busca: ${SLOTS[h.target].label}.` : `Suéltala en: ${SLOTS[h.target].label}.`, "bad");
      this.flash(h.target);
      this.cue("ui-back");
      return;
    }
    const res = h.uid !== null ? w.installPart(this.slot, h.uid) : w.connectCable(this.slot, h.target as CableId);
    if (!res.ok) {
      this.help(res.reason, "bad");
      this.cue("ui-back");
      this.release();
      return;
    }
    // la pieza baja desde arriba y encaja
    this.rebuildPlaced();
    const mesh = this.placed.children.find((o) => o.userData.kind === h.target && (h.target !== "ram" || o.userData.index === this.build().ram.length - 1));
    if (mesh && !mesh.userData.cable) {
      const to = mesh.position.clone();
      mesh.position.y += 1.2;
      this.drops.push({ obj: mesh, to, t: 0 });
    }
    this.cue("place");
    this.release();
    this.renderTray();
    this.help();
    this.sig = this.signature();
  }

  private flashUntil = new Map<Target, number>();
  private flash(t: Target): void {
    this.flashUntil.set(t, performance.now() + 1400);
  }

  // ── encender ──

  private powerOn(): void {
    const w = this.world();
    const wasOpen = !!w.rackServer(this.slot)?.maintenance;
    const { post, server } = w.powerOn(this.slot);
    this.cue(post.ok ? "check" : "ui-back");
    this.link.posted?.(post, post.ok);
    this.showPost(post, server, wasOpen && !!server?.os);
  }

  private showPost(post: PostResult, server: Server | null, hasLinux: boolean, mine = true): void {
    void mine;
    const box = this.el.querySelector<HTMLElement>(".as-post")!;
    const pre = box.querySelector("pre")!;
    const btn = box.querySelector<HTMLButtonElement>(".as-post-ok")!;
    box.hidden = false;
    box.classList.toggle("ok", post.ok);
    const lines = ["BIOS de La Esquina v1.0", "Prueba de encendido (POST)…", "", ...post.lines, ...post.warnings.map((x) => `⚠ ${x}`)];
    pre.textContent = "";
    btn.hidden = true;
    let i = 0;
    const type = () => {
      if (box.hidden) return;
      if (i < lines.length) {
        pre.textContent += lines[i++] + "\n";
        setTimeout(type, 260);
      } else {
        btn.hidden = false;
        btn.textContent = post.ok ? (hasLinux ? "Listo ▸" : "Instalar Linux ▸") : "Volver al montaje";
        btn.focus();
      }
    };
    type();
    btn.onclick = () => {
      box.hidden = true;
      if (post.ok) this.close(server);
    };
  }

  // ── cuadro a cuadro ──

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private frame(time: number): void {
    // el otro jugador montó o sacó algo (o encendió): se redibuja
    if (time - this.lastSigCheck > 250) {
      this.lastSigCheck = time;
      const sig = this.signature();
      if (sig !== this.sig) {
        this.sig = sig;
        if (sig !== "listo") {
          this.rebuildPlaced();
          this.renderTray();
          if (!this.holding) this.help();
        }
      }
    }
    // la cámara entra (zoom) y se mueve un poco con el mouse, como la cabeza
    this.zoom = Math.min(1, this.zoom + 0.025);
    const k = 1 - (1 - this.zoom) ** 3;
    const far = new THREE.Vector3(0, 7.5, 8.5);
    const near = new THREE.Vector3(-0.1, 5.4, 3.7);
    this.camera.position.copy(far.lerp(near, k)).add(new THREE.Vector3(this.mouse.x * 0.25, this.mouse.y * 0.12, 0));
    this.camera.lookAt(-0.25, 0, 0.3);
    for (const d of [...this.drops]) {
      d.t = Math.min(1, d.t + 0.07);
      d.obj.position.lerpVectors(d.obj.position, d.to, d.t);
      if (d.t >= 1) this.drops.splice(this.drops.indexOf(d), 1);
    }
    for (const s of this.spinners) s.obj.rotation[s.axis] += s.speed * 16;
    // brillo de las zonas: verde la que sirve, más fuerte bajo el mouse; parpadea la correcta si se equivocó
    for (const [t, glow] of this.glows) {
      const mat = glow.material as THREE.MeshBasicMaterial;
      const want = this.holding?.target === t;
      const flashing = (this.flashUntil.get(t) ?? 0) > time;
      mat.color.setHex(this.hover && this.hover === t && !want ? 0xe2483d : 0x3fd06a);
      mat.opacity = want ? (this.hover === t ? 0.6 : 0.32 + Math.sin(time / 180) * 0.14) : flashing ? 0.28 + Math.sin(time / 90) * 0.22 : this.hover === t ? 0.22 : 0;
    }
    // la pieza montada bajo el mouse se marca (clic = sacarla)
    for (const o of this.placed.children) {
      const on = o === this.hoverPlaced;
      if (o.userData.lit === on) continue;
      o.userData.lit = on;
      o.traverse((m) => {
        const mesh = m as THREE.Mesh;
        if (!mesh.isMesh) return;
        if (on) {
          mesh.userData.base ??= mesh.material;
          const c = (mesh.material as THREE.MeshStandardMaterial).clone();
          c.emissive = new THREE.Color(0xf3c04c);
          c.emissiveIntensity = 0.35;
          mesh.material = c;
        } else if (mesh.userData.base) mesh.material = mesh.userData.base;
      });
    }
    this.renderer.render(this.scene, this.camera);
  }
}
