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

    // ---- Initial scroll position ----
    // .snap-root is the scroll container, so neither browser fragment-jump
    // nor session restore touch it correctly. Place it at the top, or on the
    // hash target if one is present in the URL.
    const placeInitialScroll = () => {
      if (!scrollerEl) return;
      const hash = window.location.hash;
      if (hash && hash.length > 1) {
        let target = null;
        try { target = document.querySelector(hash); } catch (_) {}
        if (target) {
          const header = document.querySelector(".site-header");
          const headerOffset = header ? header.offsetHeight + 12 : 0;
          const top = Math.max(
            0,
            target.getBoundingClientRect().top + scrollerEl.scrollTop - headerOffset
          );
          scrollerEl.scrollTo({ top, behavior: "auto" });
          return;
        }
      }
      scrollerEl.scrollTo({ top: 0, behavior: "auto" });
    };

    if (document.readyState === "complete" || document.readyState === "interactive") {
      placeInitialScroll();
    } else {
      document.addEventListener("DOMContentLoaded", placeInitialScroll);
    }
    window.addEventListener("load", placeInitialScroll);

    // ---- Tall-section detector ----
    // Su mobile, le sezioni piu' alte del viewport ricevono la classe .is-tall:
    // mobile.css le trasforma in scroll container annidati cosi' lo scroll
    // interno e' fluido (niente snap-back-to-top a fine sezione).
    const isMobile = () => window.matchMedia("(max-width: 700px)").matches;
    const updateTallSections = () => {
      if (!scrollerEl) return;
      const sections = scrollerEl.querySelectorAll(
        "main > .section, main > section, footer.site-footer"
      );
      if (!isMobile()) {
        sections.forEach((s) => s.classList.remove("is-tall"));
        return;
      }
      const vpH = scrollerEl.clientHeight;
      const tolerance = 8;
      sections.forEach((sec) => {
        // Misura ignorando una eventuale classe .is-tall gia' applicata:
        // la togliamo, leggiamo l'altezza naturale, poi la riapplichiamo se serve.
        sec.classList.remove("is-tall");
        const naturalH = sec.scrollHeight;
        if (naturalH > vpH + tolerance) sec.classList.add("is-tall");
      });
    };
    window.addEventListener("load", updateTallSections);
    window.addEventListener("resize", updateTallSections);
    window.addEventListener("orientationchange", updateTallSections);
  })();
