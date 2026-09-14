# Verifica /scan e /door — 14 settembre 2026

Il flusso principale funziona, verificato sia nei test locali sia eseguendo le funzioni sul database reale. Sono stati trovati e corretti alcuni problemi operativi. **Le correzioni fanno parte del rilascio autorizzato il 14 settembre 2026.** Il controllo non sostituisce una prova con telefoni e connessione del cinema.

## Regole verificate

| Titolo presentato | Esito |
| --- | --- |
| Biglietto pagato, proiezione corretta | Entra; una sola registrazione |
| Biglietto per un'altra proiezione | Rifiutato senza consumarlo |
| Stesso biglietto una seconda volta | Già entrato |
| Badge valido con prenotazione per la proiezione | Entra; il QR del relativo biglietto condivide lo stesso ingresso |
| Badge valido senza prenotazione | Accredito senza posto |
| Badge usato su due proiezioni prenotate | Un ingresso distinto per ciascuna |
| Giornaliera pagata | Un ingresso per ciascuna proiezione inclusa all'acquisto |
| Giornaliera per un altro giorno o per un film escluso | Rifiutata senza consumare gli altri ingressi |
| Ordine non pagato o annullato | Rifiutato |
| Acquisto per più persone | Codici utilizzabili separatamente |
| Biglietto ridotto / carrozzina | Segnalazione restituita allo staff |
| Vendita alla cassa prima della chiusura online | Bloccata anche dal database |
| Sala piena / annullamento di una tariffa senza vendite | Bloccato anche dal database |

**Un badge non è un ingresso automatico.** Il posto va prenotato online prima della chiusura delle vendite, normalmente un'ora prima. `/door` registra vendite intere/ridotte: non offre una funzione per assegnare gratuitamente un posto a un accreditato arrivato senza prenotazione. Questa eventualità richiede una procedura concordata con l'organizzazione.

La giornaliera copre le proiezioni ancora prenotabili al momento dell'acquisto, non automaticamente tutti i film del giorno. Il messaggio nello scanner ora dice “Giornaliera non valida qui”, evitando di indicare falsamente un giorno diverso.

## Problemi corretti

- Scansione manuale ripetuta e cambio proiezione durante una richiesta: ora una richiesta per volta, con comandi bloccati fino all'esito.
- Permesso telecamera che arriva dopo aver lasciato lo scanner: le tracce vengono chiuse; le risposte di una precedente sessione non modificano quella nuova. Ripristino della pagina dalla cache del browser gestito.
- Elenco proiezioni senza aggiornamento: aggiunto Aggiorna, con selezione sospesa durante la richiesta.
- Disponibilità di `AbortSignal.timeout`: sostituita con un timeout tramite AbortController per supportare anche browser che non espongono quel metodo.
- Lettore QR dipendente da una CDN: jsQR 1.4.0 è incluso nel sito, con licenza Apache 2.0 e identico hash di integrità. Il guasto del lettore ha un messaggio e resta disponibile il codice manuale.
- Aggiornamento periodico della cassa sovrapposto alla vendita: richieste serializzate; nessuna risposta vecchia può sovrascrivere il risultato di una vendita concorrente dello stesso dispositivo.
- Risposta persa alla cassa: il movimento ha un identificativo persistito nella sessione. Aggiorna e il ripristino dopo reload recuperano lo stesso movimento. La nuova funzione SQL registra risultato e vendita nella stessa transazione, senza duplicarli ai tentativi successivi.
- Pulsanti riattivati indiscriminatamente dopo un errore: ora i conteggi devono essere riletti; sottrazioni impossibili e sala piena restano bloccate.
- Server vecchio: la nuova cassa verifica il supporto al recupero dei movimenti prima di abilitare vendite.
- Giornaliera sconosciuta/non pagata/annullata: motivi distinti dal semplice mancato posto nella proiezione.
- Accredito revocato: anche il suo biglietto derivato viene rifiutato. La proiezione è obbligatoria anche nella funzione SQL.

## Verifiche eseguite

