import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        tl: {
          bg: "#000000",
          surface: "#000000",
          border: "#2a2a2a",
          text: "#f5f5f5",
          muted: "#9c9c9c",
          brand: "#4f8cff"
        }
      },
      fontFamily: {
        sans: ["Beiruti", "Segoe UI", "sans-serif"]
      }
    }
  },
  plugins: []
} satisfies Config;
