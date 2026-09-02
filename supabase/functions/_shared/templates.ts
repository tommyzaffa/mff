// The four applicant-facing emails, in the four languages the site speaks.
//
// The applicant picked a language on the site and we stored it on the pass, so
// every message they get back is in that language. The one internal email (the
// approval request) is Italian only — it goes to the festival office.

import { esc, layout } from "./mail.ts";

export type Locale = "it" | "en" | "fr" | "de";

export function asLocale(value: unknown): Locale {
  return value === "en" || value === "fr" || value === "de" ? value : "it";
}

// Pass names, per language. `guest_student` deliberately reads as a guest pass
// with a student fare, because that is what it is.
const PASS_NAME: Record<Locale, Record<string, string>> = {
  it: {
    guest: "Pass Guest", guest_student: "Pass Guest — tariffa studenti",
    industry: "Pass Industry", press: "Pass Press", delegation: "Pass Delegation",
    sponsor: "Pass Sponsor", staff: "Pass Staff", media: "Pass Media",
  },
  en: {
    guest: "Guest Pass", guest_student: "Guest Pass — student fare",
    industry: "Industry Pass", press: "Press Pass", delegation: "Delegation Pass",
    sponsor: "Sponsor Pass", staff: "Staff Pass", media: "Media Pass",
  },
  fr: {
    guest: "Pass Guest", guest_student: "Pass Guest — tarif étudiant",
    industry: "Pass Industry", press: "Pass Presse", delegation: "Pass Délégation",
    sponsor: "Pass Sponsor", staff: "Pass Staff", media: "Pass Média",
  },
  de: {
    guest: "Guest-Pass", guest_student: "Guest-Pass — Studierendentarif",
    industry: "Industry-Pass", press: "Presse-Pass", delegation: "Delegations-Pass",
    sponsor: "Sponsoren-Pass", staff: "Staff-Pass", media: "Medien-Pass",
  },
};

export function passName(type: string, locale: Locale): string {
  return PASS_NAME[locale][type] ?? PASS_NAME.it[type] ?? type;
}

