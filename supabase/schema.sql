-- Código de Barras: partidas en línea.
-- Pegar en Supabase → SQL Editor → Run (una sola vez). Se puede volver a correr sin romper nada.
--
-- Las partidas son públicas (el juego es privado entre amigos): cualquiera con la clave publicable puede
-- listarlas, crearlas, guardarlas y borrarlas. El tiempo real (código compartido, la tienda en vivo) va por
-- Supabase Realtime (broadcast y presence) y no necesita tablas.

create table if not exists public.partidas (
  id          text primary key,                 -- código de 4 letras (ABCD)
  nombre      text not null,
  creada      timestamptz not null default now(),
  actualizada timestamptz not null default now(),
  -- nombres de quienes han jugado en ella (para la lista)
  jugadores   jsonb not null default '[]'::jsonb,
  -- día de juego y plata (para la lista, sin bajar todo el estado)
  dia         integer not null default 1,
  plata       integer not null default 0,
  -- el mundo guardado (World serializado), el código compartido (Yjs) y la base del jugador (pg_dump)
  estado      jsonb,
  codigo      text,
  base        jsonb
);

alter table public.partidas enable row level security;

drop policy if exists "partidas: leer" on public.partidas;
drop policy if exists "partidas: crear" on public.partidas;
drop policy if exists "partidas: guardar" on public.partidas;
drop policy if exists "partidas: borrar" on public.partidas;

create policy "partidas: leer" on public.partidas for select to anon, authenticated using (true);
create policy "partidas: crear" on public.partidas for insert to anon, authenticated with check (true);
create policy "partidas: guardar" on public.partidas for update to anon, authenticated using (true) with check (true);
create policy "partidas: borrar" on public.partidas for delete to anon, authenticated using (true);

-- la lista de partidas se actualiza sola en el menú
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'partidas') then
    alter publication supabase_realtime add table public.partidas;
  end if;
end $$;
