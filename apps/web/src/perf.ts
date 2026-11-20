// Optimizaciones de render: fundir lo que no se mueve y ajustar la resolución según lo que aguante el equipo.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/**
 * Funde en pocas piezas todas las mallas estáticas de `roots` (piso, paredes, callejón...): una por material.
 * La GPU recibe ~10 dibujos en lugar de cientos. Las piezas originales se quitan de la escena.
 * Solo para cosas que nunca se mueven, ni se esconden, ni se apuntan con el ratón.
 */
export function mergeStatic(scene: THREE.Scene, roots: THREE.Object3D[], noShadow: (m: THREE.Mesh) => boolean): number {
  scene.updateMatrixWorld(true);
  const groups = new Map<string, { material: THREE.Material; cast: boolean; receive: boolean; geos: THREE.BufferGeometry[] }>();
  const done: THREE.Mesh[] = [];
  for (const root of roots) {
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || (m as unknown as THREE.SkinnedMesh).isSkinnedMesh || Array.isArray(m.material) || !isShown(m)) return;
      const cast = m.castShadow && !noShadow(m);
      let geo = m.geometry.clone().applyMatrix4(m.matrixWorld);
      if (geo.index) geo = geo.toNonIndexed();
      // solo los atributos que todos comparten (posición, normal, uv)
      for (const name of Object.keys(geo.attributes)) if (!["position", "normal", "uv"].includes(name)) geo.deleteAttribute(name);
      if (!geo.attributes.uv) geo.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
      if (!geo.attributes.normal) geo.computeVertexNormals();
      const key = `${m.material.uuid}|${cast}|${m.receiveShadow}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { material: m.material, cast, receive: m.receiveShadow, geos: [] }));
      g.geos.push(geo);
      done.push(m);
    });
  }
  for (const m of done) {
    // se quita la malla y los grupos que quedaron vacíos (así no se recorren cada cuadro)
    let parent = m.parent;
    m.removeFromParent();
    while (parent && parent !== scene && parent.children.length === 0) {
      const up: THREE.Object3D | null = parent.parent;
      parent.removeFromParent();
      parent = up;
    }
  }
  let n = 0;
  for (const g of groups.values()) {
    const merged = mergeGeometries(g.geos, false);
    for (const geo of g.geos) geo.dispose();
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, g.material);
    mesh.castShadow = g.cast;
    mesh.receiveShadow = g.receive;
    mesh.matrixAutoUpdate = false;
    scene.add(mesh);
    n++;
  }
  return n;
}

function isShown(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

/**
 * Resolución dinámica: cada 2 s mira cuánto tardan los cuadros. Si el equipo no llega a ~45 fps baja la
 * resolución (hasta 60 %), y si va sobrado la sube de nuevo. Si aun en lo más bajo sigue lento, apaga las sombras.
 */
export class QualityGovernor {
  private readonly max: number;
  private ratio: number;
  private frames = 0;
  private since = 0;
  private slowAtFloor = 0;
  private shadowsOff = false;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly onShadowsOff: () => void,
  ) {
    const dpr = window.devicePixelRatio || 1;
    this.max = Math.min(dpr, 1.5);
    this.ratio = this.max;
    renderer.setPixelRatio(this.ratio);
  }

  /** Llamar una vez por cuadro. */
  tick(now: number): void {
    if (document.hidden) {
      this.since = 0;
      return;
    }
    if (!this.since) {
      this.since = now;
      this.frames = 0;
      return;
    }
    this.frames++;
    const elapsed = now - this.since;
    if (elapsed < 2000) return;
    const ms = elapsed / this.frames;
    this.since = now;
    this.frames = 0;
    const floor = Math.max(0.6, this.max * 0.5);
    if (ms > 22 && this.ratio > floor) this.set(this.ratio - 0.15);
    else if (ms > 22 && !this.shadowsOff && ++this.slowAtFloor >= 2) {
      this.shadowsOff = true;
      this.onShadowsOff();
    } else if (ms < 13 && this.ratio < this.max) this.set(this.ratio + 0.1);
  }

  private set(r: number): void {
    this.ratio = Math.min(this.max, Math.max(0.6, Math.round(r * 100) / 100));
    this.renderer.setPixelRatio(this.ratio);
  }
}