const COPY = {
  it: {
    hi: (n: string) => `Ciao ${n},`,
    receivedSubject: (p: string) => `Richiesta ricevuta — ${p}`,
    receivedHeading: "Abbiamo ricevuto la tua richiesta",
    receivedBody: (p: string) =>
      `la tua richiesta per il <strong>${p}</strong> è arrivata. La valutiamo entro pochi giorni
       lavorativi e ti scriviamo appena decidiamo. Se viene approvata, riceverai un link per
       completare il pagamento e ottenere il badge.`,

    approvedSubject: (p: string) => `Richiesta approvata — ${p}`,
    approvedHeading: "Richiesta approvata",
    approvedBody: (p: string, price: string) =>
      `la tua richiesta per il <strong>${p}</strong> è stata approvata. Per attivare
       l'accredito manca solo il pagamento di <strong>${price}</strong>. Il link qui sotto è
       personale: non condividerlo.`,
    approvedCta: "Completa il pagamento",

    rejectedSubject: (p: string) => `Richiesta non accolta — ${p}`,
    rejectedHeading: "Richiesta non accolta",
    rejectedBody: (p: string) =>
      `dopo averla valutata, non possiamo accogliere la tua richiesta per il <strong>${p}</strong>.
       Non è un giudizio sul tuo lavoro: i posti riservati a stampa e industry sono limitati.
       Sei naturalmente il benvenuto con un Pass Guest.`,
    rejectedNote: (n: string) => `Nota della redazione: ${n}`,
    rejectedCta: "Vedi i pass disponibili",

    issuedSubject: (p: string) => `Il tuo ${p} è pronto`,
    issuedHeading: "Il tuo pass è pronto",
    issuedBody: (p: string, code: string) =>
      `il tuo <strong>${p}</strong> è attivo. Il badge digitale è qui sotto: aprilo dal telefono
       e aggiungilo alla schermata home, così ce l'hai sempre con te, anche senza connessione.
       Il tuo codice di accredito è <strong style="letter-spacing:.06em">${code}</strong>.`,
    issuedCta: "Apri il badge",
    issuedFoot:
      `Puoi anche ritirare il badge fisico al Cinema Lux dal primo giorno di festival:
       ti basta mostrare questo codice. Conserva questa email, è il tuo unico accesso al badge.`,
  },

  en: {
    hi: (n: string) => `Hi ${n},`,
    receivedSubject: (p: string) => `Request received — ${p}`,
    receivedHeading: "We have your request",
    receivedBody: (p: string) =>
      `your request for the <strong>${p}</strong> has arrived. We review it within a few working
       days and write back as soon as we decide. If it is approved you will get a link to complete
       the payment and collect your badge.`,

    approvedSubject: (p: string) => `Request approved — ${p}`,
    approvedHeading: "Request approved",
    approvedBody: (p: string, price: string) =>
      `your request for the <strong>${p}</strong> has been approved. All that is left is the
       <strong>${price}</strong> payment. The link below is personal — please do not share it.`,
    approvedCta: "Complete the payment",

    rejectedSubject: (p: string) => `Request not accepted — ${p}`,
    rejectedHeading: "Request not accepted",
    rejectedBody: (p: string) =>
      `having reviewed it, we cannot accept your request for the <strong>${p}</strong>.
       It is not a judgement on your work: press and industry places are limited.
       You are of course very welcome with a Guest Pass.`,
    rejectedNote: (n: string) => `Note from the office: ${n}`,
    rejectedCta: "See the available passes",

    issuedSubject: (p: string) => `Your ${p} is ready`,
    issuedHeading: "Your pass is ready",
    issuedBody: (p: string, code: string) =>
      `your <strong>${p}</strong> is active. Your digital badge is below: open it on your phone
       and add it to the home screen, so it is always with you, even offline.
       Your accreditation code is <strong style="letter-spacing:.06em">${code}</strong>.`,
    issuedCta: "Open the badge",
    issuedFoot:
      `You can also pick up a physical badge at Cinema Lux from the first day of the festival —
       just show this code. Keep this email: it is your only way back to the badge.`,
  },

  fr: {
    hi: (n: string) => `Bonjour ${n},`,
    receivedSubject: (p: string) => `Demande reçue — ${p}`,
    receivedHeading: "Nous avons bien reçu votre demande",
    receivedBody: (p: string) =>
      `votre demande de <strong>${p}</strong> nous est bien parvenue. Nous l'examinons sous
       quelques jours ouvrables et vous écrivons dès que la décision est prise. Si elle est
       acceptée, vous recevrez un lien pour finaliser le paiement et obtenir votre badge.`,

    approvedSubject: (p: string) => `Demande acceptée — ${p}`,
    approvedHeading: "Demande acceptée",
    approvedBody: (p: string, price: string) =>
      `votre demande de <strong>${p}</strong> a été acceptée. Il ne reste que le paiement de
       <strong>${price}</strong>. Le lien ci-dessous est personnel : merci de ne pas le partager.`,
    approvedCta: "Finaliser le paiement",

    rejectedSubject: (p: string) => `Demande non retenue — ${p}`,
    rejectedHeading: "Demande non retenue",
    rejectedBody: (p: string) =>
      `après examen, nous ne pouvons pas retenir votre demande de <strong>${p}</strong>.
       Ce n'est pas un jugement sur votre travail : les places presse et industry sont limitées.
       Vous êtes bien sûr le bienvenu avec un Pass Guest.`,
    rejectedNote: (n: string) => `Note du bureau : ${n}`,
    rejectedCta: "Voir les pass disponibles",

    issuedSubject: (p: string) => `Votre ${p} est prêt`,
    issuedHeading: "Votre pass est prêt",
    issuedBody: (p: string, code: string) =>
      `votre <strong>${p}</strong> est actif. Votre badge numérique est ci-dessous : ouvrez-le
       depuis votre téléphone et ajoutez-le à l'écran d'accueil, vous l'aurez toujours
       sur vous, même hors connexion.
       Votre code d'accréditation est <strong style="letter-spacing:.06em">${code}</strong>.`,
    issuedCta: "Ouvrir le badge",
    issuedFoot:
      `Vous pouvez aussi retirer un badge physique au Cinema Lux dès le premier jour du festival,
       sur présentation de ce code. Conservez cet e-mail : c'est votre seul accès au badge.`,
  },

  de: {
    hi: (n: string) => `Hallo ${n},`,
    receivedSubject: (p: string) => `Anfrage erhalten — ${p}`,
    receivedHeading: "Wir haben deine Anfrage erhalten",
    receivedBody: (p: string) =>
      `deine Anfrage für den <strong>${p}</strong> ist eingegangen. Wir prüfen sie innerhalb
       weniger Arbeitstage und melden uns, sobald wir entschieden haben. Bei einer Zusage
       bekommst du einen Link, um die Zahlung abzuschliessen und dein Badge zu erhalten.`,

    approvedSubject: (p: string) => `Anfrage bestätigt — ${p}`,
    approvedHeading: "Anfrage bestätigt",
    approvedBody: (p: string, price: string) =>
      `deine Anfrage für den <strong>${p}</strong> wurde bestätigt. Es fehlt nur noch die
       Zahlung von <strong>${price}</strong>. Der Link unten ist persönlich — bitte nicht teilen.`,
    approvedCta: "Zahlung abschliessen",

    rejectedSubject: (p: string) => `Anfrage nicht angenommen — ${p}`,
    rejectedHeading: "Anfrage nicht angenommen",
    rejectedBody: (p: string) =>
      `nach der Prüfung können wir deine Anfrage für den <strong>${p}</strong> leider nicht
       annehmen. Das ist kein Urteil über deine Arbeit: die Plätze für Presse und Industry sind
       begrenzt. Mit einem Guest-Pass bist du selbstverständlich herzlich willkommen.`,
    rejectedNote: (n: string) => `Anmerkung des Büros: ${n}`,
    rejectedCta: "Verfügbare Pässe ansehen",

    issuedSubject: (p: string) => `Dein ${p} ist bereit`,
    issuedHeading: "Dein Pass ist bereit",
    issuedBody: (p: string, code: string) =>
      `dein <strong>${p}</strong> ist aktiv. Dein digitales Badge findest du unten: öffne es am
       Handy und lege es auf den Homescreen — so hast du es immer dabei, auch offline.
       Dein Akkreditierungscode lautet <strong style="letter-spacing:.06em">${code}</strong>.`,
    issuedCta: "Badge öffnen",
    issuedFoot:
      `Ab dem ersten Festivaltag kannst du im Cinema Lux auch ein physisches Badge abholen —
       zeig einfach diesen Code. Bewahre diese E-Mail auf: sie ist dein einziger Zugang zum Badge.`,
  },
} as const;

