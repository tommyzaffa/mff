// assets/js/awards-carousel.js
(() => {
    const carousels = document.querySelectorAll("[data-carousel]");
    if (!carousels.length) return;
  
    const px = (v) => (typeof v === "number" ? v : parseFloat(v || "0") || 0);
  
    function getStep(track) {
      const first = track.querySelector(".card");
      if (!first) return 320;
  
      const cardW = first.getBoundingClientRect().width;
  
      const styles = getComputedStyle(track);
      const gap = px(styles.columnGap) || px(styles.gap);
  
      return cardW + gap;
    }
  
    function clamp(n, min, max) {
      return Math.max(min, Math.min(max, n));
    }
  
    function updateButtons(track, prevBtn, nextBtn) {
        const wrap = track.closest("[data-carousel]");
        const maxScroll = track.scrollWidth - track.clientWidth;
      
        const scrollable = maxScroll > 2;
      
        if (wrap) wrap.classList.toggle("carousel--static", !scrollable);
      
        if (!scrollable) {
          prevBtn.disabled = true;
          nextBtn.disabled = true;
          prevBtn.setAttribute("aria-disabled", "true");
          nextBtn.setAttribute("aria-disabled", "true");
          return;
        }
      
        const atStart = track.scrollLeft <= 2;
        const atEnd = track.scrollLeft >= maxScroll - 2;
      
        prevBtn.disabled = atStart;
        nextBtn.disabled = atEnd;
      
        prevBtn.setAttribute("aria-disabled", String(atStart));
        nextBtn.setAttribute("aria-disabled", String(atEnd));
      }
  
    carousels.forEach((wrap) => {
      const track = wrap.querySelector("[data-track]");
      const prevBtn = wrap.querySelector("[data-prev]");
      const nextBtn = wrap.querySelector("[data-next]");
  
      if (!track || !prevBtn || !nextBtn) return;
  
      const step = () => getStep(track);
  
      prevBtn.addEventListener("click", () => {
        const target = track.scrollLeft - step();
        track.scrollTo({ left: clamp(target, 0, track.scrollWidth), behavior: "smooth" });
      });
  
      nextBtn.addEventListener("click", () => {
        const target = track.scrollLeft + step();
        track.scrollTo({ left: clamp(target, 0, track.scrollWidth), behavior: "smooth" });
      });
  
      const onChange = () => updateButtons(track, prevBtn, nextBtn);
      track.addEventListener("scroll", onChange, { passive: true });
      window.addEventListener("resize", onChange);
  
      onChange();
    });
  })();

(() => {
    const scroller = document.querySelector(".snap-root");
    if (!scroller) return;
  
    document.addEventListener("click", (e) => {
      const a = e.target.closest('a[href^="#"]');
      if (!a) return;
  
      const hash = a.getAttribute("href");
      if (!hash || hash === "#") return;
  
      const target = document.querySelector(hash);
      if (!target) return;
  
      e.preventDefault();
  
      scroller.scrollTo({
        top: target.offsetTop,
        behavior: "smooth",
      });
    });
  })();