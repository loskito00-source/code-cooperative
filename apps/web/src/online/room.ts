/**
 * Una sala de juego en tiempo real (Supabase Realtime): quién está (presence), mensajes para todos (broadcast) y
 * llamadas al anfitrión (rpc). El anfitrión es el que lleva más tiempo en la sala: su navegador corre la tienda.
 */
import type { RealtimeChannel } from "@supabase/supabase-js";
import type { PlayerInfo } from "./player.js";
import { supabase } from "./supabase.js";

export interface Peer extends PlayerInfo {
  /** Cuándo entró (ms): el más antiguo es el anfitrión. */
  joinedAt: number;
}

type Handler = (payload: any, from: string) => void;
type RpcHandler = (args: any, from: string) => unknown | Promise<unknown>;

export class Room {
  private channel: RealtimeChannel | null = null;
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly rpcHandlers = new Map<string, RpcHandler>();
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }>();
  private nextRpc = 1;
  readonly me: Peer;
  peers: Peer[] = [];
  private lastHost: string | null = null;
  /** Cambió quién está (o quién es el anfitrión). */
  onPeers?: (peers: Peer[]) => void;

  constructor(readonly code: string, player: PlayerInfo) {
    this.me = { ...player, joinedAt: Date.now() };
  }

  get hostId(): string {
    const all = this.peers.length ? this.peers : [this.me];
    return [...all].sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id))[0].id;
  }

  get isHost(): boolean {
    return this.hostId === this.me.id;
  }

  /** Entra a la sala. Espera a saber quién más está antes de devolver (para decidir quién es el anfitrión). */
  async join(): Promise<void> {
    const ch = supabase().channel(`partida:${this.code}`, {
      config: { broadcast: { self: false, ack: false }, presence: { key: this.me.id } },
    });
    this.channel = ch;
    ch.on("broadcast", { event: "m" }, ({ payload }) => this.receive(payload as { e: string; p: unknown; f: string; to?: string }));
    let synced!: () => void;
    const firstSync = new Promise<void>((r) => (synced = r));
    ch.on("presence", { event: "sync" }, () => {
      const state = ch.presenceState<Peer>();
      this.peers = Object.values(state).map((list) => list[0]).filter(Boolean);
      synced();
      this.onPeers?.(this.peers);
      this.lastHost = this.hostId;
    });
    await new Promise<void>((resolve, reject) => {
      const t = window.setTimeout(() => reject(new Error("No se pudo conectar con el servidor en tiempo real.")), 15000);
      ch.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          clearTimeout(t);
          resolve();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          clearTimeout(t);
          reject(new Error("No se pudo conectar con el servidor en tiempo real."));
        }
      });
    });
    await Promise.race([firstSync, new Promise((r) => setTimeout(r, 2500))]);
    await ch.track(this.me);
    // un momento para que nos vean y veamos a los que ya estaban
    await Promise.race([new Promise((r) => setTimeout(r, 900)), new Promise<void>((r) => this.peers.some((p) => p.id === this.me.id) && r())]);
    if (!this.peers.some((p) => p.id === this.me.id)) this.peers = [...this.peers, this.me];
  }

  leave(): void {
    void this.channel?.unsubscribe();
    this.channel = null;
  }

  /** ¿Cambió el anfitrión desde la última vez que se preguntó? (el que estaba se fue) */
  hostChanged(): boolean {
    const now = this.hostId;
    const changed = this.lastHost !== null && now !== this.lastHost;
    this.lastHost = now;
    return changed;
  }

  // ── mensajes ──

  on(event: string, fn: Handler): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  /** Manda un mensaje a los demás (o a uno solo con `to`). */
  send(event: string, payload: unknown, to?: string): void {
    void this.channel?.send({ type: "broadcast", event: "m", payload: { e: event, p: payload, f: this.me.id, to } });
  }

  private receive(msg: { e: string; p: unknown; f: string; to?: string }): void {
    if (msg.to && msg.to !== this.me.id) return;
    if (msg.e === "rpc") return void this.answer(msg.p as { id: string; m: string; a: unknown }, msg.f);
    if (msg.e === "rpc-res") {
      const r = msg.p as { id: string; ok: boolean; v?: unknown; err?: string };
      const p = this.pending.get(r.id);
      if (!p) return;
      this.pending.delete(r.id);
      clearTimeout(p.timer);
      if (r.ok) p.resolve(r.v);
      else p.reject(new Error(r.err ?? "falló"));
      return;
    }
    for (const fn of this.handlers.get(msg.e) ?? []) fn(msg.p, msg.f);
  }

  // ── llamadas al anfitrión ──

  /** El anfitrión registra qué sabe hacer. */
  handle(method: string, fn: RpcHandler): void {
    this.rpcHandlers.set(method, fn);
  }

  /** Le pide algo al anfitrión y espera la respuesta. Si yo soy el anfitrión, lo hago aquí mismo. */
  call<T = unknown>(method: string, args: unknown = null, timeoutMs = 20000): Promise<T> {
    if (this.isHost) {
      const fn = this.rpcHandlers.get(method);
      if (!fn) return Promise.reject(new Error(`no sé hacer ${method}`));
      return Promise.resolve(fn(args, this.me.id)) as Promise<T>;
    }
    const id = `${this.me.id.slice(0, 6)}-${this.nextRpc++}`;
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("El anfitrión no respondió."));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send("rpc", { id, m: method, a: args }, this.hostId);
    });
  }

  private async answer(req: { id: string; m: string; a: unknown }, from: string): Promise<void> {
    if (!this.isHost) return;
    const fn = this.rpcHandlers.get(req.m);
    try {
      if (!fn) throw new Error(`no sé hacer ${req.m}`);
      const v = await fn(req.a, from);
      this.send("rpc-res", { id: req.id, ok: true, v: v === undefined ? null : JSON.parse(JSON.stringify(v, jsonSafe)) }, from);
    } catch (e) {
      this.send("rpc-res", { id: req.id, ok: false, err: (e as Error).message }, from);
    }
  }
}

/** Para mandar resultados por la red: sin Sets, Maps ni el disco de los servidores. */
function jsonSafe(_k: string, v: unknown): unknown {
  if (v instanceof Set) return [...v];
  if (v instanceof Map) return Object.fromEntries(v);
  if (typeof v === "number" && !Number.isFinite(v)) return null;
  return v;
}
