-- La retrospettiva di domenica mattina non c'è più.
--
-- È uscita dal programma il 28 settembre (sito e PDF), ma la riga in
-- `screenings` era rimasta pubblicata, quindi la pagina dei biglietti e il
-- form degli accreditati la offrivano ancora: si poteva prenotare un posto per
-- una proiezione che non si farà. Nessuno l'aveva fatto.
--
-- Non pubblicata invece che cancellata, come le prove nel seed del 2026: una
-- proiezione cancellata si porterebbe via i biglietti (`on delete cascade`), e
-- se mai qualcuno ne avesse uno deve restare traccia di cosa gli era stato dato.

update public.screenings
   set is_published = false
 where code = 'retro-d';
