/* ============================================================
   Merge Film Festival — la cassa del Lux

   Una sola pagina, due cose: quanti biglietti restano da vendere
   per ogni proiezione, e un contatore + / − per registrare quelli
   venduti allo sportello.

   Il numero è affidabile perché la vendita online si chiude
   sessanta minuti prima dell'inizio: da quel momento nessuno
   può più prendere un posto dal sito, quindi quello che si legge
   qui è esattamente quello che il cinema può ancora vendere. Le
   proiezioni ancora in vendita online restano bloccate — la regola
   la applica la pagina, così nessuno se la deve ricordare.

   Il contatore manda +1 / −1, mai un totale: due persone allo
   stesso banco che premono insieme devono sommarsi, non
   sovrascriversi. Serve a noi per le presenze; i conti della
   vendita restano quelli della cassa del cinema.
   ============================================================ */
(function () {
  "use strict";

  var CFG = window.MFF_PASSES || {};
  var ENDPOINT = (CFG.url || "").replace(/\/+$/, "") + "/functions/v1/ticket-door";

  var panels = {};
  document.querySelectorAll("[data-panel]").forEach(function (el) {
    panels[el.getAttribute("data-panel")] = el;
  });

  var listEl = document.querySelector("[data-list]");
  var statusEl = document.querySelector("[data-status]");
  var loginForm = document.querySelector("[data-login]");
  var loginError = document.querySelector("[data-login-error]");

  var password = "";

  function show(name) {
    Object.keys(panels).forEach(function (k) { panels[k].hidden = k !== name; });
  }

  // sessionStorage e non localStorage: il tablet del banco passa di mano, e
  // chiudere la scheda deve bastare a uscire.
  try {
    password = sessionStorage.getItem("mff_door") || "";
  } catch (e) { /* modalità privata */ }

  function call(body) {
    return fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.assign({ password: password }, body || {})),
    }).then(function (r) { return r.json(); });
  }

  // --- login ----------------------------------------------------------------

  loginForm.addEventListener("submit", function (e) {
    e.preventDefault();
    loginError.textContent = "";
    password = loginForm.password.value;
    if (!password) return;

    loginForm.querySelector("button").disabled = true;
    call()
      .then(function (res) {
        loginForm.querySelector("button").disabled = false;
        if (!res.ok) {
          // A refused password and a broken server look the same from here
          // unless we say so, and whoever is holding the queue has no way to
          // guess which of the two they are looking at.
          loginError.textContent = res.error === "server_error"
            ? "Il server non risponde. Avvisa l'organizzazione."
            : "Password sbagliata.";
          return;
        }
        try { sessionStorage.setItem("mff_door", password); } catch (e2) {}
        render(res.screenings || []);
        show("board");
      })
      .catch(function () {
        loginForm.querySelector("button").disabled = false;
        loginError.textContent = "Nessuna connessione. Riprova.";
      });
  });

  // --- la lavagna -----------------------------------------------------------

  function timeText(iso) {
    try {
      return new Intl.DateTimeFormat("it-CH", {
        weekday: "short", day: "numeric", month: "short",
        hour: "2-digit", minute: "2-digit", timeZone: "Europe/Zurich",
      }).format(new Date(iso));
    } catch (e) { return iso; }
  }

  function hourText(iso) {
    try {
      return new Intl.DateTimeFormat("it-CH", {
        hour: "2-digit", minute: "2-digit", timeZone: "Europe/Zurich",
      }).format(new Date(iso));
    } catch (e) { return iso; }
  }

  function render(screenings) {
    listEl.innerHTML = "";

    if (!screenings.length) {
      var empty = document.createElement("li");
      empty.className = "door__empty";
      empty.textContent = "Nessuna proiezione nelle prossime ore.";
      listEl.appendChild(empty);
      return;
    }

    screenings.forEach(function (s) {
      var li = document.createElement("li");
      li.className = "door-show" + (s.unlocked ? "" : " is-locked");

      var when = document.createElement("p");
      when.className = "door-show__when";
      when.textContent = timeText(s.starts_at);
      li.appendChild(when);

      var title = document.createElement("h2");
      title.className = "door-show__title";
      title.textContent = s.title;
      li.appendChild(title);

      // Il numero grande è il solo dato che conta al banco: quanti biglietti
      // il cinema può ancora fare.
      var big = document.createElement("p");
      big.className = "door-show__left";
      big.textContent = String(s.seats_left);
      li.appendChild(big);

      var cap = document.createElement("p");
      cap.className = "door-show__caption";
      cap.textContent = s.unlocked
        ? "biglietti ancora vendibili in cassa"
        : "posti liberi — vendita online ancora aperta";
      li.appendChild(cap);

      if (!s.unlocked) {
        var lock = document.createElement("p");
        lock.className = "door-show__lock";
        lock.textContent = "Si può vendere dalle " + hourText(s.sales_close_at) + ".";
        li.appendChild(lock);
        listEl.appendChild(li);
        return;
      }

      var sold = document.createElement("p");
      sold.className = "door-show__sold";
      sold.textContent = "Venduti in cassa: " + s.door_sold;
      li.appendChild(sold);

      var row = document.createElement("div");
      row.className = "door-show__counter";

      var minus = step(s, -1, "−");
      var plus = step(s, +1, "+");
      minus.disabled = s.door_sold <= 0;
      plus.disabled = s.seats_left <= 0;

      row.appendChild(minus);
      row.appendChild(plus);
      li.appendChild(row);

      listEl.appendChild(li);
    });
  }

  function step(screening, delta, label) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "door-step" + (delta > 0 ? " door-step--plus" : "");
    btn.textContent = label;
    btn.addEventListener("click", function () {
      // Tutti i pulsanti si bloccano finché la risposta non arriva: la lavagna
      // viene ridisegnata sui numeri che torna il server, non su quelli che
      // avremmo indovinato qui.
      lock(true);
      statusEl.textContent = "";
      call({ action: "sell", screening: screening.code, delta: delta, actor: "cassa" })
        .then(function (res) {
          lock(false);
          if (!res.ok) {
            statusEl.textContent = res.error === "unauthorised"
              ? "Sessione scaduta: ricarica la pagina e rientra."
              : "Non registrato. Riprova.";
            return;
          }
          render(res.screenings || []);
        })
        .catch(function () {
          lock(false);
          statusEl.textContent = "Nessuna connessione. Il conteggio non è stato registrato.";
        });
    });
    return btn;
  }

  function lock(on) {
    listEl.querySelectorAll("button").forEach(function (b) { b.disabled = on; });
  }

  // --- aggiornamento --------------------------------------------------------

  function refresh() {
    return call()
      .then(function (res) {
        if (!res.ok) return show("login");
        render(res.screenings || []);
      })
      .catch(function () {
        statusEl.textContent = "Nessuna connessione.";
      });
  }

  document.querySelector("[data-refresh]").addEventListener("click", function () {
    statusEl.textContent = "";
    refresh();
  });

  // Ogni mezzo minuto, così due banchi aperti insieme non lavorano su numeri
  // diversi. Solo quando la pagina è davvero in mano a qualcuno.
  setInterval(function () {
    if (!document.hidden && !panels.board.hidden) refresh();
  }, 30000);

  // Un turno che ricarica la pagina non deve ridigitare la password.
  if (password) {
    call()
      .then(function (res) {
        if (!res.ok) return;
        render(res.screenings || []);
        show("board");
      })
      .catch(function () { /* si resta sul login */ });
  }
})();
