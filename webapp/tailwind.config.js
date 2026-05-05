/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // EstateMotion workspace palette — workspace-scale dark, slightly warmer
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
        mono: ["JetBrains Mono", "ui-monospace", "monospace"]
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
