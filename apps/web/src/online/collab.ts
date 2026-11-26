/**
 * Código compartido en tiempo real (como Live Share): cada archivo (el de cada robot, shared.py, inventario.py) es
 * un Y.Text de un mismo Y.Doc. Los cambios viajan por la sala como mensajes; Yjs los mezcla sin conflictos.
 * La "awareness" lleva el cursor y la selección de cada jugador (con su nombre y color).
 */
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { lighten, type PlayerInfo } from "./player.js";
import type { Room } from "./room.js";

const b64 = (u: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export class Collab {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  private readonly peerClients = new Map<string, number>();

  constructor(private readonly room: Room, me: PlayerInfo) {
    this.awareness.setLocalStateField("user", { name: me.name || "Jugador", color: me.color, colorLight: lighten(me.color), id: me.id });
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== this) room.send("y", { u: b64(update) });
    });
    room.on("y", (p: { u: string }) => Y.applyUpdate(this.doc, unb64(p.u), this));
    // alguien pide lo que le falta: se le manda la diferencia y nuestro cursor
    room.on("ysv", (p: { sv: string }, from) => {
      room.send("y", { u: b64(Y.encodeStateAsUpdate(this.doc, unb64(p.sv))) }, from);
      room.send("aw", { u: b64(encodeAwarenessUpdate(this.awareness, [this.doc.clientID])) }, from);
    });
    this.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === this) return;
      const changed = [...added, ...updated, ...removed];
      if (changed.includes(this.doc.clientID)) room.send("aw", { u: b64(encodeAwarenessUpdate(this.awareness, [this.doc.clientID])) });
    });
    room.on("aw", (p: { u: string }, from) => {
      applyAwarenessUpdate(this.awareness, unb64(p.u), this);
      for (const [client, state] of this.awareness.getStates()) if ((state as { user?: { id?: string } }).user?.id === from) this.peerClients.set(from, client);
    });
    // el que se va deja de mostrar su cursor
    const prevPeers = room.onPeers;
    room.onPeers = (peers) => {
      prevPeers?.(peers);
      for (const [id, client] of this.peerClients) {
        if (!peers.some((p) => p.id === id)) {
          removeAwarenessStates(this.awareness, [client], this);
          this.peerClients.delete(id);
        }
      }
    };
  }

  /** Pide a los demás lo que nos falta del código (al entrar). */
  requestSync(): void {
    this.room.send("ysv", { sv: b64(Y.encodeStateVector(this.doc)) });
  }

  text(id: string): Y.Text {
    return this.doc.getText(id);
  }

  /** Pone el texto inicial de un archivo si todavía está vacío (lo hace solo el anfitrión, para no duplicar). */
  seed(id: string, content: string): void {
    const t = this.text(id);
    if (t.length === 0 && content) t.insert(0, content);
  }

  /** Todo el código como un solo bloque (para guardar la partida). */
  snapshot(): string {
    return b64(Y.encodeStateAsUpdate(this.doc));
  }

  load(saved: string): void {
    Y.applyUpdate(this.doc, unb64(saved), this);
  }
}