- **31 test PostgreSQL isolati**, con tutte le migrazioni applicate: prenotazioni, emissione, badge, giornaliere, posti, annullamenti, tariffe, permessi e recupero dei movimenti.
- **15 test Deno**, con rete simulata: handler effettivi, credenziali, sessioni, validazione richieste, instradamento dei tre codici e dei movimenti della cassa, controlli già esistenti sui pagamenti.
- **14 test browser Chrome**, viewport mobile: login, inserimento manuale, errori di rete, lettura QR con generatore effettivo e colori del sito, QR nel flusso video tramite MediaStream sintetico, chiusura telecamera, selezione proiezione, cassa e recupero dopo reload. Nessun errore JavaScript non gestito.
- **Prova sul database Supabase reale**, tramite `tests/staff_live_smoke.sql`: prenotazione/emissione, biglietto non pagato, film sbagliato, ingresso corretto e duplicato, badge senza/con prenotazione, equivalenza badge/biglietto, giornaliera su due film, giorno sbagliato e limiti della cassa. Transazione annullata: zero proiezioni, ordini o pass di prova rimasti. Nessuna email o pagamento esterno.
- **Online, in lettura:** 10 proiezioni a pagamento pubblicate, inclusa la premiazione; capienza 273 + 2 spazi carrozzina; nessun codice di formato incompatibile, duplicato di prenotazione per badge/giornaliera, conteggio negativo o sovracapienza. Al momento della verifica risultano zero biglietti attivi emessi.
- `ticket-door` attivo, risposta 401 senza credenziali, `DOOR_PASSWORD` presente nei metadati dei secret. Tutte le migrazioni antecedenti a questa verifica risultano applicate.

La prova sul database reale è stata ripetuta dopo la pubblicazione della nuova migrazione, includendo recupero idempotente della vendita, rifiuto del riutilizzo di un identificativo con parametri diversi, revoca del badge e proiezione obbligatoria. Sono rimasti zero record di prova anche nel registro dei tentativi. Non è stato effettuato un login online con la password dello staff né un check-in HTTP reale. Non è stato effettuato un test di carico o un test con più connessioni PostgreSQL simultanee: i lock sono stati verificati nel codice, mentre PGlite serializza le richieste.

## Pubblicazione e prova finale

Il rilascio applica nell’ordine: migrazione `20260914120000_staff_reliability.sql`, Edge Function `ticket-door`, poi sito statico con `staff-api.js`, jsQR locale e pagine aggiornate. Ricaricare le schede già aperte. La nuova cassa tiene bloccate le vendite se rileva il backend precedente.

Prima dell'impiego al festival, fare una prova con almeno due telefoni effettivamente destinati allo staff, su HTTPS e sul Wi-Fi/rete mobile del cinema: stesso QR su due dispositivi, badge prenotato/non prenotato, giornaliera, cambio film, perdita della rete e recupero della vendita. Usare uno staging o una sessione di collaudo organizzata con dati di prova. Non usare biglietti degli spettatori per verifiche esplorative.

Indicazioni per il turno:

1. In `/scan`, scegliere sempre la proiezione corretta. L'elenco mostra gli eventi nelle prossime 18 ore e fino a 45 minuti dopo l'inizio; lontano dal festival è normale trovarlo vuoto.
2. Verde: ingresso registrato. Ridotto: controllare il documento. Badge: controllare l'intestatario secondo la procedura del cinema.
3. “Già entrato”: controllare l'orario; non far passare automaticamente. Dopo una risposta persa potrebbe essere la propria prima scansione già registrata.
4. Senza rete lo scanner non autorizza ingressi. Usare il codice manuale se il QR o la telecamera non funzionano: anche questa verifica richiede connessione.
5. In `/door`, usare Intero/Ridotto per ogni vendita e “−” sulla tariffa corretta per correggerla. Dopo un esito incerto premere Aggiorna, evitando di registrare un nuovo movimento dalla stessa o da un'altra postazione finché non è chiarito.
6. Gli “entrati” dello scanner contano i check-in dei titoli online; `/door` conta le vendite al banco. Non sono lo stesso contatore e `/door` non emette QR.
7. Sessione staff di 8 ore: al messaggio di scadenza rientrare con la password. Tenere caricatore/powerbank disponibile.

## Ripetere i test locali

```sh
npm install --prefix supabase/tests
npm test --prefix supabase/tests
DENO_NO_PACKAGE_JSON=1 deno test --no-config --no-lock --allow-env supabase/tests/*_test.ts
cd supabase/tests
npx playwright install chromium
npm run test:browser
```

Il test browser serve i file in locale e intercetta tutte le chiamate esterne: non contatta i servizi di produzione. È possibile specificare `MFF_CHROME_PATH` per un Chrome già installato. La prova SQL online è separata e non fa parte della suite automatica.
