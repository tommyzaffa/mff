// Stub every network request; requests never reach Supabase, Stripe or Resend.
Deno.env.set('SUPABASE_URL', 'https://database.example.invalid');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role');
Deno.env.set('DOOR_PASSWORD', 'long-test-only-password');
Deno.env.set('STRIPE_WEBHOOK_SECRET', 'test-signing-secret');
let handler: (req: Request) => Promise<Response>;
Deno.serve = ((fn: typeof handler) => { handler = fn; return {} }) as unknown as typeof Deno.serve;
await import('../functions/ticket-door/index.ts');
const door = handler!;
await import('../functions/pass-submit/index.ts');
const submit = handler!;
await import('../functions/pass-stripe-webhook/index.ts');
const webhook = handler!;
let calls: string[] = [];
let rateAllowed = true;
globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
  const url = String(input); calls.push(url);
  if (url.includes('/rpc/security_rate_limit')) return Promise.resolve(Response.json(rateAllowed));
  if (url.includes('/rpc/ticket_expire_holds')) return Promise.resolve(Response.json(0));
  if (url.includes('/screening_availability')) return Promise.resolve(Response.json([]));
  if (url.includes('/pass_kinds')) return Promise.resolve(Response.json({type:'staff',price_cents:0,code_only:true,needs_org:true}));
  throw new Error('Unexpected network operation: '+url);
};
function assert(value: unknown){if(!value)throw new Error('assertion failed')}
function req(body: unknown) { return new Request('https://function.example.invalid', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}); }
Deno.test('door cannot scan or sell with absent, forged or coerced credentials', async () => {
  rateAllowed=true;
  for(const body of [{action:'scan',code:'MFF-T-ABCDEFGH',screening:'test-show'},{action:'sell',delta:1,screening:'test-show'},{password:['long-test-only-password']},{session:'forged'}]){
    calls=[]; const res=await door(req(body));assert(res.status===401);
    assert(calls.every(c=>c.includes('security_rate_limit')));
  }
});
Deno.test('blocked login cannot test even the correct password; signed session stays usable',async()=>{
  rateAllowed=true; const login=await door(req({password:'long-test-only-password'}));
  const data=await login.json();assert(data.ok && data.session);
  assert(!JSON.stringify(data).includes('long-test-only-password'));
  rateAllowed=false; calls=[];
  assert((await door(req({password:'long-test-only-password'}))).status===429);
  calls=[];assert((await door(req({session:data.session}))).status===200);
  assert(!calls.some(c=>c.includes('security_rate_limit')));
  rateAllowed=true;
});
Deno.test('missing server password denies access with explicit unavailable response', async()=>{
  Deno.env.delete('DOOR_PASSWORD');calls=[];
  assert((await door(req({password:''}))).status===503);assert(calls.length===0);
  Deno.env.set('DOOR_PASSWORD','long-test-only-password');
});
Deno.test('private pass ignores forged issued status/zero amount and requires invitation',async()=>{
  const f=new FormData();for(const [k,v] of Object.entries({type:'staff',first_name:'Test',last_name:'User',email:'test@example.invalid',org:'Test',status:'issued',amount_cents:'0'}))f.set(k,v);
  calls=[];const res=await submit(new Request('https://function.example.invalid',{method:'POST',body:f}));
  assert((await res.json()).error==='code_required');assert(!calls.some(c=>c.includes('/storage/')||c.endsWith('/passes')));
});
Deno.test('unsigned forged Stripe payment cannot touch the database',async()=>{
  calls=[];const res=await webhook(req({type:'checkout.session.completed',data:{object:{payment_status:'paid'}}}));
  assert(res.status===400);assert(calls.length===0);
});
Deno.test('private JSON responses are not cacheable',async()=>{
  const res=await door(req({password:'wrong'}));assert(res.headers.get('cache-control')==='no-store');assert(res.headers.get('referrer-policy')==='no-referrer');
});

const { verifyWebhook } = await import('../functions/_shared/stripe.ts');
Deno.test('Stripe signature accepts rotation signatures but rejects stale or altered payloads',async()=>{
  const text='{"type":"checkout.session.completed"}';
  const timestamp=String(Math.floor(Date.now()/1000));
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode('test-signing-secret'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const mac=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(timestamp+'.'+text));
  const sig=Array.from(new Uint8Array(mac)).map(b=>b.toString(16).padStart(2,'0')).join('');
  const header=`t=${timestamp},v1=${sig},v1=${'0'.repeat(64)}`;
  assert(await verifyWebhook(text,header));
  assert(!await verifyWebhook(text+' ',header));
  assert(!await verifyWebhook(text,`t=${Number(timestamp)-301},v1=${sig}`));
  assert(!await verifyWebhook(text,`t=${timestamp},t=${timestamp},v1=${sig}`));
});

Deno.test('paid ticket receipt recovers on webhook retry after an email outage',async()=>{
  const original=globalThis.fetch;let sent=false;let attempts=0;
  const order={id:'11111111-1111-4111-8111-111111111111',status:'issued',amount_cents:1500,stripe_session_id:'cs_paid',first_name:'Test',last_name:'User',email:'test@example.invalid',locale:'it',screening:'test-show',day:null};
  globalThis.fetch=async(input,init)=>{
    const url=String(input);
    if(url.includes('/rpc/ticket_order_issue'))return Response.json({ok:true,already:true});
    if(url.includes('/ticket_orders')){
      if(init?.method==='PATCH'){sent=true;return new Response(null,{status:204})}
      return Response.json({...order,email_sent_at:sent?'2026-09-12T12:00:00Z':null});
    }
    if(url.includes('/tickets?'))return Response.json([{code:'MFF-T-ABCDEFGH',holder_name:'Test User',badge_code:null,tariff:'full',screening:'test-show'}]);
    if(url.includes('/screenings?'))return Response.json({title:'Test',venue:'Lux',starts_at:'2026-10-01T18:00:00Z'});
    if(url==='https://api.resend.com/emails'){
      attempts++;assert(new Headers(init?.headers).get('idempotency-key')===`ticket-issued/${order.id}`);
      return attempts===1?Response.json({error:'temporary outage'},{status:503}):Response.json({id:'email-test'});
    }
    throw new Error('Unexpected mocked URL '+url);
  };
  Deno.env.set('RESEND_API_KEY','test-key');
  try{
    const text=JSON.stringify({type:'checkout.session.completed',data:{object:{id:'cs_paid',payment_status:'paid',currency:'chf',amount_total:1500,metadata:{kind:'ticket',order_id:order.id}}}});
    const time=String(Math.floor(Date.now()/1000));
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode('test-signing-secret'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const mac=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(time+'.'+text));
    const sig=Array.from(new Uint8Array(mac)).map(b=>b.toString(16).padStart(2,'0')).join('');
    const call=()=>webhook(new Request('https://function.example.invalid',{method:'POST',headers:{'stripe-signature':`t=${time},v1=${sig}`},body:text}));
    assert((await call()).status===500);assert(!sent);
    assert((await call()).status===200);assert(sent && attempts===2);
    assert((await call()).status===200);assert(attempts===2);
  }finally{globalThis.fetch=original;}
});
