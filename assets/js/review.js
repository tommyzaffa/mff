/* ============================================================
   Merge Film Festival — press/industry approval page

   Staff-only, reached from the internal email. The token in the
   URL is the only credential; the decision is a POST so that a
   mail scanner following the link cannot approve anything.

   Values coming back from the API are written with textContent,
   never innerHTML: the applicant chose their own name and
   organisation, and this page is opened by us.
   ============================================================ */
(function () {
  "use strict";

  var base = (window.MFF_PASSES || {}).url;
  var endpoint = base + "/functions/v1/pass-review";
  var token = new URLSearchParams(window.location.search).get("t") || "";

  var titleEl = document.getElementById("title");
  var bodyEl = document.getElementById("body");

  function el(tag, text, className) {
    var node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function say(title, text, isError) {
    titleEl.textContent = title;
    bodyEl.textContent = "";
    bodyEl.appendChild(el("p", text, isError ? "error" : null));
  }

  var STATUS = {
    pending_review: "in attesa di valutazione",
    awaiting_payment: "in attesa di pagamento",
    paid: "pagata",
    issued: "già emessa",
    rejected: "rifiutata",
    cancelled: "annullata",
  };

  function problem(data, httpStatus) {
    if (data && data.error === "already") {
      say("Già gestita", "Questa richiesta è già stata gestita (stato: " +
        (STATUS[data.status] || data.status) + ").");
    } else if (data && data.error === "not_found") {
      say("Link non valido", "Questa richiesta non esiste più.", true);
    } else {
      say("Errore", "Qualcosa è andato storto (" + ((data && data.error) || httpStatus) + ").", true);
    }
  }

  function render(r) {
    titleEl.textContent = "Richiesta di accredito";
    bodyEl.textContent = "";

    var rows = [
      ["Nome", r.name],
      ["Email", r.email || "—"],
      ["Pass", r.pass],
      [r.orgLabel, r.org || "—"],
      ["Importo", "CHF " + (r.amountCents / 100).toFixed(2)],
      ["Richiesta", new Date(r.createdAt).toLocaleString("it-CH")],
    ];
    var table = el("table", null, "kv");
    rows.forEach(function (pair) {
      var tr = document.createElement("tr");
      tr.appendChild(el("th", pair[0]));
      tr.appendChild(el("td", pair[1]));
      table.appendChild(tr);
    });
    bodyEl.appendChild(table);

    if (r.photoUrl) {
      var img = el("img", null, "photo");
      img.src = r.photoUrl;
      img.alt = "Foto del richiedente";
      bodyEl.appendChild(img);
    }

    if (r.proofUrl) {
      var p = document.createElement("p");
      var a = el("a", "Apri il documento allegato");
      a.href = r.proofUrl;
      a.target = "_blank";
      a.rel = "noopener";
      p.appendChild(a);
      bodyEl.appendChild(p);
    }

    var label = el("label", "Nota (facoltativa, viene inclusa nell'email di rifiuto)", "note");
    var note = document.createElement("textarea");
    note.rows = 3;
    note.placeholder = "Es. posti stampa esauriti";
    label.appendChild(note);
    bodyEl.appendChild(label);

    var actions = el("div", null, "actions");
    var approve = el("button", "Approva", "ok");
    var reject = el("button", "Rifiuta", "no");
    actions.appendChild(approve);
    actions.appendChild(reject);
    bodyEl.appendChild(actions);

    function decide(action) {
      approve.disabled = reject.disabled = true;
      approve.textContent = action === "approve" ? "Attendere…" : "Approva";
      reject.textContent = action === "reject" ? "Attendere…" : "Rifiuta";

      fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: token, action: action, note: note.value }),
      })
        .then(function (res) {
          return res.json().then(function (data) { return { res: res, data: data }; });
        })
        .then(function (out) {
          if (!out.data || !out.data.ok) return problem(out.data, out.res.status);
          var d = out.data;
          if (d.result === "issued") {
            say("Approvata", d.name + " è stato approvato e il badge " + d.badge +
              " gli è già stato inviato per email.");
          } else if (d.result === "approved") {
            say("Approvata", d.name + " è stato approvato per il " + d.pass +
              ". Gli è appena partita l'email con il link di pagamento: il badge viene emesso da solo appena paga.");
          } else {
            say("Rifiutata", "La richiesta di " + d.name + " è stata rifiutata e gliel'abbiamo comunicato.");
          }
        })
        .catch(function () {
          approve.disabled = reject.disabled = false;
          approve.textContent = "Approva";
          reject.textContent = "Rifiuta";
          say("Errore", "Non sono riuscito a contattare il server. Riprova.", true);
        });
    }

    approve.addEventListener("click", function () { decide("approve"); });
    reject.addEventListener("click", function () { decide("reject"); });
  }

  if (!/^[a-f0-9]{48}$/.test(token)) {
    say("Link non valido", "Manca il codice della richiesta.", true);
    return;
  }

  fetch(endpoint + "?t=" + encodeURIComponent(token))
    .then(function (res) {
      return res.json().then(function (data) { return { res: res, data: data }; });
    })
    .then(function (out) {
      if (out.data && out.data.ok) render(out.data.request);
      else problem(out.data, out.res.status);
    })
    .catch(function () {
      say("Errore", "Non sono riuscito a contattare il server. Riprova.", true);
    });
})();
