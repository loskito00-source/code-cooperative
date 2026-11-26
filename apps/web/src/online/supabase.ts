/**
 * Conexión a Supabase (partidas guardadas + tiempo real). La clave publicable es pública a propósito: va en el
 * navegador. La clave secreta NUNCA va aquí (el sitio es estático: todo lo que esté en el código lo ve cualquiera).
 * Se pueden cambiar con VITE_SUPABASE_URL y VITE_SUPABASE_KEY (archivo apps/web/.env).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const SUPABASE_URL: string = import.meta.env.VITE_SUPABASE_URL ?? "https://nenjeyukfagagbekjqqw.supabase.co";
export const SUPABASE_KEY: string = import.meta.env.VITE_SUPABASE_KEY ?? "sb_publishable_dMES7m38dOZlDi0Wd1svYA_zdL9wTr_";

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  client ??= createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 40 } },
  });
  return client;
}
