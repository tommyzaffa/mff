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

  var LANG = initialLang();
  applyTranslations(LANG);

  // For strings that are written from script rather than sitting in the markup.
  function t(key, fallback) {
    var dict = (window.MFF_I18N || {})[LANG] || (window.MFF_I18N || {}).en || {};
    var node = dict;
    var parts = key.split(".");
    for (var i = 0; i < parts.length && node; i++) node = node[parts[i]];
    return typeof node === "string" ? node : fallback;
  }

  // --- load -----------------------------------------------------------------

  var code = (new URLSearchParams(location.search).get("c") || "").trim().toUpperCase();

  if (!code) {
    show("missing");
    return;
  }

  // The dashboard links here with ?print=1 to get the artwork for the printer
  // without anyone having to press anything.
  var autoSave = new URLSearchParams(location.search).get("print") === "1";

  fetch(BASE + "/pass-badge?c=" + encodeURIComponent(code))
    .then(function (r) { return r.json(); })
    .then(function (res) {
      if (!res.ok) return show("missing");
      render(res.badge);
      show("badge");
      if (autoSave) whenPhotoReady(savePdf);
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

  // The browser's print dialog cannot be told a page size — Safari ignores
  // `@page { size }` outright — so printing always dropped the card in the
  // middle of an A4 and left someone to trim it by hand. Instead the card is
  // rasterised at print resolution and wrapped in a one-page PDF built around
  // the card: a standard CR80 PVC card, 53.98 x 85.6 mm (ISO/IEC 7810 ID-1),
  // which the card printer prints on directly — nothing is cut out of a sheet.
  //
  // Around it runs a bleed: the outermost pixels of the card carried on past
  // its edge. The first test print came out with a white hairline along the top
  // although the violet reached the very first row of the file — the printer
  // lays the image a fraction of a millimetre off the card, and with nothing
  // beyond the edge that fraction is bare plastic. The page is the card plus the
  // bleed, and the TrimBox says where the card is; printed at 100 % the bleed
  // simply falls off the card. It keeps the card's proportions (1 mm at the
  // sides, 1.6 mm top and bottom), so a printer told to fit the page to the card
  // still fills it edge to edge, only 4 % smaller, instead of leaving a strip.
  var MM_W = 53.98;
  var MM_H = 85.6;
  var BLEED_MM_X = 1;
  var BLEED_MM_Y = BLEED_MM_X * MM_H / MM_W;
  var DPI = 600;
  var PT = 72 / 25.4;

  // Fetched only when the file is actually asked for: at the door the badge has
  // to open on one bar of signal, and showing it needs none of this.
  var SHOT_URL = "https://cdn.jsdelivr.net/npm/modern-screenshot@4.6.0/dist/index.js";
  var SHOT_SRI = "sha384-gGN1lMNOLP39es/9RsdeQtXj8dH/UyIcMRtuOf14OHZjXYzt7gsYXVcJ5enPlRbz";

  function loadShot() {
    if (window.modernScreenshot) return Promise.resolve(window.modernScreenshot);
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = SHOT_URL;
      s.integrity = SHOT_SRI;
      s.crossOrigin = "anonymous";
      s.onload = function () {
        window.modernScreenshot ? resolve(window.modernScreenshot) : reject(new Error("lib"));
      };
      s.onerror = function () { reject(new Error("lib")); };
      document.head.appendChild(s);
    });
  }

  // Stretches the card's outermost row and column of pixels outward into the
  // bleed. The card's edges are flat colour — the violet masthead, the white
  // body, the hairlines running across it — so this is what they would look
  // like carried past the cut. It samples one pixel in, in case the capture
  // antialiased the very edge.
  function withBleed(card) {
    var w = card.width;
    var h = card.height;
    var bx = Math.ceil(BLEED_MM_X / 25.4 * DPI);
    var by = Math.ceil(BLEED_MM_Y / 25.4 * DPI);
    var sheet = document.createElement("canvas");
    sheet.width = w + 2 * bx;
    sheet.height = h + 2 * by;
    var ctx = sheet.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    var L = 1, T = 1, R = w - 2, B = h - 2;
    ctx.drawImage(card, 0, T, w, 1, bx, 0, w, by);           // top
    ctx.drawImage(card, 0, B, w, 1, bx, by + h, w, by);      // bottom
    ctx.drawImage(card, L, 0, 1, h, 0, by, bx, h);           // left
    ctx.drawImage(card, R, 0, 1, h, bx + w, by, bx, h);      // right
    ctx.drawImage(card, L, T, 1, 1, 0, 0, bx, by);           // corners
    ctx.drawImage(card, R, T, 1, 1, bx + w, 0, bx, by);
    ctx.drawImage(card, L, B, 1, 1, 0, by + h, bx, by);
    ctx.drawImage(card, R, B, 1, 1, bx + w, by + h, bx, by);
    ctx.drawImage(card, bx, by);
    return { canvas: sheet, cardW: w, cardH: h, bx: bx, by: by };
  }

  // Everything on the card is sized in cqw, so asking for 54 mm worth of pixels
  // is the same drawing at a larger scale rather than a different layout. At
  // 600 dpi the portrait and the QR are both scaled down, never up.
  function cardImage() {
    var card = document.querySelector("[data-badge]");
    var px = Math.round(MM_W / 25.4 * DPI);
    return loadShot().then(function (shot) {
      return shot.domToCanvas(card, {
        scale: px / card.getBoundingClientRect().width,
        backgroundColor: "#ffffff",
        // The rounded corner is a die and the shadow belongs to the screen: the
        // sheet handed to a printer has to be a plain rectangle.
        style: { borderRadius: "0", boxShadow: "none" },
      });
    }).then(function (canvas) {
      var out = withBleed(canvas);
      return new Promise(function (resolve, reject) {
        out.canvas.toBlob(function (blob) {
          if (!blob) return reject(new Error("encode"));
          out.blob = blob;
          resolve(out);
        }, "image/jpeg", 0.95);
      });
    });
  }

  // One page, one image, five objects. Writing the file out by hand instead of
  // pulling in a PDF library keeps this page as light as the rest of it.
  function pdfWithImage(jpeg, img) {
    var enc = new TextEncoder();
    var parts = [];
    var offsets = [];
    var len = 0;

    function put(chunk) {
      var bytes = typeof chunk === "string" ? enc.encode(chunk) : chunk;
      parts.push(bytes);
      len += bytes.length;
    }
    function obj(n, dict, stream) {
      offsets[n] = len;
      put(n + " 0 obj\n" + dict + "\n");
      if (stream) { put("stream\n"); put(stream); put("\nendstream\n"); }
      put("endobj\n");
    }

    // The page is the card plus the bleed; the TrimBox is the card. The image
    // is placed so that its card pixels land exactly on the TrimBox — whole
    // pixels of bleed are a hair wider than the bleed in millimetres, and that
    // excess simply falls off the page.
    var trimW = MM_W * PT, trimH = MM_H * PT;
    var bleedX = BLEED_MM_X * PT, bleedY = BLEED_MM_Y * PT;
    var pageW = trimW + 2 * bleedX, pageH = trimH + 2 * bleedY;
    var sx = trimW / img.cardW, sy = trimH / img.cardH;
    var content = "q " + (img.canvas.width * sx).toFixed(4) + " 0 0 " +
                  (img.canvas.height * sy).toFixed(4) + " " +
                  (bleedX - img.bx * sx).toFixed(4) + " " +
                  (bleedY - img.by * sy).toFixed(4) + " cm /Im0 Do Q";
    function box(x0, y0, x1, y1) {
      return "[" + [x0, y0, x1, y1].map(function (n) { return n.toFixed(4); }).join(" ") + "]";
    }

    // The binary comment stops anything downstream treating the file as text.
    put(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a,
                        0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
    obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    obj(3, "<< /Type /Page /Parent 2 0 R" +
           " /MediaBox " + box(0, 0, pageW, pageH) +
           " /BleedBox " + box(0, 0, pageW, pageH) +
           " /TrimBox " + box(bleedX, bleedY, bleedX + trimW, bleedY + trimH) +
           " /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>");
    // DCTDecode is the JPEG the canvas already produced, stored byte for byte.
    obj(4, "<< /Type /XObject /Subtype /Image /Width " + img.canvas.width +
           " /Height " + img.canvas.height +
           " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " +
           jpeg.length + " >>", jpeg);
    obj(5, "<< /Length " + content.length + " >>", content);

    var xref = len;
    var table = "xref\n0 6\n0000000000 65535 f \n";
    for (var i = 1; i <= 5; i++) {
      table += ("0000000000" + offsets[i]).slice(-10) + " 00000 n \n";
    }
    put(table + "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n");

    return new Blob(parts, { type: "application/pdf" });
  }

  function fileName() {
    var name = (document.querySelector("[data-name]").textContent || "").trim();
    var value = (document.querySelector("[data-code]").textContent || "").trim();
    return ("Badge " + value + " " + name).replace(/[\\/:*?"<>|]+/g, "").trim() + ".pdf";
  }

  function save(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  // The portrait comes over the network, so without this the card can be
  // captured with an empty photo frame.
  function whenPhotoReady(done) {
    var photo = document.querySelector("[data-photo]");
    if (!photo || !photo.getAttribute("src") || photo.complete) return done();
    photo.addEventListener("load", done, { once: true });
    photo.addEventListener("error", done, { once: true });
  }

  var saving = false;
  var printBtn = document.querySelector("[data-print]");
  var printLabel = printBtn && printBtn.querySelector("span");

  function savePdf() {
    if (saving) return;
    saving = true;
    var idle = printLabel && printLabel.textContent;
    if (printBtn) printBtn.disabled = true;
    if (printLabel) printLabel.textContent = t("badge.preparingPdf", "Preparing the file…");

    cardImage()
      .then(function (out) {
        return out.blob.arrayBuffer().then(function (buf) {
          save(pdfWithImage(new Uint8Array(buf), out), fileName());
        });
      })
      .catch(function () {
        if (printLabel) printLabel.textContent = t("badge.pdfError", "The file could not be prepared.");
        return new Promise(function (r) { setTimeout(r, 6000); });
      })
      .then(function () {
        saving = false;
        if (printBtn) printBtn.disabled = false;
        if (printLabel) printLabel.textContent = idle;
      });
  }

  if (printBtn) printBtn.addEventListener("click", savePdf);
})();
