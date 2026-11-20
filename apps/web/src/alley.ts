import * as THREE from "three";

/**
 * El callejón detrás de la tienda y el camión del distribuidor, hechos con geometría simple
 * (estilo low-poly, como los modelos de Kenney). El camión avanza hacia -x: la cabina va adelante
 * y las puertas traseras miran hacia +x.
 */

export interface Truck {
  group: THREE.Group;
  wheels: THREE.Object3D[];
  /** Bisagras de las puertas traseras (rotan en y). */
  doors: [THREE.Object3D, THREE.Object3D];
  boxes: THREE.Object3D[];
  /** Punto entre las puertas, en coordenadas del camión (para apuntar la cámara). */
  rear: THREE.Vector3;
  wheelRadius: number;
}

const mat = (color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0, ...opts });

function box(w: number, h: number, d: number, material: THREE.Material | THREE.Material[], x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Letrero pintado a los costados del camión. */
function logoTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 512;
  const g = c.getContext("2d")!;
  g.fillStyle = "#f7f4ec";
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#3fa34d";
  g.fillRect(0, 360, c.width, 70);
  g.fillStyle = "#f6c945";
  g.fillRect(0, 430, c.width, 30);
  g.fillStyle = "#2b2b2b";
  g.font = "bold 70px Rubik, sans-serif";
  g.fillText("Distribuidora", 70, 150);
  g.fillStyle = "#e2483d";
  g.font = "bold 150px 'Lilita One', Rubik, sans-serif";
  g.fillText("EL SURTIDOR", 60, 300);
  g.fillStyle = "#ffffff";
  g.font = "bold 44px Rubik, sans-serif";
  g.fillText("pan · leche · huevos · y mucho más", 70, 410);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function cardboardBox(w: number, h: number, d: number): THREE.Group {
  const g = new THREE.Group();
  const shade = 0.9 + Math.random() * 0.15;
  const body = box(w, h, d, mat(new THREE.Color(0xc99459).multiplyScalar(shade).getHex()), 0, h / 2, 0);
  const tape = box(w * 1.002, 0.012, d * 0.22, mat(0xe8d2a6, { roughness: 0.4 }), 0, h + 0.003, 0);
  const label = box(w * 0.35, h * 0.3, 0.004, mat(0xffffff), w * 0.15, h * 0.55, d / 2 + 0.002);
  g.add(body, tape, label);
  return g;
}

export function buildTruck(food: { loaf: THREE.Object3D; carton: THREE.Object3D; egg: THREE.Object3D }): Truck {
  const group = new THREE.Group();
  const white = mat(0xf7f4ec);
  const red = mat(0xe2483d, { roughness: 0.5 });
  const dark = mat(0x2f3138, { roughness: 0.9 });
  const steel = mat(0x9aa0a8, { metalness: 0.4, roughness: 0.4 });
  const glass = mat(0x24384a, { roughness: 0.15, metalness: 0.3 });
  const logo = mat(0xffffff, { map: logoTexture(), roughness: 0.6 });

  // chasis
  group.add(box(3.25, 0.14, 1.06, dark, -0.1, 0.33, 0));

  // caja de carga hueca (para ver las cajas cuando se abren las puertas)
  const cx = 0.45;
  const len = 2.2;
  const rearX = cx + len / 2;
  const [y0, h] = [0.4, 1.32];
  group.add(box(len, 0.06, 1.22, mat(0x8d8f96), cx, y0, 0)); // piso
  // paredes: el letrero va en la cara de afuera (+z en la izquierda, -z en la derecha)
  const side = (z: number, outward: number) => {
    const mats = [white, white, white, white, white, white];
    mats[outward] = logo;
    return box(len, h, 0.05, mats, cx, y0 + h / 2, z);
  };
  group.add(side(0.6, 4), side(-0.6, 5));
  group.add(box(len, 0.05, 1.25, white, cx, y0 + h, 0)); // techo
  group.add(box(0.05, h, 1.2, white, cx - len / 2, y0 + h / 2, 0)); // pared delantera
  // marco trasero
  group.add(box(0.06, h, 0.06, steel, rearX, y0 + h / 2, 0.6), box(0.06, h, 0.06, steel, rearX, y0 + h / 2, -0.6));
  group.add(box(0.06, 0.06, 1.26, steel, rearX, y0 + h, 0), box(0.12, 0.08, 1.2, dark, rearX + 0.03, y0 - 0.02, 0));

  // puertas traseras con bisagra
  const door = (hingeZ: number) => {
    const hinge = new THREE.Group();
    hinge.position.set(rearX + 0.03, y0 + h / 2 + 0.01, hingeZ);
    const dir = -Math.sign(hingeZ);
    const panel = box(0.035, h - 0.06, 0.6, white, 0, 0, dir * 0.3);
    const handle = box(0.03, 0.22, 0.03, steel, 0.03, -0.05, dir * 0.52);
    const stripe = box(0.037, 0.08, 0.6, mat(0x3fa34d), 0, -h * 0.28, dir * 0.3);
    hinge.add(panel, handle, stripe);
    group.add(hinge);
    return hinge;
  };
  const doors: [THREE.Object3D, THREE.Object3D] = [door(0.6), door(-0.6)];

  // luces traseras
  for (const z of [0.5, -0.5]) group.add(box(0.03, 0.1, 0.12, mat(0xe2483d, { emissive: 0x7a0f08, emissiveIntensity: 0.6 }), rearX + 0.08, 0.48, z));

  // cabina
  const cabX = cx - len / 2 - 0.5;
  group.add(box(0.92, 0.98, 1.18, red, cabX, 0.88, 0));
  group.add(box(0.42, 0.5, 1.14, red, cabX - 0.62, 0.62, 0)); // capó
  const windshield = box(0.04, 0.46, 1.04, glass, cabX - 0.47, 1.06, 0);
  windshield.rotation.z = -0.28;
  group.add(windshield);
  for (const z of [0.595, -0.595]) group.add(box(0.5, 0.38, 0.02, glass, cabX - 0.05, 1.08, z));
  group.add(box(0.06, 0.16, 1.2, steel, cabX - 0.85, 0.42, 0)); // parachoques
  for (const z of [0.42, -0.42]) group.add(box(0.03, 0.1, 0.18, mat(0xfff3c4, { emissive: 0xf6c945, emissiveIntensity: 0.9 }), cabX - 0.84, 0.66, z));
  for (const z of [0.68, -0.68]) group.add(box(0.06, 0.16, 0.04, dark, cabX - 0.3, 1.12, z)); // espejos

  // ruedas
  const wheelRadius = 0.22;
  const tire = new THREE.CylinderGeometry(wheelRadius, wheelRadius, 0.2, 20);
  const hub = new THREE.CylinderGeometry(0.1, 0.1, 0.21, 12);
  const wheels: THREE.Object3D[] = [];
  for (const x of [cabX - 0.15, cx + 0.55, cx + 0.05]) {
    for (const z of [0.52, -0.52]) {
      const w = new THREE.Group();
      const t = new THREE.Mesh(tire, dark);
      t.castShadow = true;
      const hb = new THREE.Mesh(hub, steel);
      w.add(t, hb);
      w.rotation.x = Math.PI / 2;
      w.position.set(x, wheelRadius, z);
      group.add(w);
      wheels.push(w);
    }
  }

  // cajas adentro (y una caja abierta con productos, cerca de la puerta)
  const boxes: THREE.Object3D[] = [];
  const spots: [number, number, number, number][] = [
    // x, z, tamaño, altura
    [cx - 0.75, 0.3, 0.42, 0.42], [cx - 0.75, -0.3, 0.42, 0.38], [cx - 0.3, 0.3, 0.4, 0.4], [cx - 0.3, -0.3, 0.42, 0.42],
    [cx + 0.15, 0.32, 0.38, 0.36], [cx + 0.15, -0.28, 0.42, 0.44], [cx - 0.75, 0.3, 0.36, 0.34], [cx - 0.3, -0.3, 0.36, 0.32],
  ];
  const heights = new Map<string, number>();
  for (const [x, z, s, hh] of spots) {
    const key = `${x}:${z}`;
    const base = heights.get(key) ?? y0 + 0.03;
    const b = cardboardBox(s, hh, s * 0.95);
    b.position.set(x, base, z);
    b.rotation.y = (Math.random() - 0.5) * 0.15;
    heights.set(key, base + hh);
    group.add(b);
    boxes.push(b);
  }
  // caja abierta con leche y pan, para que se vea qué trajo el camión
  const crate = new THREE.Group();
  crate.position.set(cx + 0.65, y0 + 0.03, 0);
  const crateMat = mat(0x3fa34d, { roughness: 0.6 });
  crate.add(box(0.5, 0.04, 0.6, crateMat, 0, 0.02, 0));
  for (const [w, d, x, z] of [[0.5, 0.03, 0, 0.3], [0.5, 0.03, 0, -0.3], [0.03, 0.6, 0.25, 0], [0.03, 0.6, -0.25, 0]] as const) {
    crate.add(box(w, 0.2, d, crateMat, x, 0.12, z));
  }
  const fit = (o: THREE.Object3D, size: number) => {
    const c = o.clone(true);
    const dims = new THREE.Box3().setFromObject(c).getSize(new THREE.Vector3());
    c.scale.setScalar(size / Math.max(dims.x, dims.y, dims.z));
    return c;
  };
  for (let i = 0; i < 3; i++) {
    const m = fit(food.carton, 0.2);
    m.position.set(-0.12 + i * 0.12, 0.04, 0.12);
    crate.add(m);
    const l = fit(food.loaf, 0.2);
    l.position.set(-0.12 + i * 0.12, 0.04, -0.14);
    l.rotation.y = Math.PI / 2;
    crate.add(l);
  }
  group.add(crate);
  boxes.push(crate);

  group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });

  return { group, wheels, doors, boxes, rear: new THREE.Vector3(rearX, y0 + 0.6, 0), wheelRadius };
}

