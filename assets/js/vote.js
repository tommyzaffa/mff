/* ============================================================
   Merge Film Festival — premio del pubblico

   Si votano i FILM in concorso, uno per uno, da 1 a 10. Il blocco di
   proiezione serve solo a decidere quando: la finestra si apre quando il
   programma finisce e dura tre ore, cioè il tempo in cui chi vota ha davvero
   visto quei film.

   Due modi di arrivare qui. Con ?s=<codice> la pagina è quel blocco lì, che è
   quello che stampa il foglio QR per sala. Senza — il QR unico appeso in sala
   per tutto il festival — la pagina chiede al database cosa è votabile adesso
   e mostra quei film. Retrospettive e cerimonie non hanno film in gara, quindi
   non compaiono mai: non c'è una riga di codice che le escluda, semplicemente
   non hanno niente da votare.
   ============================================================ */
(function () {
  "use strict";

  var CFG = window.MFF_VOTE || {};
  var VOTER_KEY = "mff.voter";
  var VOTES_KEY = "mff.votes";

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

  // La lista è costruita in JS, quindi le sue etichette non possono portare un
  // data-i18n e devono leggersi il dizionario da sole.
  function t(key, fallback) {
    var node = (window.MFF_I18N || {})[document.documentElement.dataset.lang || "en"];
    var parts = key.split(".");
    for (var i = 0; i < parts.length && node; i++) node = node[parts[i]];
    return typeof node === "string" ? node : fallback;
  }

  var SECTION_KEYS = {
    full: "program.catFull",
    hybrid: "program.catHyb",
    experimental: "program.catExp",
  };

  function sectionLabel(section) {
    return t(SECTION_KEYS[section] || "", section);
  }

  /* -------------------------------------------------- identità del dispositivo */

  // Un id casuale che resta sul telefono, così un secondo tocco sullo stesso
  // film dallo stesso apparecchio lo rifiuta il vincolo unique. Non è
  // un'identità e non è legato a niente di personale.
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

  // { slug: voto } — il voto serve per rimostrarlo in lista, non solo per
  // sapere che c'è stato.
  function myVotes() {
    try { return JSON.parse(localStorage.getItem(VOTES_KEY)) || {}; } catch (e) { return {}; }
  }

  function remember(slug, score) {
    var mine = myVotes();
    mine[slug] = score;
    try { localStorage.setItem(VOTES_KEY, JSON.stringify(mine)); } catch (e) {}
  }

  /* -------------------------------------------------- supabase */

  function headers() {
    return {
      apikey: CFG.anonKey,
      Authorization: "Bearer " + CFG.anonKey,
      "Content-Type": "application/json",
    };
  }

  var FIELDS = "slug,title,section,position,screening,screening_title,venue,starts_at,opens_at,closes_at";

  function query(filter) {
    return fetch(CFG.url + "/rest/v1/votable_films?select=" + FIELDS + "&" + filter, {
      headers: headers(),
    }).then(function (res) {
      if (!res.ok) throw new Error("lookup failed: " + res.status);
      return res.json();
    });
  }

  // `now` lo legge Postgres, non il telefono: un apparecchio con l'orologio
  // sbagliato si vedrebbe altrimenti offrire film per cui il server poi
  // rifiuta il voto.
  function loadOpen() {
    return query("opens_at=lte.now&closes_at=gt.now&order=starts_at.asc,position.asc");
  }

  function loadBlock(code) {
    return query("screening=eq." + encodeURIComponent(code) + "&order=position.asc");
  }

  function postVote(slug, score) {
    return fetch(CFG.url + "/rest/v1/votes", {
      method: "POST",
      headers: Object.assign(headers(), { Prefer: "return=minimal" }),
      body: JSON.stringify({ film: slug, score: score, voter: voterId() }),
    });
  }

  /* -------------------------------------------------- formato */

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

  function blockLabel(film) {
    var bits = [film.screening_title];
    if (film.starts_at) bits.push(timeLabel(film.starts_at));
    return bits.join(" • ");
  }

  function fill(selector, text) {
    Array.prototype.forEach.call(root.querySelectorAll(selector), function (el) {
      el.textContent = text;
    });
  }

  /* -------------------------------------------------- arrivo */

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
    ? loadBlock(code).then(function (films) {
        // Nessun film in gara sotto quel codice: o il codice non esiste, o è
        // una retrospettiva. In sala la differenza non interessa a nessuno.
        if (!films.length) { show("none"); return; }

        var first = films[0];
        fill("[data-block]", blockLabel(first));
        fill("[data-opens]", timeLabel(first.opens_at));

        var now = Date.now();
        if (now < new Date(first.opens_at).getTime()) { show("early"); return; }
        if (now >= new Date(first.closes_at).getTime()) { show("closed"); return; }

        begin(films);
      })
    : loadOpen().then(function (films) {
        if (!films.length) { show("none"); return; }
        begin(films);
      });

  arrival.catch(function () { show("error"); });

  /* -------------------------------------------------- la lista */

  var open = [];
  var groupsEl = panels.films.querySelector("[data-groups]");
  var noteEl = panels.films.querySelector("[data-note]");

  function begin(films) {
    open = films;
    renderList();
    show("films");
  }

  function renderList() {
    var mine = myVotes();
    groupsEl.textContent = "";

    // Un gruppo per proiezione, nell'ordine in cui sono passate. Di norma ce
    // n'è uno solo; sabato tra le 17 e le 18 le finestre del Programma 3 e 4
    // si accavallano ed è giusto così, chi ha visto entrambi vota entrambi.
    var order = [];
    var byBlock = {};
    open.forEach(function (film) {
      if (!byBlock[film.screening]) {
        byBlock[film.screening] = [];
        order.push(film.screening);
      }
      byBlock[film.screening].push(film);
    });

    order.forEach(function (screening) {
      var head = document.createElement("p");
      head.className = "vote__group";
      head.textContent = blockLabel(byBlock[screening][0]);
      groupsEl.appendChild(head);

      var list = document.createElement("ul");
      list.className = "vote__list";

      byBlock[screening].forEach(function (film) {
        list.appendChild(row(film, mine[film.slug]));
      });

      groupsEl.appendChild(list);
    });
  }

  function row(film, score) {
    var li = document.createElement("li");
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "vote__pick";

    var title = document.createElement("span");
    title.className = "vote__pick-title";
    title.textContent = film.title;
    btn.appendChild(title);

    var meta = document.createElement("span");
    meta.className = "vote__pick-meta";
    meta.textContent = sectionLabel(film.section);
    btn.appendChild(meta);

    // Un film già votato resta in lista col suo voto invece di sparire: una
    // riga che manca si legge come "il festival ha perso il mio voto".
    if (score) {
      btn.disabled = true;
      btn.classList.add("is-voted");
      var mark = document.createElement("span");
      mark.className = "vote__pick-score";
      mark.textContent = score;
      btn.appendChild(mark);
      meta.textContent += " · " + t("vote.voted", "voted");
    } else {
      btn.addEventListener("click", function () { openScale(film); });
    }

    li.appendChild(btn);
    return li;
  }

  function note(text) {
    noteEl.textContent = text;
    noteEl.hidden = !text;
  }

  /* -------------------------------------------------- la scala */

  var scale = panels.open.querySelector("[data-scale]");
  var current = null;
  var sending = false;

  panels.open.querySelector("[data-back]").addEventListener("click", function () {
    show("films");
  });

  function openScale(film) {
    current = film;
    fill("[data-section]", sectionLabel(film.section));
    fill("[data-film]", film.title);
    fill("[data-where]", blockLabel(film));
    show("open");
  }

  scale.addEventListener("click", function (event) {
    var btn = event.target.closest("[data-score]");
    if (!btn || sending || !current) return;

    var film = current;
    var score = Number(btn.getAttribute("data-score"));

    sending = true;
    scale.setAttribute("aria-busy", "true");
    btn.classList.add("is-chosen");

    postVote(film.slug, score).then(function (res) {
      // 409 è il vincolo unique: questo dispositivo aveva già votato il film.
      // Per chi vota è la stessa cosa di un voto andato a segno.
      if (res.ok || res.status === 201 || res.status === 409) {
        remember(film.slug, score);
        renderList();

        var mine = myVotes();
        var left = open.filter(function (f) { return !mine[f.slug]; }).length;
        note(left
          ? t("vote.saved", "Vote saved for {film}.").replace("{film}", film.title)
          : t("vote.allDone", "You have rated every film of this screening. Thank you!"));

        show("films");
        return;
      }
      // RLS ha rifiutato l'insert, che qui vuol dire che la finestra si è
      // appena chiusa.
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
})();
