// Asset Forge review UI. Static SPA (no SSR) generated into .output/public and served by forge-api at /ui/,
// so the browser talks to the API on the same origin (no CORS, one port behind Caddy).
import vuetify, { transformAssetUrls } from "vite-plugin-vuetify";

export default defineNuxtConfig({
  ssr: false,
  compatibilityDate: "2026-09-01",
  devtools: { enabled: false },
  app: {
    baseURL: "/ui/",
    head: {
      title: "Asset Forge",
      meta: [{ name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" }, { name: "theme-color", content: "#2e7d32" }],
    },
  },
  css: ["vuetify/styles", "@mdi/font/css/materialdesignicons.css"],
  build: { transpile: ["vuetify"] },
  modules: [
    (_options, nuxt) => {
      nuxt.hooks.hook("vite:extendConfig", (config) => {
        // @ts-expect-error plugins is typed loosely here
        config.plugins.push(vuetify({ autoImport: true }));
      });
    },
  ],
  vite: {
    vue: { template: { transformAssetUrls } },
    optimizeDeps: { include: ["three"] },
  },
  nitro: { preset: "static" },
  runtimeConfig: { public: { apiBase: "" } },
});
