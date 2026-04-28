// assets/js/menu.js
(() => {
    const dd = document.querySelector(".nav__dropdown");
    if (!dd) return;
  
    const close = () => dd.removeAttribute("open");
  
    document.addEventListener("click", (e) => {
      if (!dd.contains(e.target)) close();
    });
  
    const scroller = document.querySelector(".snap-root") || window;
    scroller.addEventListener("scroll", close, { passive: true });
  
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });
  
    dd.addEventListener("click", (e) => {
      const a = e.target.closest("a");
      if (a) close();
    });
  })();