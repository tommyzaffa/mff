/* ============================================================
   Merge Film Festival — audience award voting
   Shows a 1-10 scale and posts one vote straight to Supabase.

   Two ways in. With ?s=<code> the page is about that one screening,
   which is what the per-screening QR sheet prints. Without it — the
   single QR that hangs in the room all festival — the page asks the
   database what is open for voting right now: one answer goes straight
   to the scale, several become a list to pick from.
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

  // The list is built in JS, so its labels cannot carry data-i18n and have to
  // read the dictionary themselves.
  function t(key, fallback) {
    var node = (window.MFF_I18N || {})[document.documentElement.dataset.lang || "en"];
    var parts = key.split(".");
    for (var i = 0; i < parts.length && node; i++) node = node[parts[i]];
    return typeof node === "string" ? node : fallback;
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

  var FIELDS = "code,title,section,venue,starts_at,opens_at,closes_at";

  function query(filter) {
    return fetch(CFG.url + "/rest/v1/screenings?select=" + FIELDS + "&" + filter, {
      headers: headers(),
    }).then(function (res) {
      if (!res.ok) throw new Error("lookup failed: " + res.status);
      return res.json();
    });
  }

  function loadScreening(code) {
    return query("code=eq." + encodeURIComponent(code)).then(function (rows) {
      return rows[0] || null;
    });
  }

  // `now` is read by Postgres, not by the phone: a device with a wrong clock
  // would otherwise be offered a screening the server then refuses to accept a
  // vote for. Unpublished rows never come back — the RLS policy sees to that.
  function loadOpen() {
    return query("opens_at=lte.now&closes_at=gt.now&order=opens_at.desc");
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

  if (code && !/^[a-z0-9][a-z0-9-]{1,23}$/.test(code)) {
    show("unknown");
    return;
  }

  if (!CFG.url || CFG.url.indexOf("YOUR-PROJECT") !== -1) {
    show("error");
    return;
  }

  show("loading");

  var arrival = code
    ? loadScreening(code).then(function (screening) {
        if (!screening) { show("unknown"); return; }
        begin(screening);
      })
    : loadOpen().then(function (open) {
        if (!open.length) { show("none"); return; }
        // One thing open is the normal case, and making the audience tap a
        // list of one would only be a step to get wrong.
        if (open.length === 1) { begin(open[0]); return; }
        offer(open);
      });

  arrival.catch(function () { show("error"); });

  // Everything the page does once it knows which screening it is about. The
  // window is checked against the clock a second time here because a phone can
  // sit on this page for an hour between the scan and the tap.
  function begin(screening) {
    describe(screening);

    if (votedList().indexOf(screening.code) !== -1) { show("already"); return; }

    var now = Date.now();
    if (now < new Date(screening.opens_at).getTime()) { show("early"); return; }
    if (now >= new Date(screening.closes_at).getTime()) { show("closed"); return; }

    show("open");
    wireScale(screening.code);
  }

  function offer(open) {
    var list = panels.pick.querySelector("[data-list]");
    list.textContent = "";

    open.forEach(function (screening) {
      var li = document.createElement("li");
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "vote__pick";

      var title = document.createElement("span");
      title.className = "vote__pick-title";
      title.textContent = screening.title;
      btn.appendChild(title);

      var meta = document.createElement("span");
      meta.className = "vote__pick-meta";
      // Already voted stays on the list rather than disappearing from it:
      // a missing row reads as "the festival lost my vote".
      meta.textContent = votedList().indexOf(screening.code) !== -1
        ? t("vote.pickVoted", "already voted")
        : timeLabel(screening.starts_at);
      btn.appendChild(meta);

      btn.addEventListener("click", function () { begin(screening); });
      li.appendChild(btn);
      list.appendChild(li);
    });

    show("pick");
  }

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
