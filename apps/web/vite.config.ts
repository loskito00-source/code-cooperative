import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 5173 },
  // PGlite trae su propio .wasm y .data: no debe pasar por el pre-empaquetado de Vite
  optimizeDeps: { exclude: ["@electric-sql/pglite"] },
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
});
