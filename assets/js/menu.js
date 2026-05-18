// assets/js/menu.js
(() => {
    const scrollerEl = document.querySelector(".snap-root");
    const getScroller = () => scrollerEl || document.scrollingElement || document.documentElement;
    const scriptSrc = document.currentScript && document.currentScript.src;
    const heroPosterSrc = scriptSrc
      ? new URL("../img/hero-poster.jpg", scriptSrc).href
      : "assets/img/hero-poster.jpg";

    // ---- Editorial dropdown menu ----
    // Panel stays inside .nav__dropdown (position: absolute), so we just
    // toggle attributes/classes and let CSS handle the open/close transitions.
    const dd = document.querySelector(".nav__dropdown");
    if (dd) {
      const panel = dd.querySelector(".nav__panel");
      const summary = dd.querySelector("summary");
      let isOpen = false;
      let closeTimer = null;

      const menuOpen = () => {
        if (!panel || isOpen) return;
        isOpen = true;
        if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
        panel.classList.remove("is-closing");
        panel.classList.add("is-open");
        dd.classList.add("is-open");
        dd.setAttribute("open", "");
        if (summary) summary.setAttribute("aria-expanded", "true");
        document.body.classList.add("menu-open");
      };

      const menuClose = () => {
        if (!panel || !isOpen) return;
        isOpen = false;
        // Remove .is-open so the panel transitions back to closed state.
        // Keep [open] on <details> during the animation so the UA stylesheet
        // doesn't hide children instantly; .is-closing handles link stagger
        // and pointer-events. Then strip [open] when the close finishes.
        panel.classList.remove("is-open");
        panel.classList.add("is-closing");
        dd.classList.remove("is-open");
        if (summary) summary.setAttribute("aria-expanded", "false");
        document.body.classList.remove("menu-open");
        closeTimer = setTimeout(() => {
          panel.classList.remove("is-closing");
          dd.removeAttribute("open");
          closeTimer = null;
        }, 620);
      };

      // Intercept summary click before native <details> behaviour
      if (summary) {
        summary.setAttribute("aria-expanded", "false");
        summary.addEventListener("click", (e) => {
          e.preventDefault();
          isOpen ? menuClose() : menuOpen();
        });
      }

      // Close when a nav link inside the overlay is clicked
      document.addEventListener("click", (e) => {
        if (panel && panel.contains(e.target)) {
          const a = e.target.closest("a");
          if (a) menuClose();
        }
      });

      // Escape key
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && isOpen) menuClose();
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

    // ---- Hero video: kick-start when iOS Low Power Mode blocks autoplay ----
    // Apple disables muted-autoplay under Low Power Mode. There's no API to
    // bypass it, but a single user gesture (tap, scroll, key) IS allowed to
    // start playback. Set a poster so the screen isn't empty until then,
    // then on first interaction force-play any paused .bg__video.
    const initHeroVideo = () => {
      const videos = document.querySelectorAll("video.bg__video");
      if (!videos.length) return;

      videos.forEach(v => {
        // Make sure the basics are right — these attrs may be missing on
        // some pages or stripped by other tooling.
        v.muted = true;
        v.playsInline = true;
        v.setAttribute("playsinline", "");
        v.setAttribute("webkit-playsinline", "");
        if (!v.hasAttribute("poster")) v.setAttribute("poster", heroPosterSrc);
      });

      const tryPlayAll = () => {
        videos.forEach(v => {
          if (v.paused) {
            const p = v.play();
            if (p && typeof p.catch === "function") p.catch(() => {});
          }
        });
      };

      // First attempt — works on full-power Safari, no-op on Low Power Mode.
      tryPlayAll();

      // Fallback: any user gesture re-tries playback. Once one succeeds,
      // we don't need to keep listening.
      const events = ["pointerdown", "touchstart", "click", "keydown", "wheel", "scroll"];
      const onGesture = () => {
        tryPlayAll();
        // If at least one is now playing, detach.
        const anyPlaying = Array.from(videos).some(v => !v.paused);
        if (anyPlaying) {
          events.forEach(e => {
            document.removeEventListener(e, onGesture, true);
            window.removeEventListener(e, onGesture, true);
          });
        }
      };
      events.forEach(e => {
        document.addEventListener(e, onGesture, { capture: true, passive: true });
        window.addEventListener(e, onGesture, { capture: true, passive: true });
      });
    };

    if (document.readyState === "complete" || document.readyState === "interactive") {
      initHeroVideo();
    } else {
      document.addEventListener("DOMContentLoaded", initHeroVideo);
    }
  })();
