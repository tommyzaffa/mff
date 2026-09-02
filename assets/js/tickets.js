/* ============================================================
   Merge Film Festival — seat reservation

   Four panels (loading / soon / choose / form / done). The page
   never counts anything: it shows what ticket-screenings says is
   left and lets ticket-reserve decide, under the screening's row
   lock, whether the seats are actually there. Everything here is
   presentation, so a stale count on screen can only ever produce
   an honest refusal, never an oversold room.
   ============================================================ */
(function () {
  "use strict";

  var CFG = window.MFF_PASSES || {};
  var BASE = (CFG.url || "").replace(/\/+$/, "") + "/functions/v1/";

  var listEl = document.querySelector("[data-list]");
  if (!listEl) return;

  var panels = {};
  document.querySelectorAll("[data-panel]").forEach(function (el) {
    panels[el.getAttribute("data-panel")] = el;
  });

  var form = document.getElementById("ticketForm");
  var seatsEl = form.querySelector("[data-seats]");
  var totalEl = form.querySelector("[data-total]");
  var statusEl = form.querySelector("[data-status]");
  var submitBtn = form.querySelector("[data-submit-label]");
  var showTitleEl = form.querySelector("[data-show-title]");
  var showWhenEl = form.querySelector("[data-show-when]");
  var addSeatBtn = form.querySelector("[data-add-seat]");
  var codesEl = document.querySelector("[data-codes]");

  var MAX_SEATS = 10;

  var screenings = [];
  var current = null;

  function show(name) {
    Object.keys(panels).forEach(function (key) {
      panels[key].hidden = key !== name;
    });
  }

  function lang() {
    return document.documentElement.dataset.lang || "en";
  }

  function t(key, fallback) {
    var node = (window.MFF_I18N || {})[lang()];
    var parts = key.split(".");
    for (var i = 0; i < parts.length && node; i++) node = node[parts[i]];
    return typeof node === "string" ? node : fallback;
  }

  // Times are always the festival's, never the reader's: someone booking from
  // Paris must see the hour they have to be in the room in Massagno.
  var LOCALES = { it: "it-CH", en: "en-GB", fr: "fr-CH", de: "de-CH" };

  function whenText(iso) {
    try {
      return new Intl.DateTimeFormat(LOCALES[lang()] || "en-GB", {
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

  function money(cents) {
    return "CHF " + (cents / 100).toFixed(2).replace(/\.00$/, ".–");
  }

  // --- the programme --------------------------------------------------------

  fetch(BASE + "ticket-screenings")
    .then(function (r) { return r.json(); })
    .then(function (res) {
      screenings = (res.screenings || []).filter(function (s) { return s.is_ticketed; });
      if (!screenings.length) return show("soon");
      render();
      show("choose");
    })
    .catch(function () {
      show("soon");
    });

  function render() {
    listEl.innerHTML = "";
    screenings.forEach(function (s) {
      var left = Number(s.seats_left);
      var closed = !s.sales_open;
      var soldOut = left <= 0;

      var li = document.createElement("li");
      li.className = "screening" + (closed || soldOut ? " is-closed" : "");

      var info = document.createElement("div");
      info.className = "screening__info";

      var when = document.createElement("p");
      when.className = "screening__when";
      when.textContent = whenText(s.starts_at);
      info.appendChild(when);

      var title = document.createElement("h3");
      title.className = "screening__title";
      title.textContent = s.title;
      info.appendChild(title);

      var meta = document.createElement("p");
      meta.className = "screening__meta";
      meta.textContent = [
        s.venue,
        s.price_cents > 0 ? money(s.price_cents) : t("tickets.free", "Free"),
      ].filter(Boolean).join(" • ");
      info.appendChild(meta);

      var seats = document.createElement("p");
      seats.className = "screening__seats";
      seats.textContent = soldOut
        ? t("tickets.soldOut", "Sold out")
        : closed
        ? t("tickets.closed", "Online sales are closed — ask at the box office.")
        : left + " " + t("tickets.seatsLeft", "seats left");
      info.appendChild(seats);

      li.appendChild(info);

      if (!closed && !soldOut) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn btn--apply btn--small";
        btn.textContent = t("tickets.book", "Book");
        btn.addEventListener("click", function () { openForm(s); });
        li.appendChild(btn);
      }

      listEl.appendChild(li);
    });
  }

  // --- the form -------------------------------------------------------------

  function openForm(s) {
    current = s;
    showTitleEl.textContent = s.title;
    showWhenEl.textContent = whenText(s.starts_at) + " • " + (s.venue || "");
    seatsEl.innerHTML = "";
    addSeat();
    statusEl.textContent = "";
    statusEl.className = "form__status";
    show("form");
    window.scrollTo({ top: document.querySelector("[data-panel='form']").offsetTop - 80, behavior: "smooth" });
  }

  function seatRows() {
    return Array.prototype.slice.call(seatsEl.querySelectorAll(".seat"));
  }

  function addSeat() {
    var n = seatRows().length;
    if (n >= MAX_SEATS) return;

    var li = document.createElement("li");
    li.className = "seat";

    var head = document.createElement("div");
    head.className = "seat__head";

    var label = document.createElement("span");
    label.className = "seat__n";
    head.appendChild(label);

    var remove = document.createElement("button");
    remove.type = "button";
    remove.className = "seat__remove";
    remove.setAttribute("aria-label", t("tickets.removeSeat", "Remove this seat"));
    remove.textContent = "×";
    remove.addEventListener("click", function () {
      if (seatRows().length <= 1) return;
      li.remove();
      renumber();
      updateTotal();
    });
    head.appendChild(remove);
    li.appendChild(head);

    var holder = document.createElement("input");
    holder.type = "text";
    holder.className = "seat__holder";
    holder.setAttribute("data-holder", "");
    holder.placeholder = t("tickets.phHolder", "Name on the ticket (optional)");
    li.appendChild(holder);

    var badge = document.createElement("input");
    badge.type = "text";
    badge.className = "seat__badge";
    badge.setAttribute("data-badge", "");
    badge.placeholder = t("tickets.phBadge", "Badge number (optional)");
    badge.addEventListener("input", function () {
      badge.value = badge.value.toUpperCase();
      updateTotal();
    });
    li.appendChild(badge);

    var chair = document.createElement("label");
    chair.className = "seat__chair";
    var box = document.createElement("input");
    box.type = "checkbox";
    box.setAttribute("data-wheelchair", "");
    var text = document.createElement("span");
    text.textContent = t("tickets.wheelchair", "Wheelchair space");
    chair.appendChild(box);
    chair.appendChild(text);
    li.appendChild(chair);

    seatsEl.appendChild(li);
    renumber();
    updateTotal();
  }

  function renumber() {
    var rows = seatRows();
    rows.forEach(function (li, i) {
      li.querySelector(".seat__n").textContent = t("tickets.seat", "Seat") + " " + (i + 1);
      li.querySelector(".seat__remove").hidden = rows.length <= 1;
    });
    if (addSeatBtn) addSeatBtn.hidden = rows.length >= MAX_SEATS;
  }

  function collect() {
    return seatRows().map(function (li) {
      return {
        badge: li.querySelector("[data-badge]").value.trim().toUpperCase() || null,
        holder: li.querySelector("[data-holder]").value.trim() || null,
        wheelchair: li.querySelector("[data-wheelchair]").checked,
      };
    });
  }

  // A badge covers exactly one seat, so the sum is simply the seats without one.
  // The server checks each badge for real; this is only what the buyer is told
  // to expect, and a badge that turns out to be invalid stops the booking rather
  // than quietly charging for it.
  function updateTotal() {
    if (!current) return;
    var seats = collect();
    var paying = seats.filter(function (s) { return !s.badge; }).length;
    var cents = paying * current.price_cents;

    totalEl.textContent = cents > 0
      ? t("tickets.total", "Total") + ": " + money(cents)
      : t("tickets.totalFree", "Nothing to pay — your accreditation covers these seats.");

    var key = cents > 0 ? "tickets.submitPay" : "tickets.submitFree";
    submitBtn.setAttribute("data-i18n", key);
    submitBtn.textContent = t(key, submitBtn.textContent);
  }

  if (addSeatBtn) addSeatBtn.addEventListener("click", addSeat);

  form.querySelectorAll("[data-back]").forEach(function (btn) {
    btn.addEventListener("click", function () { show("choose"); });
  });

  // --- submit ---------------------------------------------------------------

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (!current) return;

    statusEl.className = "form__status";
    statusEl.textContent = "";

    var body = {
      screening: current.code,
      first_name: form.first_name.value.trim(),
      last_name: form.last_name.value.trim(),
      email: form.email.value.trim(),
      locale: lang(),
      seats: collect(),
    };

    if (!body.first_name || !body.last_name) return bad("name_required");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(body.email)) return bad("email_invalid");
    if (!form.consent.checked) return bad("consent_required");

    submitBtn.disabled = true;
    statusEl.textContent = t("tickets.sending", "Sending…");

    fetch(BASE + "ticket-reserve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res.ok) return bad(res.error || "server_error");
        if (res.outcome === "checkout") {
          window.location.href = res.url;
          return;
        }
        codes(res.codes || []);
        show("done");
      })
      .catch(function () { bad("network"); });
  });

  function codes(list) {
    if (!codesEl) return;
    codesEl.innerHTML = "";
    list.forEach(function (code) {
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.href = "ticket.html?c=" + encodeURIComponent(code);
      a.textContent = code;
      li.appendChild(a);
      codesEl.appendChild(li);
    });
  }

  function bad(code) {
    statusEl.className = "form__status is-err";
    statusEl.textContent = t("tickets." + code, t("tickets.server_error", "Something went wrong. Please try again."));
    submitBtn.disabled = false;
    return false;
  }

  // The labels we set by hand have to follow a language switch too.
  var previous = window.onLangApplied;
  window.onLangApplied = function (l) {
    if (typeof previous === "function") previous(l);
    if (screenings.length) render();
    renumber();
    updateTotal();
  };
})();
