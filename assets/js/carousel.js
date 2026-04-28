window.addEventListener("load", () => {
    const root = document.querySelector(".snap-root");
    if (!root) return;
    root.scrollTo({ top: 0, left: 0, behavior: "auto" });
  });

history.scrollRestoration = "manual";

window.addEventListener("load", () => {
  // Se l'URL è rimasto su #news, torna a "home" e parti dall'hero
  if (location.hash === "#news") {
    history.replaceState(null, "", location.pathname + location.search);
  }
  window.scrollTo(0, 0);
});

(() => {
  function initInfiniteCarousel({
    trackSelector,
    cardSelector,
    prevBtnSelector,
    nextBtnSelector,
    loops = 10,
  }) {
    const track = document.querySelector(trackSelector);
    if (!track) return;

    const originals = Array.from(track.querySelectorAll(cardSelector));
    const cardCount = originals.length;
    if (cardCount === 0) return;

    const LOOPS = loops;

    // Build: [LOOPS clones] + [original nodes] + [LOOPS clones]
    const frag = document.createDocumentFragment();
    for (let i = 0; i < LOOPS; i++) originals.forEach((el) => frag.appendChild(el.cloneNode(true)));
    originals.forEach((el) => frag.appendChild(el)); // move originals
    for (let i = 0; i < LOOPS; i++) originals.forEach((el) => frag.appendChild(el.cloneNode(true)));

    track.innerHTML = "";
    track.appendChild(frag);

    let cards = Array.from(track.querySelectorAll(cardSelector));
    const originalStart = cardCount * LOOPS;

    const getTrackCenterX = () => {
      const r = track.getBoundingClientRect();
      return r.left + r.width / 2;
    };

    const getNearestIndexToCenter = () => {
      const trackCenter = getTrackCenterX();
      let bestI = 0;
      let bestD = Infinity;

      for (let i = 0; i < cards.length; i++) {
        const r = cards[i].getBoundingClientRect();
        const cCenter = r.left + r.width / 2;
        const d = Math.abs(cCenter - trackCenter);
        if (d < bestD) {
          bestD = d;
          bestI = i;
        }
      }
      return bestI;
    };

    const setActiveClasses = () => {
      const i = getNearestIndexToCenter();
      for (let k = 0; k < cards.length; k++) {
        cards[k].classList.toggle("is-active", k === i);
      }
    };

    const setFocus = () => {
      const trackRect = track.getBoundingClientRect();
      const trackCenter = trackRect.left + trackRect.width / 2;

      const maxDist = trackRect.width * 0.55;

      for (const c of cards) {
        const r = c.getBoundingClientRect();
        const cCenter = r.left + r.width / 2;
        const dist = Math.abs(cCenter - trackCenter);

        let focus = 1 - dist / maxDist;
        if (focus < 0) focus = 0;
        if (focus > 1) focus = 1;

        c.style.setProperty("--focus", focus.toFixed(4));
      }
    };

    const CENTER_NUDGE_PX = 0;

const centerCard = (el, behavior = "auto") => {
  if (!el) return;

  const trackRect = track.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();

  const trackCenter = trackRect.left + trackRect.width / 2;
  const elCenter = elRect.left + elRect.width / 2;

  const delta = (elCenter - trackCenter) + CENTER_NUDGE_PX;
  track.scrollTo({ left: track.scrollLeft + delta, behavior });
};

    const getSegment = () => {
      const startEl = cards[originalStart];
      const nextStartEl = cards[originalStart + cardCount];
      if (!startEl || !nextStartEl) return null;
      const segmentStart = startEl.offsetLeft;
      const segmentWidth = nextStartEl.offsetLeft - segmentStart;
      return { segmentStart, segmentWidth };
    };

    const normalizeScroll = () => {
      const seg = getSegment();
      if (!seg) return;

      const { segmentStart, segmentWidth } = seg;

      const safeDelta = segmentWidth * Math.max(1, LOOPS - 1);
      const leftLimit = segmentStart - safeDelta;
      const rightLimit = segmentStart + safeDelta;

      const teleport = (delta) => {
        track.style.scrollSnapType = "none";
        track.style.scrollBehavior = "auto";
        track.scrollLeft += delta;

        requestAnimationFrame(() => {
          track.style.scrollSnapType = "";
          track.style.scrollBehavior = "";
          // dopo teleport: riallinea subito
          setActiveClasses();
          setFocus();
        });
      };

      if (track.scrollLeft < leftLimit) teleport(safeDelta);
      else if (track.scrollLeft > rightLimit) teleport(-safeDelta);
    };

    const getActiveIndex = () => cards.findIndex((c) => c.classList.contains("is-active"));

    const root = track.closest(".carousel") || document;

    root.querySelector(prevBtnSelector)?.addEventListener("click", () => {
      const i = getActiveIndex();
      const idx = i >= 0 ? i : getNearestIndexToCenter();
      if (idx > 0) centerCard(cards[idx - 1], "smooth");
    });

    root.querySelector(nextBtnSelector)?.addEventListener("click", () => {
      const i = getActiveIndex();
      const idx = i >= 0 ? i : getNearestIndexToCenter();
      if (idx >= 0 && idx < cards.length - 1) centerCard(cards[idx + 1], "smooth");
    });

    // Init
    requestAnimationFrame(() => {
      centerCard(cards[originalStart], "auto");
      normalizeScroll();
      setActiveClasses();
      setFocus();
    });

    // Scroll: aggiorna DURANTE lo scroll + normalizza quando ti fermi
    let rafId = 0;
    let endTimer = null;

    track.addEventListener(
      "scroll",
      () => {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          setActiveClasses();
          setFocus(); // <-- update live mentre scrolli
        });

        clearTimeout(endTimer);
        endTimer = setTimeout(() => {
          normalizeScroll();
          setActiveClasses();
          setFocus();
        }, 90);
      },
      { passive: true }
    );

    window.addEventListener("resize", () => {
      requestAnimationFrame(() => {
        normalizeScroll();
        setActiveClasses();
        setFocus();
      });
    });

    window.addEventListener("load", () => {
        const bgVid = document.querySelector(".bg__media");
        if (!bgVid) return;
      
        bgVid.play().catch(() => {});
      });
  }

  // FILMS
  initInfiniteCarousel({
    trackSelector: ".film-track",
    cardSelector: ".card",
    prevBtnSelector: ".carousel__btn--prev",
    nextBtnSelector: ".carousel__btn--next",
    loops: 10,
  });

  // NEWS
  initInfiniteCarousel({
    trackSelector: ".news-track",
    cardSelector: ".news-card",
    prevBtnSelector: ".news-prev",
    nextBtnSelector: ".news-next",
    loops: 10,
  });
})();

(() => {
    function getSnapType(el) {
      return el.style.scrollSnapType || getComputedStyle(el).scrollSnapType;
    }
  
    window.addEventListener("load", () => {
      const root = document.querySelector(".snap-root");
      if (!root) return;
  
      document.querySelectorAll('a[href="#top"]').forEach((a) => {
        a.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();

          if (location.hash) {
            history.replaceState(null, "", location.pathname + location.search);
          }
  
          const prevSnap = getSnapType(root);
          root.style.scrollSnapType = "none";

          root.scrollTo({ top: 0, left: 0, behavior: "smooth" });

          window.setTimeout(() => {
            root.style.scrollSnapType = prevSnap;
            root.scrollTo({ top: 0, left: 0, behavior: "auto" });
          }, 700);
        });
      });
    });
  })();