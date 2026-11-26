/** Quién soy en las partidas en línea: un id fijo por navegador, el nombre que elegí y un color. */

export interface PlayerInfo {
  id: string;
  name: string;
  color: string;
}

const KEY = "cdb.player.v1";
export const PLAYER_COLORS = ["#2ec4d6", "#f28c28", "#3fa34d", "#9b6bd6", "#e86aa6", "#e8c33a"];

export function loadPlayer(): PlayerInfo {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as PlayerInfo | null;
    if (saved?.id) return saved;
  } catch {
    /* sin almacenamiento */
  }
  const p = { id: crypto.randomUUID(), name: "", color: PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)] };
  savePlayer(p);
  return p;
}

export function savePlayer(p: PlayerInfo): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* sin almacenamiento */
  }
}

/** Color clarito (para la selección del otro jugador en el editor). */
export function lighten(hex: string, alpha = 0.25): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
