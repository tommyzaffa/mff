/* ============================================================
   Merge Film Festival — accreditation endpoints

   Only the project URL lives here. The pass functions run with
   verify_jwt off and do their own checking, so no key is needed
   in the browser at all: the anon key would not open anything
   anyway (the pass tables have RLS on and no policy), and the
   service role key must never leave the server.
   ============================================================ */
window.MFF_PASSES = {
  url: "https://luciaehqndzdeszdktzp.supabase.co",

  // Flip to true once GOOGLE_WALLET_ISSUER_ID and GOOGLE_WALLET_SERVICE_ACCOUNT
  // are set: until then pass-wallet answers 501 and the button would be dead.
  // Apple Wallet is not offered at all — it needs a paid developer account.
  googleWallet: false,
};
