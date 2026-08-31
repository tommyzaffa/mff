# Accrediti e prevendite — messa in opera

Tutto il backend del festival sta in un progetto Supabase solo. Il sito è statico
su GitHub Pages e non parla mai col database: passa sempre dalle Edge Function,
che sono le uniche a usare la service role.

---

## 1. Database

Lo schema sta in `migrations/`, già applicato al progetto **Merge Film Festival**
(`luciaehqndzdeszdktzp`, region eu-central-2 / Zurigo):

- `20260828100000_passes.sql` — tabelle, prezzi, codici d'invito, pool di 5000
  numeri badge, RLS, bucket di storage. Chiama da sola `pass_fill_badge_pool(5000)`.
- `20260828100100_audience_award.sql` — il premio del pubblico. Indipendente,
  non tocca nulla di `pass_*`.

Per riapplicare o aggiornare:

```bash
supabase link --project-ref luciaehqndzdeszdktzp
supabase db push
```

Verifiche rapide dopo il lancio:

```sql
select count(*) from pass_badge_codes;          -- 5000
select * from pass_kinds order by sort;         -- prezzi e lettere
select code, label, max_uses from pass_access_codes;
```

**Codice master interno** (già inserito): `MERGE-STAFF-MASTER-26`. Usi
illimitati, sblocca ogni tipo di pass. Serve a noi per emettere accrediti a mano
al banco. Non va distribuito. Per cambiarlo: inserisci il nuovo e metti
`is_active = false` sul vecchio.

**Lettere sui badge**: G guest, I industry, P press, D delegation, S sponsor,
**T staff** (la S era già presa da sponsor), M media.

---

## 2. Servizi esterni

### Stripe

1. Attiva l'account e passa in modalità live.
2. **Impostazioni → Metodi di pagamento**: accendi TWINT e le carte. Il codice
   non fissa i metodi, li prende da qui — così ne aggiungi uno senza toccare
   niente.
3. **Sviluppatori → Webhook → Aggiungi endpoint**:
   - URL: `https://<progetto>.supabase.co/functions/v1/pass-stripe-webhook`
   - Eventi: `checkout.session.completed`, `checkout.session.expired`
   - Copia il *signing secret* (`whsec_…`).
4. Copia la chiave segreta API (`sk_live_…`).

### Resend (email)

1. Crea l'account e verifica il dominio `mergefestival.ch` (3 record DNS: SPF,
   DKIM, e il MX per il bounce).
2. Crea una API key con permesso di sola *sending*.
3. Casella mittente consigliata: `accrediti@mergefestival.ch`.

### Google Wallet (facoltativo, gratis)

1. Google Pay & Wallet Console → richiedi l'accesso da emittente. Segnati
   l'**issuer ID**.
2. Google Cloud → crea un service account, dagli il ruolo *Wallet Object
   Issuer*, scarica la chiave JSON.
3. Il contenuto **intero** del JSON va nel secret `GOOGLE_WALLET_SERVICE_ACCOUNT`.

### Apple Wallet (facoltativo, a pagamento)

Serve un account Apple Developer (99 USD/anno). Se non lo apriamo, il bottone
"Aggiungi a Apple Wallet" semplicemente non compare: badge PDF e pagina web
funzionano lo stesso.

1. Certificates → identificatore **Pass Type ID** (es. `pass.ch.mergefestival.badge`).
2. Genera il certificato, esportalo in PEM: certificato e chiave privata separati.
3. Scarica anche il certificato **Apple WWDR G4** in PEM.

---

## 3. Secret delle Edge Function

`SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` li mette la piattaforma da sola.
Tutto il resto:

```bash
supabase link --project-ref <ref-del-progetto>

supabase secrets set \
  SITE_URL="https://mergefestival.ch" \
  STRIPE_SECRET_KEY="sk_live_…" \
  STRIPE_WEBHOOK_SECRET="whsec_…" \
  RESEND_API_KEY="re_…" \
  MAIL_FROM="Merge Film Festival <accrediti@mergefestival.ch>" \
  MAIL_REVIEW_TO="accrediti@mergefestival.ch"

# facoltativi
supabase secrets set \
  GOOGLE_WALLET_ISSUER_ID="…" \
  GOOGLE_WALLET_SERVICE_ACCOUNT="$(cat service-account.json)"

supabase secrets set \
  APPLE_TEAM_ID="…" \
  APPLE_PASS_TYPE_ID="pass.ch.mergefestival.badge" \
  APPLE_PASS_CERTIFICATE="$(cat pass-cert.pem)" \
  APPLE_PASS_KEY="$(cat pass-key.pem)" \
  APPLE_WWDR_CERTIFICATE="$(cat wwdr.pem)"
```

