import { boundedRequest, RequestError, passwordMatches, paymentMatches } from "../functions/_shared/request.ts";
function assert(condition: unknown) { if (!condition) throw new Error("assertion failed"); }
Deno.test("password rejects empty, wrong, coerced and missing credentials", () => {
  for (const v of [undefined, null, '', 123, {}, ['correct'], 'correc', 'Correct']) assert(!passwordMatches(v, 'correct'));
  assert(!passwordMatches('', ''));
  assert(passwordMatches('correct', 'correct'));
});
Deno.test("payment must match exact session, CHF amount and paid state", () => {
  const order = { stripe_session_id: 'cs_test', amount_cents: 4000 };
  const s = { id: 'cs_test', amount_total: 4000, currency: 'chf', payment_status: 'paid' };
  assert(paymentMatches(s, order));
  for (const change of [{id:'another'}, {amount_total:0}, {amount_total:3999}, {amount_total:4001}, {amount_total:'4000'}, {currency:'usd'}, {payment_status:'unpaid'}]) assert(!paymentMatches({...s,...change},order));
  assert(!paymentMatches(s,{...order,stripe_session_id:null}));
});
Deno.test("bounds chunked body even with a lying Content-Length", async () => {
  for (const headers of [new Headers(), new Headers({'content-length':'1'})]) {
    const req = new Request('https://example.test', {method:'POST',body:'123456',headers});
    try { await boundedRequest(req,5); throw new Error('accepted oversize'); }
    catch(e) { assert(e instanceof RequestError && e.status === 413); }
  }
});
Deno.test("bounded body preserves multipart files and JSON", async () => {
  const f = new FormData(); f.set('name','Test'); f.set('photo',new File(['abc'],'photo.png',{type:'image/png'}));
  const req = await boundedRequest(new Request('https://example.test',{method:'POST',body:f}),4096);
  const out = await req.formData(); assert(out.get('name')==='Test'); assert(await (out.get('photo') as File).text()==='abc');
  const j = await boundedRequest(new Request('https://example.test',{method:'POST',body:'{"x":1}'}),7);
  assert((await j.json()).x===1);
});

import { createDoorSession, validDoorSession } from "../functions/_shared/door-session.ts";
Deno.test("staff session is signed, expires after eight hours and rejects tampering/rotation", async () => {
  const now = 1_800_000_000_000;
  const token = await createDoorSession('test password', now);
  assert(await validDoorSession(token, 'test password', now));
  assert(!await validDoorSession(token, 'changed password', now));
  assert(!await validDoorSession(token, 'test password', now + 8 * 3600_000));
  const [payload, sig] = token.split('.');
  assert(!await validDoorSession(payload + '.AAAA' + sig, 'test password', now));
  assert(!await validDoorSession('eyJhdWQiOiJtZmYtZG9vciIsImV4cCI6OTk5OTk5OTk5OX0.' + sig, 'test password', now));
  assert(!await validDoorSession({}, 'test password', now));
});
