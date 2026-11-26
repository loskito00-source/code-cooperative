import type { Server, World } from "@cdb/sim";
import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { mergeStatic } from "./perf.js";

/**
 * La sala de servidores (anexo al oeste de la tienda): un centro de datos pequeño pero creíble, en el mismo
 * estilo low-poly de la tienda. Piso técnico con baldosas perforadas, 3 gabinetes de rack con puerta de malla,
 * bandeja de cables, switch y patch panel con luces, aire acondicionado (si lo compraron), consola con monitor,
 * UPS y extintor. Todo reacciona al estado del juego: luces de carga, franja de estado arriba de cada rack,
 * pantalla de la pared con la temperatura de cada servidor y el puesto libre que "invita" a montar.
 */

export const ROOM = {
  /** Borde oeste, este y norte del anexo (coordenadas de la escena). */
  x0: -3.75,
  x1: -0.62,
  /** El rack i está en x = rackX0 + i * rackStep. */
  rackX0: -3.3,
  rackStep: 0.8,
};

interface RackView {
  group: THREE.Group;
  /** El gabinete (solo si ya lo compraron). */
  body: THREE.Group;
  /** Puesto sin gabinete: marca en el piso. */
  spot: THREE.Group;
  /** El servidor encendido (unidad de 2U con su frente). */
  unit: THREE.Group;
  leds: THREE.Mesh[];
  /** Montaje a medias: chasis abierto sobre un carrito delante del rack. */
  building: THREE.Group;
  /** Puesto libre: silueta que late para invitar a montar. */
  ghost: THREE.Mesh;
  /** Franja de luz arriba del rack: verde bien, ámbar caliente, rojo atacado, azul sin servidor. */
  strip: THREE.Mesh;
  door: THREE.Mesh;
  fans: THREE.Mesh[];
  label: HTMLDivElement;
}

// ── texturas dibujadas (sin archivos) ──

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat?: [number, number]): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(...repeat);
  }
  return t;
}

/** Baldosa de piso técnico: gris claro, borde, y una de cada tanto perforada (sale el aire frío). */
const floorTex = () =>
  canvasTex(256, 256, (g) => {
    for (let ty = 0; ty < 2; ty++) {
      for (let tx = 0; tx < 2; tx++) {
        const x = tx * 128;
        const y = ty * 128;
        const vent = (tx + ty) % 2 === 0;
        g.fillStyle = vent ? "#aeb7bf" : "#c6cdd3";
        g.fillRect(x, y, 128, 128);
        g.strokeStyle = "#8d969e";
        g.lineWidth = 4;
        g.strokeRect(x + 2, y + 2, 124, 124);
        if (vent) {
          g.fillStyle = "#6f7880";
          for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) g.fillRect(x + 16 + i * 11, y + 16 + j * 11, 5, 5);
        }
      }
    }
  }, [3, 3]);

