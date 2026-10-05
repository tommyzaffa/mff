/* ============================================================
   Merge Film Festival — edition.js (/2026/, the first-edition recap)
   Motion on scroll: the figures count up, the audience bars fill, and
   posters, cards, faces and lists arrive in a cascade once they are on
   screen. All of it hangs off `.ed-motion` on <html>, which only this
   script adds — without it (no JS, reduced motion) the page is static
   and complete.
   ============================================================ */
(function () {
  "use strict";

  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || !("IntersectionObserver" in window) || !window.requestAnimationFrame) return;

  var root = document.documentElement;
  root.classList.add("ed-motion");

  function each(sel, ctx, fn) { Array.prototype.forEach.call((ctx || document).querySelectorAll(sel), fn); }

  /* Stagger indexes inside a group, read by the CSS as var(--i). */
  function index(boxSel, childSel) {
    each(boxSel, document, function (box) {
      each(childSel, box, function (el, i) { el.style.setProperty("--i", i); });
    });
  }
  index(".ed-stats, .ed-vote-figures", ":scope > li");
  index(".ed-vote", ".ed-vote__row");
  index(".ed-jury__faces, .ed-day__list", ":scope > li");
  index(".page-hero .comp-index", ".comp-index__item");

  /* Count a figure up from zero to whatever it reads now ("≈ 370", "8,7"),
     keeping its prefix and its decimal comma. A translated figure (the
     scores) stops if the language changes mid-count, because app.js has
     just written the new text. */
  function countUp(el, delay, duration) {
    var final = el.textContent;
    var m = final.match(/^(\D*)(\d+(?:[.,]\d+)?)(.*)$/);
    if (!m) return;
    var target = parseFloat(m[2].replace(",", "."));
    var decimals = (m[2].split(/[.,]/)[1] || "").length;
    var comma = m[2].indexOf(",") !== -1;
    var translated = el.hasAttribute("data-i18n");
    var lang = root.getAttribute("lang");
    var start = null;

    function format(v) {
      var s = v.toFixed(decimals);
      return comma ? s.replace(".", ",") : s;
    }

    el.textContent = m[1] + format(0) + m[3];
    function tick(now) {
      if (translated && root.getAttribute("lang") !== lang) return;
      if (start === null) start = now + delay;
      var p = Math.max(0, Math.min(1, (now - start) / duration));
      var eased = 1 - Math.pow(1 - p, 4);
      el.textContent = m[1] + format(target * eased) + m[3];
      if (p < 1) requestAnimationFrame(tick);
      else el.textContent = final;
    }
    requestAnimationFrame(tick);
  }

  /* Groups: the whole block plays at once, its children staggered by --i.
     They wait until the block is well inside the viewport, so the counting
     is actually seen. */
  var groups = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (!en.isIntersecting) return;
      var box = en.target;
      groups.unobserve(box);
      box.classList.add("ed-in");
      var bars = box.classList.contains("ed-vote");
      each(".ed-stat__num, .ed-vote__score", box, function (n, i) {
        if (bars) countUp(n, 250 + i * 110, 1400);   // in step with the bar it ends
        else countUp(n, 150 + i * 110, 1600);
      });
    });
  }, { threshold: 0, rootMargin: "0px 0px -18% 0px" });
  each(".ed-stats, .ed-vote-figures, .ed-vote", document, function (el) { groups.observe(el); });

  /* Items: each one plays as it arrives. Items that arrive in the same
     callback (a row of posters, a pair of cards) are staggered by --d in
     the order they appear, so a row sweeps in from left to right. */
  var items = new IntersectionObserver(function (entries) {
    var batch = 0;
    entries.forEach(function (en) {
      if (!en.isIntersecting) return;
      var el = en.target;
      items.unobserve(el);
      el.style.setProperty("--d", (batch++ * 70) + "ms");
      el.classList.add("ed-in");
    });
  }, { threshold: 0, rootMargin: "0px 0px -8% 0px" });
  each(".film-grid .film-card, .ed-award, .ed-jury, .ed-day, .ed-thanks", document, function (el) { items.observe(el); });
})();
