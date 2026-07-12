import { useEffect } from "react";

// Landing-page motion chrome — gold scroll-progress bar + magnetic cursor —
// ported into the app so both surfaces feel like one product (Troy, launch
// eve: "make everything match"). Same rules as the landing page: nothing
// under prefers-reduced-motion; the cursor only for fine pointers. Text
// inputs keep the native caret cursor (see index.css) — hiding the I-beam
// while typing is landing-page flair, not app UX.
const SNAP_TARGETS =
  'a,button,[role="button"],input,select,textarea,label,summary,[data-cursor-snap]';

export default function PolishFX() {
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const fine = window.matchMedia("(pointer: fine)").matches;
    if (reduce) return;

    // ---- Scroll progress bar ----
    const bar = document.createElement("div");
    bar.className = "fx-scrollbar";
    document.body.appendChild(bar);
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const h = document.documentElement.scrollHeight - window.innerHeight;
        bar.style.transform = `scaleX(${h > 0 ? (window.scrollY / h).toFixed(4) : 0})`;
        ticking = false;
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    // Content height changes without scroll events in an SPA (screen swaps,
    // async lists) — keep the bar honest.
    const ro = new ResizeObserver(onScroll);
    ro.observe(document.documentElement);
    onScroll();

    // ---- Magnetic cursor (fine pointers only) ----
    let dot: HTMLDivElement | null = null;
    let ring: HTMLDivElement | null = null;
    let raf = 0;
    let onMove: ((e: PointerEvent) => void) | null = null;
    let onOver: ((e: Event) => void) | null = null;
    let onOut: ((e: Event) => void) | null = null;

    if (fine) {
      dot = document.createElement("div");
      dot.className = "cursor-dot";
      ring = document.createElement("div");
      ring.className = "cursor-ring";
      document.body.appendChild(dot);
      document.body.appendChild(ring);
      document.body.classList.add("has-cursor");

      let mx = window.innerWidth / 2;
      let my = window.innerHeight / 2;
      let rx = mx;
      let ry = my;
      let shown = false;

      onMove = (e: PointerEvent) => {
        mx = e.clientX;
        my = e.clientY;
        if (!shown && dot && ring) {
          shown = true;
          dot.style.opacity = "1";
          ring.style.opacity = "1";
        }
        if (dot) dot.style.transform = `translate3d(${mx}px,${my}px,0)`;
      };
      window.addEventListener("pointermove", onMove, { passive: true });

      const loop = () => {
        rx += (mx - rx) * 0.18;
        ry += (my - ry) * 0.18;
        if (ring) ring.style.transform = `translate3d(${rx.toFixed(1)}px,${ry.toFixed(1)}px,0)`;
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);

      // Event delegation instead of the landing page's static
      // querySelectorAll — app screens mount and unmount constantly.
      onOver = (e: Event) => {
        const t = e.target as Element | null;
        if (t?.closest?.(SNAP_TARGETS)) ring?.classList.add("snap");
      };
      onOut = (e: Event) => {
        const t = e.target as Element | null;
        if (t?.closest?.(SNAP_TARGETS)) ring?.classList.remove("snap");
      };
      document.addEventListener("pointerover", onOver);
      document.addEventListener("pointerout", onOut);
    }

    return () => {
      window.removeEventListener("scroll", onScroll);
      ro.disconnect();
      bar.remove();
      if (onMove) window.removeEventListener("pointermove", onMove);
      if (onOver) document.removeEventListener("pointerover", onOver);
      if (onOut) document.removeEventListener("pointerout", onOut);
      if (raf) cancelAnimationFrame(raf);
      dot?.remove();
      ring?.remove();
      document.body.classList.remove("has-cursor");
    };
  }, []);

  return null;
}
