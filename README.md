# Código de Barras

Juego web cooperativo: dos amigos administran un supermercado programando robots en Python.
El diseño completo está en `docs/gdd/output/CodigoDeBarras_GDD_v0.1.pdf`.

## Correr el juego

```bash
pnpm install
pnpm dev        # abre http://localhost:5173
```

## Desarrollo

```bash
pnpm test       # tests del intérprete y de la simulación
pnpm typecheck
pnpm build      # build de producción en apps/web/dist
```

| Carpeta | Qué es |
|---|---|
| `packages/interpreter` | Intérprete propio de un subconjunto de Python: ejecución por ticks, desbloqueos de sintaxis, errores en español |
| `packages/sim` | Simulación de la tienda, `db` estilo asyncpg, pandas sencillo y la hoja del distribuidor. Balance en `src/config.ts` |
| `packages/db` | PostgreSQL real (PGlite): tablas que diseña el jugador (public, guardadas en IndexedDB) y un registro interno del juego, invisible para el jugador |
| `apps/web` | Three.js (tienda 3D con modelos CC0 de Kenney) + CodeMirror 6 en ventanas flotantes |
| `docs/gdd` | Documento de diseño; se regenera con `build_gdd.py` |
# code-cooperative
