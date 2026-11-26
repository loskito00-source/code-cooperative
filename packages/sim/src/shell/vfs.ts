/**
 * Sistema de archivos virtual de un servidor (Linux simulado). Los archivos pueden ser texto fijo o generarse al
 * leerlos (p. ej. /proc/cpuinfo). Las rutas son absolutas y con "/".
 */
export type VNode = { type: "dir" } | { type: "file"; content: string | (() => string); binary?: boolean };

export class VFS {
  private readonly nodes = new Map<string, VNode>([["/", { type: "dir" }]]);

  static normalize(path: string, cwd = "/"): string {
    const parts = (path.startsWith("/") ? path : `${cwd}/${path}`).split("/");
    const out: string[] = [];
    for (const p of parts) {
      if (!p || p === ".") continue;
      if (p === "..") out.pop();
      else out.push(p);
    }
    return "/" + out.join("/");
  }

  static parent(path: string): string {
    const i = path.lastIndexOf("/");
    return i <= 0 ? "/" : path.slice(0, i);
  }

  static base(path: string): string {
    return path.slice(path.lastIndexOf("/") + 1);
  }

  mkdir(path: string): void {
    const p = VFS.normalize(path);
    if (p !== "/") this.mkdir(VFS.parent(p));
    if (!this.nodes.has(p)) this.nodes.set(p, { type: "dir" });
  }

  write(path: string, content: string | (() => string), binary = false): void {
    const p = VFS.normalize(path);
    this.mkdir(VFS.parent(p));
    this.nodes.set(p, { type: "file", content, binary });
  }

  append(path: string, line: string): void {
    const p = VFS.normalize(path);
    const n = this.nodes.get(p);
    const prev = n?.type === "file" ? (typeof n.content === "string" ? n.content : n.content()) : "";
    this.write(p, prev + line + "\n");
  }

  get(path: string): VNode | undefined {
    return this.nodes.get(VFS.normalize(path));
  }

  read(path: string): string | null {
    const n = this.get(path);
    if (!n || n.type !== "file") return null;
    return typeof n.content === "string" ? n.content : n.content();
  }

  exists(path: string): boolean {
    return this.nodes.has(VFS.normalize(path));
  }

  remove(path: string): boolean {
    const p = VFS.normalize(path);
    if (!this.nodes.has(p) || p === "/") return false;
    for (const k of [...this.nodes.keys()]) if (k === p || k.startsWith(p + "/")) this.nodes.delete(k);
    return true;
  }

  /** Nombres dentro de una carpeta (ordenados; las carpetas terminan en "/" si `mark`). */
  list(path: string, all = false): string[] | null {
    const p = VFS.normalize(path);
    if (this.nodes.get(p)?.type !== "dir") return null;
    const prefix = p === "/" ? "/" : p + "/";
    const names = new Set<string>();
    for (const k of this.nodes.keys()) {
      if (k === p || !k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      if (!rest.includes("/")) names.add(rest);
    }
    return [...names].filter((n) => all || !n.startsWith(".")).sort();
  }

  isDir(path: string): boolean {
    return this.get(path)?.type === "dir";
  }
}
