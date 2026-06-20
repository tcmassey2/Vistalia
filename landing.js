// Vistalia landing page — minimal vanilla JS for interactions.
// Three behaviors:
//   1. Sticky nav adds .scrolled when the page has moved past the hero
//   2. FAQ items toggle open/closed
//   3. Elements with .reveal animate in once they enter the viewport

(function () {
  "use strict";

  /* -------------------- Sticky nav scrolled state -------------------- */
  const nav = document.getElementById("nav");
  if (nav) {
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        nav.classList.toggle("scrolled", window.scrollY > 24);
        ticking = false;
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  /* -------------------- FAQ accordion -------------------- */
  document.querySelectorAll("[data-faq-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = btn.closest(".faq-item");
      if (!item) return;
      const isOpen = item.getAttribute("data-open") === "true";
      // Close other items in same FAQ for cleaner accordion behavior
      const siblings = item.parentElement?.querySelectorAll(".faq-item") || [];
      siblings.forEach((s) => s.setAttribute("data-open", "false"));
      siblings.forEach((s) => s.querySelector("[data-faq-toggle]")?.setAttribute("aria-expanded", "false"));
      if (!isOpen) {
        item.setAttribute("data-open", "true");
        btn.setAttribute("aria-expanded", "true");
      }
    });
  });

  /* -------------------- Scroll-reveal -------------------- */
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("in-view");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
    );
    document.querySelectorAll(".reveal").forEach((el) => observer.observe(el));
  } else {
    // Fallback: just show everything
    document.querySelectorAll(".reveal").forEach((el) => el.classList.add("in-view"));
  }

  /* -------------------- Honor prefers-reduced-motion for the autoplay reels -------------------- */
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    document.querySelectorAll(".reel-scene, .slideshow-scene, .estate-scene").forEach((el) => {
      el.style.animation = "none";
      el.style.opacity = "1";
    });
  }
})();
