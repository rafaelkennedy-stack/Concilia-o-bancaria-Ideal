// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { loadEnv } from "vite";

// The Lovable config only injects VITE_* vars (into the client bundle). Server-side
// code reads non-prefixed secrets from process.env (e.g. SUPABASE_SERVICE_ROLE_KEY,
// ANTHROPIC_API_KEY), which are never loaded from .env in local dev. Load every var
// from .env into process.env here — without overriding vars already set in the real
// environment, so platform-injected values (Lovable/CI) still win in production.
const dotEnv = loadEnv(process.env.NODE_ENV || "development", process.cwd(), "");
for (const [key, value] of Object.entries(dotEnv)) {
  if (process.env[key] === undefined) process.env[key] = value;
}

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});