/** Puerta de malla perforada del rack (negra, con agujeros hexagonales). */
const meshDoorTex = () =>
  canvasTex(128, 256, (g) => {
    g.fillStyle = "#15181c";
    g.fillRect(0, 0, 128, 256);
    g.fillStyle = "#2e343b";
    for (let y = 8; y < 248; y += 9) for (let x = 8 + ((y / 9) % 2) * 4; x < 122; x += 9) {
      g.beginPath();
      g.arc(x, y, 2.6, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = "#3b434b";
    g.fillRect(112, 110, 8, 36); // manija
  });

/** Frente de un servidor de 2U: bahías de discos y rejilla. */
const bezelTex = () =>
  canvasTex(256, 64, (g) => {
    g.fillStyle = "#2b3138";
    g.fillRect(0, 0, 256, 64);
    for (let i = 0; i < 6; i++) {
      g.fillStyle = "#1a1e23";
      g.fillRect(10 + i * 28, 10, 24, 44);
      g.fillStyle = "#3d454d";
      g.fillRect(12 + i * 28, 46, 20, 5);
    }
    g.fillStyle = "#14171b";
    for (let y = 12; y < 54; y += 6) for (let x = 186; x < 246; x += 6) g.fillRect(x, y, 3, 3);
  });

/** Panel ciego (relleno de los huecos del rack). */
const blankTex = () =>
  canvasTex(128, 32, (g) => {
    g.fillStyle = "#1d2126";
    g.fillRect(0, 0, 128, 32);
    g.strokeStyle = "#2c3238";
    for (let y = 4; y < 32; y += 8) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(128, y);
      g.stroke();
    }
  });

/** Franjas de seguridad amarillas y negras. */
const hazardTex = () =>
  canvasTex(128, 16, (g) => {
    g.fillStyle = "#f2c230";
    g.fillRect(0, 0, 128, 16);
    g.fillStyle = "#1b1b1b";
    for (let x = -16; x < 140; x += 24) {
      g.beginPath();
      g.moveTo(x, 16);
      g.lineTo(x + 12, 0);
      g.lineTo(x + 24, 0);
      g.lineTo(x + 12, 16);
      g.fill();
    }
  }, [6, 1]);

/** Letrero de la sala. */
const signTex = () =>
  canvasTex(512, 96, (g) => {
    g.fillStyle = "#12302a";
    g.fillRect(0, 0, 512, 96);
    g.fillStyle = "#3fd06a";
    g.fillRect(0, 88, 512, 8);
    g.font = "bold 44px sans-serif";
    g.fillStyle = "#e9f5ec";
    g.textBaseline = "middle";
    g.fillText("SALA DE SERVIDORES", 28, 44);
    g.font = "bold 26px monospace";
    g.fillStyle = "#7ee08f";
    g.fillText("10.0.0.0/24", 380, 46);
  });

export class ServerRoom {
  readonly racks: RackView[] = [];
  private readonly screen: { tex: THREE.CanvasTexture; ctx: CanvasRenderingContext2D; last: number };
  private readonly monitor: { tex: THREE.CanvasTexture; ctx: CanvasRenderingContext2D; last: number; line: number };
  private readonly aircon: THREE.Group;
  private readonly airFan: THREE.Mesh;
  private readonly deskFan: THREE.Group;
  private readonly deskFanBlades: THREE.Mesh;
  private readonly switchLeds: THREE.Mesh[] = [];
  /** Luz propia de la sala: de noche se nota más (la tienda se apaga, los servidores no). */
  private readonly light: THREE.PointLight;

  constructor(private readonly scene: THREE.Scene, private readonly zBack: number, label: (text: string, cls: string, parent: THREE.Object3D, y: number) => HTMLDivElement) {
    // un material por color (así lo fijo se funde en pocas piezas)
    const cache = new Map<string, THREE.MeshStandardMaterial>();
    const M = (color: number, extra: THREE.MeshStandardMaterialParameters = {}) => {
      const key = `${color}|${JSON.stringify(extra)}`;
      let m = cache.get(key);
      if (!m) cache.set(key, (m = new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...extra })));
      return m;
    };
    const statics = new THREE.Group();
    scene.add(statics);
    const box = (parent: THREE.Object3D, w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, shadow = true) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      m.castShadow = shadow;
      m.receiveShadow = true;
      parent.add(m);
      return m;
    };
    const W = ROOM.x1 - ROOM.x0;
    const cx = (ROOM.x0 + ROOM.x1) / 2;
    const z0 = zBack;
    const D = 3.0;
    const cz = z0 + D / 2;

    // ── base, piso técnico y bordes ──
    box(statics, W + 0.1, 0.35, D + 0.1, M(0x5b636b, { roughness: 0.9 }), cx, -0.18, cz, false);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ map: floorTex(), roughness: 0.75, metalness: 0.1 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(cx, 0.006, cz);
    floor.receiveShadow = true;
    statics.add(floor);
    const hazard = new THREE.Mesh(new THREE.PlaneGeometry(W, 0.09), new THREE.MeshStandardMaterial({ map: hazardTex(), roughness: 0.6 }));
    hazard.rotation.x = -Math.PI / 2;
    hazard.position.set(cx, 0.008, z0 + D - 0.06);
    statics.add(hazard);
    // franja de luz en el piso delante de los racks (pasillo frío)
    const coldAisle = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.3, 0.035), new THREE.MeshBasicMaterial({ color: 0x5fc8ff }));
    coldAisle.rotation.x = -Math.PI / 2;
    coldAisle.position.set(cx, 0.01, z0 + 1.02);
    scene.add(coldAisle);

    // ── paredes: fondo (norte) y oeste, de panel gris claro con zócalo ──
    const wallMat = M(0xe4e8eb, { roughness: 0.85 });
    const trimMat = M(0x3a4148, { roughness: 0.5 });
    box(statics, W, 1.9, 0.1, wallMat, cx, 0.95, z0 - 0.05);
    box(statics, 0.1, 1.9, D, wallMat, ROOM.x0 - 0.05, 0.95, cz);
    box(statics, W, 0.08, 0.12, trimMat, cx, 0.04, z0 - 0.02);
    box(statics, 0.12, 0.08, D, trimMat, ROOM.x0 - 0.02, 0.04, cz);
    // juntas de los paneles de la pared
    for (let x = ROOM.x0 + 0.6; x < ROOM.x1; x += 0.6) box(statics, 0.012, 1.9, 0.012, M(0xc9cfd4), x, 0.95, z0 + 0.002, false);
    // barra de luz en lo alto de la pared y luz de la sala (blanca fría, de centro de datos)
    const lightBar = new THREE.Mesh(new THREE.BoxGeometry(W - 0.3, 0.04, 0.05), new THREE.MeshBasicMaterial({ color: 0xe8f6ff }));
    lightBar.position.set(cx, 1.86, z0 + 0.04);
    scene.add(lightBar);
    this.light = new THREE.PointLight(0xdff1ff, 2.5, 5.5, 1.3);
    this.light.position.set(cx, 2.3, z0 + 1.6);
    scene.add(this.light);
    // letrero
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.24), new THREE.MeshBasicMaterial({ map: signTex() }));
    sign.position.set(ROOM.x0 + 0.012, 1.62, z0 + 2.3);
    sign.rotation.y = Math.PI / 2;
    scene.add(sign);

    // ── bandeja de cables amarilla sobre los racks, con cables que bajan ──
    const trayMat = M(0xf2c230, { roughness: 0.45, metalness: 0.3 });
    const trayY = 1.72;
    box(statics, W - 0.25, 0.025, 0.24, trayMat, cx, trayY, z0 + 0.45, false);
    box(statics, W - 0.25, 0.07, 0.02, trayMat, cx, trayY + 0.04, z0 + 0.34, false);
    box(statics, W - 0.25, 0.07, 0.02, trayMat, cx, trayY + 0.04, z0 + 0.56, false);
    for (let x = ROOM.x0 + 0.3; x < ROOM.x1 - 0.2; x += 0.22) box(statics, 0.02, 0.07, 0.24, trayMat, x, trayY + 0.04, z0 + 0.45, false);
    const cableColors = [0x2e86de, 0x2e86de, 0xd94f3d, 0x3fd06a, 0x2e86de];
    for (let i = 0; i < 3; i++) {
      const x = ROOM.rackX0 + i * ROOM.rackStep;
      cableColors.forEach((c, k) => {
        if (k > 2) return;
        box(statics, 0.025, 0.12, 0.025, M(c, { roughness: 0.7 }), x - 0.08 + k * 0.08, trayY - 0.08, z0 + 0.45, false);
      });
      // cables a lo largo de la bandeja
      box(statics, ROOM.rackStep, 0.03, 0.03, M(cableColors[i]), x + 0.43, trayY + 0.03, z0 + 0.42 + i * 0.04, false);
    }

    // ── switch y patch panel en la pared, con luces de los puertos ──
    const netX = ROOM.x1 - 0.42;
    box(statics, 0.5, 0.36, 0.12, M(0x23282e, { metalness: 0.4 }), netX, 1.28, z0 + 0.07);
    box(statics, 0.46, 0.08, 0.02, M(0x15181c), netX, 1.38, z0 + 0.14);
    box(statics, 0.46, 0.08, 0.02, M(0x15181c), netX, 1.24, z0 + 0.14);
    for (let row = 0; row < 2; row++) {
      for (let i = 0; i < 5; i++) {
        const led = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.02, 0.01), new THREE.MeshBasicMaterial({ color: 0x3fd06a }));
        led.position.set(netX - 0.18 + i * 0.09, row ? 1.29 : 1.43, z0 + 0.152);
        scene.add(led);
        this.switchLeds.push(led);
      }
    }
    // cable gordo del switch a la bandeja
    box(statics, 0.05, trayY - 1.46, 0.05, M(0x2e86de), netX + 0.18, (trayY + 1.46) / 2, z0 + 0.1, false);

    // ── pantalla de la pared: estado de los servidores (se dibuja en vivo) ──
    const sc = document.createElement("canvas");
    sc.width = 512;
    sc.height = 256;
    const scTex = new THREE.CanvasTexture(sc);
    scTex.colorSpace = THREE.SRGBColorSpace;
    this.screen = { tex: scTex, ctx: sc.getContext("2d")!, last: 0 };
    box(statics, 0.04, 0.52, 0.96, M(0x111417), ROOM.x0 + 0.03, 1.42, z0 + 1.0);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.45), new THREE.MeshBasicMaterial({ map: scTex }));
    screen.position.set(ROOM.x0 + 0.055, 1.42, z0 + 1.0);
    screen.rotation.y = Math.PI / 2;
    scene.add(screen);

    // ── aire acondicionado de precisión en la pared oeste (solo si lo compraron) ──
    this.aircon = new THREE.Group();
    this.aircon.position.set(ROOM.x0 + 0.17, 0, z0 + 1.75);
    box(this.aircon, 0.3, 1.25, 0.72, M(0xf0f2f4, { roughness: 0.4 }), 0, 0.625, 0);
    box(this.aircon, 0.02, 0.5, 0.6, M(0x9aa3ab), 0.16, 0.42, 0);
    for (let i = 0; i < 6; i++) box(this.aircon, 0.022, 0.012, 0.58, M(0x6f7880), 0.165, 0.22 + i * 0.07, 0, false);
    const acPanel = box(this.aircon, 0.02, 0.12, 0.22, new THREE.MeshBasicMaterial({ color: 0x5fc8ff }), 0.161, 1.05, 0.12, false);
    void acPanel;
    this.airFan = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.02, 6), M(0x4d565e, { metalness: 0.5 }));
    this.airFan.rotation.z = Math.PI / 2;
    this.airFan.position.set(0.17, 0.85, -0.12);
    this.aircon.add(this.airFan);
    this.aircon.visible = false;
    scene.add(this.aircon);
    // sin aire acondicionado: un ventilador de pie (de los baratos)
    this.deskFan = new THREE.Group();
    this.deskFan.position.set(ROOM.x0 + 0.3, 0, z0 + 1.9);
    box(this.deskFan, 0.22, 0.03, 0.22, M(0x2f343a), 0, 0.015, 0);
    box(this.deskFan, 0.03, 0.62, 0.03, M(0x9aa3ab, { metalness: 0.6 }), 0, 0.33, 0);
    const cage = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.015, 6, 20), M(0xc9cfd4, { metalness: 0.6 }));
    cage.position.y = 0.68;
    cage.rotation.y = Math.PI / 2;
    this.deskFan.add(cage);
    this.deskFanBlades = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.28, 0.05), M(0x5fa8d8));
    this.deskFanBlades.position.y = 0.68;
    this.deskFan.add(this.deskFanBlades);
    this.deskFan.rotation.y = -0.6;
    scene.add(this.deskFan);

    // ── consola: escritorio, monitor con la terminal, teclado y silla ──
    const desk = new THREE.Group();
    desk.position.set(ROOM.x1 - 0.55, 0, z0 + 2.3);
    desk.rotation.y = -0.35;
    const wood = M(0x8a6a4a, { roughness: 0.8 });
    const metal = M(0x30363c, { metalness: 0.5 });
    box(desk, 0.8, 0.04, 0.42, wood, 0, 0.5, 0);
    for (const [x, z] of [[-0.36, -0.17], [0.36, -0.17], [-0.36, 0.17], [0.36, 0.17]]) box(desk, 0.035, 0.5, 0.035, metal, x, 0.25, z);
    box(desk, 0.36, 0.24, 0.025, M(0x111417), 0, 0.72, -0.12);
    box(desk, 0.05, 0.12, 0.04, metal, 0, 0.57, -0.13);
    box(desk, 0.32, 0.012, 0.1, M(0x22272c), 0, 0.525, 0.06);
    box(desk, 0.06, 0.012, 0.08, M(0x22272c), 0.24, 0.525, 0.06);
    const mc = document.createElement("canvas");
    mc.width = 256;
    mc.height = 160;
    const mTex = new THREE.CanvasTexture(mc);
    mTex.colorSpace = THREE.SRGBColorSpace;
    this.monitor = { tex: mTex, ctx: mc.getContext("2d")!, last: 0, line: 0 };
    const mon = new THREE.Mesh(new THREE.PlaneGeometry(0.33, 0.21), new THREE.MeshBasicMaterial({ map: mTex }));
    mon.position.set(0, 0.72, -0.106);
    desk.add(mon);
    // la pantalla cambia: se saca del grupo que se va a fundir, conservando dónde quedó
    desk.updateMatrixWorld(true);
    scene.attach(mon);
    // silla de oficina
    const chair = new THREE.Group();
    chair.position.set(0.05, 0, 0.42);
    chair.rotation.y = 0.3;
    box(chair, 0.3, 0.05, 0.3, M(0x2b3a4a), 0, 0.42, 0);
    box(chair, 0.3, 0.34, 0.04, M(0x2b3a4a), 0, 0.62, 0.15);
    box(chair, 0.04, 0.38, 0.04, metal, 0, 0.21, 0);
    box(chair, 0.34, 0.025, 0.04, metal, 0, 0.03, 0);
    box(chair, 0.04, 0.025, 0.34, metal, 0, 0.03, 0);
    desk.add(chair);
    statics.add(desk);

    // ── UPS (respaldo de energía) y extintor ──
    const ups = new THREE.Group();
    ups.position.set(ROOM.x1 - 0.32, 0, z0 + 1.25);
    box(ups, 0.3, 0.5, 0.42, M(0x1f2328, { metalness: 0.3 }), 0, 0.25, 0);
    box(ups, 0.14, 0.06, 0.01, new THREE.MeshBasicMaterial({ color: 0x7ee08f }), 0, 0.4, 0.211, false);
    box(ups, 0.2, 0.012, 0.01, M(0x3a4148), 0, 0.3, 0.211, false);
    statics.add(ups);
    const ext = new THREE.Group();
    ext.position.set(ROOM.x0 + 0.14, 0, z0 + 2.72);
    const red = M(0xd8352a, { roughness: 0.35 });
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.34, 12), red);
    cyl.position.y = 0.2;
    cyl.castShadow = true;
    ext.add(cyl);
    box(ext, 0.05, 0.06, 0.05, M(0x1b1b1b), 0, 0.4, 0);
    box(ext, 0.12, 0.02, 0.02, M(0x1b1b1b), 0.05, 0.42, 0);
    statics.add(ext);

    // ── los 3 gabinetes de rack ──
    const frameMat = M(0x1a1d21, { metalness: 0.55, roughness: 0.35 });
    const sideMat = M(0x262b31, { metalness: 0.4, roughness: 0.45 });
    const doorTex = meshDoorTex();
    const bezel = bezelTex();
    const blank = blankTex();
    const postMat = M(0x8d969e, { metalness: 0.7 });
    const blankMat = new THREE.MeshStandardMaterial({ map: blank, roughness: 0.6, metalness: 0.3 });
    const pduMat = M(0x111417);
    for (let slot = 0; slot < 3; slot++) {
      const g = new THREE.Group();
      g.position.set(ROOM.rackX0 + slot * ROOM.rackStep, 0, z0 + 0.5);
      // el gabinete entero se esconde mientras no lo compren
      const body = new THREE.Group();
      g.add(body);
      const rs = body;
      const RW = 0.64, RH = 1.6, RD = 0.72;
      // marco: base, techo, laterales, fondo y postes
      box(rs, RW, 0.06, RD, frameMat, 0, 0.05, 0);
      box(rs, RW, 0.05, RD, frameMat, 0, RH, 0);
      box(rs, 0.03, RH, RD, sideMat, -RW / 2 + 0.015, RH / 2, 0);
      box(rs, 0.03, RH, RD, sideMat, RW / 2 - 0.015, RH / 2, 0);
      box(rs, RW, RH, 0.03, sideMat, 0, RH / 2, -RD / 2 + 0.015);
      for (const x of [-0.25, 0.25]) box(rs, 0.025, RH - 0.1, 0.025, postMat, x, RH / 2, RD / 2 - 0.06, false);
      // rejilla de ventilación del techo y ventiladores
      const fans: THREE.Mesh[] = [];
      for (const x of [-0.14, 0.14]) {
        const fan = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.01, 6), M(0x3c444c, { metalness: 0.5 }));
        fan.position.set(x, RH + 0.03, 0);
        body.add(fan);
        fans.push(fan);
      }
      // paneles ciegos (rellenan los huecos) y algo de equipo fijo: patch panel arriba, PDU vertical
      for (let u = 0; u < 7; u++) {
        if (u === 3) continue; // el hueco del servidor
        const p = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.17), blankMat);
        p.position.set(0, 0.22 + u * 0.19, RD / 2 - 0.07);
        rs.add(p);
      }
      box(rs, 0.03, RH - 0.25, 0.03, pduMat, RW / 2 - 0.06, RH / 2, -RD / 2 + 0.06, false);
      // puerta de malla (semitransparente, para ver las luces)
      const door = new THREE.Mesh(
        new THREE.PlaneGeometry(RW - 0.04, RH - 0.06),
        new THREE.MeshStandardMaterial({ map: doorTex, transparent: true, opacity: 0.32, roughness: 0.5, metalness: 0.4, emissive: 0x000000, depthWrite: false }),
      );
      door.position.set(0, RH / 2 + 0.03, RD / 2 + 0.002);
      body.add(door);
      // franja de estado arriba de la puerta
      const strip = new THREE.Mesh(new THREE.BoxGeometry(RW - 0.08, 0.035, 0.014), new THREE.MeshBasicMaterial({ color: 0x4aa8ff }));
      strip.position.set(0, RH - 0.05, RD / 2 + 0.01);
      body.add(strip);
      // el servidor: unidad de 2U con su frente, discos y luces
      const unit = new THREE.Group();
      unit.position.set(0, 0.22 + 3 * 0.19, 0.02);
      const chassis = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.17, 0.62), M(0x5d6873, { metalness: 0.5, roughness: 0.35 }));
      chassis.castShadow = true;
      unit.add(chassis);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.17), new THREE.MeshStandardMaterial({ map: bezel, roughness: 0.45, metalness: 0.2, emissive: 0x1a2026, emissiveMap: bezel }));
      face.position.z = 0.311;
      unit.add(face);
      const leds: THREE.Mesh[] = [];
      for (let i = 0; i < 4; i++) {
        const led = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.02, 0.008), new THREE.MeshBasicMaterial({ color: 0x3fd06a }));
        led.position.set(-0.19 + i * 0.07, -0.055, 0.315);
        unit.add(led);
        leds.push(led);
      }
      const power = new THREE.Mesh(new THREE.CircleGeometry(0.012, 12), new THREE.MeshBasicMaterial({ color: 0x5fc8ff }));
      power.position.set(0.21, 0.05, 0.313);
      unit.add(power);
      unit.visible = false;
      body.add(unit);
      // puesto libre: silueta que late
      const ghost = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.17, 0.62),
        new THREE.MeshBasicMaterial({ color: 0x7ee08f, transparent: true, opacity: 0.25, depthWrite: false, wireframe: true }),
      );
      ghost.position.copy(unit.position);
      body.add(ghost);
      // montaje a medias: carrito con el chasis abierto delante del rack
      const building = new THREE.Group();
      building.position.set(0, 0, RD / 2 + 0.36);
      box(building, 0.5, 0.03, 0.36, M(0x8d969e, { metalness: 0.6 }), 0, 0.42, 0);
      for (const [x, z] of [[-0.22, -0.15], [0.22, -0.15], [-0.22, 0.15], [0.22, 0.15]]) box(building, 0.025, 0.42, 0.025, M(0x5b636b), x, 0.21, z);
      box(building, 0.46, 0.1, 0.32, M(0xb4bcc5, { metalness: 0.5 }), 0, 0.5, 0);
      box(building, 0.4, 0.012, 0.26, M(0x1f6b3a), 0, 0.56, 0);
      building.visible = false;
      body.add(building);
      // puesto sin gabinete: contorno punteado en el piso y una cruz
      const spot = new THREE.Group();
      const spotMat = new THREE.MeshBasicMaterial({ color: 0x4aa8ff, transparent: true, opacity: 0.8 });
      for (let i = 0; i < 6; i++) {
        for (const [x, z, w, d] of [[-RW / 2 + 0.05 + i * 0.11, -RD / 2, 0.07, 0.025], [-RW / 2 + 0.05 + i * 0.11, RD / 2, 0.07, 0.025]] as const) {
          const dash = new THREE.Mesh(new THREE.BoxGeometry(w, 0.01, d), spotMat);
          dash.position.set(x, 0.012, z);
          spot.add(dash);
        }
        for (const [x, z, w, d] of [[-RW / 2, -RD / 2 + 0.06 + i * 0.12, 0.025, 0.08], [RW / 2, -RD / 2 + 0.06 + i * 0.12, 0.025, 0.08]] as const) {
          const dash = new THREE.Mesh(new THREE.BoxGeometry(w, 0.01, d), spotMat);
          dash.position.set(x, 0.012, z);
          spot.add(dash);
        }
      }
      for (const [w, d] of [[0.22, 0.04], [0.04, 0.22]] as const) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(w, 0.012, d), spotMat);
        bar.position.y = 0.013;
        spot.add(bar);
      }
      // caja invisible para el mouse (pasar por encima / clic = comprar)
      const hit = new THREE.Mesh(new THREE.BoxGeometry(RW, 0.6, RD), new THREE.MeshBasicMaterial({ visible: false }));
      hit.position.y = 0.3;
      spot.add(hit);
      g.add(spot);
      const lab = label("", "label-rack", g, RH + 0.22);
      scene.add(g);
      this.racks.push({ group: g, body, spot, unit, leds, building, ghost, strip, door, fans, label: lab });
    }

    // todo lo que no se mueve, en pocas piezas (rendimiento)
    mergeStatic(scene, [statics], () => false);
  }

  /** Cada cuadro: luces, franjas de estado, ventiladores, pantallas. */
  update(w: World, time: number, hovered: THREE.Object3D | null, night = 0): void {
    this.light.intensity = 1.2 + night * 5;
    const aire = w.services.has("aire");
    this.aircon.visible = aire;
    this.deskFan.visible = !aire;
    this.airFan.rotation.y = time / 120;
    this.deskFanBlades.rotation.x = time / 70;
    // luces del switch: titilan con el tráfico
    const traffic = Math.min(1, w.servers.reduce((s, x) => s + x.load + (x.ddos ? x.ddos.level : 0), 0));
    this.switchLeds.forEach((led, i) => {
      const on = Math.sin(time / (90 + i * 13) + i) > 0.6 - traffic;
      (led.material as THREE.MeshBasicMaterial).color.setHex(on ? (i % 5 === 0 ? 0xf3c04c : 0x3fd06a) : 0x16301d);
    });
    this.racks.forEach((v, slot) => {
      const owned = slot < w.racksOwned;
      v.body.visible = owned;
      // los puestos que no caben en la sala (sin ampliar en Mejoras) ni se ofrecen
      v.spot.visible = !owned && slot < w.rackCapacity;
      if (!owned) {
        ((v.spot.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = hovered === v.group ? 1 : 0.45 + Math.sin(time / 500) * 0.15;
        if (v.label.textContent !== "") v.label.textContent = "";
        v.label.className = "label-rack locked";
        return;
      }
      this.updateRack(v, w.rackServer(slot) ?? null, !!w.racks[slot], time, hovered === v.group);
    });
    if (time - this.screen.last > 1000) {
      this.screen.last = time;
      this.drawScreen(w);
    }
    if (time - this.monitor.last > 450) {
      this.monitor.last = time;
      this.drawMonitor(w);
    }
  }

  private updateRack(v: RackView, s: Server | null, building: boolean, time: number, hovered: boolean): void {
    v.unit.visible = !!s;
    v.building.visible = !s && building;
    v.ghost.visible = !s && !building;
    const gm = v.ghost.material as THREE.MeshBasicMaterial;
    gm.opacity = 0.18 + (Math.sin(time / 320) + 1) * 0.2;
    const bad = !!s && ((s.malware !== null && s.malware.respawnAt === null) || !!s.ddos);
    const hot = !!s && s.temp > 85;
    const state = !s ? (building ? "building" : "free") : !s.online ? "off" : bad ? "bad" : hot ? "hot" : !s.os || !s.services.has("robot-agent") ? "setup" : "on";
    const stripColor = { free: 0x4aa8ff, building: 0xf3c04c, off: 0x333333, bad: 0xe2483d, hot: 0xf39c32, setup: 0xf3c04c, on: 0x3fd06a }[state];
    const sm = v.strip.material as THREE.MeshBasicMaterial;
    const pulse = state === "bad" ? (Math.sin(time / 120) > 0 ? 1 : 0.25) : 1;
    sm.color.setHex(stripColor).multiplyScalar(pulse);
    // al pasar el mouse, la puerta se aclara un poco
    const dm = v.door.material as THREE.MeshStandardMaterial;
    dm.emissive.setHex(hovered ? 0x1d3a2a : 0x000000);
    dm.opacity = hovered ? 0.18 : 0.32;
    v.fans.forEach((f, i) => (f.rotation.y = (s?.online ? time / (60 - (s.load * 30)) : 0) + i));
    const text = s ? s.hostname : building ? "⋯" : "";
    if (v.label.textContent !== text) v.label.textContent = text;
    v.label.className = `label-rack ${state}`;
    if (!s) return;
    v.leds.forEach((led, i) => {
      const m = led.material as THREE.MeshBasicMaterial;
      if (!s.online) return m.color.setHex(0x1b1b1b);
      const rate = 80 + (1 - s.load) * 500 + i * 17;
      const on = i === 0 || Math.sin(time / rate + i * 1.7) > 0.3 - s.load;
      m.color.setHex(!on ? 0x15251a : bad && i >= 2 ? 0xe2483d : hot && i === 3 ? 0xf3c04c : i === 0 ? 0x5fc8ff : 0x3fd06a);
    });
  }

  /** Pantalla de la pared: temperatura y carga de cada servidor. */
  private drawScreen(w: World): void {
    const g = this.screen.ctx;
    g.fillStyle = "#0b1410";
    g.fillRect(0, 0, 512, 256);
    g.fillStyle = "#16362a";
    g.fillRect(0, 0, 512, 40);
    g.font = "bold 22px monospace";
    g.fillStyle = "#7ee08f";
    g.fillText("MONITOREO", 16, 28);
    const c = w.clock;
    g.fillStyle = "#a8b5a9";
    g.fillText(`${String(Math.floor(c.hour)).padStart(2, "0")}:${String(Math.floor((c.hour % 1) * 60)).padStart(2, "0")}`, 420, 28);
    if (!w.servers.length) {
      g.fillStyle = "#f3c04c";
      g.font = "bold 24px monospace";
      g.fillText("SIN SERVIDORES", 120, 130);
      g.font = "18px monospace";
      g.fillStyle = "#a8b5a9";
      g.fillText("monta uno en el rack", 140, 165);
    }
    w.servers.slice(0, 3).forEach((s, i) => {
      const y = 62 + i * 64;
      const bad = (s.malware && s.malware.respawnAt === null) || s.ddos;
      g.font = "bold 22px monospace";
      g.fillStyle = bad ? "#ff8f84" : "#e9f5ec";
      g.fillText(s.hostname.slice(0, 10), 16, y + 22);
      g.font = "18px monospace";
      g.fillStyle = s.temp > 85 ? "#f39c32" : "#a8b5a9";
      g.fillText(`${Math.round(s.temp)}°C`, 170, y + 22);
      // barra de CPU
      g.fillStyle = "#1d2a24";
      g.fillRect(250, y + 6, 240, 20);
      g.fillStyle = s.load > 0.8 ? "#e2483d" : s.load > 0.5 ? "#f3c04c" : "#3fd06a";
      g.fillRect(250, y + 6, 240 * Math.min(1, s.load), 20);
      g.fillStyle = "#e9f5ec";
      g.fillText(`${Math.round(s.load * 100)}%`, 456, y + 22);
      g.fillStyle = bad ? "#ff8f84" : "#6c8a6a";
      g.font = "15px monospace";
      g.fillText(bad ? "⚠ actividad sospechosa" : `${s.ip ?? "sin IP"} · ${w.robotsOn(s).length} robot(s)`, 16, y + 46);
    });
    this.screen.tex.needsUpdate = true;
  }

  /** Monitor de la consola: texto de terminal que corre. */
  private drawMonitor(w: World): void {
    const m = this.monitor;
    const g = m.ctx;
    g.fillStyle = "#07100b";
    g.fillRect(0, 0, 256, 160);
    g.font = "13px monospace";
    const s = w.servers[0];
    const lines = s
      ? [`admin@${s.hostname}:~$ top`, `%Cpu: ${(s.load * 100).toFixed(1)}`, `temp: ${Math.round(s.temp)} C`, `robots: ${w.robotsOn(s).map((r) => r.id).join(" ") || "-"}`, s.ddos ? "!! SYN flood" : "red: ok", `admin@${s.hostname}:~$ _`]
      : ["BIOS v1.0", "no hay disco", "esperando montaje...", "_"];
    m.line = (m.line + 1) % 2;
    lines.forEach((l, i) => {
      g.fillStyle = l.startsWith("!!") ? "#ff8f84" : i === lines.length - 1 && m.line ? "#07100b" : "#7ee08f";
      g.fillText(l, 10, 22 + i * 22);
    });
    m.tex.needsUpdate = true;
  }

  /** Para el clic: qué puesto del rack es este objeto. */
  slotOf(obj: THREE.Object3D | null): number {
    for (let o = obj; o; o = o.parent) {
      const i = this.racks.findIndex((r) => r.group === o);
      if (i >= 0) return i;
    }
    return -1;
  }
}