const LOCALE_NAME: Record<Locale, string> = {
  it: "Italiano",
  en: "Inglese",
  fr: "Francese",
  de: "Tedesco",
};

function money(cents: number): string {
  return `CHF ${(cents / 100).toFixed(2).replace(/\.00$/, ".–")}`;
}

// --- the four applicant emails ---------------------------------------------

export function receivedEmail(o: { name: string; type: string; locale: Locale }) {
  const t = COPY[o.locale];
  const p = passName(o.type, o.locale);
  return {
    subject: t.receivedSubject(p),
    html: layout({
      locale: o.locale,
      preheader: t.receivedHeading,
      heading: t.receivedHeading,
      body: `<p style="margin:0 0 12px">${esc(t.hi(o.name))}</p><p style="margin:0">${t.receivedBody(esc(p))}</p>`,
    }),
  };
}

export function approvedEmail(
  o: { name: string; type: string; locale: Locale; payUrl: string; amountCents: number },
) {
  const t = COPY[o.locale];
  const p = passName(o.type, o.locale);
  return {
    subject: t.approvedSubject(p),
    html: layout({
      locale: o.locale,
      preheader: t.approvedHeading,
      heading: t.approvedHeading,
      body: `<p style="margin:0 0 12px">${esc(t.hi(o.name))}</p><p style="margin:0">${
        t.approvedBody(esc(p), money(o.amountCents))
      }</p>`,
      cta: { label: t.approvedCta, href: o.payUrl },
    }),
  };
}

export function rejectedEmail(
  o: { name: string; type: string; locale: Locale; note?: string | null; passesUrl: string },
) {
  const t = COPY[o.locale];
  const p = passName(o.type, o.locale);
  const note = o.note?.trim()
    ? `<p style="margin:14px 0 0;padding:12px 14px;background:#f6f4f0;border-radius:12px">${
      esc(t.rejectedNote(o.note.trim()))
    }</p>`
    : "";
  return {
    subject: t.rejectedSubject(p),
    html: layout({
      locale: o.locale,
      preheader: t.rejectedHeading,
      heading: t.rejectedHeading,
      body: `<p style="margin:0 0 12px">${esc(t.hi(o.name))}</p><p style="margin:0">${
        t.rejectedBody(esc(p))
      }</p>${note}`,
      cta: { label: t.rejectedCta, href: o.passesUrl },
    }),
  };
}

