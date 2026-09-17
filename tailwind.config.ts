import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#06070b",
          900: "#0a0c12",
          850: "#0e1119",
          800: "#12161f",
          700: "#1a2030",
          600: "#232b3f",
        },
        gold: {
          300: "#ffe9a8",
          400: "#f8cf6b",
          500: "#eab84a",
          600: "#c9962e",
        },
        arena: {
          red: "#ff4d5e",
          green: "#3ddc84",
          cyan: "#5ad7ff",
          violet: "#a78bfa",
        },
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "SFMono-Regular", "monospace"],
      },
      boxShadow: {
        glow: "0 0 40px rgba(234,184,74,0.15)",
        card: "0 12px 40px rgba(0,0,0,0.45)",
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(14px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "pop-in": {
          "0%": { opacity: "0", transform: "scale(0.6)" },
          "60%": { opacity: "1", transform: "scale(1.08)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-400px 0" },
          "100%": { backgroundPosition: "400px 0" },
        },
        "pulse-ring": {
          "0%": { boxShadow: "0 0 0 0 rgba(234,184,74,0.45)" },
          "100%": { boxShadow: "0 0 0 18px rgba(234,184,74,0)" },
        },
        "vs-flash": {
          "0%": { opacity: "0", transform: "scale(2.4)", filter: "blur(8px)" },
          "100%": { opacity: "1", transform: "scale(1)", filter: "blur(0)" },
        },
        "count-pop": {
          "0%": { opacity: "0", transform: "scale(2.2)" },
          "25%": { opacity: "1", transform: "scale(1)" },
          "85%": { opacity: "1", transform: "scale(0.92)" },
          "100%": { opacity: "0", transform: "scale(0.7)" },
        },
        "reveal-up": {
          "0%": { opacity: "0", transform: "translateY(40px) scale(0.96)" },
          "100%": { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        marquee: {
          "0%": { transform: "translateX(0)" },
          "100%": { transform: "translateX(-50%)" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.5s cubic-bezier(0.22,1,0.36,1) both",
        "pop-in": "pop-in 0.55s cubic-bezier(0.22,1,0.36,1) both",
        shimmer: "shimmer 1.6s linear infinite",
        "pulse-ring": "pulse-ring 1.8s cubic-bezier(0.4,0,0.6,1) infinite",
        "vs-flash": "vs-flash 0.7s cubic-bezier(0.22,1,0.36,1) both",
        "count-pop": "count-pop 1s ease-in-out both",
        "reveal-up": "reveal-up 0.7s cubic-bezier(0.22,1,0.36,1) both",
        marquee: "marquee 30s linear infinite",
      },
    },
  },
  plugins: [],
};
export default config;
