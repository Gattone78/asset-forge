import { createVuetify } from "vuetify";

export default defineNuxtPlugin((nuxtApp) => {
  const vuetify = createVuetify({
    theme: {
      defaultTheme: "forge",
      themes: {
        forge: {
          dark: false,
          colors: { primary: "#2e7d32", secondary: "#5d6d7e", surface: "#ffffff", background: "#f3f5f4" },
        },
      },
    },
    defaults: { VBtn: { rounded: "lg" }, VCard: { rounded: "lg" } },
  });
  nuxtApp.vueApp.use(vuetify);
});