export function issuedEmail(
  o: { name: string; type: string; locale: Locale; badgeCode: string; badgeUrl: string },
) {
  const t = COPY[o.locale];
  const p = passName(o.type, o.locale);
  return {
    subject: t.issuedSubject(p),
    html: layout({
      locale: o.locale,
      preheader: t.issuedHeading,
      heading: t.issuedHeading,
      body: `<p style="margin:0 0 12px">${esc(t.hi(o.name))}</p><p style="margin:0">${
        t.issuedBody(esc(p), esc(o.badgeCode))
      }</p>`,
      cta: { label: t.issuedCta, href: o.badgeUrl },
      footnote: t.issuedFoot,
    }),
  };
}

// --- the internal one -------------------------------------------------------

// Goes to the festival office with the two buttons that decide the outcome, so
// press and industry requests can be handled without opening the dashboard.
export function reviewRequestEmail(o: {
  name: string;
  email: string;
  type: string;
  org: string | null;
  locale: Locale;
  amountCents: number;
  reviewUrl: string;
  photoUrl: string | null;
}) {
  const p = passName(o.type, "it");
  const rows: [string, string][] = [
    ["Nome", o.name],
    ["Email", o.email],
    ["Pass", p],
    [o.type === "press" ? "Testata" : "Casa di produzione", o.org || "—"],
    ["Da pagare", o.amountCents > 0 ? money(o.amountCents) : "Gratuito"],
    // Whoever writes the rejection note by hand needs to know which language
    // the applicant will read it in.
    ["Lingua", LOCALE_NAME[o.locale]],
  ];

  // Photo on the left, details on the right: the face is the first thing the
  // office checks, and a press card is easier to judge next to a name.
  const cells = rows
    .map(([k, v]) =>
      `<tr><td style="padding:5px 12px 5px 0;color:#6b6b75;white-space:nowrap">${esc(k)}</td>
        <td style="padding:5px 0;font-weight:600">${esc(v)}</td></tr>`
    )
    .join("");

  const details =
    `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14.5px">${cells}</table>`;

  const body = o.photoUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
         <td width="104" valign="top" style="padding-right:18px">
           <img src="${esc(o.photoUrl)}" alt="" width="104"
                style="display:block;width:104px;border-radius:14px;border:1px solid #e9e7e2">
         </td>
         <td valign="top">${details}</td>
       </tr></table>`
    : details;

  return {
    subject: `Da approvare — ${p} · ${o.name}`,
    html: layout({
      preheader: `${p} · ${o.name}${o.org ? ` · ${o.org}` : ""}`,
      heading: "Nuova richiesta di accredito",
      body,
      cta: { label: "Approva o rifiuta", href: o.reviewUrl },
      footnote:
        "Il link apre una pagina con i due pulsanti. Se approvi, al richiedente parte in automatico l'email con il link di pagamento, nella sua lingua.",
      why: "Email interna del sistema accrediti del Merge Film Festival.",
    }),
  };
}

// --- the ticket email -------------------------------------------------------

// Times are always written in the festival's own timezone, never the reader's:
// somebody booking from Paris must not be told the film starts at 19:30.
const ZONE = "Europe/Zurich";
const DATE_LOCALE: Record<Locale, string> = {
  it: "it-CH",
  en: "en-GB",
  fr: "fr-CH",
  de: "de-CH",
};

export function whenText(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(DATE_LOCALE[locale], {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: ZONE,
  }).format(new Date(iso));
}

const TICKET_COPY: Record<Locale, {
  subject: (title: string) => string;
  heading: string;
  hi: (n: string) => string;
  body: (n: number) => string;
  seatsLabel: string;
  freeSeat: string;
  cta: string;
  foot: string;
}> = {
  it: {
    subject: (t) => `Il tuo posto — ${t}`,
    heading: "Posto confermato",
    hi: (n) => `Ciao ${n},`,
    body: (n) =>
      n === 1
        ? "il tuo posto è prenotato. Mostra il biglietto qui sotto all'ingresso della sala."
        : `i tuoi ${n} posti sono prenotati. Mostra i biglietti qui sotto all'ingresso della sala.`,
    seatsLabel: "I tuoi biglietti",
    freeSeat: "Incluso nell'accredito",
    cta: "Apri il biglietto",
    foot:
      `Il posto in sala è garantito ma non numerato: puoi sederti dove preferisci.
       Ti consigliamo di arrivare qualche minuto prima. Ogni biglietto vale per una
       persona e può essere usato una volta sola.`,
  },
  en: {
    subject: (t) => `Your seat — ${t}`,
    heading: "Seat confirmed",
    hi: (n) => `Hi ${n},`,
    body: (n) =>
      n === 1
        ? "your seat is booked. Show the ticket below at the door."
        : `your ${n} seats are booked. Show the tickets below at the door.`,
    seatsLabel: "Your tickets",
    freeSeat: "Included with your accreditation",
    cta: "Open the ticket",
    foot:
      `Your place in the room is guaranteed but not numbered — sit wherever you like.
       Please arrive a few minutes early. Each ticket admits one person and can only
       be used once.`,
  },
  fr: {
    subject: (t) => `Votre place — ${t}`,
    heading: "Place confirmée",
    hi: (n) => `Bonjour ${n},`,
    body: (n) =>
      n === 1
        ? "votre place est réservée. Présentez le billet ci-dessous à l'entrée de la salle."
        : `vos ${n} places sont réservées. Présentez les billets ci-dessous à l'entrée de la salle.`,
    seatsLabel: "Vos billets",
    freeSeat: "Inclus dans votre accréditation",
    cta: "Ouvrir le billet",
    foot:
      `Votre place est garantie mais non numérotée : asseyez-vous où vous voulez.
       Merci d'arriver quelques minutes en avance. Chaque billet admet une personne
       et ne peut être utilisé qu'une seule fois.`,
  },
  de: {
    subject: (t) => `Dein Platz — ${t}`,
    heading: "Platz bestätigt",
    hi: (n) => `Hallo ${n},`,
    body: (n) =>
      n === 1
        ? "dein Platz ist reserviert. Zeig das Ticket unten am Saaleingang."
        : `deine ${n} Plätze sind reserviert. Zeig die Tickets unten am Saaleingang.`,
    seatsLabel: "Deine Tickets",
    freeSeat: "In deiner Akkreditierung enthalten",
    cta: "Ticket öffnen",
    foot:
      `Dein Platz im Saal ist garantiert, aber nicht nummeriert — setz dich, wohin du
       möchtest. Bitte komm ein paar Minuten früher. Jedes Ticket gilt für eine Person
       und kann nur einmal verwendet werden.`,
  },
};

