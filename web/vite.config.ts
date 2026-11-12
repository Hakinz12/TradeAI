import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev` serves the UI on :5173 and forwards /api to the engine on :3000.
// `npm run build` writes web/dist, which the engine's Express server serves in production.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://127.0.0.1:3000" } },
  build: { outDir: "dist", sourcemap: false },
});
