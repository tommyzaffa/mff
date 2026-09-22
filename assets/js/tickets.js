/* ============================================================
   Merge Film Festival — seat reservation

   Five panels (loading / soon / choose / form / done). The page
   never counts anything: it shows what ticket-screenings says is
   left and lets ticket-reserve decide, under the screening's row
   lock, whether the seats are actually there. Everything here is
   presentation, so a stale count on screen can only ever produce
   an honest refusal, never an oversold room.

   Two things are on sale and they share the whole flow, because
   they only differ in what is sent: a screening posts `screening`,
   a day pass posts `day`. Each seat carries its own tariff, full
   or reduced — declared here, checked at the door, which is why
   the word travels all the way to the scanner.

   A day pass buys a CODE, not seats: like an accreditation badge
   it reserves nothing, and its holder comes back here to book each
   screening with it. That is why the day cards carry no seat count
   and the day form offers neither a wheelchair box nor a badge
   field — and why the credential field on a screening accepts
   either kind of code.
   ============================================================ */
(function () {
  "use strict";

  var CFG = window.MFF_PASSES || {};
  var BASE = (CFG.url || "").replace(/\/+$/, "") + "/functions/v1/";

  var form = document.getElementById("ticketForm");
  if (!form) return;

  // Tickets sit under the accreditations on the same page, and both flows call
  // their panels `choose` and `form`. Everything is therefore looked up inside
  // this flow's own block, never across the whole document.
  var scope = form.closest("[data-flow]") || document;

  var listEl = scope.querySelector("[data-list]");
  var daysEl = scope.querySelector("[data-days]");
  var dayGroupEl = scope.querySelector("[data-day-group]");

  var panels = {};
  scope.querySelectorAll("[data-panel]").forEach(function (el) {
    panels[el.getAttribute("data-panel")] = el;
  });

  var seatsEl = form.querySelector("[data-seats]");
  var totalEl = form.querySelector("[data-total]");
  var statusEl = form.querySelector("[data-status]");
  var submitBtn = form.querySelector("[data-submit-label]");
  var showTitleEl = form.querySelector("[data-show-title]");
  var showWhenEl = form.querySelector("[data-show-when]");
  var addSeatBtn = form.querySelector("[data-add-seat]");
  var codesEl = scope.querySelector("[data-codes]");
  var seatsLabelEl = form.querySelector("[data-seats-label]");
  var dayWarnEls = Array.prototype.slice.call(form.querySelectorAll("[data-day-warning]"));
  var seatedOnlyEls = Array.prototype.slice.call(form.querySelectorAll("[data-seated-only]"));
  var inviteEl = form.querySelector("[data-invite]");
  var doneEl = scope.querySelector("[data-done-body]");
  var doneTitleEl = scope.querySelector("[data-done-title]");

  function retitle(el, key) {
    if (!el) return;
    el.setAttribute("data-i18n", key);
    el.textContent = t(key, el.textContent);
  }

  var MAX_SEATS = 10;

  var screenings = [];
  var days = [];

  // Whatever is being bought, reduced to the three things the form needs: what
  // to call it, what a seat costs, and which key to post it under. Keeping the
  // rest of the page blind to which of the two it is holding is what stops the
  // day pass from becoming a second copy of the booking flow.
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

  function dayText(day) {
    try {
      return new Intl.DateTimeFormat(LOCALES[lang()] || "en-GB", {
        weekday: "long",
        day: "numeric",
        month: "long",
        timeZone: "Europe/Zurich",
      }).format(new Date(day + "T12:00:00Z"));
    } catch (e) {
      return day;
    }
  }

  function money(cents) {
    return "CHF " + (cents / 100).toFixed(2).replace(/\.00$/, ".–");
  }

  // "CHF 15.– · ridotto 10.–", or just "Free". The reduced price is only worth
  // printing when it is actually different from the full one.
  function priceText(full, reduced) {
    if (!(full > 0)) return t("tickets.free", "Free");
    var out = money(full);
    if (reduced > 0 && reduced !== full) {
      out += " · " + t("tickets.reducedShort", "reduced") + " " + money(reduced);
    }
    return out;
  }

  // --- the programme --------------------------------------------------------

  // A failed request is NOT an empty programme. This used to fall through to
  // the "soon" panel, so one dropped connection told the visitor the programme
  // had not been announced yet — with the programme long since published.
  // Network trouble gets its own panel and a retry button; "soon" is now only
  // ever shown when the server really answers with no ticketed screening.
  function loadScreenings() {
    show("loading");
    fetch(BASE + "ticket-screenings")
      .then(function (r) {
        if (!r.ok) throw new Error("http " + r.status);
        return r.json();
      })
      .then(function (res) {
        screenings = (res.screenings || []).filter(function (s) { return s.is_ticketed; });
        days = res.days || [];
        if (!screenings.length) return show("soon");
        render();
        show("choose");
        deepLink();
      })
      .catch(function () {
        show("offline");
      });
  }

  var retryBtn = scope.querySelector("[data-retry]");
  if (retryBtn) retryBtn.addEventListener("click", loadScreenings);

  loadScreenings();

  // Coming from the programme page, which links straight at one screening or
  // one day. Nothing is skipped: the form simply opens already filled in.
  function deepLink() {
    var q = new URLSearchParams(window.location.search);
    var s = q.get("s");
    var d = q.get("d");
    // The gestionale hands out one link per invitation, so the guest never has
    // to copy the code by hand. It is still a plain field they can edit.
    if (inviteEl) {
      var i = (q.get("i") || "").trim().toUpperCase();
      if (i) inviteEl.value = i;
    }
    var pick = s
      ? screenings.filter(function (x) { return x.code === s && x.sales_open && x.seats_left > 0; })[0]
      : d
      ? days.filter(function (x) { return x.day === d && x.sales_open; })[0]
      : null;
    if (pick) openForm(s ? asScreening(pick) : asDay(pick));
  }

  function asScreening(s) {
    return {
      key: "screening",
      value: s.code,
      title: s.title,
      when: whenText(s.starts_at) + (s.venue ? " • " + s.venue : ""),
      full: Number(s.price_cents),
      reduced: Number(s.price_reduced_cents),
      badges: true,
      seated: true,
    };
  }

  function asDay(d) {
    return {
      key: "day",
      value: d.day,
      title: t("tickets.dayPass", "Day pass") + " · " + dayText(d.day),
      // How many doors it opens is the only thing that makes a day pass worth
      // more than a ticket, so it is what the header says.
      when: d.screenings.length + " " + t("tickets.dayScreenings", "screenings"),
      full: Number(d.price_cents),
      reduced: Number(d.price_reduced_cents),
      // An accreditation already admits its holder to every screening, so a
      // badge on a day pass would be money for nothing — the server refuses it
      // and the field is simply not offered.
      badges: false,
      // Nothing is being seated here, so neither the wheelchair box nor the
      // seat count means anything: both belong to the booking that comes later.
      seated: false,
    };
  }

  function card(o) {
    var li = document.createElement("li");
    li.className = "screening" + (o.closed || o.soldOut ? " is-closed" : "");

    var info = document.createElement("div");
    info.className = "screening__info";

    var when = document.createElement("p");
    when.className = "screening__when";
    when.textContent = o.when;
    info.appendChild(when);

    var title = document.createElement("h3");
    title.className = "screening__title";
    title.textContent = o.title;
    info.appendChild(title);

    var meta = document.createElement("p");
    meta.className = "screening__meta";
    meta.textContent = [o.meta, o.price].filter(Boolean).join(" • ");
    info.appendChild(meta);

    var seats = document.createElement("p");
    seats.className = "screening__seats";
    seats.textContent = o.soldOut
      ? t("tickets.soldOut", "Sold out")
      : o.closed
      ? t("tickets.closed", "Online sales are closed — ask at the box office.")
      : o.note
      ? o.note
      : o.left + " " + t("tickets.seatsLeft", "seats left");
    info.appendChild(seats);

    li.appendChild(info);

    if (!o.closed && !o.soldOut) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn--apply btn--small";
      btn.textContent = t("tickets.book", "Book");
      btn.addEventListener("click", o.book);
      li.appendChild(btn);
    }

    return li;
  }

  function render() {
    listEl.innerHTML = "";
    screenings.forEach(function (s) {
      listEl.appendChild(card({
        when: whenText(s.starts_at),
        title: s.title,
        meta: s.venue,
        price: priceText(Number(s.price_cents), Number(s.price_reduced_cents)),
        left: Number(s.seats_left),
        closed: !s.sales_open,
        soldOut: Number(s.seats_left) <= 0,
        book: function () { openForm(asScreening(s)); },
      }));
    });

    if (!daysEl) return;
    daysEl.innerHTML = "";
    var open = days.filter(function (d) { return d.sales_open; });
    if (dayGroupEl) dayGroupEl.hidden = open.length === 0;
    open.forEach(function (d) {
      daysEl.appendChild(card({
        when: dayText(d.day),
        title: t("tickets.dayPass", "Day pass"),
        meta: d.screenings.length + " " + t("tickets.dayScreenings", "screenings"),
        price: priceText(Number(d.price_cents), Number(d.price_reduced_cents)),
        // A pass takes no seat, so there is no number to count down. What the
        // buyer needs on the card is the rule, not a figure.
        note: t("tickets.dayBookNote", "Reserve each screening afterwards with your pass code."),
        closed: false,
        soldOut: false,
        book: function () { openForm(asDay(d)); },
      }));
    });
  }

  // --- the form -------------------------------------------------------------

  function openForm(item) {
    current = item;
    showTitleEl.textContent = item.title;
    showWhenEl.textContent = item.when;
    // The one thing a day-pass buyer must not miss, said before they pay and
    // again in the email, on the pass and at the door.
    dayWarnEls.forEach(function (el) { el.hidden = item.seated; });
    seatedOnlyEls.forEach(function (el) { el.hidden = !item.seated; });
    seatsEl.innerHTML = "";
    addSeat();
    statusEl.textContent = "";
    statusEl.className = "form__status";
    show("form");
    // The section is positioned, so `offsetTop` is measured from it and not from
    // the page — and the form no longer starts the page anyway.
    var y = panels.form.getBoundingClientRect().top + window.scrollY - 80;
    window.scrollTo({ top: y, behavior: "smooth" });
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

    // Declared, not proven: the door asks for the student card or the ID. The
    // word travels with the seat all the way to the scanner, which is the only
    // reason it is a field and not a price the buyer picks.
    var tariff = document.createElement("select");
    tariff.className = "seat__tariff";
    tariff.setAttribute("data-tariff", "");
    tariff.setAttribute("aria-label", t("tickets.tariffLabel", "Tariff"));
    [
      ["full", "tickets.tariffFull", "Full"],
      ["reduced", "tickets.tariffReduced", "Reduced — student / 65+"],
    ].forEach(function (o) {
      var opt = document.createElement("option");
      opt.value = o[0];
      opt.textContent = t(o[1], o[2]);
      tariff.appendChild(opt);
    });
    tariff.addEventListener("change", updateTotal);
    li.appendChild(tariff);

    // One field for both credentials. A badge is MFF-XXXX-XXXX and a day pass
    // MFF-D-XXXXXXXX, so the server can tell them apart with certainty and the
    // buyer is spared a choice they could only get wrong.
    if (!current || current.badges) {
      var badge = document.createElement("input");
      badge.type = "text";
      badge.className = "seat__badge";
      badge.setAttribute("data-badge", "");
      badge.placeholder = t("tickets.phBadge", "Badge or day-pass code (optional)");
      badge.addEventListener("input", function () {
        badge.value = badge.value.toUpperCase();
        updateTotal();
      });
      li.appendChild(badge);
    }

    // A wheelchair space is claimed when a seat is actually taken, so it asks
    // nothing of a day pass: the holder will tick it on each booking instead.
    if (!current || current.seated) {
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
    }

    seatsEl.appendChild(li);
    renumber();
    updateTotal();
  }

  function renumber() {
    var rows = seatRows();
    var unitKey = current && !current.seated ? "tickets.dayPass" : "tickets.seat";
    if (seatsLabelEl) {
      seatsLabelEl.textContent = current && !current.seated
        ? t("tickets.passesLabel", "Day passes")
        : t("tickets.seatsLabel", "Seats");
    }
    if (addSeatBtn) {
      addSeatBtn.textContent = current && !current.seated
        ? t("tickets.addPass", "+ Add a pass")
        : t("tickets.addSeat", "+ Add a seat");
    }
    rows.forEach(function (li, i) {
      li.querySelector(".seat__n").textContent = t(unitKey, "Seat") + " " + (i + 1);
      li.querySelector(".seat__remove").hidden = rows.length <= 1;
      // The options were written by hand, so a language switch has to come back
      // for them; the chosen value is preserved because only the labels change.
      var sel = li.querySelector("[data-tariff]");
      if (sel) {
        sel.options[0].textContent = t("tickets.tariffFull", "Full");
        sel.options[1].textContent = t("tickets.tariffReduced", "Reduced — student / 65+");
      }
      var holder = li.querySelector("[data-holder]");
      if (holder) {
        holder.placeholder = current && !current.seated
          ? t("tickets.phPassHolder", "Name on the pass (optional)")
          : t("tickets.phHolder", "Name on the ticket (optional)");
      }
      var badge = li.querySelector("[data-badge]");
      if (badge) badge.placeholder = t("tickets.phBadge", "Badge or day-pass code (optional)");
    });
    if (addSeatBtn) addSeatBtn.hidden = rows.length >= MAX_SEATS;
  }

  function collect() {
    return seatRows().map(function (li) {
      var badge = li.querySelector("[data-badge]");
      var chair = li.querySelector("[data-wheelchair]");
      return {
        badge: badge ? badge.value.trim().toUpperCase() || null : null,
        holder: li.querySelector("[data-holder]").value.trim() || null,
        wheelchair: chair ? chair.checked : false,
        tariff: li.querySelector("[data-tariff]").value,
      };
    });
  }

  // A badge or a day pass covers exactly one seat, so the sum is simply the
  // seats without one, each at the tariff it declared. The server checks every
  // credential for real; this is only what the buyer is told to expect, and one
  // that turns out to be invalid stops the booking rather than quietly charging
  // for it.
  function invite() {
    return inviteEl ? inviteEl.value.trim().toUpperCase() : "";
  }

  function updateTotal() {
    if (!current) return;
    var invited = !!invite();
    var cents = collect().reduce(function (sum, s) {
      if (s.badge) return sum;
      // An invitation pays for exactly the seats nobody else is paying for, so
      // on screen it zeroes the same seats the database will zero. If it turns
      // out to be spent or wrong, the booking is refused rather than charged.
      if (invited) return sum;
      return sum + (s.tariff === "reduced" ? current.reduced : current.full);
    }, 0);

    totalEl.textContent = cents > 0
      ? t("tickets.total", "Total") + ": " + money(cents)
      : invited
      ? t("tickets.totalInvited", "Nothing to pay — your invitation covers this booking.")
      : t("tickets.totalFree", "Nothing to pay — your accreditation or day pass covers these seats.");

    var key = cents > 0 ? "tickets.submitPay" : "tickets.submitFree";
    submitBtn.setAttribute("data-i18n", key);
    submitBtn.textContent = t(key, submitBtn.textContent);
  }

  if (addSeatBtn) addSeatBtn.addEventListener("click", addSeat);

  if (inviteEl) {
    inviteEl.addEventListener("input", function () {
      inviteEl.value = inviteEl.value.toUpperCase();
      updateTotal();
    });
  }

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
      first_name: form.first_name.value.trim(),
      last_name: form.last_name.value.trim(),
      email: form.email.value.trim(),
      locale: lang(),
      seats: collect(),
      access_code: invite() || null,
    };
    // One or the other, never both — the function refuses a request carrying
    // two, because it would have to guess which the buyer meant.
    body[current.key] = current.value;

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
        // The `data-i18n` key moves with the text, so a language switch on the
        // done panel keeps saying the same thing rather than reverting to the
        // ticket wording.
        retitle(doneTitleEl, current.seated ? "tickets.doneTitle" : "tickets.doneDayTitle");
        retitle(doneEl, current.seated ? "tickets.doneBody" : "tickets.doneDayBody");
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
      // The booking lives on /passes/ but the ticket itself is still served from
      // /tickets/, next to the page Stripe returns to.
      a.href = "../tickets/ticket.html?c=" + encodeURIComponent(code);
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
