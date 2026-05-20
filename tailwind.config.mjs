import defaultTheme from "tailwindcss/defaultTheme";

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: [
    "./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", ...defaultTheme.fontFamily.sans],
        serif: ["Lora", ...defaultTheme.fontFamily.serif],
      },
      colors: {
        oki: {
          sand:            "#F5EDD5",
          "sand-deep":     "#E6D6A8",
          cream:           "#FAF4E8",
          ocean:           "#0092A3",
          "ocean-light":   "#00BAD0",
          "ocean-deep":    "#00606F",
          "ocean-pale":    "#C8E9EE",
          coral:           "#D4563A",
          "coral-light":   "#E87858",
          hibiscus:        "#C0408A",
          indigo:          "#1A2550",
          "indigo-mid":    "#243070",
          night:           "#0C1428",
          "night-mid":     "#152040",
          green:           "#3A7050",
          gold:            "#C09040",
        },
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
};
