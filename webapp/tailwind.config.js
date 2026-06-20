/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Vistalia workspace palette — workspace-scale dark, slightly warmer
        // than the marketing landing's pure black so eyes don't fatigue.
        ink: {
          DEFAULT: "#F0EFE9",
          soft: "#C7C7C2",
          muted: "#8B8B92",
          dim: "#5A5A60"
        },
        paper: {
          DEFAULT: "#0E0E10",
          soft: "#131317"
        },
        surface: {
          DEFAULT: "#18181C",
          raised: "#22222A",
          input: "#1E1E24"
        },
        edge: {
          DEFAULT: "#2A2A30",
          soft: "#1E1E24",
          strong: "#3A3A42"
        },
        gold: {
          DEFAULT: "#C7A76C",
          light: "#DBBE7E",
          dim: "#9C773B"
        }
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
        // v2 revamp: cinematic display serif for headline moments (auth, the
        // finished-video reveal, render progress) — mirrors the marketing
        // site so app + landing read as one product.
        display: ["Fraunces", "Georgia", "serif"]
      },
      letterSpacing: {
        tightish: "-0.015em",
        tighter2: "-0.025em"
      },
      transitionTimingFunction: {
        ease: "cubic-bezier(0.16, 1, 0.3, 1)"
      }
    }
  },
  plugins: []
};
