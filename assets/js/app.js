/* ============================================================
   Merge Film Festival 2.0 — app.js
   - i18n runtime (translations.js)
   - scroll-driven background colour crossfade (cream <-> violet)
   - artistic full-screen menu
   - news carousel, hero video controller, scroll reveals
   ============================================================ */
(function () {
  "use strict";

  var SUPPORTED = ["en", "it", "fr", "de"];
  var STORE_KEY = "mff_lang";
  var LANG_CONTROL_SELECTOR = "a[data-lang], button[data-lang]";
  var I18N = window.MFF_I18N || {};

  /* ---------------- helpers ---------------- */
  function $(s, c) { return (c || document).querySelector(s); }
  function $all(s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); }

  function lookup(lang, path) {
    var node = I18N[lang];
    var parts = path.split(".");
    for (var i = 0; i < parts.length && node != null; i++) node = node[parts[i]];
    return (node == null && lang !== "en") ? lookup("en", path) : node;
  }

  /* ---------------- i18n ---------------- */
  function applyTranslations(lang) {
    if (SUPPORTED.indexOf(lang) === -1) lang = "en";
    var dict = I18N[lang];
    if (!dict) return;

    document.documentElement.setAttribute("lang", (dict.meta && dict.meta.htmlLang) || lang);

    $all("[data-i18n]").forEach(function (el) {
      var v = lookup(lang, el.getAttribute("data-i18n"));
      if (v != null) el.textContent = v;
    });
    $all("[data-i18n-html]").forEach(function (el) {
      var v = lookup(lang, el.getAttribute("data-i18n-html"));
      if (v != null) el.innerHTML = v;
    });
    $all("[data-i18n-attr]").forEach(function (el) {
      el.getAttribute("data-i18n-attr").split(";").forEach(function (pair) {
        var kv = pair.split(":");
        if (kv.length < 2) return;
        var attr = kv[0].trim();
        var v = lookup(lang, kv.slice(1).join(":").trim());
        if (v != null) el.setAttribute(attr, v);
      });
    });

    /* active states on every language control */
    $all(LANG_CONTROL_SELECTOR).forEach(function (a) {
      var on = a.getAttribute("data-lang") === lang;
      a.classList.toggle("nav__lang-option--active", on && a.classList.contains("nav__lang-option"));
      a.classList.toggle("is-active", on);
    });

    try { localStorage.setItem(STORE_KEY, lang); } catch (e) {}
    document.documentElement.dataset.lang = lang;
    if (typeof window.onLangApplied === "function") window.onLangApplied(lang);
  }

  function resolveInitialLang() {
    var stored;
    try { stored = localStorage.getItem(STORE_KEY); } catch (e) {}
    if (stored && SUPPORTED.indexOf(stored) !== -1) return stored;
    var nav = (navigator.language || "en").slice(0, 2).toLowerCase();
    return SUPPORTED.indexOf(nav) !== -1 ? nav : "en";
  }

  window.setLang = applyTranslations;

  /* ---------------- background crossfade engine ---------------- */
  function colorFor(kind) {
    switch (kind) {
      case "violet": return { r: 75, g: 46, b: 131, a: 1, mesh: 1 };
      case "cream":  return { r: 243, g: 242, b: 239, a: 1, mesh: 0 };
      case "hero":   return { r: 75, g: 46, b: 131, a: 0, mesh: 0 };
      case "photo":  return { r: 243, g: 242, b: 239, a: 0, mesh: 0 };
      default:       return { r: 243, g: 242, b: 239, a: 1, mesh: 0 };
    }
  }
  function lerp(a, b, t) { return a + (b - a) * t; }

  /* ---------------- mobile inner-page colour inversion ----------------
     On phones the inner (non-home) pages drop the fixed "head" photo. With no
     white photo header, each inner page instead STARTS on pure violet and the
     section colours simply alternate (violet -> cream -> violet ...). We do
     this by inverting, on mobile only, BOTH:
       • the section background driver  data-bg  (photo/cream -> violet, violet -> cream)
       • the ink/theme class            is-on-cream <-> is-on-violet
     Inverting both together keeps each section's background (painted by the
     crossfade canvas) and its component theming (cards, forms, text — all keyed
     off is-on-*) in sync, whatever a page happens to contain. The footer is left
     untouched, so it stays violet. The photo + cream wash are removed in CSS. */
  function initMobileInnerColors() {
    if (document.body.classList.contains("home-page")) return;
    var sections = $all("main > .section[data-bg]");
    if (!sections.length) return;

    var mq = window.matchMedia("(max-width: 700px)");
    var BG_FLIP = { photo: "violet", cream: "violet", violet: "cream" };

    sections.forEach(function (el) {
      /* Capture the desktop originals once so the swap is reversible. */
      el.dataset.bgDesktop = el.getAttribute("data-bg") || "";
      el.dataset.inkDesktop = el.classList.contains("is-on-violet") ? "violet"
                            : el.classList.contains("is-on-cream") ? "cream" : "";
    });

    function setInk(el, mode) {
      el.classList.toggle("is-on-violet", mode === "violet");
      el.classList.toggle("is-on-cream", mode === "cream");
    }

    function apply(mobile) {
      sections.forEach(function (el) {
        var baseBg = el.dataset.bgDesktop;
        var baseInk = el.dataset.inkDesktop;
        if (mobile) {
          if (BG_FLIP[baseBg]) el.setAttribute("data-bg", BG_FLIP[baseBg]);
          if (baseInk) setInk(el, baseInk === "violet" ? "cream" : "violet");
        } else {
          if (baseBg) el.setAttribute("data-bg", baseBg);
          if (baseInk) setInk(el, baseInk);
        }
      });
      /* Nudge the crossfade canvas + header to recompute from the new values.
         (No-op on first run — the engine/header initialise afterwards and read
         the already-swapped state directly.) */
      window.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("scroll"));
    }

    apply(mq.matches);
    if (mq.addEventListener) mq.addEventListener("change", function (e) { apply(e.matches); });
    else if (mq.addListener) mq.addListener(function (e) { apply(e.matches); });
  }

  function initBackgroundEngine() {
    var canvas = $("#bgCanvas");
    var mesh = $("#bgMesh");
    if (!canvas) return;
    var themeMeta = document.querySelector('meta[name="theme-color"]');
    var defaultThemeColor = themeMeta ? themeMeta.getAttribute("content") : "#4B2E83";
    var mobileThemeMq = window.matchMedia("(max-width: 700px)");
    var lastThemeColor = "";

    var stops = $all("[data-bg]").map(function (el) {
      var kind = el.getAttribute("data-bg");
      return { el: el, kind: kind, c: colorFor(kind) };
    });
    if (!stops.length) return;

    function centerOf(el) {
      var r = el.getBoundingClientRect();
      return r.top + window.scrollY + r.height / 2;
    }
    function topOf(el) {
      var r = el.getBoundingClientRect();
      return r.top + window.scrollY;
    }

    var CREAM_SOLID = { r: 243, g: 242, b: 239, a: 1, mesh: 0 };

    function toHexChannel(n) {
      var hex = Math.max(0, Math.min(255, Math.round(n))).toString(16);
      return hex.length === 1 ? "0" + hex : hex;
    }

    function toHex(c) {
      return "#" + toHexChannel(c.r) + toHexChannel(c.g) + toHexChannel(c.b);
    }

    function updateMobileChrome(col) {
      if (!themeMeta) return;
      var theme = (document.body.classList.contains("home-page") && col.a < 0.98)
        ? "#4B2E83"
        : toHex(col);

      document.documentElement.style.setProperty("--safari-ui-bg", theme);
      document.body.style.setProperty("--safari-ui-bg", theme);

      if (!mobileThemeMq.matches) {
        theme = defaultThemeColor;
      }
      if (theme !== lastThemeColor) {
        themeMeta.setAttribute("content", theme);
        lastThemeColor = theme;
      }
    }

    function buildPoints() {
      var pts = [];
      var vh = window.innerHeight;
      stops.forEach(function (stop, index) {
        /* Read data-bg live so the mobile colour inversion
           (initMobileInnerColors) is reflected without re-initialising. */
        var kind = stop.el.getAttribute("data-bg");
        var c = colorFor(kind);
        var rect = stop.el.getBoundingClientRect();
        var top = rect.top + window.scrollY;
        var prevKind = index > 0 ? stops[index - 1].el.getAttribute("data-bg") : null;

        if (index === 0) {
          /* First section holds its own colour from the very top. */
          pts.push({ y: top, c: c });
        } else if (prevKind === "photo") {
          /* Leaving a photo hero: fade the still photo into an opaque cream
             "page" first, THEN tint toward this section's own colour — so the
             hero never snaps straight to violet. */
          pts.push({ y: top, c: CREAM_SOLID });
          pts.push({ y: top + vh * 0.42, c: c });
        } else if (prevKind === "hero") {
          /* Leaving the video hero — SAME on every device (desktop, tablet,
             phone). The render sample line is scrollY + vh/2, so to keep the
             video perfectly CLEAN at the top (no violet wash) we hold the hero's
             transparent colour until (top - vh*0.5) — exactly where the sample
             line sits at scrollY 0 — and only then fade to this section's colour
             over the last stretch before it. */
          pts.push({ y: top - vh * 0.5, c: colorFor("hero") }); /* hold video clean */
          pts.push({ y: top - vh * 0.05, c: c });               /* fade to violet   */
        } else {
          /* Generic boundary between two content sections. The colour change is
             confined to a short band centred on the boundary, so each section
             holds its OWN pure colour across its whole body instead of sitting
             in a permanent half-blend (which read as faint seams). This stays
             clean as the site grows: the plateaus just get longer, the
             transitions stay put at the seams. */
          var prevRect = stops[index - 1].el.getBoundingClientRect();
          var band = Math.min(vh * 0.42, rect.height * 0.45, prevRect.height * 0.45);
          var prevColor = colorFor(prevKind);
          pts.push({ y: top - band, c: prevColor }); /* end of previous plateau */
          pts.push({ y: top + band, c: c });          /* start of this plateau  */
        }
      });
      return pts;
    }

    function render() {
      var line = window.scrollY + window.innerHeight / 2;
      var pts = buildPoints();

      var col;
      if (line <= pts[0].y) col = pts[0].c;
      else if (line >= pts[pts.length - 1].y) col = pts[pts.length - 1].c;
      else {
        for (var i = 0; i < pts.length - 1; i++) {
          if (line >= pts[i].y && line <= pts[i + 1].y) {
            var span = pts[i + 1].y - pts[i].y || 1;
            var t = (line - pts[i].y) / span;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            /* smoothstep: zero slope at both ends, so the joins where a plateau
               meets a transition band are imperceptible (no faint crease). */
            t = t * t * (3 - 2 * t);
            var A = pts[i].c, B = pts[i + 1].c;
            col = {
              r: lerp(A.r, B.r, t), g: lerp(A.g, B.g, t), b: lerp(A.b, B.b, t),
              a: lerp(A.a, B.a, t), mesh: lerp(A.mesh, B.mesh, t)
            };
            break;
          }
        }
      }
      if (!col) col = pts[0].c;
      canvas.style.backgroundColor = "rgba(" + Math.round(col.r) + "," + Math.round(col.g) + "," + Math.round(col.b) + "," + col.a.toFixed(3) + ")";
      if (mesh) mesh.style.opacity = (col.mesh * 0.5 * col.a).toFixed(3);
      updateMobileChrome(col);
    }

    var ticking = false;
    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () { render(); ticking = false; });
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", render);
    if (mobileThemeMq.addEventListener) mobileThemeMq.addEventListener("change", render);
    else if (mobileThemeMq.addListener) mobileThemeMq.addListener(render);
    render();
  }

  /* ---------------- header ink + scrolled state ---------------- */
  function initHeader() {
    var header = $(".site-header");
    if (!header) return;
    var stops = $all("[data-bg]");

    function update() {
      var isScrolled = window.scrollY > 12;
      header.classList.toggle("is-scrolled", isScrolled);
      var probe = window.scrollY + 44;
      var theme = isScrolled ? "cream" : "violet";
      for (var i = 0; i < stops.length; i++) {
        var r = stops[i].getBoundingClientRect();
        var top = r.top + window.scrollY, bot = top + r.height;
        if (probe >= top && probe < bot) {
          var kind = stops[i].getAttribute("data-bg");
          if (!isScrolled) theme = (kind === "cream" || kind === "photo") ? "cream" : "violet";
          break;
        }
      }
      header.setAttribute("data-header-theme", theme);
    }
    var ticking = false;
    window.addEventListener("scroll", function () {
      if (ticking) return; ticking = true;
      requestAnimationFrame(function () { update(); ticking = false; });
    }, { passive: true });
    window.addEventListener("resize", update);
    update();
  }

  /* ---------------- artistic menu ----------------
     Robust JS-driven toggle (no native <details>, which is buggy in
     Safari when the <summary> carries display:flex — it could leave the
     full-screen panel "open" but invisible, swallowing every click). */
  function initMenu() {
    var dd = $(".nav__dropdown");
    if (!dd) return;
    var toggle = $(".nav__toggle", dd);
    var panel = $(".nav__panel", dd);
    var closeBtn = $(".nav__panel-close", dd);
    var savedScrollY = 0;
    var closeTimer = null;
    var CLOSE_MS = 880; /* must cover the reverse cascade + backdrop fade in style.css */
    if (panel && panel.parentNode !== document.body) {
      document.body.appendChild(panel);
    }
    if (panel) panel.setAttribute("aria-hidden", "true");

    function lockPage() {
      savedScrollY = window.scrollY || window.pageYOffset || 0;
      document.documentElement.classList.add("is-menu-open");
      document.body.classList.add("is-menu-open");
    }

    function unlockPage() {
      var root = document.documentElement;
      var previousScrollBehavior = root.style.scrollBehavior;
      root.classList.remove("is-menu-open");
      document.body.classList.remove("is-menu-open");
      root.style.scrollBehavior = "auto";
      window.scrollTo(0, savedScrollY);
      requestAnimationFrame(function () {
        root.style.scrollBehavior = previousScrollBehavior;
      });
    }

    function open() {
      if (dd.classList.contains("is-open")) return;
      window.clearTimeout(closeTimer);
      dd.classList.add("is-open");
      if (panel) {
        panel.classList.remove("is-closing");
        panel.classList.add("is-open");
        panel.setAttribute("aria-hidden", "false");
      }
      if (toggle) toggle.setAttribute("aria-expanded", "true");
      lockPage();
    }
    function close() {
      if (!dd.classList.contains("is-open")) return;
      dd.classList.remove("is-open");
      if (panel) {
        panel.classList.remove("is-open");
        /* keep the panel on screen and play the cascade in reverse */
        panel.classList.add("is-closing");
        panel.setAttribute("aria-hidden", "true");
      }
      if (toggle) toggle.setAttribute("aria-expanded", "false");
      window.clearTimeout(closeTimer);
      closeTimer = window.setTimeout(function () {
        if (panel) panel.classList.remove("is-closing");
        unlockPage();
      }, CLOSE_MS);
    }
    function toggleMenu() {
      if (dd.classList.contains("is-open")) close(); else open();
    }

    if (toggle) {
      toggle.addEventListener("click", function (e) { e.preventDefault(); toggleMenu(); });
    }
    if (closeBtn) {
      closeBtn.addEventListener("click", function (e) { e.preventDefault(); close(); });
    }
    if (panel) {
      $all("a", panel).forEach(function (a) {
        a.addEventListener("click", function () {
          if (a.hasAttribute("data-lang")) return; /* lang handled separately */
          close();
        });
      });
      panel.addEventListener("click", function (e) { if (e.target === panel) close(); });
    }
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
  }

  /* ---------------- language controls ---------------- */
  function initLangControls() {
    $all(LANG_CONTROL_SELECTOR).forEach(function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        applyTranslations(a.getAttribute("data-lang"));
      });
    });
  }

  /* ---------------- news carousel (wheel / coverflow) ----------------
     Not a loop: the active card sits centered and full-size, while the
     cards to either side shrink, rotate away and fade until they vanish.
     Arrows live in a separate row below and disable at the two ends. */
  function initCarousel() {
    var carousel = $(".carousel--news");
    if (!carousel) return;
    var stage = $(".carousel__stage", carousel);
    var track = $(".news-track", carousel);
    if (!track) return;
    var cards = $all(".news-card", track);
    if (!cards.length) return;
    var prev = $(".news-prev", carousel), next = $(".news-next", carousel);
    var dotsWrap = $(".news-dots", carousel);
    var active = 0;
    var mobileMq = window.matchMedia("(max-width: 700px)");

    /* build progress dots */
    if (dotsWrap) {
      dotsWrap.innerHTML = "";
      cards.forEach(function (_, i) {
        var d = document.createElement("span");
        d.addEventListener("click", function () { go(i); });
        dotsWrap.appendChild(d);
      });
    }
    var dots = dotsWrap ? $all("span", dotsWrap) : [];

    function layout() {
      /* size the stage to the tallest card so absolute cards have room */
      var maxH = 0;
      cards.forEach(function (c) { if (c.offsetHeight > maxH) maxH = c.offsetHeight; });
      if (stage && maxH) stage.style.height = Math.ceil(maxH + 56) + "px";

      var w = cards[0].getBoundingClientRect().width || 340;
      var compact = mobileMq.matches;
      var spacing = compact ? 0 : w * 0.6;

      cards.forEach(function (card, i) {
        var off = i - active;
        var abs = Math.abs(off);
        var scale = compact ? (off === 0 ? 1 : 0.96) : Math.max(0, 1 - abs * 0.2);
        var opacity = compact ? (off === 0 ? 1 : 0) : (abs > 2 ? 0 : Math.max(0, 1 - abs * 0.32));
        var tx = off * spacing;
        var rot = compact ? 0 : off * -20;
        card.style.transform =
          "translate(-50%, -50%) translateX(" + tx + "px) rotateY(" + rot + "deg) scale(" + scale + ")";
        card.style.opacity = opacity;
        card.style.visibility = compact && off !== 0 ? "hidden" : "visible";
        card.style.zIndex = String(100 - abs);
        card.style.pointerEvents = off === 0 ? "auto" : "none";
        card.setAttribute("aria-hidden", off === 0 ? "false" : "true");
      });

      dots.forEach(function (d, i) { d.classList.toggle("is-active", i === active); });
      if (prev) prev.disabled = active <= 0;
      if (next) next.disabled = active >= cards.length - 1;
    }

    function go(n) {
      active = Math.max(0, Math.min(cards.length - 1, n));
      layout();
    }

    if (prev) prev.addEventListener("click", function () { go(active - 1); });
    if (next) next.addEventListener("click", function () { go(active + 1); });
    carousel.addEventListener("keydown", function (e) {
      if (e.key === "ArrowLeft") { e.preventDefault(); go(active - 1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); go(active + 1); }
    });

    var rt;
    window.addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(layout, 150); });
    if (mobileMq.addEventListener) mobileMq.addEventListener("change", layout);
    else if (mobileMq.addListener) mobileMq.addListener(layout);
    cards.forEach(function (card) {
      $all("img", card).forEach(function (img) {
        if (!img.complete) img.addEventListener("load", layout, { once: true });
      });
    });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(layout).catch(function () {});
    carousel.addEventListener("transitionend", function (e) {
      if (e.target === carousel) layout();
    });
    /* relayout after the reveal animation / images settle */
    layout();
    setTimeout(layout, 300);
    setTimeout(layout, 900);
    window.addEventListener("load", layout);
  }

  /* ---------------- hero video (language-specific) ---------------- */
  function initHeroVideo() {
    var v = $("#heroVideo");
    if (!v) return;
    var base = v.getAttribute("data-base") || "";
    var LOOP_START_DESKTOP = 22.0;
    var LOOP_START_MOBILE = 22.90;
    function device() { return window.matchMedia("(max-width: 700px)").matches ? "mobile" : "desktop"; }
    function loopStartSeconds() { return device() === "mobile" ? LOOP_START_MOBILE : LOOP_START_DESKTOP; }

    // Some environments (notably iOS Low Power / energy-saving mode) block
    // autoplay even for muted, inline video. We keep a gesture fallback armed
    // so the first user gesture — scroll, tap, etc. — starts the video.
    var gestureArmed = false;
    var GESTURE_EVENTS = ["pointerdown", "touchstart", "touchend", "click", "keydown", "scroll", "wheel"];
    function removeGestureListeners() {
      gestureArmed = false;
      GESTURE_EVENTS.forEach(function (ev) {
        window.removeEventListener(ev, onFirstGesture, true);
      });
    }
    function armGestureFallback() {
      if (gestureArmed) return;
      gestureArmed = true;
      GESTURE_EVENTS.forEach(function (ev) {
        window.addEventListener(ev, onFirstGesture, { capture: true, passive: true });
      });
    }
    function onFirstGesture() {
      if (!v.paused) { removeGestureListeners(); return; }
      v.muted = true;
      var p = v.play();
      if (p && p.then) {
        p.then(function () { if (!v.paused) removeGestureListeners(); }).catch(function () {});
      } else if (!v.paused) {
        removeGestureListeners();
      }
    }
    function tryPlay() {
      v.muted = true; // a muted video is far more likely to be allowed to play
      // Always keep a gesture fallback armed: if autoplay is blocked, the first
      // scroll or tap will start the video.
      armGestureFallback();
      var p = v.play();
      if (p && p.then) {
        p.then(function () { if (!v.paused) removeGestureListeners(); }).catch(function () {});
      }
    }

    function load(lang) {
      var src = base + "-" + device() + "-" + lang + ".mp4";
      if (v.getAttribute("src") === src) return;
      v.defaultMuted = true; v.muted = true;
      v.setAttribute("muted", ""); v.setAttribute("playsinline", "");
      v.setAttribute("src", src); v.load();
      tryPlay();
    }
    window.onLangApplied = function (lang) { load(lang); };
    load(document.documentElement.dataset.lang || "en");

    var resizeTimer;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { load(document.documentElement.dataset.lang || "en"); }, 250);
    });
    v.addEventListener("ended", function () {
      try {
        var LS = loopStartSeconds();
        v.currentTime = isFinite(v.duration) && v.duration > LS ? LS : 0;
      } catch (e) {}
      tryPlay();
    });
  }

  /* ---------------- newsletter (clean field + CTA) ----------------
     Submits to the MailerLite "embedded form" endpoint. The opaque
     no-cors response means we can't read the status, so we optimistically
     show success after a successful network round-trip. If the form code
     or account ever changes, update ML_ACCOUNT / ML_FORM below. */
  var ML_ACCOUNT = "2102085";
  var ML_FORM = "HwxvEb";

  function initNewsletter() {
    var forms = $all(".nl-form");
    if (!forms.length) return;
    var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    forms.forEach(function (form) {
      var input = $(".nl-form__input", form);
      var status = $(".nl-form__status", form);
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var lang = document.documentElement.dataset.lang || "en";
        var email = (input && input.value || "").trim();
        if (!EMAIL_RE.test(email)) {
          if (status) status.textContent = lookup(lang, "footer.nlErr") || "Invalid email.";
          if (input) input.focus();
          return;
        }
        var endpoint = "https://assets.mailerlite.com/jsonp/" + ML_ACCOUNT +
                       "/forms/" + ML_FORM + "/subscribe";
        var body = new FormData();
        body.append("fields[email]", email);
        body.append("ml-submit", "1");
        body.append("anticsrf", "true");

        if (status) status.textContent = "…";
        fetch(endpoint, { method: "POST", body: body, mode: "no-cors" })
          .then(function () {
            if (status) status.textContent = lookup(lang, "footer.nlOk") || "Subscribed.";
            if (input) input.value = "";
          })
          .catch(function () {
            if (status) status.textContent = lookup(lang, "footer.nlErr") || "Error. Try again.";
          });
      });
    });
  }

  /* ---------------- scroll reveals ---------------- */
  function initReveals() {
    var els = $all(".reveal");
    if (!els.length) return;

    // Hero content has its own CSS entrance animation that fires on load (so it
    // appears together with the hero photo). Leave those elements untouched here
    // — adding is-in would override the animation and cut it short.
    var rest = [];
    els.forEach(function (e) {
      if (e.closest && e.closest(".page-hero")) return;
      rest.push(e);
    });
    if (!rest.length) return;

    if (!("IntersectionObserver" in window)) { rest.forEach(function (e) { e.classList.add("is-in"); }); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("is-in"); io.unobserve(en.target); }
      });
    }, { threshold: 0.01, rootMargin: "0px 0px -4% 0px" });
    rest.forEach(function (e) { io.observe(e); });
  }

  /* ---------------- page open / close fade ---------------- */
  function initPageTransitions() {
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;

    var LEAVE_MS = 520;

    // If the page is restored from the back/forward cache, make sure it is
    // visible again (otherwise it would stay faded out).
    window.addEventListener("pageshow", function (e) {
      if (e.persisted) document.body.classList.remove("is-leaving");
    });

    document.addEventListener("click", function (e) {
      // Only plain left-clicks, no modifier keys.
      if (e.defaultPrevented) return;
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

      var a = e.target.closest ? e.target.closest("a") : null;
      if (!a) return;

      // Skip links that should not trigger a navigation fade.
      if (a.target && a.target !== "_self") return;          // new tab / window
      if (a.hasAttribute("download")) return;                 // downloads
      if (a.getAttribute("data-lang") != null) return;        // language switch
      var href = a.getAttribute("href");
      if (!href) return;
      if (href.charAt(0) === "#") return;                     // in-page anchor
      if (/^(mailto:|tel:|javascript:)/i.test(href)) return;  // non-page schemes

      // Resolve to an absolute URL and only intercept same-origin navigations.
      var url;
      try { url = new URL(a.href, window.location.href); } catch (err) { return; }
      if (url.origin !== window.location.origin) return;      // external site

      // Same page, only a hash change -> let the browser handle it natively.
      if (url.pathname === window.location.pathname &&
          url.search === window.location.search &&
          url.hash) return;

      e.preventDefault();
      document.body.classList.add("is-leaving");
      window.setTimeout(function () { window.location.href = a.href; }, LEAVE_MS);
    });
  }

  /* ---------------- timeline scroll animation ----------------
     The vertical line "grows" downward as you scroll (a CSS var on
     each list drives the fill height) and every item lights up the
     moment the fill front reaches its node. Fully progressive: with
     no JS or reduced motion the markup just shows normally. */
  function initTimeline() {
    var timelines = $all(".timeline");
    if (!timelines.length) return;

    var reduce = window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduce) {
      timelines.forEach(function (tl) {
        var list = $(".timeline__list", tl);
        if (list) list.style.setProperty("--t-fill", "1");
        $all(".t-item", tl).forEach(function (it) { it.classList.add("is-lit"); });
      });
      return;
    }

    timelines.forEach(function (tl) { tl.classList.add("is-anim"); });

    function clamp(n) { return n < 0 ? 0 : n > 1 ? 1 : n; }

    function update() {
      /* the "reveal line" sits ~72% down the viewport */
      var anchor = window.scrollY + window.innerHeight * 0.72;
      timelines.forEach(function (tl) {
        var list = $(".timeline__list", tl);
        if (!list) return;
        var rect = list.getBoundingClientRect();
        var top = rect.top + window.scrollY;
        var h = rect.height || 1;
        list.style.setProperty("--t-fill", clamp((anchor - top) / h).toFixed(4));

        $all(".t-item", list).forEach(function (it) {
          if (it.classList.contains("is-lit")) return;
          var node = $(".t-node", it) || it;
          var nr = node.getBoundingClientRect();
          var ny = nr.top + window.scrollY + nr.height / 2;
          if (anchor >= ny) it.classList.add("is-lit");
        });
      });
    }

    var ticking = false;
    window.addEventListener("scroll", function () {
      if (ticking) return; ticking = true;
      requestAnimationFrame(function () { update(); ticking = false; });
    }, { passive: true });
    window.addEventListener("resize", update);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(update).catch(function () {});
    update();
  }

  /* ---------------- custom desktop cursor ----------------
     Only on real pointer devices (hover + fine). A dot tracks the
     pointer 1:1 while a ring follows with a soft lag and swells over
     interactive elements. Both use mix-blend-mode:difference so they
     stay visible over the cream and violet backgrounds alike. */
  function initCursor() {
    if (!(window.matchMedia &&
          window.matchMedia("(hover: hover) and (pointer: fine)").matches)) return;

    var root = document.documentElement;
    var ring = document.createElement("div");
    var dot = document.createElement("div");
    ring.className = "mff-cursor-ring";
    dot.className = "mff-cursor-dot";
    ring.setAttribute("aria-hidden", "true");
    dot.setAttribute("aria-hidden", "true");
    document.body.appendChild(ring);
    document.body.appendChild(dot);

    var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var mx = window.innerWidth / 2, my = window.innerHeight / 2;
    var rx = mx, ry = my, moved = false;

    function place(el, x, y) { el.style.transform = "translate(" + x + "px," + y + "px)"; }

    /* Decide whether the pointer is over a violet background so the cursor
       can flip to white ring + lime dot; otherwise black ring + violet dot.
       We read the nearest ancestor that declares a theme (section class,
       footer, intro overlay or data-bg attribute). */
    var THEME_SEL = '.is-on-violet, .is-on-cream, .site-footer, #introOverlay, [data-bg]';
    var onViolet = false;
    function themeAt(x, y) {
      var el = document.elementFromPoint(x, y);
      if (!el || !el.closest) return false;
      var m = el.closest(THEME_SEL);
      if (!m) return false;
      if (m.classList.contains("is-on-violet") ||
          m.classList.contains("site-footer") ||
          m.id === "introOverlay") return true;
      var bg = m.getAttribute("data-bg");
      return bg === "violet" || bg === "violet-deep";
    }
    function updateTheme() {
      var v = themeAt(mx, my);
      if (v === onViolet) return;
      onViolet = v;
      dot.classList.toggle("on-violet", v);
      ring.classList.toggle("on-violet", v);
    }

    window.addEventListener("mousemove", function (e) {
      mx = e.clientX; my = e.clientY;
      place(dot, mx, my);
      if (reduce) { place(ring, mx, my); updateTheme(); }
      if (!moved) { moved = true; root.classList.add("mff-cursor-ready"); updateTheme(); }
    }, { passive: true });

    window.addEventListener("mousedown", function () { ring.classList.add("is-down"); });
    window.addEventListener("mouseup", function () { ring.classList.remove("is-down"); });
    document.addEventListener("mouseleave", function () { root.classList.remove("mff-cursor-ready"); moved = false; });
    document.addEventListener("mouseenter", function () { if (moved) root.classList.add("mff-cursor-ready"); });

    var HOVER_SEL = 'a, button, input, textarea, select, label, summary, [role="button"], .t-card, .card';
    document.addEventListener("mouseover", function (e) {
      if (e.target.closest && e.target.closest(HOVER_SEL)) ring.classList.add("is-hover");
    });
    document.addEventListener("mouseout", function (e) {
      if (!(e.target.closest && e.target.closest(HOVER_SEL))) return;
      var to = e.relatedTarget;
      if (!to || !(to.closest && to.closest(HOVER_SEL))) ring.classList.remove("is-hover");
    });

    if (reduce) { place(ring, mx, my); return; }
    var tick = 0;
    (function follow() {
      rx += (mx - rx) * 0.18;
      ry += (my - ry) * 0.18;
      place(ring, rx, ry);
      /* re-check the background theme a few times a second — this also
         catches scroll-driven background changes under a still pointer */
      if ((tick++ & 3) === 0) updateTheme();
      requestAnimationFrame(follow);
    })();
  }

  /* ---------------- home intro / opening animation ----------------
     Plays once per browsing session (armed inline in index.html via
     sessionStorage, so there's no flash on repeat visits). The violet
     curtain holds briefly, then lifts to reveal the hero. */
  function initIntro() {
    var overlay = document.getElementById("introOverlay");
    var root = document.documentElement;
    if (!overlay || !root.classList.contains("intro-armed")) return;

    function clear() {
      root.classList.remove("intro-armed");
      overlay.setAttribute("aria-hidden", "true");
    }

    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      clear();
      return;
    }

    window.setTimeout(function () {
      overlay.classList.add("is-done");
      var done = false;
      function finish() { if (done) return; done = true; clear(); }
      overlay.addEventListener("transitionend", finish, { once: true });
      window.setTimeout(finish, 1200); /* failsafe if transitionend is missed */
    }, 2100);
  }

  /* ---------------- boot ---------------- */
  function boot() {
    initIntro();
    applyTranslations(resolveInitialLang());
    initMobileInnerColors();
    initLangControls();
    initMenu();
    initHeader();
    initCarousel();
    initReveals();
    initTimeline();
    initHeroVideo();
    initNewsletter();
    initBackgroundEngine();
    initCursor();
    initPageTransitions();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