`MAIL_REVIEW_TO` è la casella dove arrivano le richieste stampa e industry da
approvare.

---

## 4. Deploy delle funzioni

```bash
supabase functions deploy pass-submit
supabase functions deploy pass-review
supabase functions deploy pass-badge
supabase functions deploy pass-stripe-webhook
supabase functions deploy pass-wallet
```

`config.toml` mette `verify_jwt = false` su tutte e cinque: nessuna è pubblica
"a vuoto", ognuna ha la sua credenziale (firma Stripe, token di 48 caratteri,
numero badge non indovinabile).

---

## 5. Sito

In `assets/js/passes-config.js` va solo l'URL del progetto:

```js
window.MFF_PASSES = { url: "https://<progetto>.supabase.co" };
```

Nel browser non finisce nessuna chiave, nemmeno la anon: le tabelle `pass_*`
hanno RLS accesa senza policy, quindi non servirebbe comunque a niente.

---

## 6. Gestionale (PoPaCi Studio)

La sezione è **Merge → Accrediti**. In `.env.local` del gestionale:

```
MFF_SUPABASE_URL=https://<progetto>.supabase.co
MFF_SUPABASE_SERVICE_ROLE_KEY=<service role del progetto festival>
```

Ci entrano Thomas, Francesco, Dario e Manila (`ACCREDITI_USERNAMES` in
`src/lib/constants.ts`). Gli altri che hanno accesso a Merge vedono la card col
lucchetto e, se ci cliccano, trovano la schermata di blocco.

Da lì si fa: elenco e ricerca di tutti i pass, statistiche e incassato,
approvazione/rifiuto delle richieste stampa e industry, apertura di foto e
documenti con link firmati a 10 minuti, creazione di codici d'invito (singoli o
serie monouso, es. 20 per una scuola) ed export CSV.

---

## 7. Prova prima di aprire le prevendite

Con Stripe in **modalità test** e la carta `4242 4242 4242 4242`:

1. Pass Guest normale → si arriva su Stripe, si paga, la pagina di ritorno gira
   qualche secondo e mostra il badge. Arriva l'email col link.
2. Pass Guest studente → chiede il documento, prezzo 30.
3. Pass Press → niente pagamento subito: arriva l'email a `MAIL_REVIEW_TO`.
   Approva dal gestionale o dal link nell'email → parte l'email col pagamento.
4. Pass Staff col codice master → badge emesso all'istante, zero franchi.
5. Codice a usi contati: creane uno da 2 usi, consumali, al terzo tentativo la
   pagina deve dire che il codice è esaurito.
6. Apri il badge sul telefono → "Salva come PDF" e il bottone del wallet.

---

## 8. Costi

Volume ipotizzato: qualche centinaio di pass venduti, sotto le 2000 email.

| Voce | Costo | Note |
|---|---|---|
| Supabase | **0** | Il piano gratuito basta (500 MB DB, 1 GB storage, 500k invocazioni). Se serve, il Pro è 25 USD/mese. |
| GitHub Pages | **0** | Il sito è già lì. |
| **Resend** | **0** | 3000 email/mese e 100/giorno sul piano gratuito. Sopra: 20 USD/mese per 50 000. |
| **Stripe** | **~2.9% + 0.30 CHF** a transazione | Su un pass da 40 CHF sono circa **1.46 CHF**. TWINT costa uguale. Nessun canone fisso. |
| Google Wallet | **0** | |
| Apple Wallet | **99 USD/anno** | Solo se vogliamo il bottone Apple. Facoltativo. |

Esempio concreto su **300 pass da 40 CHF** = 12 000 CHF incassati, di cui circa
**440 CHF** di commissioni Stripe. Tutto il resto è a zero, a meno di aprire
l'account Apple.

Sulle email: Resend è già il più economico della categoria (Postmark parte da 15
USD/mese, SendGrid da 20). Restiamo dentro il gratuito senza problemi finché non
superiamo le 100 email al giorno — se un giorno di punta sfondiamo quel tetto,
si passa al piano da 20 USD/mese per quel mese e basta.

---

## 9. Chiavi da procurare

- [ ] Stripe: `sk_live_…` e `whsec_…`
- [ ] Resend: `re_…` + dominio verificato
- [ ] (facolt.) Google Wallet: issuer ID + JSON del service account
- [ ] (facolt.) Apple Developer: 99 USD/anno, poi i tre PEM
- [ ] Service role del progetto festival, da mettere nel `.env.local` del gestionale
