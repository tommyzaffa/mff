/* ============================================================
   Merge Film Festival — audience award voting
   Reads ?s=<screening code> from the QR link, shows a 1-10 scale,
   posts one vote straight to Supabase.
   ============================================================ */
(function () {
  "use strict";

  var CFG = window.MFF_VOTE || {};
  var VOTER_KEY = "mff.voter";
  var VOTED_KEY = "mff.voted";

  var root = document.querySelector("[data-vote]");
  if (!root) return;

  var panels = {};
  Array.prototype.forEach.call(root.querySelectorAll("[data-panel]"), function (el) {
    panels[el.getAttribute("data-panel")] = el;
  });

  function show(name) {
    Object.keys(panels).forEach(function (key) {
      panels[key].hidden = key !== name;
    });
  }

  function fill(selector, text) {
    Array.prototype.forEach.call(root.querySelectorAll(selector), function (el) {
      el.textContent = text;
    });
  }

  /* -------------------------------------------------- device identity */

  // A random id kept on the device so a second tap on the same phone is
  // rejected by the unique constraint. It is not an identity and it is not
  // tied to anything personal.
  function voterId() {
    var id = null;
    try { id = localStorage.getItem(VOTER_KEY); } catch (e) {}
    if (!id) {
      id = (window.crypto && window.crypto.randomUUID)
        ? window.crypto.randomUUID()
        : String(Date.now()) + Math.random().toString(36).slice(2).padEnd(14, "0");
      try { localStorage.setItem(VOTER_KEY, id); } catch (e) {}
    }
    return id;
  }

  function votedList() {
    try { return JSON.parse(localStorage.getItem(VOTED_KEY)) || []; } catch (e) { return []; }
  }

  function rememberVote(code) {
    var list = votedList();
    if (list.indexOf(code) === -1) list.push(code);
    try { localStorage.setItem(VOTED_KEY, JSON.stringify(list)); } catch (e) {}
  }

  /* -------------------------------------------------- supabase */

  function headers() {
    return {
      apikey: CFG.anonKey,
      Authorization: "Bearer " + CFG.anonKey,
      "Content-Type": "application/json",
    };
  }

  function loadScreening(code) {
    var url = CFG.url + "/rest/v1/screenings"
      + "?select=code,title,section,venue,starts_at,opens_at,closes_at"
      + "&code=eq." + encodeURIComponent(code);
    return fetch(url, { headers: headers() }).then(function (res) {
      if (!res.ok) throw new Error("lookup failed: " + res.status);
      return res.json();
    }).then(function (rows) {
      return rows[0] || null;
    });
  }

  function postVote(code, score) {
    return fetch(CFG.url + "/rest/v1/votes", {
      method: "POST",
      headers: Object.assign(headers(), { Prefer: "return=minimal" }),
      body: JSON.stringify({ screening: code, score: score, voter: voterId() }),
    });
  }

  /* -------------------------------------------------- rendering */

  function timeLabel(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return "";
    try {
      return new Intl.DateTimeFormat(document.documentElement.lang || "en", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Europe/Zurich",
      }).format(d);
    } catch (e) {
      return d.toISOString().slice(11, 16);
    }
  }

  function describe(screening) {
    fill("[data-film]", screening.title);
    var bits = [];
    if (screening.venue) bits.push(screening.venue);
    if (screening.starts_at) bits.push(timeLabel(screening.starts_at));
    fill("[data-where]", bits.join(" • "));
    fill("[data-opens]", timeLabel(screening.opens_at));
  }

  /* -------------------------------------------------- flow */

  var code = (new URLSearchParams(location.search).get("s") || "").trim().toLowerCase();

  if (!code || !/^[a-z0-9][a-z0-9-]{1,23}$/.test(code)) {
    show("unknown");
    return;
  }

  if (!CFG.url || CFG.url.indexOf("YOUR-PROJECT") !== -1) {
    show("error");
    return;
  }

  show("loading");

  loadScreening(code).then(function (screening) {
    if (!screening) { show("unknown"); return; }
    describe(screening);

    if (votedList().indexOf(code) !== -1) { show("already"); return; }

    var now = Date.now();
    if (now < new Date(screening.opens_at).getTime()) { show("early"); return; }
    if (now >= new Date(screening.closes_at).getTime()) { show("closed"); return; }

    show("open");
    wireScale(code);
  }).catch(function () {
    show("error");
  });

  function wireScale(code) {
    var scale = panels.open.querySelector("[data-scale]");
    if (!scale) return;
    var sending = false;

    scale.addEventListener("click", function (event) {
      var btn = event.target.closest("[data-score]");
      if (!btn || sending) return;

      sending = true;
      scale.setAttribute("aria-busy", "true");
      btn.classList.add("is-chosen");

      postVote(code, Number(btn.getAttribute("data-score"))).then(function (res) {
        if (res.ok || res.status === 201) {
          rememberVote(code);
          fill("[data-chosen]", btn.getAttribute("data-score"));
          show("thanks");
          return;
        }
        // 409 is the unique constraint: this device already voted.
        if (res.status === 409) { rememberVote(code); show("already"); return; }
        // RLS refused the insert, which here means the window just shut.
        if (res.status === 401 || res.status === 403) { show("closed"); return; }
        show("error");
      }).catch(function () {
        show("error");
      }).then(function () {
        sending = false;
        scale.removeAttribute("aria-busy");
        btn.classList.remove("is-chosen");
      });
    });
  }
})();