// One email for the whole order, but one block per ticket: the people on it may
// well arrive separately, so each has to be forwardable on its own.
export function ticketsEmail(o: {
  name: string;
  locale: Locale;
  screeningTitle: string;
  startsAt: string;
  venue: string | null;
  amountCents: number;
  tickets: { code: string; url: string; holder: string | null; badge: string | null }[];
}) {
  const t = TICKET_COPY[o.locale];

  const blocks = o.tickets
    .map((tk) => {
      const who = tk.holder
        ? `<div style="font-size:13px;color:#6b6b75;margin:0 0 2px">${esc(tk.holder)}</div>`
        : "";
      const free = tk.badge
        ? `<div style="font-size:12.5px;color:#6b6b75;margin:6px 0 0">${esc(t.freeSeat)} · ${
          esc(tk.badge)
        }</div>`
        : "";
      return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%"
                     style="margin:0 0 10px;background:#f6f4f0;border-radius:14px">
                <tr><td style="padding:14px 16px">
                  ${who}
                  <div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
                              font-size:19px;font-weight:700;letter-spacing:.06em">${esc(tk.code)}</div>
                  <div style="margin:8px 0 0"><a href="${esc(tk.url)}"
                       style="color:#2E1B54;font-weight:600;font-size:14px">${esc(t.cta)} →</a></div>
                  ${free}
                </td></tr>
              </table>`;
    })
    .join("");

  const where = o.venue ? ` · ${o.venue}` : "";

  return {
    subject: t.subject(o.screeningTitle),
    html: layout({
      locale: o.locale,
      preheader: `${o.screeningTitle} · ${whenText(o.startsAt, o.locale)}`,
      heading: t.heading,
      body:
        `<p style="margin:0 0 12px">${esc(t.hi(o.name))}</p>
         <p style="margin:0 0 18px">${esc(t.body(o.tickets.length))}</p>
         <p style="margin:0 0 4px;font-size:17px;font-weight:700">${esc(o.screeningTitle)}</p>
         <p style="margin:0 0 18px;color:#6b6b75">${
          esc(whenText(o.startsAt, o.locale) + where)
        }</p>
         <p style="margin:0 0 8px;font-weight:600">${esc(t.seatsLabel)}</p>
         ${blocks}`,
      footnote: t.foot,
    }),
  };
}
