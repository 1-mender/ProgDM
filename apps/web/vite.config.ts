import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: false,
    proxy: {
      "/health": process.env.PROGDM_API_TARGET ?? "http://localhost:3333",
      "/api": process.env.PROGDM_API_TARGET ?? "http://localhost:3333"
    }
  }
});
