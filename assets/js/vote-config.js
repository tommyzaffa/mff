/* ============================================================
   Merge Film Festival — audience award endpoint

   These two values are meant to be public: the anon key only ever
   grants what the RLS policies in supabase/audience-award.sql allow,
   which is reading the published schedule and inserting one vote
   inside a screening's voting window. Never put the service role key
   in this file — it bypasses RLS entirely.
   ============================================================ */
window.MFF_VOTE = {
  url: "https://luciaehqndzdeszdktzp.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx1Y2lhZWhxbmR6ZGVzemRrdHpwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc5MTA4NzQsImV4cCI6MjEwMzQ4Njg3NH0.0ck_rcMJHQvBeKUSIYj2qzg4C5J2HHdKKnNf0hpxq6M",
};
