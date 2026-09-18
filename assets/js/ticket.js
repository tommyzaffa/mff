/* ============================================================
   Merge Film Festival — one ticket

   Standalone like the badge page, and for the same reason: it is
   opened on a phone at the door of a cinema, so it loads in one
   paint and carries no menu, no animated background and no app.js.

   The code in the URL is the credential. The endpoint returns only
   what is on the ticket — the screening, the name printed on it and
   whether it is still valid. The buyer's email address and the rest
   of the party's seats never leave the server.
   ============================================================ */
(function () {
  "use strict";

  var CFG = window.MFF_PASSES || {};
  var BASE = (CFG.url || "").replace(/\/+$/, "") + "/functions/v1";

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

  // A small copy of what app.js does, so this page can stay standalone.
  function applyTranslations(lang) {
    var dict = (window.MFF_I18N || {})[lang] || (window.MFF_I18N || {}).en;
    if (!dict) return;
    document.documentElement.setAttribute("lang", (dict.meta && dict.meta.htmlLang) || lang);
    document.documentElement.dataset.lang = lang;
    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var node = dict;
      var parts = el.getAttribute("data-i18n").split(".");
      for (var i = 0; i < parts.length && node; i++) node = node[parts[i]];
      if (typeof node === "string") el.textContent = node;
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

  function t(key, fallback) {
    var node = (window.MFF_I18N || {})[LANG] || (window.MFF_I18N || {}).en || {};
    var parts = key.split(".");
    for (var i = 0; i < parts.length && node; i++) node = node[parts[i]];
    return typeof node === "string" ? node : fallback;
  }

  // The hour on the ticket is the hour in Massagno, whatever phone is showing it.
  var LOCALES = { it: "it-CH", en: "en-GB", fr: "fr-CH", de: "de-CH" };

  function whenText(iso) {
    try {
      return new Intl.DateTimeFormat(LOCALES[LANG] || "en-GB", {
        weekday: "long",
        day: "numeric",
        month: "long",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Europe/Zurich",
      }).format(new Date(iso));
    } catch (e) {
      return iso;
    }
  }

  // --- load -----------------------------------------------------------------

  var code = new URLSearchParams(location.search).get("c");
  if (!code) {
    show("missing");
    return;
  }

  fetch(BASE + "/ticket-show?c=" + encodeURIComponent(code))
    .then(function (r) { return r.json(); })
    .then(function (res) {
      if (!res.ok || !res.ticket) return show("missing");
      paint(res.ticket, res.screening || {}, res.screenings || []);
      show("ticket");
    })
    .catch(function () { show("missing"); });

  // A day pass carries a bare `YYYY-MM-DD`, which Date reads as UTC midnight —
  // an hour before the Zurich day it names. Noon is safely inside either.
  function asDate(iso) {
    return new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso + "T12:00:00" : iso);
  }

  function dayText(iso) {
    try {
      return new Intl.DateTimeFormat(LOCALES[LANG] || "en-GB", {
        weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Zurich",
      }).format(asDate(iso));
    } catch (e) { return iso; }
  }

  function hourText(iso) {
    try {
      return new Intl.DateTimeFormat(LOCALES[LANG] || "en-GB", {
        hour: "2-digit", minute: "2-digit", timeZone: "Europe/Zurich",
      }).format(new Date(iso));
    } catch (e) { return iso; }
  }

  // The transport wording needs the Swiss written date, in Italian, whatever
  // language the rest of the card is in.
  function stampDate(iso) {
    try {
      return new Intl.DateTimeFormat("it-CH", {
        day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Zurich",
      }).format(asDate(iso)).replace(/\//g, ".");
    } catch (e) { return ""; }
  }

  // Retitling has to move the key with the text, or the next language switch
  // puts the ticket wording back on a day pass.
  function retitle(el, key, fallback) {
    if (!el) return;
    el.setAttribute("data-i18n", key);
    el.textContent = t(key, fallback);
  }

  function paint(ticket, screening, screenings) {
    var pass = !!ticket.day_pass;

    // A day pass is named after its day, not after a film: it admits to none
    // until its holder books one.
    document.querySelector("[data-title]").textContent = pass
      ? t("ticket.dayPass", "Day pass")
      : screening.title || "—";
    var when = pass ? ticket.day : screening.starts_at;
    document.querySelector("[data-when]").textContent = when
      ? (pass ? dayText(when) : whenText(when))
      : "";
    document.querySelector("[data-venue]").textContent = pass ? "" : (screening.venue || "");
    document.querySelector("[data-code]").textContent = ticket.code;

    if (pass) {
      retitle(document.querySelector("[data-code-label]"), "ticket.passCodeLabel", "Day pass code");
      retitle(document.querySelector("[data-note]"), "ticket.passNote",
        "This pass does not reserve a seat. Book each screening you want with this code — it costs nothing.");
    }

    var book = document.querySelector("[data-book]");
    if (book) book.hidden = !pass;

    var tariff = document.querySelector("[data-tariff]");
    if (tariff) tariff.hidden = ticket.tariff !== "reduced";

    // What the pass has actually been used to book. Empty is a real answer and
    // is said out loud, because it means there is no seat waiting.
    var shows = document.querySelector("[data-shows]");
    var showsLabel = document.querySelector("[data-shows-label]");
    var showsEmpty = document.querySelector("[data-shows-empty]");
    if (shows) {
      shows.innerHTML = "";
      shows.hidden = !pass || !screenings.length;
      if (showsLabel) showsLabel.hidden = !pass || !screenings.length;
      if (showsEmpty) showsEmpty.hidden = !pass || screenings.length > 0;
      screenings.forEach(function (s) {
        var li = document.createElement("li");
        li.textContent = hourText(s.starts_at) + " · " + s.title;
        if (s.used) li.className = "is-used";
        shows.appendChild(li);
      });
    }

    var holder = document.querySelector("[data-holder]");
    holder.textContent = ticket.holder || "";
    holder.hidden = !ticket.holder;

    document.querySelector("[data-chair]").hidden = !ticket.wheelchair;

    // The state is the first thing anyone at the door looks at, so it is a word
    // and a colour rather than something to work out from the rest of the card.
    var STATES = {
      valid: { key: "ticket.stateValid", css: "is-valid" },
      used: { key: "ticket.stateUsed", css: "is-used" },
      pending: { key: "ticket.statePending", css: "is-pending" },
      cancelled: { key: "ticket.stateCancelled", css: "is-cancelled" },
    };
    var state = STATES[ticket.status] || STATES.pending;
    var stateEl = document.querySelector("[data-state]");
    stateEl.setAttribute("data-i18n", state.key);
    stateEl.textContent = t(state.key, ticket.status);
    document.querySelector("[data-status-class]").className = "tkt " + state.css;

    // The ticket doubles as an Arcobaleno day card for the day it admits to —
    // but only while it is admission: a cancelled or unpaid one travels nowhere.
    var transport = document.querySelector("[data-transport]");
    var stamp = when ? stampDate(when) : "";
    if (transport) {
      transport.hidden = !stamp || (ticket.status !== "valid" && ticket.status !== "used");
      document.querySelector("[data-transport-date]").textContent = stamp;
    }

    // The QR carries the bare code, not a URL: it is scanned by the festival's
    // own check-in, and a short payload reads faster on a dark foyer's worth of
    // cracked phone screens.
    var host = document.querySelector("[data-qr]");
    if (host && window.QrCreator) {
      host.innerHTML = "";
      window.QrCreator.render({
        text: ticket.code,
        radius: 0.1,
        ecLevel: "M",
        fill: "#2E1B54",
        background: "#ffffff",
        size: 320,
      }, host);
    }
  }
})();
