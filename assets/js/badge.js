/* ============================================================
   Merge Film Festival — digital badge

   Deliberately standalone: no app.js, no animated background, no
   menu. This page has one job and often gets opened on a phone
   with one bar of signal at the door of a cinema.

   The badge code in the URL is the credential — eight characters
   drawn at random from a pool of five thousand, so it cannot be
   guessed or walked. The endpoint returns only what is printed on
   the badge; the email address and the student document never
   leave the server.
   ============================================================ */
(function () {
  "use strict";

  var CFG = window.MFF_PASSES || {};
  var BASE = (CFG.url || "").replace(/\/+$/, "") + "/functions/v1";

  var COLOURS = { violet: "#4B2E83", red: "#B3232B", grey: "#4A4A52" };

  var panels = {};
  document.querySelectorAll("[data-panel]").forEach(function (el) {
    panels[el.getAttribute("data-panel")] = el;
  });

  function show(name) {
    Object.keys(panels).forEach(function (key) {
      panels[key].hidden = key !== name;
    });
  }

  // --- translations ---------------------------------------------------------

  // A four-line copy of what app.js does, so this page can stay standalone.
  function applyTranslations(lang) {
    var dict = (window.MFF_I18N || {})[lang] || (window.MFF_I18N || {}).en;
    if (!dict) return;

    function lookup(key) {
      var node = dict;
      var parts = key.split(".");
      for (var i = 0; i < parts.length && node; i++) node = node[parts[i]];
      return typeof node === "string" ? node : null;
    }

    document.documentElement.setAttribute("lang", (dict.meta && dict.meta.htmlLang) || lang);
    document.documentElement.dataset.lang = lang;
    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var value = lookup(el.getAttribute("data-i18n"));
      if (value) el.textContent = value;
    });
  }

  function initialLang() {
    try {
      var saved = localStorage.getItem("mff_lang");
      if (saved) return saved;
    } catch (e) { /* private mode */ }
    var nav = (navigator.language || "en").slice(0, 2);
    return ["it", "en", "fr", "de"].indexOf(nav) >= 0 ? nav : "en";
  }

  applyTranslations(initialLang());

  // --- load -----------------------------------------------------------------

  var code = (new URLSearchParams(location.search).get("c") || "").trim().toUpperCase();

  if (!code) {
    show("missing");
    return;
  }

  fetch(BASE + "/pass-badge?c=" + encodeURIComponent(code))
    .then(function (r) { return r.json(); })
    .then(function (res) {
      if (!res.ok) return show("missing");
      render(res.badge);
      show("badge");
    })
    .catch(function () { show("missing"); });

  // --- render ---------------------------------------------------------------

  function render(badge) {
    var root = document.querySelector("[data-badge]");
    var colour = COLOURS[badge.colour] || COLOURS.violet;
    root.style.setProperty("--badge-colour", colour);

    document.querySelector("[data-name]").textContent =
      badge.first_name + " " + badge.last_name;
    document.querySelector("[data-code]").textContent = badge.code;

    var orgEl = document.querySelector("[data-org]");
    orgEl.hidden = !badge.org;
    if (badge.org) orgEl.textContent = badge.org;

    // Every pass is identified by the single letter printed on the physical
    // badge. Staff is the exception: it is spelled out, because that is the one
    // the public and the venues need to recognise without being told the code.
    var typeEl = document.querySelector("[data-type]");
    var dict = (window.MFF_I18N || {})[document.documentElement.dataset.lang] || {};
    var isStaff = badge.type === "staff";
    typeEl.textContent = isStaff
      ? (dict.badge && dict.badge.type_staff) || "Staff"
      : badge.letter;
    typeEl.classList.toggle("badge__type--word", isStaff);

    var photo = document.querySelector("[data-photo]");
    if (badge.photo_url) {
      photo.src = badge.photo_url;
      photo.alt = badge.first_name + " " + badge.last_name;
    }

    document.title = badge.first_name + " " + badge.last_name + " — Merge Film Festival";

    drawQr(badge.code, colour);
    wireWallets(badge.code);
  }

  // The QR carries the bare code, not a URL: the people scanning it at the door
  // are running the festival's own check-in, and a short payload scans faster on
  // a cracked phone screen in a dark foyer.
  function drawQr(value, colour) {
    var host = document.querySelector("[data-qr]");
    if (!host || !window.QrCreator) return;
    host.innerHTML = "";
    window.QrCreator.render({
      text: value,
      radius: 0.1,
      ecLevel: "M",
      fill: colour,
      background: "#ffffff",
      size: 320,
    }, host);
  }

  // Only Google Wallet: Apple's needs a paid developer account we decided not to
  // open, so the button would only ever lead to a 501.
  function wireWallets(value) {
    var google = document.querySelector("[data-wallet-google]");
    if (!google || !(window.MFF_PASSES && window.MFF_PASSES.googleWallet)) return;
    google.href = BASE + "/pass-wallet?p=google&c=" + encodeURIComponent(value);
    google.hidden = false;
  }

  // --- PDF ------------------------------------------------------------------

  // Print rather than a generated file: the print stylesheet lays the badge out
  // on one page and every browser turns that into a PDF. It stays vector-sharp,
  // needs no library, and works offline.
  var printBtn = document.querySelector("[data-print]");
  if (printBtn) printBtn.addEventListener("click", function () { window.print(); });
})();
