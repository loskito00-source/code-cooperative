import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { type GLTF, GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { buildAlley, buildTruck, cardboardBox, type Truck } from "./alley.js";
import { mergeStatic, QualityGovernor } from "./perf.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import { type Customer, type ProductName, type Robot, type SimEvent, WAREHOUSE_START, type World } from "@cdb/sim";

export interface StoreHooks {
  world: () => World;
  /** Avanza la simulación según el tiempo real; devuelve la fracción del tick actual (0-1). */
  advance: (deltaMs: number) => number;
  selected: () => string;
  onSelect: (robotId: string) => void;
  onEvents: (events: SimEvent[]) => void;
  /** Momentos de la intro para el sonido: "truck", "brake", "doors", "box". */
  onCue?: (cue: string) => void;
  /** Pixeles tapados a la izquierda por las ventanas: la tienda se centra en el resto. */
  leftInset: () => number;
}

const MODELS = {
  floor: "shop/floor.glb",
  floorWood: "shop/floor-wood.glb",
  wall: "shop/wall.glb",
  wallWindow: "shop/wall-window.glb",
  wallDoor: "shop/wall-door-rotate.glb",
  wallCorner: "shop/wall-corner.glb",
  shelf: "shop/shelf-boxes.glb",
  register: "shop/cash-register.glb",
  handTruck: "shop/hand-truck.glb",
  column: "shop/column.glb",
  freezers: "shop/freezers-standing.glb",
  fruit: "shop/display-fruit.glb",
  cart: "shop/shopping-cart.glb",
  basket: "shop/shopping-basket.glb",
  robot: "chars/character-robot.glb",
  loaf: "food/loaf.glb",
  carton: "food/carton.glb",
  egg: "food/egg.glb",
} as const;

const PEOPLE = [
  "female-a", "male-a", "female-b", "male-b", "female-c", "male-c", "female-d",
  "male-d", "female-e", "male-e", "female-f", "male-f", "male-g",
].map((n) => `chars/character-${n}.glb`);

/** Producto -> modelo y cuántas copias van en cada hueco del estante. */
const PRODUCT_MODEL: Record<string, { key: keyof typeof MODELS; perSlot: number; size: number }> = {
  pan: { key: "loaf", perSlot: 1, size: 0.17 },
  leche: { key: "carton", perSlot: 1, size: 0.2 },
  huevos: { key: "egg", perSlot: 3, size: 0.09 },
};

const ROBOT_TINT: Record<Robot["color"], string> = { cian: "#7fe3f0", naranja: "#ffb877" };
const ROBOT_RING: Record<Robot["color"], string> = { cian: "#2ec4d6", naranja: "#f28c28" };

type Anim = "idle" | "walk" | "interact-right" | "emote-yes" | "emote-no" | "pick-up";

class Animated {
  readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;

  constructor(readonly root: THREE.Object3D, clips: THREE.AnimationClip[]) {
    this.mixer = new THREE.AnimationMixer(root);
    for (const c of clips) this.actions.set(c.name, this.mixer.clipAction(c));
    this.play("idle");
  }

  play(name: Anim, fade = 0.2): void {
    const next = this.actions.get(name);
    if (!next || next === this.current) return;
    next.reset().play();
    if (this.current) this.current.crossFadeTo(next, fade, false);
    this.current = next;
  }
}

const PRODUCT_EMOJI: Record<string, string> = { pan: "🍞", leche: "🥛", huevos: "🥚" };

interface Coin {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
}

interface RobotView {
  bubble: HTMLDivElement;
  group: THREE.Group;
  anim: Animated;
  ring: THREE.Mesh;
  carry: THREE.Group;
  carryProduct: string | null;
  label: HTMLDivElement;
  heading: number;
}

interface CustomerView {
  group: THREE.Group;
  anim: Animated;
  basket: THREE.Object3D;
  label: HTMLDivElement;
  heading: number;
}

interface ShelfView {
  /** Huecos del estante; se llenan con el producto cuando el estante lo tiene. */
  slots: THREE.Group[];
  /** Producto con que se llenaron los huecos (null = estante libre). */
  product: string | null;
  /** Cuántos productos se veían el cuadro anterior (para animar los que aparecen). */
  shown: number;
  badge: CSS2DObject;
}

/** Estantería del almacén con las cajas de un producto. */
interface CrateView {
  product: ProductName;
  boxes: THREE.Object3D[];
  label: HTMLDivElement;
  /** Lo más que ha tenido (la estantería se ve llena con esa cantidad). */
  max: number;
}

/** Algo que muestra información al pasar el mouse: un estante o una estantería del almacén. */
interface HoverTarget {
  obj: THREE.Object3D;
  html: (w: World) => string;
}

/** Color de cada producto (franjas de las cajas, letreros). */
const PRODUCT_COLOR: Record<string, number> = { pan: 0xd9822b, leche: 0x3d8bd9, huevos: 0xe8c33a };

export class Store3D {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly labels: CSS2DRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly timer = new THREE.Timer();
  private readonly models = new Map<string, GLTF>();
  private readonly robots = new Map<string, RobotView>();
  private readonly customers = new Map<number, CustomerView>();
  private readonly shelves: ShelfView[] = [];
  private readonly crates: CrateView[] = [];
  private readonly hoverTargets: HoverTarget[] = [];
  // ── día y noche ──
  private hemi!: THREE.HemisphereLight;
  private sun!: THREE.DirectionalLight;
  private readonly lamps: THREE.PointLight[] = [];
  private readonly quality: QualityGovernor;
  /** Luz del día (1 = mediodía, 0 = noche) y tono de amanecer/atardecer, suavizados entre cuadros. */
  private daylight = { k: 1, warm: 0, sky: "", last: 0 };
  private hovered: HoverTarget | null = null;
  private readonly tip: HTMLDivElement;
  private readonly raycaster = new THREE.Raycaster();
  private coins: Coin[] = [];
  private readonly coinGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.02, 16);
  private readonly coinMat = new THREE.MeshStandardMaterial({ color: 0xf6c945, metalness: 0.6, roughness: 0.3, emissive: 0x6b4a00, emissiveIntensity: 0.25 });
  private readonly hooks: StoreHooks;
  private readonly container: HTMLElement;
  private readonly center: THREE.Vector3;
  private inset = -1;
  /** El jugador ya usó la rueda o arrastró: no volver a encuadrar solo. */
  private userMovedCamera = false;

  // ── intro: callejón y camión ──
  /** intro = cinemática; alley = mirando el camión; flying = volando a la tienda; store = juego normal. */
  private mode: "menu" | "intro" | "alley" | "flying" | "store" = "store";
  private truck!: Truck;
  private intro: { start: number; resolve: () => void; cues: Set<string>; lastX: number } | null = null;
  private fly: { start: number; dur: number; fromPos: THREE.Vector3; fromTarget: THREE.Vector3; toPos: THREE.Vector3; toTarget: THREE.Vector3; resolve: () => void } | null = null;
  private unloading: { obj: THREE.Object3D; start: number; from: THREE.Vector3; to: THREE.Vector3 }[] = [];
  private static readonly PARK = new THREE.Vector3(2.0, 0, -2.75);
  /**
   * La cámara mira la tienda de frente, desde el sur: en pantalla North queda arriba, East a la derecha,
   * West a la izquierda y South abajo (como los comandos move de los robots).
   */
  private static readonly VIEW_DIR = new THREE.Vector3(0, 9.5, 8.5).normalize();
  private static readonly TRUCK_START_X = 16;
  private static readonly ALLEY_CAM = { pos: new THREE.Vector3(6.6, 1.45, -1.75), target: new THREE.Vector3(3.3, 0.75, -2.8) };

  constructor(container: HTMLElement, hooks: StoreHooks) {
    this.container = container;
    this.hooks = hooks;
    const w = hooks.world();

    // tarjeta de video dedicada si el portátil tiene dos; sin suavizado de bordes en pantallas de alta densidad
    // (ahí casi no se nota y es de lo que más cuesta)
    this.renderer = new THREE.WebGLRenderer({ antialias: (window.devicePixelRatio || 1) < 1.5, alpha: true, powerPreference: "high-performance" });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.append(this.renderer.domElement);
    // resolución dinámica: baja sola si el equipo no da abasto (y en último caso apaga las sombras)
    this.quality = new QualityGovernor(this.renderer, () => {
      this.sun.castShadow = false;
      this.renderer.shadowMap.enabled = false;
    });

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = "labels";
    container.append(this.labels.domElement);

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    const center = new THREE.Vector3((w.width - 1) / 2, 0.2, (w.height - 1) / 2);
    this.center = center;
    this.camera.position.copy(center).addScaledVector(Store3D.VIEW_DIR, 14);
    this.controls = new OrbitControls(this.camera, this.labels.domElement);
    this.controls.target.copy(center);
    this.controls.addEventListener("start", () => (this.userMovedCamera = true));
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 22;
    this.controls.minPolarAngle = 0.35;
    this.controls.maxPolarAngle = 1.15;
    this.controls.update();

    this.labels.domElement.addEventListener("pointerdown", (e) => this.pick(e));
    this.tip = document.createElement("div");
    this.tip.className = "hover-tip";
    this.tip.hidden = true;
    container.append(this.tip);
    this.labels.domElement.addEventListener("pointermove", (e) => this.hover(e));
    this.labels.domElement.addEventListener("pointerleave", () => this.setHover(null));
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  /** Casilla del mundo (y crece al norte) a coordenadas 3D: el norte queda al fondo (z = 0). */
  private pos(x: number, y: number): THREE.Vector3 {
    return new THREE.Vector3(x, 0, this.hooks.world().height - 1 - y);
  }

  async load(onProgress: (done: number, total: number) => void): Promise<void> {
    const loader = new GLTFLoader();
    const entries = [...Object.entries(MODELS), ...PEOPLE.map((p) => [p, p] as const)];
    let done = 0;
    await Promise.all(
      entries.map(async ([key, path]) => {
        const gltf = await loader.loadAsync(`models/${path}`);
        gltf.scene.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) {
            o.castShadow = true;
            o.receiveShadow = true;
          }
        });
        this.models.set(key, gltf);
        onProgress(++done, entries.length);
      }),
    );
    this.build();
  }

  private model(key: keyof typeof MODELS | string): THREE.Object3D {
    const g = this.models.get(key);
    if (!g) throw new Error(`modelo no cargado: ${key}`);
    return g.animations.length ? cloneSkinned(g.scene) : g.scene.clone(true);
  }

  // ── construcción de la tienda ────────────────────────────────

  private build(): void {
    const w = this.hooks.world();
    const s = this.scene;

    const hemi = new THREE.HemisphereLight(0xfdf6ec, 0xb9a88f, 1.6);
    s.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
    this.hemi = hemi;
    this.sun = sun;
    // lámpara de adentro: se prende de noche. Una sola y alta, que alumbra toda la tienda (cada luz puntual
    // se calcula en cada píxel de la pantalla: antes eran cuatro y pesaban mucho en equipos sin tarjeta de video)
    for (const [x, y] of [[(w.width - 1) / 2, (w.height - 1) / 2]]) {
      const lamp = new THREE.PointLight(0xffd59a, 0, 13, 1.1);
      lamp.position.copy(this.pos(x, y)).add(new THREE.Vector3(0, 3.2, 0));
      s.add(lamp);
      this.lamps.push(lamp);
    }
    sun.position.set(w.width + 4, 10, w.height + 2);
    sun.target.position.set((w.width - 1) / 2, 0, (w.height - 1) / 2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1536, 1536);
    Object.assign(sun.shadow.camera, { near: 1, far: 40, left: -8, right: 8, top: 8, bottom: -8 });
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    s.add(sun, sun.target);

    // base de la tienda (maqueta flotando, como el campo de The Farmer Was Replaced)
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(w.width + 0.5, 0.35, w.height + 0.5),
      new THREE.MeshStandardMaterial({ color: 0xe8dcc6, roughness: 0.9 }),
    );
    slab.position.set((w.width - 1) / 2, -0.18, (w.height - 1) / 2);
    slab.receiveShadow = true;
    s.add(slab);
    const edge = new THREE.Mesh(
      new THREE.BoxGeometry(w.width + 0.5, 0.08, w.height + 0.5),
      new THREE.MeshStandardMaterial({ color: 0x5d6b8a, roughness: 0.8 }),
    );
    edge.position.set((w.width - 1) / 2, -0.38, (w.height - 1) / 2);
    s.add(edge);

    // todo lo que se agrega desde aquí hasta el callejón (piso y paredes) no se mueve: al final se funde
    const staticFrom = s.children.length;
    for (let y = 0; y < w.height; y++) {
      for (let x = 0; x < w.width; x++) {
        const kind = w.tiles[y][x];
        const floor = this.model(kind === "warehouse" ? "floor" : "floorWood");
        floor.position.copy(this.pos(x, y));
        s.add(floor);
      }
    }

    this.buildWalls(w);

    const statics = [slab, edge, ...s.children.slice(staticFrom)];
    // callejón detrás de la tienda y el camión del distribuidor
    const alley = buildAlley();
    s.add(alley);
    statics.push(alley);
    this.truck = buildTruck({ loaf: this.model("loaf"), carton: this.model("carton"), egg: this.model("egg") });
    this.truck.group.position.copy(Store3D.PARK);
    this.openDoors(1);
    for (const b of this.truck.boxes) b.visible = false; // ya descargadas (si no hay intro)
    s.add(this.truck.group);

    this.buildWarehouse(w);

    // estantes con huecos para los productos (empiezan libres y vacíos)
    for (const shelf of w.shelves) {
      const model = this.model("shelf");
      model.position.copy(this.pos(shelf.x, shelf.y)).add(new THREE.Vector3(0, 0, -0.16));
      model.scale.setScalar(0.92);
      s.add(model);
      const slots: THREE.Group[] = [];
      const items: THREE.Object3D[] = [];
      model.traverse((o) => {
        if (o !== model && (o.name.startsWith("carton") || o.name.startsWith("box"))) items.push(o);
      });
      // los productos de fábrica se esconden; cada hueco se llena según el stock real
      for (const item of items) {
        item.visible = false;
        const slot = new THREE.Group();
        slot.position.copy(item.position);
        item.parent!.add(slot);
        slots.push(slot);
      }
      // de abajo hacia arriba, del frente hacia atrás
      slots.sort((a, b) => a.position.y - b.position.y || b.position.z - a.position.z);
      const div = document.createElement("div");
      div.className = "badge-shelf";
      const badge = new CSS2DObject(div);
      badge.position.copy(this.pos(shelf.x, shelf.y)).add(new THREE.Vector3(0, 1.05, -0.1));
      s.add(badge);
      const view: ShelfView = { slots, product: null, badge, shown: 0 };
      this.hoverTargets.push({ obj: model, html: (world) => this.shelfInfo(world, world.shelves.indexOf(shelf)) });
      this.fillShelf(view, shelf.product);
      this.shelves.push(view);
    }

    // caja registradora: Lupe atiende desde el oeste, la cola llega desde el este
    const reg = this.model("register");
    reg.position.copy(this.pos(w.register.x, w.register.y)).add(new THREE.Vector3(0.22, 0, 0));
    reg.rotation.y = Math.PI / 2;
    s.add(reg);

    // decoración que no estorba: carritos junto a la entrada y una fruta en el pasillo
    const cart = this.model("cart");
    cart.position.copy(this.pos(w.entrance.x, w.entrance.y - 1)).add(new THREE.Vector3(0.32, 0, 0));
    cart.rotation.y = -Math.PI / 2;
    s.add(cart);

    for (const r of w.robots) this.robots.set(r.id, this.makeRobot(r));
    this.buildCompass(w);

    // cientos de piezas fijas -> unas pocas mallas (una por material); lo plano no proyecta sombra
    mergeStatic(s, statics, (m) => {
      m.geometry.computeBoundingBox();
      const size = m.geometry.boundingBox!.getSize(new THREE.Vector3()).multiply(m.getWorldScale(new THREE.Vector3()));
      return Math.min(size.x, size.y, size.z) < 0.06 && size.y < 0.4;
    });
  }

  /** Las cuatro direcciones de move(), pintadas alrededor de la tienda. */
  private buildCompass(w: World): void {
    const cx = (w.width - 1) / 2;
    const cz = (w.height - 1) / 2;
    // North va sobre la pared del fondo, en la esquina de la puerta del almacén (no tapa los estantes)
    const marks: [string, string, number, number, number][] = [
      ["North", "▲", w.warehouse.x + 0.5, 1.75, -0.55],
      ["South", "▼", cx, 0, w.height + 0.15],
      ["East", "▶", w.width + 0.2, 0, cz],
      ["West", "◀", -1.2, 0, cz],
    ];
    for (const [name, arrow, x, y, z] of marks) {
      const div = document.createElement("div");
      div.className = "compass";
      div.innerHTML = name === "East" ? `${name} ${arrow}` : name === "West" ? `${arrow} ${name}` : `${arrow}<br>${name}`;
      if (name === "South") div.innerHTML = `${name}<br>${arrow}`;
      const obj = new CSS2DObject(div);
      obj.position.set(x, y, z);
      this.scene.add(obj);
    }
  }

  /** Llena los huecos de un estante con copias del producto (o los deja vacíos si está libre). */
  private fillShelf(view: ShelfView, product: string | null): void {
    view.product = product;
    view.shown = 0;
    const cfg = product ? PRODUCT_MODEL[product] : null;
    for (const slot of view.slots) {
      slot.clear();
      if (!cfg) continue;
      for (let i = 0; i < cfg.perSlot; i++) {
        const p = this.fitted(cfg.key, cfg.size);
        p.position.x = (i - (cfg.perSlot - 1) / 2) * 0.07;
        p.rotation.y = (i * 1.7) % 1;
        slot.add(p);
      }
    }
  }

  /**
   * El cuarto del almacén: una estantería metálica por producto contra la pared oeste (con cajas que se vacían
   * según la tabla de inventario), piso de concreto con líneas amarillas, franja de seguridad en la puerta,
   * estibas con cajas, carretilla y letrero.
   */
  private buildWarehouse(w: World): void {
    const cells: { x: number; y: number }[] = [];
    for (let y = 0; y < w.height; y++) for (let x = 0; x < w.width; x++) if (w.inWarehouse(x, y)) cells.push({ x, y });
    if (!cells.length) return;
    const minX = Math.min(...cells.map((c) => c.x));
    const maxX = Math.max(...cells.map((c) => c.x));
    const maxY = Math.max(...cells.map((c) => c.y));
    const minY = Math.min(...cells.map((c) => c.y));
    const mat = (color: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
      new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...extra });
    const mesh = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D) => {
      const o = new THREE.Mesh(geo, m);
      o.position.set(x, y, z);
      o.castShadow = true;
      o.receiveShadow = true;
      parent.add(o);
      return o;
    };
    const steel = mat(0x2f5d9e, { metalness: 0.35, roughness: 0.5 });
    const beam = mat(0xe8762d, { roughness: 0.5 });
    const deck = mat(0xb8915e);
    const cardboard = mat(0xc99459);
    const tape = mat(0xe8d2a6, { roughness: 0.4 });

    // piso: concreto un poco más oscuro, para que el cuarto se distinga de la tienda
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(maxX - minX + 1, maxY - minY + 1),
      new THREE.MeshStandardMaterial({ color: 0x9aa1a6, roughness: 0.95, transparent: true, opacity: 0.35 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.copy(this.pos((minX + maxX) / 2, (minY + maxY) / 2)).add(new THREE.Vector3(0, 0.006, 0));
    floor.receiveShadow = true;
    this.scene.add(floor);

    // línea amarilla frente a las estanterías (pared norte del cuarto)
    const yellow = new THREE.MeshBasicMaterial({ color: 0xf2c230 });
    const line = new THREE.Mesh(new THREE.PlaneGeometry(maxX - minX + 0.9, 0.05), yellow);
    line.rotation.x = -Math.PI / 2;
    line.position.copy(this.pos((minX + maxX) / 2, maxY)).add(new THREE.Vector3(0, 0.012, -0.02));
    this.scene.add(line);

    // franja de seguridad amarilla y negra en la puerta
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 256;
    const g = c.getContext("2d")!;
    g.fillStyle = "#f2c230";
    g.fillRect(0, 0, 64, 256);
    g.fillStyle = "#222";
    for (let i = -64; i < 256; i += 40) {
      g.beginPath();
      g.moveTo(0, i);
      g.lineTo(64, i + 32);
      g.lineTo(64, i + 52);
      g.lineTo(0, i + 20);
      g.fill();
    }
    const hazard = new THREE.CanvasTexture(c);
    hazard.colorSpace = THREE.SRGBColorSpace;
    const doorStrip = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.9), new THREE.MeshBasicMaterial({ map: hazard }));
    doorStrip.rotation.x = -Math.PI / 2;
    doorStrip.position.copy(this.pos(w.warehouse.x + 0.5, w.warehouse.y)).add(new THREE.Vector3(0, 0.013, 0));
    this.scene.add(doorStrip);

    // una estantería metálica por producto contra la pared norte del cuarto, mirando a la cámara
    const products = Object.keys(WAREHOUSE_START) as ProductName[];
    const L = 0.9; // largo de cada estantería (una casilla)
    const D = 0.4; // fondo
    const levels = [0.06, 0.44, 0.82];
    const H = 1.2;
    products.forEach((product, i) => {
      const rack = new THREE.Group();
      // se arma con el frente hacia +x y se gira para que mire al sur
      rack.position.copy(this.pos(Math.min(maxX, minX + i), maxY)).add(new THREE.Vector3(0, 0, -0.5 + D / 2 + 0.03));
      rack.rotation.y = -Math.PI / 2;
      // parales
      const post = new THREE.BoxGeometry(0.045, H, 0.045);
      for (const dx of [-D / 2, D / 2]) for (const dz of [-L / 2, L / 2]) mesh(post, steel, dx, H / 2, dz, rack);
      // travesaños naranja y tablas de cada nivel
      const beamGeo = new THREE.BoxGeometry(0.04, 0.06, L);
      const deckGeo = new THREE.BoxGeometry(D - 0.02, 0.025, L - 0.02);
      for (const y of [...levels, H - 0.03]) {
        mesh(beamGeo, beam, D / 2, y, 0, rack);
        mesh(beamGeo, beam, -D / 2, y, 0, rack);
        if (y < H - 0.1) mesh(deckGeo, deck, 0, y + 0.03, 0, rack);
      }
      // cajas: 3 por nivel, con una franja del color del producto mirando al pasillo
      const boxes: THREE.Object3D[] = [];
      const color = mat(PRODUCT_COLOR[product] ?? 0xffffff, { roughness: 0.5 });
      const bw = (L - 0.12) / 3;
      for (const y of levels) {
        for (let k = 0; k < 3; k++) {
          const b = new THREE.Group();
          const h = 0.27 + ((k * 7 + i) % 3) * 0.02;
          mesh(new THREE.BoxGeometry(D - 0.08, h, bw - 0.04), cardboard, 0, h / 2, 0, b);
          mesh(new THREE.BoxGeometry(D - 0.078, 0.012, (bw - 0.04) * 0.25), tape, 0, h + 0.003, 0, b);
          mesh(new THREE.BoxGeometry(0.005, h * 0.35, (bw - 0.04) * 0.8), color, (D - 0.08) / 2 + 0.003, h * 0.55, 0, b);
          b.position.set(0, y + 0.045, -L / 2 + 0.06 + bw * (k + 0.5));
          rack.add(b);
          boxes.push(b);
        }
      }
      // muestra del producto encima, y un letrero de color en el travesaño de arriba
      const cfg = PRODUCT_MODEL[product];
      const sample = this.fitted(cfg.key, cfg.size * 1.5);
      sample.position.set(0.02, H + 0.02, 0);
      rack.add(sample);
      mesh(new THREE.BoxGeometry(0.01, 0.12, 0.42), color, D / 2 + 0.03, H - 0.03, 0, rack);
      this.scene.add(rack);
      const label = this.label("", "label-crate", rack, H + 0.35);
      const view: CrateView = { product, boxes, label, max: 1 };
      this.crates.push(view);
      this.hoverTargets.push({
        obj: rack,
        html: (world) => {
          const n = world.warehouseStock[product];
          return `<strong>${PRODUCT_EMOJI[product]} Almacén: ${product}</strong>
            <div><b>${n}</b> unidades guardadas</div>
            <small>${n > 0 ? `Viene de tu tabla de inventario. pick("${product}") toma hasta 5.` : "Se acabó: pick() se lo compra al proveedor (60% del precio)."}</small>`;
        },
      });
    });

    // estibas con cajas contra la pared oeste y en la esquina sur-este (decoración: no se tocan)
    const wood = mat(0xa87a4a);
    const pallet = (at: THREE.Vector3, high: number, seed: number) => {
      const p = new THREE.Group();
      for (const dz of [-0.2, 0, 0.2]) mesh(new THREE.BoxGeometry(0.5, 0.03, 0.12), wood, 0, 0.1, dz, p);
      for (const dx of [-0.2, 0, 0.2]) mesh(new THREE.BoxGeometry(0.08, 0.08, 0.52), wood, dx, 0.04, 0, p);
      for (let k = 0; k < high; k++) {
        const b = cardboardBox(0.2, 0.2, 0.22);
        b.position.set(k % 2 ? 0.11 : -0.11, 0.115 + Math.floor(k / 4) * 0.21, (k % 4) < 2 ? -0.12 : 0.12);
        b.rotation.y = ((k + seed) * 0.37) % 0.25;
        p.add(b);
      }
      p.position.copy(at);
      p.scale.setScalar(0.8);
      this.scene.add(p);
    };
    for (let y = minY; y < maxY - 1; y += 2) pallet(this.pos(minX, y).add(new THREE.Vector3(-0.27, 0, 0)), y === minY ? 8 : 6, y);
    pallet(this.pos(maxX, minY).add(new THREE.Vector3(0.18, 0, 0.2)), 5, 9);

    const truck = this.model("handTruck");
    truck.position.copy(this.pos(minX + 1, minY)).add(new THREE.Vector3(0.1, 0, 0.32));
    truck.rotation.y = 0.4;
    this.scene.add(truck);

    // letrero del cuarto, sobre la puerta
    const sign = document.createElement("div");
    sign.className = "label-room";
    sign.textContent = "📦 Almacén";
    const obj = new CSS2DObject(sign);
    obj.position.copy(this.pos((minX + maxX) / 2, minY)).add(new THREE.Vector3(0, 0.05, 0.62));
    this.scene.add(obj);
  }

  private buildWalls(w: World): void {
    // pared del fondo (norte) y pared izquierda (oeste); el frente queda abierto para mirar
    for (let x = 0; x < w.width; x++) {
      const isDoor = x === w.entrance.x;
      const piece = this.model(isDoor ? "wallDoor" : x % 2 === 1 ? "wallWindow" : "wall");
      piece.position.set(x, 0, -0.5);
      if (isDoor && x === w.width - 1) piece.position.x -= 0.15;
      this.scene.add(piece);
    }
    for (let y = 0; y < w.height; y++) {
      const z = w.height - 1 - y;
      const piece = this.model("wall");
      piece.position.set(-0.5, 0, z);
      piece.rotation.y = Math.PI / 2;
      this.scene.add(piece);
    }
    // paredes interiores (la del almacén): bajitas, para que se vea lo que pasa adentro
    for (const key of w.walls) {
      const [a, b] = key.split("|").map((p) => p.split(",").map(Number));
      const piece = this.model("wall");
      piece.scale.y = 0.42;
      const mid = this.pos((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      piece.position.copy(mid);
      if (a[1] === b[1]) piece.rotation.y = Math.PI / 2; // pared entre vecinos este-oeste
      this.scene.add(piece);
    }
    // marco de la puerta del almacén: dos columnas a los lados del hueco
    const door = w.warehouse;
    for (const dz of [-0.5, 0.5]) {
      const col = this.model("column");
      col.position.copy(this.pos(door.x + 0.5, door.y)).add(new THREE.Vector3(0, 0, dz));
      col.scale.set(0.6, 0.55, 0.6);
      this.scene.add(col);
    }
  }

  /** Copia de un modelo escalada para que su lado más grande mida `size`. */
  private fitted(key: keyof typeof MODELS, size: number): THREE.Object3D {
    const m = this.model(key);
    const box = new THREE.Box3().setFromObject(m);
    const dims = box.getSize(new THREE.Vector3());
    m.scale.setScalar(size / Math.max(dims.x, dims.y, dims.z));
    return m;
  }

  private label(text: string, className: string, parent: THREE.Object3D, y: number): HTMLDivElement {
    const div = document.createElement("div");
    div.className = className;
    div.textContent = text;
    const obj = new CSS2DObject(div);
    obj.position.set(0, y, 0);
    parent.add(obj);
    return div;
  }

  private makeRobot(r: Robot): RobotView {
    const gltf = this.models.get("robot")!;
    const body = cloneSkinned(gltf.scene);
    body.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
        mat.color = new THREE.Color(ROBOT_TINT[r.color]);
        mesh.material = mat;
      }
    });
    const group = new THREE.Group();
    group.add(body);
    group.userData.robotId = r.id;
    body.traverse((o) => (o.userData.robotId = r.id));

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.28, 0.36, 40),
      new THREE.MeshBasicMaterial({ color: ROBOT_RING[r.color], transparent: true, opacity: 0.9 }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.012;
    group.add(ring);

    const carry = new THREE.Group();
    carry.position.set(0, 0.42, 0.22);
    group.add(carry);

    const label = this.label(r.name, "label-robot", group, 1.05);
    const bubble = this.label("", "bubble-robot", group, 1.4);
    this.scene.add(group);
    return { bubble, group, anim: new Animated(body, gltf.animations), ring, carry, carryProduct: null, label, heading: 0 };
  }

  private makeCustomer(c: Customer): CustomerView {
    const key = PEOPLE[c.id % PEOPLE.length];
    const gltf = this.models.get(key)!;
    const body = cloneSkinned(gltf.scene);
    const group = new THREE.Group();
    group.add(body);
    const basket = this.fitted("basket", 0.26);
    basket.position.set(0.3, 0.18, 0.05);
    group.add(basket);
    const label = this.label("", "label-customer", group, 1.0);
    this.scene.add(group);
    const at = this.pos(c.x, c.y);
    group.position.copy(at);
    return { group, anim: new Animated(body, gltf.animations), basket, label, heading: Math.PI };
  }

  // ── cada cuadro ──────────────────────────────────────────────

  start(): void {
    this.renderer.setAnimationLoop((t) => this.frame(t));
  }

  private frame(time: number): void {
    this.timer.update(time);
    const dt = Math.min(this.timer.getDelta(), 0.1);
    this.quality.tick(time);
    const frac = this.hooks.advance(dt * 1000);
    const w = this.hooks.world();

    if (this.mode === "menu") this.updateMenu(time);
    else if (this.mode === "intro" && this.intro) this.updateIntro(time);
    else if (this.mode === "flying") this.updateFly(time);
    this.updateUnloading(time);

    const events = w.drainEvents();
    for (const e of events) {
      if (e.type === "float") this.float(e.x, e.y, e.text, e.tone);
      else if (e.type === "sound" && e.name === "cash") this.coinBurst();
    }
    if (events.length) this.hooks.onEvents(events);

    this.updateDaylight(w, dt);
    this.updateShelves(w, time);
    this.updateCrates(w);
    this.refreshTip();
    this.updateRobots(w, frac, dt, time);
    this.updateCustomers(w, dt);
    this.updateCoins(dt);

    const inset = Math.round(this.hooks.leftInset());
    if (inset !== this.inset && (this.mode === "store" || this.mode === "alley")) {
      this.inset = inset;
      if (this.mode === "store") this.frameCamera();
      else this.applyViewOffset();
    }
    if (this.mode === "store" || this.mode === "alley") this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }

  private updateShelves(w: World, time: number): void {
    w.shelves.forEach((s, i) => {
      const view = this.shelves[i];
      if (view.product !== s.product) this.fillShelf(view, s.product);
      view.slots.forEach((slot, n) => {
        slot.visible = n < s.stock;
        // los productos nuevos aparecen con un pequeño salto
        if (slot.visible && n >= view.shown) slot.userData.popStart = time;
        const t0 = slot.userData.popStart as number | undefined;
        if (t0 !== undefined) {
          const p = Math.min(1, (time - t0) / 260);
          slot.scale.setScalar(p < 1 ? 1 + Math.sin(p * Math.PI) * 0.35 - (1 - p) * 0.6 : 1);
          if (p >= 1) delete slot.userData.popStart;
        }
      });
      view.shown = s.stock;
      const el = view.badge.element as HTMLElement;
      const text = s.product === null ? "Libre" : s.stock === 0 ? `Sin ${s.product}` : "";
      if (el.textContent !== text) el.textContent = text;
      el.classList.toggle("free", s.product === null);
      view.badge.visible = text !== "";
      if (s.product !== null && s.stock === 0) el.style.opacity = String(0.65 + 0.35 * Math.sin(time / 200));
      else el.style.opacity = "";
    });
  }

  /**
   * Amanecer, día, atardecer y noche según el reloj del juego: luz del sol (o de la luna), cielo de fondo
   * y lámparas de adentro. Antes de que empiece el ciclo (intro y misión) es de día.
   */
  private updateDaylight(w: World, dt: number): void {
    const smooth = (a: number, b: number, x: number) => {
      const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    let k = 1;
    let warm = 0;
    if (w.cycle) {
      const h = w.clock.hour;
      k = h >= 12 ? 1 - smooth(17.2, 19.25, h) : smooth(6.3, 8.2, h);
      warm = Math.min(1, Math.max(0, 1 - Math.abs(h - 18.6) / 1.4) + Math.max(0, 1 - Math.abs(h - 7) / 1.3));
    }
    const d = this.daylight;
    // transición suave en tiempo real (p. ej. cuando votan para abrir de noche), aunque el render vaya lento
    const now = performance.now();
    const real = d.last ? (now - d.last) / 1000 : dt;
    d.last = now;
    const a = 1 - Math.exp(-real * 2.2);
    d.k += (k - d.k) * a;
    d.warm += (warm - d.warm) * a;
    const mix = (night: number, day: number, tint: number, wAmt: number) =>
      new THREE.Color(night).lerp(new THREE.Color(day), d.k).lerp(new THREE.Color(tint), d.warm * wAmt);
    this.hemi.intensity = THREE.MathUtils.lerp(0.32, 1.6, d.k);
    this.hemi.color.copy(mix(0x5868a8, 0xfdf6ec, 0xffc58a, 0.45));
    this.hemi.groundColor.copy(mix(0x2a2f45, 0xb9a88f, 0x9a6a4a, 0.3));
    this.sun.intensity = THREE.MathUtils.lerp(0.22, 2.4, d.k);
    this.sun.color.copy(mix(0x9db2ff, 0xfff1dc, 0xff9a50, 0.6));
    this.renderer.toneMappingExposure = THREE.MathUtils.lerp(0.85, 1.05, d.k);
    for (const l of this.lamps) l.intensity = (1 - d.k) * 6;
    const css = (c: THREE.Color) => `#${c.getHexString()}`;
    const sky = `linear-gradient(180deg, ${css(mix(0x0d1730, 0xa9dcec, 0xf3a06a, 0.55))} 0%, ${css(mix(0x1b2a4c, 0xd9efe6, 0xf6c79a, 0.45))} 50%, ${css(mix(0x2a3452, 0xf4ecdc, 0xf2d6b0, 0.3))} 100%)`;
    if (sky !== d.sky) {
      d.sky = sky;
      this.container.style.background = sky;
    }
    this.container.classList.toggle("night", d.k < 0.4);
  }

  /** Las pilas del almacén se achican a medida que sale la mercancía. */
  private updateCrates(w: World): void {
    for (const c of this.crates) {
      const n = w.warehouseStock[c.product];
      c.max = Math.max(c.max, n);
      const full = c.max;
      const visible = n <= 0 ? 0 : Math.max(1, Math.ceil((n / full) * c.boxes.length));
      c.boxes.forEach((b, i) => (b.visible = i < visible));
      const text = `${PRODUCT_EMOJI[c.product]} ${n}`;
      if (c.label.textContent !== text) c.label.textContent = text;
      c.label.classList.toggle("out", n <= 0);
    }
  }

  /** Dónde se dibuja una entidad parada en (x, y): frente a los muebles, no dentro de ellos. */
  private standAt(w: World, x: number, y: number): THREE.Vector3 {
    const p = this.pos(x, y);
    const kind = w.tileAt(Math.round(x), Math.round(y));
    if (kind === "shelf") p.z += 0.3;
    // junto a las estanterías del almacén, un poco hacia el pasillo para no meterse en ellas
    if (kind === "warehouse" && !w.inWarehouse(Math.round(x) - 1, Math.round(y))) p.x += 0.15;
    if (kind === "warehouse" && !w.inWarehouse(Math.round(x), Math.round(y) + 1)) p.z += 0.3; // frente a las estanterías
    if (kind === "register") p.x -= 0.2;
    return p;
  }

  private turn(current: number, target: number, dt: number): number {
    let d = target - current;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return current + d * Math.min(1, dt * 12);
  }

  private updateRobots(w: World, frac: number, dt: number, time: number): void {
    const selected = this.hooks.selected();
    for (const r of w.robots) {
      const v = this.robots.get(r.id)!;
      let target: THREE.Vector3;
      let heading = v.heading;

      if (r.moving) {
        const p = Math.min(1, (w.tick - r.moving.startTick + frac) / r.moving.ticks);
        const from = this.standAt(w, r.moving.from.x, r.moving.from.y);
        const to = this.standAt(w, r.moving.to.x, r.moving.to.y);
        target = from.clone().lerp(to, p);
        heading = Math.atan2(to.x - from.x, to.z - from.z);
        v.anim.play("walk");
      } else {
        target = this.standAt(w, r.x, r.y);
        const kind = w.tileAt(r.x, r.y);
        if (kind === "register") heading = Math.PI / 2; // mira a la cola (este)
        else if (kind === "shelf") heading = Math.PI; // mira al estante
        else if (kind === "warehouse" && !w.inWarehouse(r.x, r.y + 1)) heading = Math.PI; // mira a las estanterías
        const busy = r.vm && r.vm.status === "waiting" && r.vm.busyTicks > 0;
        v.anim.play(busy ? "interact-right" : "idle");
      }
      v.group.position.copy(target);
      v.heading = this.turn(v.heading, heading, dt);
      v.group.children[0].rotation.y = v.heading;
      v.carry.position.set(Math.sin(v.heading) * 0.24, 0.42, Math.cos(v.heading) * 0.24);

      // lo que carga, en las manos
      const product = r.cargo.n > 0 ? r.cargo.product : null;
      if (product !== v.carryProduct) {
        v.carry.clear();
        if (product) {
          const cfg = PRODUCT_MODEL[product];
          v.carry.add(this.fitted(cfg.key, cfg.size * 1.4));
        }
        v.carryProduct = product;
      }

      const isSel = r.id === selected;
      const ringMat = v.ring.material as THREE.MeshBasicMaterial;
      ringMat.color.set(isSel ? "#f6c945" : ROBOT_RING[r.color]);
      v.ring.scale.setScalar(isSel ? 1.12 + 0.06 * Math.sin(time / 180) : 1);

      const status = r.vm?.status;
      const cargo = product ? ` · ${r.cargo.n} ${product}` : "";
      v.label.textContent = `${status === "error" ? "⚠ " : ""}${r.name}${cargo}`;
      // globo con lo que está haciendo (o dónde está pausado)
      const bubble = status === "paused" ? `⏸ línea ${r.vm!.line}` : status === "waiting" && r.action ? r.action : "";
      if (v.bubble.textContent !== bubble) v.bubble.textContent = bubble;
      v.bubble.classList.toggle("paused", status === "paused");
      v.bubble.hidden = !bubble;
      v.label.classList.toggle("error", status === "error");
      v.label.classList.toggle("selected", isSel);
      v.anim.mixer.update(dt);
    }
  }

  private updateCustomers(w: World, dt: number): void {
    const alive = new Set<number>();
    for (const c of w.customers) {
      alive.add(c.id);
      let v = this.customers.get(c.id);
      if (!v) {
        v = this.makeCustomer(c);
        this.customers.set(c.id, v);
      }
      const target = this.standAt(w, c.x, c.y);
      const delta = target.clone().sub(v.group.position);
      const dist = delta.length();
      const speed = 2.2; // casillas por segundo (un paso cada 5 ticks)
      if (dist > 0.02) {
        v.group.position.add(delta.multiplyScalar(Math.min(1, (speed * dt) / dist)));
        v.heading = this.turn(v.heading, Math.atan2(target.x - v.group.position.x, target.z - v.group.position.z), dt);
        v.anim.play("walk");
      } else {
        v.group.position.copy(target);
        const serving = c.state === "queue" && c.atRegister;
        if (serving) v.heading = this.turn(v.heading, -Math.PI / 2, dt); // mira a la caja
        v.anim.play(serving && (c.checkout.scanned > 0 || c.checkout.charged !== null) ? "interact-right" : "idle");
      }
      v.group.children[0].rotation.y = v.heading;
      v.basket.visible = c.cart.length > 0 && c.state !== "leaving";

      const waiting = c.state === "queue" && c.checkout.scanned === 0 && c.checkout.charged === null;
      if (c.state === "leaving") v.label.innerHTML = c.mood === "enojado" ? "😡" : c.mood === "feliz" ? "😊" : "";
      else if (c.state === "shopping") v.label.innerHTML = `<span class="want">${PRODUCT_EMOJI[c.list[c.listIndex]] ?? ""}</span>`;
      else if (waiting) {
        const p = Math.max(0, c.patience / 450);
        v.label.innerHTML = `<span class="patience"><span style="width:${p * 100}%;background:${p > 0.35 ? "#3fa34d" : "#e2483d"}"></span></span>`;
      } else v.label.innerHTML = "";
      v.anim.mixer.update(dt);
    }
    for (const [id, v] of this.customers) {
      if (alive.has(id)) continue;
      v.group.traverse((o) => o instanceof CSS2DObject && o.element.remove());
      this.scene.remove(v.group);
      this.customers.delete(id);
    }
  }

  /** Monedas que saltan de la caja registradora con cada venta. */
  private coinBurst(): void {
    const w = this.hooks.world();
    const origin = this.pos(w.register.x, w.register.y).add(new THREE.Vector3(0.22, 0.6, 0));
    for (let i = 0; i < 7; i++) {
      const mesh = new THREE.Mesh(this.coinGeo, this.coinMat);
      mesh.castShadow = true;
      mesh.position.copy(origin);
      mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
      const a = Math.random() * Math.PI * 2;
      const vel = new THREE.Vector3(Math.cos(a) * (0.6 + Math.random() * 0.8), 2.2 + Math.random() * 1.2, Math.sin(a) * (0.6 + Math.random() * 0.8));
      this.scene.add(mesh);
      this.coins.push({ mesh, vel, life: 1.1 + Math.random() * 0.3 });
    }
  }

  private updateCoins(dt: number): void {
    this.coins = this.coins.filter((c) => {
      c.life -= dt;
      c.vel.y -= 7.5 * dt;
      c.mesh.position.addScaledVector(c.vel, dt);
      if (c.mesh.position.y < 0.02) {
        c.mesh.position.y = 0.02;
        c.vel.y *= -0.35;
        c.vel.x *= 0.6;
        c.vel.z *= 0.6;
      }
      c.mesh.rotation.x += dt * 9;
      c.mesh.rotation.z += dt * 6;
      c.mesh.scale.setScalar(Math.min(1, c.life * 3));
      if (c.life > 0) return true;
      this.scene.remove(c.mesh);
      return false;
    });
  }

  private float(x: number, y: number, text: string, tone: "good" | "bad" | "info"): void {
    const div = document.createElement("div");
    div.className = `float ${tone}`;
    div.textContent = text;
    const obj = new CSS2DObject(div);
    obj.position.copy(this.standAt(this.hooks.world(), x, y)).add(new THREE.Vector3(0, 1.2, 0));
    this.scene.add(obj);
    setTimeout(() => {
      this.scene.remove(obj);
      div.remove();
    }, 1500);
  }

  // ── información al pasar el mouse ────────────────────────────

  private shelfInfo(w: World, i: number): string {
    const s = w.shelves[i];
    const pct = Math.round((s.stock / s.capacity) * 100);
    const bar = `<span class="tip-bar"><span style="width:${pct}%"></span></span>`;
    const where = `<span class="tip-pos">(${s.x}, ${s.y})</span>`;
    if (!s.product) {
      return `<strong>Estante libre</strong> ${where}
        <div>Vacío · le caben <b>${s.capacity}</b> productos</div>
        <small>El primer producto que pongas con place() lo define.</small>`;
    }
    const left = s.capacity - s.stock;
    return `<strong>${PRODUCT_EMOJI[s.product] ?? ""} Estante de ${s.product}</strong> ${where}
      <div><b>${s.stock}</b> de <b>${s.capacity}</b> ${s.product} ${bar}</div>
      <small>${left === 0 ? "Está lleno." : `Caben ${left} más.`} Solo acepta ${s.product}.</small>`;
  }

  private hover(e: PointerEvent): void {
    if (e.buttons !== 0 || this.mode !== "store") return this.setHover(null);
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObjects(this.hoverTargets.map((t) => t.obj), true)[0];
    let target: HoverTarget | null = null;
    if (hit) {
      for (let o: THREE.Object3D | null = hit.object; o && !target; o = o.parent) target = this.hoverTargets.find((t) => t.obj === o) ?? null;
    }
    this.setHover(target);
    if (target) {
      const box = this.container.getBoundingClientRect();
      const x = e.clientX - box.left + 16;
      const y = e.clientY - box.top + 18;
      this.tip.style.left = `${Math.min(x, box.width - this.tip.offsetWidth - 8)}px`;
      this.tip.style.top = `${Math.min(y, box.height - this.tip.offsetHeight - 8)}px`;
    }
  }

  private setHover(t: HoverTarget | null): void {
    this.hovered = t;
    this.tip.hidden = !t;
    this.container.style.cursor = t ? "help" : "";
    if (t) this.refreshTip();
  }

  /** El contenido se actualiza en vivo mientras el mouse está encima (el stock cambia). */
  private refreshTip(): void {
    if (!this.hovered) return;
    const html = this.hovered.html(this.hooks.world());
    if (this.tip.innerHTML !== html) this.tip.innerHTML = html;
  }

  // ── interacción ──────────────────────────────────────────────

  private pick(e: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const groups = [...this.robots.values()].map((v) => v.group);
    const hit = this.raycaster.intersectObjects(groups, true)[0];
    const id = hit?.object.userData.robotId as string | undefined;
    if (id) this.hooks.onSelect(id);
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    if (this.mode === "store") this.frameCamera();
    else if (this.mode === "alley") this.applyViewOffset();
    else this.camera.updateProjectionMatrix();
  }

  /**
   * Centra la tienda en la zona libre (a la derecha de las ventanas) y la acerca para que la llene.
   * setViewOffset corre la imagen sin mover la cámara, así que girar y hacer zoom sigue funcionando igual.
   */
  // ── intro ────────────────────────────────────────────────────

  private openDoors(p: number): void {
    const a = THREE.MathUtils.degToRad(102) * p;
    this.truck.doors[0].rotation.y = -a;
    this.truck.doors[1].rotation.y = a;
  }

  private cue(name: string): void {
    if (!this.intro || this.intro.cues.has(name)) return;
    this.intro.cues.add(name);
    this.hooks.onCue?.(name);
  }

  /** El camión llega por el callejón, se estaciona y abre las puertas. Termina mirando las cajas. */
  playIntro(): Promise<void> {
    return new Promise((resolve) => {
      this.mode = "intro";
      this.controls.enabled = false;
      this.camera.clearViewOffset();
      this.truck.group.position.set(Store3D.TRUCK_START_X, 0, Store3D.PARK.z);
      this.openDoors(0);
      for (const b of this.truck.boxes) {
        b.visible = true;
        b.scale.setScalar(1);
      }
      this.intro = { start: -1, resolve, cues: new Set(), lastX: Store3D.TRUCK_START_X };
    });
  }

  /** Menú principal: la cámara gira despacio alrededor de la tienda, con la tienda corrida a la derecha. */
  showMenu(): void {
    this.mode = "menu";
    this.intro = null;
    this.controls.enabled = false;
  }

  private updateMenu(time: number): void {
    // se mece despacio frente a la tienda (desde el sur), entre el sureste y el suroeste
    const a = 0.35 + Math.sin(time * 0.00007) * 0.42;
    const r = 13.5;
    const c = this.center;
    this.camera.position.set(c.x + Math.sin(a) * r, 7.2 + Math.sin(time * 0.00011) * 0.6, c.z + Math.cos(a) * r);
    this.camera.lookAt(c.x, 0.2, c.z - 0.6);
    // el menú ocupa la izquierda: la tienda se corre hacia la derecha
    const { clientWidth: w, clientHeight: h } = this.container;
    if (w > 900) this.camera.setViewOffset(w, h, -w * 0.17, 0, w, h);
    else this.camera.clearViewOffset();
  }

  /** Deja todo listo para la intro (camión fuera de cuadro, cámara al inicio del callejón). */
  prepareIntro(): void {
    this.mode = "intro";
    this.intro = null;
    this.controls.enabled = false;
    this.camera.clearViewOffset();
    this.truck.group.position.set(Store3D.TRUCK_START_X, 0, Store3D.PARK.z);
    this.openDoors(0);
    this.camera.position.set(9.8, 1.2, -1.15);
    this.camera.lookAt(Store3D.TRUCK_START_X - 6, 0.65, Store3D.PARK.z);
  }

  /** Salta la cinemática y deja el camión estacionado con las puertas abiertas. */
  skipIntro(): void {
    if (this.mode !== "intro" || !this.intro) return;
    this.intro.start = performance.now() - 9500;
  }

  private updateIntro(time: number): void {
    const it = this.intro!;
    if (it.start < 0) it.start = time;
    const t = (time - it.start) / 1000;
    const ease = (x: number) => 1 - (1 - Math.min(1, Math.max(0, x))) ** 3;
    const easeInOut = (x: number) => {
      x = Math.min(1, Math.max(0, x));
      return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
    };

    // el camión llega frenando (0.4 s -> 6 s)
    if (t > 0.2) this.cue("truck");
    const drive = ease((t - 0.4) / 5.6);
    const x = Store3D.TRUCK_START_X + (Store3D.PARK.x - Store3D.TRUCK_START_X) * drive;
    const g = this.truck.group;
    g.position.x = x;
    const moved = it.lastX - x;
    it.lastX = x;
    for (const wheel of this.truck.wheels) wheel.rotation.y -= moved / this.truck.wheelRadius;
    const speed = Math.min(1, Math.abs(moved) * 20);
    g.position.y = Math.sin(time / 70) * 0.008 * speed;
    g.rotation.z = (1 - drive) * -0.012 + (t > 5.6 && t < 6.4 ? Math.sin((t - 5.6) * 9) * 0.01 * (6.4 - t) : 0); // se inclina al frenar
    if (t > 5.5) this.cue("brake");

    // puertas (6.4 s -> 7.6 s)
    if (t > 6.4) this.cue("doors");
    this.openDoors(easeInOut((t - 6.4) / 1.2));

    // cámara: sigue al camión y luego se acerca a la parte de atrás
    const start = { pos: new THREE.Vector3(9.8, 1.2, -1.15), target: new THREE.Vector3(x + 1.2, 0.65, Store3D.PARK.z) };
    const k = easeInOut((t - 6.2) / 2.8);
    this.camera.position.copy(start.pos).lerp(Store3D.ALLEY_CAM.pos, k);
    const target = start.target.clone().lerp(Store3D.ALLEY_CAM.target, k);
    this.camera.lookAt(target);

    if (t > 9.3) {
      this.mode = "alley";
      this.intro = null;
      this.controls.target.copy(Store3D.ALLEY_CAM.target);
      this.controls.enabled = true;
      this.controls.update();
      this.inset = -1;
      it.resolve();
    }
  }

  /** Deja la cámara en el callejón (sin cinemática), p. ej. al volver a la partida. */
  showAlley(withBoxes: boolean): void {
    this.mode = "alley";
    for (const b of this.truck.boxes) b.visible = withBoxes;
    this.openDoors(1);
    this.camera.position.copy(Store3D.ALLEY_CAM.pos);
    this.controls.target.copy(Store3D.ALLEY_CAM.target);
    this.controls.enabled = true;
    this.controls.update();
    this.inset = -1;
  }

  /** Las cajas del camión "entran" al almacén, una por una. */
  unloadBoxes(): void {
    const w = this.hooks.world();
    const to = this.pos(0, w.height - 2).add(new THREE.Vector3(-0.2, 0.3, 0)); // a las pilas del almacén
    const now = performance.now();
    this.truck.boxes.forEach((b, i) => {
      if (!b.visible) return;
      const from = b.getWorldPosition(new THREE.Vector3());
      this.unloading.push({ obj: b, start: now + i * 140, from, to });
    });
  }

  private updateUnloading(time: number): void {
    this.unloading = this.unloading.filter((u) => {
      const p = (time - u.start) / 600;
      if (p < 0) return true;
      if (p === 0 || !u.obj.userData.cued) {
        u.obj.userData.cued = true;
        this.hooks.onCue?.("box");
      }
      const k = Math.min(1, p);
      const local = u.from.clone().lerp(u.to, k);
      local.y += Math.sin(k * Math.PI) * 0.8;
      u.obj.parent!.worldToLocal(local);
      u.obj.position.copy(local);
      u.obj.scale.setScalar(1 - k * 0.85);
      if (k >= 1) {
        u.obj.visible = false;
        return false;
      }
      return true;
    });
  }

  /** Vuela del callejón a la vista de la tienda. */
  flyToStore(): Promise<void> {
    return new Promise((resolve) => {
      const fromPos = this.camera.position.clone();
      const fromTarget = this.controls.target.clone();
      this.mode = "store";
      this.userMovedCamera = false;
      this.inset = Math.round(this.hooks.leftInset());
      this.frameCamera(); // calcula dónde debe terminar
      const toPos = this.camera.position.clone();
      const toTarget = this.controls.target.clone();
      this.camera.position.copy(fromPos);
      this.camera.lookAt(fromTarget);
      this.controls.enabled = false;
      this.mode = "flying";
      this.fly = { start: -1, dur: 2600, fromPos, fromTarget, toPos, toTarget, resolve };
    });
  }

  private updateFly(time: number): void {
    const f = this.fly!;
    if (f.start < 0) f.start = time;
    const x = Math.min(1, (time - f.start) / f.dur);
    const k = x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
    // sube un poco a mitad del vuelo, para pasar por encima de la pared
    const pos = f.fromPos.clone().lerp(f.toPos, k);
    pos.y += Math.sin(k * Math.PI) * 2.2;
    this.camera.position.copy(pos);
    this.camera.lookAt(f.fromTarget.clone().lerp(f.toTarget, k));
    if (x >= 1) {
      this.mode = "store";
      this.fly = null;
      this.controls.target.copy(f.toTarget);
      this.controls.enabled = true;
      this.controls.update();
      f.resolve();
    }
  }

  private applyViewOffset(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    const inset = Math.max(0, Math.min(this.inset, w * 0.6));
    this.camera.setViewOffset(w, h, -inset / 2, -26, w, h);
    this.camera.updateProjectionMatrix();
  }

  private frameCamera(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    const inset = Math.max(0, Math.min(this.inset, w * 0.6));
    this.camera.setViewOffset(w, h, -inset / 2, -26, w, h); // -26: deja espacio para la barra superior
    this.camera.updateProjectionMatrix();
    if (this.userMovedCamera) return;

    // Busca la distancia más corta en que las esquinas de la tienda (con paredes) caben en la zona libre.
    const world = this.hooks.world();
    const corners: THREE.Vector3[] = [];
    for (const x of [-0.75, world.width - 0.25]) {
      for (const z of [-0.75, world.height - 0.25]) {
        for (const y of [-0.4, 1.1]) corners.push(new THREE.Vector3(x, y, z));
      }
    }
    // zona libre en NDC: a la derecha de las ventanas y debajo de la barra superior, con margen
    const margin = 0.06;
    const minX = (inset / w) * 2 - 1 + margin;
    const maxX = 1 - margin;
    const maxY = 1 - (70 / h) * 2 - margin;
    const minY = -1 + margin;
    const dir = Store3D.VIEW_DIR.clone(); // siempre de frente (el jugador puede girar después)
    this.controls.target.copy(this.center);

    const fits = (d: number) => {
      this.camera.position.copy(this.center).addScaledVector(dir, d);
      this.camera.lookAt(this.center);
      this.camera.updateMatrixWorld();
      return corners.every((c) => {
        const p = c.clone().project(this.camera);
        return p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY;
      });
    };
    let lo = this.controls.minDistance;
    let hi = this.controls.maxDistance;
    if (!fits(hi)) {
      lo = hi;
    } else {
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) hi = mid;
        else lo = mid;
      }
    }
    fits(hi);
  }
}
