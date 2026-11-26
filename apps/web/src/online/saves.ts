/**
 * Partidas guardadas en Supabase (tabla public.partidas, ver supabase/schema.sql). Todas son públicas: cualquiera
 * las ve en la lista y puede entrar. El que hace de anfitrión guarda cada rato.
 */
import { supabase } from "./supabase.js";

export interface PartidaInfo {
  id: string;
  nombre: string;
  actualizada: string;
  jugadores: string[];
  dia: number;
  plata: number;
}

export interface PartidaSave {
  estado: Record<string, unknown> | null;
  codigo: string | null;
  base: { public: string; registro: string } | null;
}

/** Explica el error de Supabase en español (el más común: falta correr el SQL de la tabla). */
function why(err: { message: string; code?: string } | null): string {
  if (!err) return "";
  if (/schema cache|does not exist|relation .*partidas/i.test(err.message)) {
    return "Falta crear la tabla de partidas en Supabase: corre supabase/schema.sql en el SQL Editor de tu proyecto.";
  }
  if (/fetch|network/i.test(err.message)) return "No hay conexión con Supabase.";
  return err.message;
}

export async function listPartidas(): Promise<{ ok: true; list: PartidaInfo[] } | { ok: false; reason: string }> {
  const { data, error } = await supabase().from("partidas").select("id, nombre, actualizada, jugadores, dia, plata").order("actualizada", { ascending: false }).limit(60);
  if (error) return { ok: false, reason: why(error) };
  return { ok: true, list: (data ?? []) as PartidaInfo[] };
}

const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // sin I ni O (se confunden con 1 y 0)
export const newCode = (): string => Array.from({ length: 4 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join("");

export async function createPartida(nombre: string, jugador: string): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  for (let i = 0; i < 5; i++) {
    const id = newCode();
    const { error } = await supabase().from("partidas").insert({ id, nombre, jugadores: [jugador] });
    if (!error) return { ok: true, id };
    if (error.code !== "23505") return { ok: false, reason: why(error) }; // 23505 = el código ya existe: otro intento
  }
  return { ok: false, reason: "No se pudo crear la partida. Intenta otra vez." };
}

export async function getPartida(id: string): Promise<{ ok: true; info: PartidaInfo; save: PartidaSave } | { ok: false; reason: string }> {
  const { data, error } = await supabase().from("partidas").select("*").eq("id", id).maybeSingle();
  if (error) return { ok: false, reason: why(error) };
  if (!data) return { ok: false, reason: `No existe la partida ${id}.` };
  const { estado, codigo, base, ...info } = data as PartidaInfo & PartidaSave;
  return { ok: true, info, save: { estado, codigo, base } };
}

export async function savePartida(id: string, data: Partial<PartidaSave> & { dia?: number; plata?: number; jugadores?: string[] }): Promise<string | null> {
  const { error } = await supabase().from("partidas").update({ ...data, actualizada: new Date().toISOString() }).eq("id", id);
  return error ? why(error) : null;
}

export async function deletePartida(id: string): Promise<string | null> {
  const { error } = await supabase().from("partidas").delete().eq("id", id);
  return error ? why(error) : null;
}
