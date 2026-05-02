// assets/js/menu.js
(() => {
    const scrollerEl = document.querySelector(".snap-root");
    const getScroller = () => scrollerEl || document.scrollingElement || document.documentElement;

    // ---- Dropdown menu ----
    const dd = document.querySelector(".nav__dropdown");
    if (dd) {
      const close = () => dd.removeAttribute("open");

      document.addEventListener("click", (e) => {
        if (!dd.contains(e.target)) close();
      });

      const scrollSrc = scrollerEl || window;
      scrollSrc.addEventListener("scroll", close, { passive: true });
      if (scrollSrc !== window) {
        window.addEventListener("scroll", close, { passive: true });
      }

      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") close();
      });

      dd.addEventListener("click", (e) => {
        const a = e.target.closest("a");
        if (a) close();
      });
    }

    // ---- Anchor link handler ----
    // .snap-root is the scroll container, so native #fragment scrolling
    // and window.scrollTo don't work. Scroll the right element instead.
    document.addEventListener("click", (e) => {
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

      const scroller = getScroller();
      const header = document.querySelector(".site-header");
      const headerOffset = header ? header.offsetHeight + 12 : 0;
      const scrollerTop = scroller === window ? window.scrollY : scroller.scrollTop;
      const top = Math.max(0, target.getBoundingClientRect().top + scrollerTop - headerOffset);

      if (history.pushState) {
        history.pushState(null, "", hash);
      }

      scroller.scrollTo({ top, behavior: "smooth" });
    }, true);

    // ---- Tall-section detector (mobile only) ----
    // On mobile, sections that overflow the viewport lose their
    // scroll-snap-align so internal scrolling feels fluid instead of
    // micro-snapping. The .is-tall class is consumed by mobile.css.
    const isMobile = () => window.matchMedia("(max-width: 700px)").matches;

    const updateTallSections = () => {
      if (!scrollerEl) return;
      const vpH = scrollerEl.clientHeight;
      const sections = scrollerEl.querySelectorAll(
        "main > .section, main > section, footer.site-footer"
      );
      const tolerance = 8;
      sections.forEach((sec) => {
        const tall = isMobile() && sec.scrollHeight > vpH + tolerance;
        sec.classList.toggle("is-tall", tall);
      });
    };

    if (document.readyState === "complete") {
      updateTallSections();
    } else {
      window.addEventListener("load", updateTallSections);
    }
    window.addEventListener("resize", updateTallSections);
    window.addEventListener("orientationchange", updateTallSections);
  })();
