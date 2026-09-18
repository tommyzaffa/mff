-- La retrospettiva di venerdì mattina ha un film: WALL·E.
--
-- Il titolo dello screening non vive solo nel programma: è quello che l'ospite
-- legge sul biglietto, nella mail di conferma e sulla board di sala, quindi un
-- segnaposto come "venerdì 2 ottobre" sarebbe rimasto in mano al pubblico.
-- Cambiare il titolo non tocca i biglietti già emessi: li identifica il codice,
-- non il nome.

update public.screenings
   set title = 'Retrospettiva · WALL·E'
 where code = 'retro-b';
