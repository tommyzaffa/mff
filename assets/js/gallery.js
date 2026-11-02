/* ============================================================
   Merge Film Festival — gallery.js (/gallery/ and the photos on /2026/)
   - Lays every [data-gallery] grid out in columns, placing each photo in
     the shortest column so they still read left to right in the order they
     were taken (CSS columns, the no-JS fallback, read top to bottom).
   - On /gallery/, filters by edition and category; ?year= and ?cat= in the
     address pick the starting view, so other pages can link to a filter.
   - Opens any .gallery-item in a lightbox: arrows, swipe, Esc, download,
     and a #photo-<year>-<nn> address that can be shared.
   Without JS every photo is simply a link to its full-size file.
   ============================================================ */
(function () {
  "use strict";

  var doc = document;
  var root = doc.documentElement;
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function $(s, c) { return (c || doc).querySelector(s); }
  function $all(s, c) { return Array.prototype.slice.call((c || doc).querySelectorAll(s)); }

  /* Strings follow the language app.js has applied to <html lang>. */
  function t(k) {
    var all = window.MFF_I18N || {};
    var lang = (root.getAttribute("lang") || "en").slice(0, 2);
    var here = (all[lang] && all[lang].gallery) || {};
    var en = (all.en && all.en.gallery) || {};
    return here[k] || en[k] || k;
  }

  /* ---------------- columns ---------------- */
  var grids = $all("[data-gallery]").map(function (el) {
    return { el: el, items: $all(".gallery-item", el), cols: 0 };
  });

  function columnCount(g) {
    var n = parseInt(getComputedStyle(g.el).getPropertyValue("--cols"), 10);
    return n > 0 ? n : 3;
  }

  function layout(g, force) {
    var n = columnCount(g);
    if (!force && n === g.cols) return;
    g.cols = n;
    var cols = [], heights = [], i;
    for (i = 0; i < n; i++) {
      var c = doc.createElement("div");
      c.className = "gallery-col";
      cols.push(c);
      heights.push(0);
    }
    /* Heights come from the width/height attributes, so nothing has to be
       loaded or measured; the constant stands in for the gap. */
    var park = doc.createElement("div");
    park.className = "gallery-park";
    park.hidden = true;
    g.items.forEach(function (it) {
      if (it.hidden) { park.appendChild(it); return; }
      var img = it.querySelector("img");
      var ratio = (+img.getAttribute("height") || 1) / (+img.getAttribute("width") || 1);
      var k = heights.indexOf(Math.min.apply(null, heights));
      cols[k].appendChild(it);
      heights[k] += ratio + 0.06;
    });
    $all(".gallery-col, .gallery-park", g.el).forEach(function (old) { old.parentNode.removeChild(old); });
    cols.forEach(function (c) { g.el.appendChild(c); });
    g.el.appendChild(park);
    g.el.classList.add("is-masonry");
  }

  grids.forEach(function (g) { layout(g, true); });
  var resizeQueued = false;
  window.addEventListener("resize", function () {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(function () {
      resizeQueued = false;
      grids.forEach(function (g) { layout(g, false); });
    });
  });

  /* ---------------- photos arrive as they scroll in ---------------- */
  if (!reduce && "IntersectionObserver" in window) {
    root.classList.add("gallery-motion");
    var seen = new IntersectionObserver(function (entries) {
      var batch = 0;
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        seen.unobserve(en.target);
        en.target.style.setProperty("--d", (batch++ * 60) + "ms");
        en.target.classList.add("is-shown");
      });
    }, { rootMargin: "0px 0px -6% 0px" });
    grids.forEach(function (g) { g.items.forEach(function (it) { seen.observe(it); }); });
  }

  /* ---------------- filters (/gallery/ only) ---------------- */
  var filters = $(".gallery-filters");
  if (filters) {
    var editions = $all(".gallery-year");
    var yearPills = $all(".gallery-pill[data-year]", filters);
    var catPills = $all(".gallery-pill[data-cat]", filters);
    var params = new URLSearchParams(location.search);
    var state = { year: params.get("year"), cat: params.get("cat") || "all" };
    var has = function (pills, attr, v) { return pills.some(function (b) { return b.getAttribute(attr) === v; }); };
    if (!has(yearPills, "data-year", state.year)) state.year = yearPills.length ? yearPills[0].getAttribute("data-year") : null;
    if (!has(catPills, "data-cat", state.cat)) state.cat = "all";

    var apply = function (fromUser) {
      yearPills.forEach(function (b) {
        var on = b.getAttribute("data-year") === state.year;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
      catPills.forEach(function (b) {
        var on = b.getAttribute("data-cat") === state.cat;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
      editions.forEach(function (ed) {
        var on = ed.getAttribute("data-year") === state.year;
        ed.hidden = !on;
        var shown = 0;
        $all(".gallery-item", ed).forEach(function (it) {
          var vis = state.cat === "all" || it.getAttribute("data-cat") === state.cat;
          it.hidden = !vis;
          if (vis) shown++;
        });
        var empty = $(".gallery-empty", ed);
        if (empty) empty.hidden = shown > 0;
      });
      /* The counts on the category pills follow the selected edition. */
      catPills.forEach(function (b) {
        var n = $(".gallery-pill__n", b);
        if (!n) return;
        var cat = b.getAttribute("data-cat");
        n.textContent = $all('.gallery-year[data-year="' + state.year + '"] .gallery-item' +
          (cat === "all" ? "" : '[data-cat="' + cat + '"]')).length;
      });
      grids.forEach(function (g) { layout(g, true); });
      if (fromUser) {
        var q = new URLSearchParams(location.search);
        q.set("year", state.year);
        if (state.cat === "all") q.delete("cat"); else q.set("cat", state.cat);
        history.replaceState(null, "", location.pathname + "?" + q.toString());
      }
    };

    filters.addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest(".gallery-pill") : null;
      if (!b) return;
      if (b.hasAttribute("data-year")) state.year = b.getAttribute("data-year");
      if (b.hasAttribute("data-cat")) state.cat = b.getAttribute("data-cat");
      apply(true);
    });
    apply(false);
  }

  /* ---------------- lightbox ---------------- */
  var box, img, text, count, credit, download, list = [], at = 0, lastFocus = null, closeTimer = null;

  function build() {
    box = doc.createElement("div");
    box.className = "lightbox";
    box.hidden = true;
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.innerHTML =
      '<figure class="lightbox__figure">' +
        '<img class="lightbox__img" alt="" />' +
        '<figcaption class="lightbox__caption"><span class="lightbox__text"></span>' +
        '<span class="lightbox__meta"><span class="lightbox__count"></span><span class="lightbox__credit"></span></span></figcaption>' +
      '</figure>' +
      '<a class="lightbox__download" download></a>' +
      '<button class="lightbox__btn lightbox__close" type="button"></button>' +
      '<button class="lightbox__btn lightbox__prev" type="button"></button>' +
      '<button class="lightbox__btn lightbox__next" type="button"></button>';
    doc.body.appendChild(box);
    img = $(".lightbox__img", box);
    text = $(".lightbox__text", box);
    count = $(".lightbox__count", box);
    credit = $(".lightbox__credit", box);
    download = $(".lightbox__download", box);

    $(".lightbox__close", box).addEventListener("click", close);
    $(".lightbox__prev", box).addEventListener("click", function () { show(at - 1); });
    $(".lightbox__next", box).addEventListener("click", function () { show(at + 1); });
    /* A click on the dark backdrop closes; a click on the photo does not. */
    box.addEventListener("click", function (e) {
      if (e.target === box || e.target.classList.contains("lightbox__figure")) close();
    });
    box.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); show(at - 1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); show(at + 1); }
      else if (e.key === "Tab") {
        /* Keep the focus inside the dialog. */
        var f = $all("a[href], button", box);
        var i = f.indexOf(doc.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    });
    var x0 = null, y0 = null;
    box.addEventListener("touchstart", function (e) {
      if (e.touches.length !== 1) { x0 = null; return; }
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
    }, { passive: true });
    box.addEventListener("touchend", function (e) {
      if (x0 === null) return;
      var dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
      x0 = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) show(at + (dx < 0 ? 1 : -1));
    });
  }

  function labels() {
    box.setAttribute("aria-label", t("lbLabel"));
    $(".lightbox__close", box).setAttribute("aria-label", t("lbClose"));
    $(".lightbox__prev", box).setAttribute("aria-label", t("lbPrev"));
    $(".lightbox__next", box).setAttribute("aria-label", t("lbNext"));
    download.textContent = t("lbDownload");
    credit.textContent = t("credit");
    var one = list.length < 2;
    $(".lightbox__prev", box).hidden = one;
    $(".lightbox__next", box).hidden = one;
  }

  function show(i) {
    at = (i + list.length) % list.length;
    var a = list[at];
    var thumb = a.querySelector("img");
    /* The thumbnail is already loaded: show it at once, swap in the full
       file when it arrives. */
    img.src = thumb.currentSrc || thumb.src;
    img.alt = thumb.alt;
    var full = new Image();
    full.onload = function () { if (list[at] === a) img.src = a.href; };
    full.src = a.href;
    [1, -1].forEach(function (d) { (new Image()).src = list[(at + d + list.length) % list.length].href; });
    text.textContent = thumb.alt;
    count.textContent = (at + 1) + " / " + list.length;
    download.href = a.href;
    if (a.id) history.replaceState(null, "", location.pathname + location.search + "#" + a.id);
  }

  function open(a) {
    if (!box) build();
    var g = grids.filter(function (x) { return x.el.contains(a); })[0];
    list = (g ? g.items : [a]).filter(function (x) { return !x.hidden; });
    lastFocus = doc.activeElement;
    labels();
    clearTimeout(closeTimer);
    box.hidden = false;
    root.classList.add("is-lightbox-open");
    requestAnimationFrame(function () { box.classList.add("is-open"); });
    show(list.indexOf(a));
    $(".lightbox__close", box).focus();
  }

  function close() {
    box.classList.remove("is-open");
    root.classList.remove("is-lightbox-open");
    closeTimer = setTimeout(function () { box.hidden = true; img.removeAttribute("src"); }, reduce ? 0 : 260);
    if (location.hash.indexOf("#photo-") === 0) history.replaceState(null, "", location.pathname + location.search);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  grids.forEach(function (g) {
    /* On the grid, so it runs before app.js's page-fade listener on the
       document, which leaves a prevented click alone. */
    g.el.addEventListener("click", function (e) {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target.closest ? e.target.closest(".gallery-item") : null;
      if (!a) return;
      e.preventDefault();
      open(a);
    });
  });

  /* A shared #photo-2026-07 address opens that photo — once app.js has
     translated the captions (it may first have to fetch the language). */
  function openFromHash() {
    var id = location.hash && location.hash.indexOf("#photo-") === 0 ? location.hash.slice(1) : "";
    var target = id ? doc.getElementById(id) : null;
    if (target && target.classList.contains("gallery-item") && !target.hidden) open(target);
  }
  if (window.MFF_READY) openFromHash();
  else window.addEventListener("mff:ready", openFromHash, { once: true });
})();
