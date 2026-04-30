// assets/js/menu.js
(() => {
    const dd = document.querySelector(".nav__dropdown");
    if (!dd) return;
  
    const close = () => dd.removeAttribute("open");
    const isMobileLayout = () => window.matchMedia("(max-width: 700px)").matches;
  
    document.addEventListener("click", (e) => {
      if (!dd.contains(e.target)) close();
    });
  
    const scroller = document.querySelector(".snap-root") || window;
    scroller.addEventListener("scroll", close, { passive: true });
    if (scroller !== window) {
      window.addEventListener("scroll", close, { passive: true });
    }

    document.addEventListener("click", (e) => {
      if (!isMobileLayout()) return;

      const a = e.target.closest('a[href^="#"]');
      if (!a) return;

      const hash = a.getAttribute("href");
      if (!hash || hash === "#") return;

      let target;
      try {
        target = document.querySelector(hash);
      } catch (_) {
        return;
      }
      if (!target) return;

      e.preventDefault();
      e.stopImmediatePropagation();

      const header = document.querySelector(".site-header");
      const headerOffset = header ? header.offsetHeight + 12 : 0;
      const top = Math.max(0, target.getBoundingClientRect().top + window.scrollY - headerOffset);

      if (history.pushState) {
        history.pushState(null, "", hash);
      }

      window.scrollTo({
        top,
        behavior: "smooth",
      });
    }, true);
  
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });
  
    dd.addEventListener("click", (e) => {
      const a = e.target.closest("a");
      if (a) close();
    });
  })();
