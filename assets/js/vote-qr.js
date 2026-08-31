/* ============================================================
   Merge Film Festival — printable QR sheet for the staff
   One card per published screening, pulled from Supabase.
   ============================================================ */
(function () {
  "use strict";

  var CFG = window.MFF_VOTE || {};
  var sheet = document.getElementById("sheet");
  var status = document.getElementById("status");

  // The QR has to point at the live site, not at whatever host is serving this
  // sheet, otherwise printing it from localhost bakes localhost into the code.
  var BASE = "https://mergefestival.ch/vote/";

  if (!CFG.url || CFG.url.indexOf("YOUR-PROJECT") !== -1) {
    status.textContent = "Set the Supabase URL and anon key in assets/js/vote-config.js first.";
    return;
  }

  if (typeof QrCreator === "undefined") {
    status.textContent = "The QR library did not load — check the connection.";
    return;
  }

  function timeLabel(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return "";
    return new Intl.DateTimeFormat("it-CH", {
      weekday: "short", day: "numeric", month: "short",
      hour: "2-digit", minute: "2-digit", timeZone: "Europe/Zurich",
    }).format(d);
  }

  function line(className, text) {
    var el = document.createElement("p");
    el.className = className;
    el.textContent = text;
    return el;
  }

  fetch(CFG.url + "/rest/v1/screenings?select=*&is_published=eq.true&order=starts_at.asc", {
    headers: { apikey: CFG.anonKey, Authorization: "Bearer " + CFG.anonKey },
  }).then(function (res) {
    if (!res.ok) throw new Error(res.status);
    return res.json();
  }).then(function (rows) {
    if (!rows.length) { status.textContent = "No published screenings yet."; return; }

    rows.forEach(function (row) {
      var link = BASE + "?s=" + row.code;

      var card = document.createElement("div");
      card.className = "card";

      var qr = document.createElement("div");
      qr.className = "card__qr";
      card.appendChild(qr);

      card.appendChild(line("card__title", row.title));
      card.appendChild(line("card__meta", [row.venue, timeLabel(row.starts_at)].filter(Boolean).join(" • ")));
      card.appendChild(line("card__cta", "Vota / Vote 1–10"));
      card.appendChild(line("card__code", link));

      sheet.appendChild(card);

      // Rendered at 440px so it stays crisp when printed at around 55mm.
      QrCreator.render({
        text: link, size: 440, radius: 0,
        ecLevel: "M", fill: "#000000", background: "#ffffff",
      }, qr);
    });
  }).catch(function () {
    status.textContent = "Could not reach Supabase.";
  });
})();
