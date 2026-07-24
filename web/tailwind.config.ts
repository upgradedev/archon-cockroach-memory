import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#090b0c",
        carbon: "#111416",
        slate: "#1a1e20",
        paper: "#f1ede3",
        muted: "#a6a89f",
        ember: "#ff704d",
        mint: "#9ce6c8",
        acid: "#d9f99d",
        line: "rgba(241, 237, 227, 0.14)"
      },
      fontFamily: {
        sans: ["Inter", "Aptos", "Segoe UI", "ui-sans-serif", "system-ui", "sans-serif"],
        editorial: ["Iowan Old Style", "Baskerville", "Times New Roman", "serif"],
        mono: ["SFMono-Regular", "Cascadia Code", "Roboto Mono", "monospace"]
      },
      letterSpacing: {
        editorial: "-0.035em"
      },
      animation: {
        "slow-pulse": "slowPulse 2.4s ease-in-out infinite"
      },
      keyframes: {
        slowPulse: {
          "0%, 100%": { opacity: "0.35" },
          "50%": { opacity: "0.8" }
        }
      }
    }
  },
  plugins: []
} satisfies Config;