/** El callejón: asfalto, el edificio de enfrente, un contenedor de basura y un poste de luz. */
export function buildAlley(): THREE.Group {
  const g = new THREE.Group();
  const asphalt = new THREE.Mesh(new THREE.BoxGeometry(18, 0.3, 3.9), mat(0x5a6069, { roughness: 0.95 }));
  asphalt.position.set(4.5, -0.18, -2.7);
  asphalt.receiveShadow = true;
  g.add(asphalt);
  g.add(box(18, 0.06, 0.25, mat(0xb9b4a8), 4.5, 0.0, -0.85)); // andén junto a la tienda

  // edificio de enfrente (ladrillo) con ventanas
  const brick = mat(0xb5654a, { roughness: 0.9 });
  g.add(box(18, 2.4, 0.4, brick, 4.5, 1.2 - 0.03, -4.85));
  g.add(box(18, 0.12, 0.5, mat(0x8c4a35), 4.5, 2.36, -4.8));
  const winMat = mat(0x2c4152, { roughness: 0.2, metalness: 0.2, emissive: 0x0d1720, emissiveIntensity: 0.4 });
  for (let x = -3.2; x < 13; x += 1.6) {
    if (Math.abs(x - 4.8) < 0.5) continue;
    g.add(box(0.7, 0.55, 0.05, winMat, x, 1.55, -4.62));
    g.add(box(0.8, 0.07, 0.1, mat(0xe8dcc6), x, 1.25, -4.6));
  }
  g.add(box(0.8, 1.2, 0.06, mat(0x3a5a4c), 4.8, 0.6, -4.62)); // puerta del vecino
  g.add(box(0.5, 0.35, 0.3, mat(0xd0d4d8), 9.6, 1.9, -4.5)); // aire acondicionado
  g.add(box(0.06, 2.2, 0.06, mat(0x7d838c, { metalness: 0.4 }), 2.2, 1.1, -4.6)); // tubo de desagüe

  // contenedor de basura
  const bin = new THREE.Group();
  bin.position.set(-1.8, 0, -3.9);
  bin.add(box(1.1, 0.7, 0.65, mat(0x2f7a45, { roughness: 0.6 }), 0, 0.35, 0));
  const lid = box(1.14, 0.06, 0.7, mat(0x24603a), 0, 0.74, 0.02);
  lid.rotation.x = -0.12;
  bin.add(lid);
  g.add(bin);
  for (const [x, z, r] of [[-0.9, -4.2, 0.18], [-0.6, -4.3, 0.14]] as const) {
    const bag = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), mat(0x202226, { roughness: 0.4 }));
    bag.position.set(x, r * 0.8, z);
    bag.castShadow = true;
    g.add(bag);
  }

  // poste de luz con una luz cálida
  const lamp = new THREE.Group();
  lamp.position.set(8.2, 0, -4.35);
  lamp.add(box(0.08, 2.1, 0.08, mat(0x3b3f46), 0, 1.05, 0));
  lamp.add(box(0.5, 0.06, 0.08, mat(0x3b3f46), 0, 2.1, 0.22));
  lamp.add(box(0.22, 0.08, 0.16, mat(0xfff1c6, { emissive: 0xffd27a, emissiveIntensity: 1.2 }), 0, 2.05, 0.42));
  const light = new THREE.PointLight(0xffd9a0, 4, 6, 1.6);
  light.position.set(0, 1.95, 0.45);
  lamp.add(light);
  g.add(lamp);

  // charcos
  for (const [x, z, s] of [[6.1, -3.4, 0.6], [1.0, -2.0, 0.4]] as const) {
    const p = new THREE.Mesh(new THREE.CircleGeometry(s, 24), mat(0x3d4a58, { roughness: 0.05, metalness: 0.4 }));
    p.rotation.x = -Math.PI / 2;
    p.position.set(x, -0.025, z);
    p.scale.set(1.4, 1, 1);
    g.add(p);
  }
  return g;
}
