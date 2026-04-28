document.addEventListener("DOMContentLoaded", () => {
    const TICKET_HOST_PATTERN = /jfcinema\.ch/i;

    // Detect language from <html lang="…">
    const pageLang = (document.documentElement.lang || "en").toLowerCase().slice(0, 2);

    const LANG_CODES = new Set(["it", "fr", "de"]);
    const SITE_ROOTS = new Set([
      "contact",
      "in_competition",
      "legal",
      "press",
      "program",
    ]);

    function getTermsUrl() {
      const segments = window.location.pathname
        .split("/")
        .filter(Boolean)
        .map((segment) => {
          try {
            return decodeURIComponent(segment);
          } catch (_) {
            return segment;
          }
        });

      const baseSegments = [];
      let langSegment = "";

      for (const segment of segments) {
        if (LANG_CODES.has(segment)) {
          langSegment = segment;
          break;
        }

        if (SITE_ROOTS.has(segment) || segment.endsWith(".html")) {
          break;
        }

        baseSegments.push(segment);
      }

      const termsSegments = [
        ...baseSegments,
        ...(langSegment ? [langSegment] : []),
        "legal",
        "terms.html",
      ];

      return "/" + termsSegments.join("/");
    }

    const TERMS_URL = getTermsUrl();

    const i18n = {
      en: {
        eyebrow: "External ticketing",
        title: "Before continuing",
        text: "To continue to the external ticketing website, please confirm that you have read and accepted the festival\u2019s terms and conditions.",
        label: "I have read and accepted the",
        terms: "Terms & Conditions",
        cancel: "Cancel",
        confirm: "Continue to tickets",
      },
      it: {
        eyebrow: "Biglietteria esterna",
        title: "Prima di continuare",
        text: "Per accedere al sito di biglietteria esterno, conferma di aver letto e accettato i termini e condizioni del festival.",
        label: "Ho letto e accetto i",
        terms: "Termini e Condizioni",
        cancel: "Annulla",
        confirm: "Continua all\u2019acquisto",
      },
      fr: {
        eyebrow: "Billetterie externe",
        title: "Avant de continuer",
        text: "Pour acc\u00e9der au site de billetterie externe, veuillez confirmer que vous avez lu et accept\u00e9 les conditions g\u00e9n\u00e9rales du festival.",
        label: "J\u2019ai lu et accept\u00e9 les",
        terms: "Conditions G\u00e9n\u00e9rales",
        cancel: "Annuler",
        confirm: "Continuer vers les billets",
      },
      de: {
        eyebrow: "Externe Ticketbuchung",
        title: "Bevor Sie fortfahren",
        text: "Um zur externen Ticketseite zu gelangen, best\u00e4tigen Sie bitte, dass Sie die allgemeinen Gesch\u00e4ftsbedingungen des Festivals gelesen und akzeptiert haben.",
        label: "Ich habe die",
        terms: "Allgemeinen Gesch\u00e4ftsbedingungen gelesen und akzeptiert",
        cancel: "Abbrechen",
        confirm: "Weiter zur Ticketbuchung",
      },
    };

    const t = i18n[pageLang] || i18n.en;

    const modal = document.createElement("div");
    modal.className = "ticket-modal";
    modal.setAttribute("aria-hidden", "true");

    modal.innerHTML = `
      <div class="ticket-modal__backdrop" data-close="true"></div>

      <div
        class="ticket-modal__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ticket-modal-title"
        aria-describedby="ticket-modal-text"
      >
        <div class="ticket-modal__body">
          <p class="ticket-modal__eyebrow">${t.eyebrow}</p>

          <h2 class="ticket-modal__title" id="ticket-modal-title">
            ${t.title}
          </h2>

          <p class="ticket-modal__text" id="ticket-modal-text">
            ${t.text}
          </p>

          <div class="ticket-modal__check">
            <input type="checkbox" id="ticket-consent-checkbox" />
            <label for="ticket-consent-checkbox">
              ${t.label}
              <a href="${TERMS_URL}" target="_blank" rel="noopener noreferrer">
                ${t.terms}
              </a>.
            </label>
          </div>

          <div class="ticket-modal__actions">
            <button type="button" class="ticket-modal__btn" data-close="true">
              ${t.cancel}
            </button>
            <button type="button" class="ticket-modal__btn ticket-modal__btn--primary" id="ticket-consent-confirm" disabled>
              ${t.confirm}
            </button>
          </div>
        </div>
      </div>
    `;
  
    document.body.appendChild(modal);
  
    const checkbox = modal.querySelector("#ticket-consent-checkbox");
    const confirmBtn = modal.querySelector("#ticket-consent-confirm");
    let pendingUrl = null;
  
    function openModal(url) {
      pendingUrl = url;
      checkbox.checked = false;
      confirmBtn.disabled = true;
      modal.classList.add("is-open");
      modal.setAttribute("aria-hidden", "false");
      document.body.classList.add("ticket-modal-open");
    }
  
    function closeModal() {
      pendingUrl = null;
      modal.classList.remove("is-open");
      modal.setAttribute("aria-hidden", "true");
      document.body.classList.remove("ticket-modal-open");
    }
  
    checkbox.addEventListener("change", () => {
      confirmBtn.disabled = !checkbox.checked;
    });
  
    confirmBtn.addEventListener("click", () => {
      if (!pendingUrl || !checkbox.checked) return;
      window.open(pendingUrl, "_blank", "noopener,noreferrer");
      closeModal();
    });
  
    modal.addEventListener("click", (event) => {
      const closeTrigger = event.target.closest("[data-close='true']");
      if (closeTrigger) closeModal();
    });
  
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && modal.classList.contains("is-open")) {
        closeModal();
      }
    });
  
    const ticketLinks = Array.from(document.querySelectorAll("a[href]")).filter((link) => {
      const href = link.getAttribute("href") || "";
      return TICKET_HOST_PATTERN.test(href);
    });
  
    ticketLinks.forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        openModal(link.href);
      });
    });
  });
