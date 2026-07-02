import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { config as loadEnv } from "dotenv";

// Load .env.local so integration tests see the same Supabase env vars the
// Next.js app uses, without requiring a manual `source .env.local` per run.
loadEnv({ path: ".env.local", quiet: true });

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  // Tests don't exercise CSS. Provide an inline empty PostCSS config so Vite
  // does not load the project postcss.config.mjs (whose string-plugin form is
  // for Next.js/Turbopack and is rejected by Vite's PostCSS loader).
  css: { postcss: { plugins: [] } },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**"],
  },
});
