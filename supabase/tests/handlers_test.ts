// Stub every network request; requests never reach Supabase, Stripe or Resend.
Deno.env.set('SUPABASE_URL', 'https://database.example.invalid');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role');
Deno.env.set('DOOR_PASSWORD', 'long-test-only-password');
Deno.env.set('STRIPE_WEBHOOK_SECRET', 'test-signing-secret');
// Deliberately the same string as DOOR_PASSWORD: the two session domains must
// stay separate even when the festival reuses a passphrase.
Deno.env.set('LIVE_CAPTIONS_PASSWORD', 'long-test-only-password');
Deno.env.set('SONIOX_API_KEY', 'soniox-account-key');
// Same passphrase again, for the same reason: the mail endpoint's sessions are
// their own domain too.
Deno.env.set('TICKET_MAIL_PASSWORD', 'long-test-only-password');
let handler: (req: Request) => Promise<Response>;
Deno.serve = ((fn: typeof handler) => { handler = fn; return {} }) as unknown as typeof Deno.serve;
await import('../functions/ticket-door/index.ts');
const door = handler!;
await import('../functions/pass-submit/index.ts');
const submit = handler!;
await import('../functions/pass-stripe-webhook/index.ts');
const webhook = handler!;
await import('../functions/live-captions/index.ts');
const live = handler!;
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

Deno.test('staff scan accepts all three code types and preserves the screening at the RPC',async()=>{
  const original=globalThis.fetch;const {createDoorSession}=await import('../functions/_shared/door-session.ts');
  const session=await createDoorSession('long-test-only-password');
  let sent: Record<string,unknown>={};
  globalThis.fetch=async(input,init)=>{
    if(!String(input).includes('/rpc/ticket_check_in'))throw new Error('Unexpected operation');
    sent=JSON.parse(String(init?.body));return Response.json({ok:true,name:'Test Visitor'});
  };
  try{
    for(const code of ['MFF-T-ABCDEFGH','MFF-D-ABCDEFGH','MFF-ABCD-EFGH']){
      const res=await door(req({session,action:'scan',screening:'staff-a',code}));
      const data=await res.json();assert(data.ok && data.scan.ok);assert(sent.p_code===code && sent.p_screening==='staff-a');
    }
    assert((await door(req({session,action:'scan',code:'MFF-T-ABCDEFGH'}))).status===400);
    assert((await door(req({session,action:'scan',screening:'staff-a',code:'invalid'}))).status===400);
  }finally{globalThis.fetch=original;}
});
Deno.test('a box-office session cannot spend audio credit, nor a regia session open the door',async()=>{
  const {createDoorSession}=await import('../functions/_shared/door-session.ts');
  const {createLiveSession}=await import('../functions/_shared/live-session.ts');
  const doorSession=await createDoorSession('long-test-only-password');
  const liveSession=await createLiveSession('long-test-only-password');
  calls=[];
  assert((await live(req({action:'check',session:doorSession}))).status===401);
  assert((await door(req({session:liveSession}))).status===401);
  assert((await live(req({action:'check',session:liveSession}))).status===200);
  assert(!calls.some(c=>c.includes('soniox')));
});
Deno.test('a Soniox key needs a live lease, and the account key never leaves the server',async()=>{
  const original=globalThis.fetch;
  const {createLiveSession}=await import('../functions/_shared/live-session.ts');
  const session=await createLiveSession('long-test-only-password');
  const publisher='11111111-1111-4111-8111-111111111111';
  let lease: Record<string,string>[]=[]; let sent: Headers|null=null;
  globalThis.fetch=async(input,init)=>{
    const url=String(input); calls.push(url);
    if(url.includes('/rpc/security_rate_limit'))return Response.json(true);
    if(url.includes('/live_caption_publishers'))return Response.json(lease);
    if(url==='https://api.soniox.com/v1/auth/temporary-api-key'){
      sent=new Headers(init?.headers); return Response.json({api_key:'temporary-key'});
    }
    throw new Error('Unexpected network operation: '+url);
  };
  try{
    calls=[];
    const denied=await live(req({action:'key',session,room:'main',publisher}));
    assert(denied.status===409 && (await denied.json()).error==='lease_lost');
    lease=[{publisher,lease_until:new Date(Date.now()+30_000).toISOString(),ends_at:new Date(Date.now()+3_600_000).toISOString()}];
    const stranger=await live(req({action:'key',session,room:'main',publisher:'22222222-2222-4222-8222-222222222222'}));
    assert((await stranger.json()).error==='lease_lost');
    assert(!calls.some(c=>c.includes('soniox')));
    const data=await (await live(req({action:'key',session,room:'main',publisher}))).json();
    assert(data.ok && data.api_key==='temporary-key');
    assert(sent!.get('authorization')==='Bearer soniox-account-key');
    assert(!JSON.stringify(data).includes('soniox-account-key'));
  }finally{globalThis.fetch=original;}
});
Deno.test('new counter routes retry IDs to the atomic RPC and advertises retry support',async()=>{
  const original=globalThis.fetch;const {createDoorSession}=await import('../functions/_shared/door-session.ts');
  const session=await createDoorSession('long-test-only-password');
  const id='11111111-1111-4111-8111-111111111111';let sent: Record<string,unknown>={};
  globalThis.fetch=async(input,init)=>{
    if(String(input).includes('/rpc/ticket_door_sell_once')){sent=JSON.parse(String(init?.body));return Response.json({ok:true});}
    return original(input,init);
  };
  try{
    const body={session,action:'sell',screening:'staff-a',delta:1,tariff:'reduced',request_id:id};
    const data=await (await door(req(body))).json();assert(data.ok && data.sale_retry);assert(sent.p_request===id && sent.p_tariff==='reduced');
    assert((await door(req({...body,request_id:'bad-id'}))).status===400);
  }finally{globalThis.fetch=original;}
});
Deno.test('an invitation code reaches the reserve RPC only once it could be real',async()=>{
  await import('../functions/ticket-reserve/index.ts');const reserve=handler!;
  const original=globalThis.fetch;let sent: Record<string,unknown>={};let hitDb=false;
  globalThis.fetch=async(input,init)=>{
    const url=String(input);
    if(url.includes('/rpc/security_rate_limit'))return Response.json(true);
    if(url.includes('/rpc/ticket_expire_holds')){hitDb=true;return Response.json(0);}
    if(url.includes('/screening_availability')){hitDb=true;return Response.json({code:'staff-a',title:'Staff A',venue:'Lux',starts_at:new Date().toISOString(),price_cents:1500,price_reduced_cents:1000});}
    if(url.includes('/rpc/ticket_reserve')){sent=JSON.parse(String(init?.body));return Response.json({ok:true,free:true,order_id:'11111111-1111-4111-8111-111111111111',codes:[],invited:true});}
    // Il resto e' la ricevuta via email, che qui non ha destinatario.
    return Response.json([]);
  };
  const body={screening:'staff-a',first_name:'Guest',last_name:'Invited',email:'guest@example.invalid',seats:[{}]};
  try{
    // Una forma che non puo' esistere non merita un giro nel database.
    hitDb=false;
    const bad=await reserve(req({...body,access_code:'MFF-T-ABCDEFGH'}));
    assert(bad.status===409 && (await bad.json()).error==='unknown_invite');assert(!hitDb);
    // Una plausibile arriva alla RPC normalizzata, non come l'ha scritta l'ospite.
    const ok=await reserve(req({...body,access_code:' scuola26-aaaa '}));
    assert((await ok.json()).ok);assert(sent.p_access_code==='SCUOLA26-AAAA');
    // Nessun codice resta nessun codice: non un stringa vuota che il database
    // dovrebbe poi indovinare.
    await reserve(req(body));assert(sent.p_access_code===null);
  }finally{globalThis.fetch=original;}
});

await import('../functions/ticket-mail/index.ts');
const mailer = handler!;
Deno.test('the mail endpoint wants its own password: door and regia sessions are refused',async()=>{
  const {createDoorSession}=await import('../functions/_shared/door-session.ts');
  const {createLiveSession}=await import('../functions/_shared/live-session.ts');
  rateAllowed=true;
  for(const body of [{action:'list'},{action:'send',order_ids:['11111111-1111-4111-8111-111111111111']},{password:'wrong'},{password:['long-test-only-password']},
    {session:await createDoorSession('long-test-only-password')},{session:await createLiveSession('long-test-only-password')}]){
    calls=[];assert((await mailer(req(body))).status===401);
    assert(calls.every(c=>c.includes('security_rate_limit')));
  }
  Deno.env.delete('TICKET_MAIL_PASSWORD');calls=[];
  assert((await mailer(req({password:'long-test-only-password'}))).status===503);assert(calls.length===0);
  Deno.env.set('TICKET_MAIL_PASSWORD','long-test-only-password');
});

// Two batches of one teacher's seats, the same address typed in another case, a
// director, a day-pass order, and an order whose only seat was given back.
const T='2026-10-02T14:00:00+02:00';
const mailOrders=[
  {id:'00000000-0000-4000-8000-000000000001',screening:'concorso-1',day:null,first_name:'Maria',last_name:'Siragusa',email:'maria.siragusa@scuola.ch',locale:'it',amount_cents:0,status:'issued',email_sent_at:null,created_at:'2026-09-29T10:00:00Z',
   tickets:[{holder_name:'Studente Uno',cancelled_at:null},{holder_name:'Studente Due',cancelled_at:null}],day_passes:[]},
  {id:'00000000-0000-4000-8000-000000000002',screening:'concorso-1',day:null,first_name:'Maria',last_name:'Siragusa',email:'Maria.Siragusa@scuola.ch',locale:'it',amount_cents:0,status:'issued',email_sent_at:null,created_at:'2026-09-29T10:00:01Z',
   tickets:[{holder_name:'Studente Tre',cancelled_at:null},{holder_name:'Studente Ritirato',cancelled_at:'2026-09-29T11:00:00Z'}],day_passes:[]},
  {id:'00000000-0000-4000-8000-000000000003',screening:'concorso-2',day:null,first_name:'Reza',last_name:'Delavar',email:'reza.delavar@example.invalid',locale:'en',amount_cents:0,status:'issued',email_sent_at:null,created_at:'2026-09-28T20:00:00Z',
   tickets:[{holder_name:'Reza Delavar',cancelled_at:null}],day_passes:[]},
  {id:'00000000-0000-4000-8000-000000000004',screening:null,day:'2026-10-02',first_name:'Maria',last_name:'Siragusa',email:'maria.siragusa@scuola.ch',locale:'it',amount_cents:3000,status:'issued',email_sent_at:null,created_at:'2026-09-20T10:00:00Z',
   tickets:[],day_passes:[{holder_name:'Studente Uno',cancelled_at:null}]},
  {id:'00000000-0000-4000-8000-000000000005',screening:'concorso-3',day:null,first_name:'Gone',last_name:'Away',email:'gone@example.invalid',locale:'it',amount_cents:0,status:'issued',email_sent_at:null,created_at:'2026-09-29T09:00:00Z',
   tickets:[{holder_name:'Gone Away',cancelled_at:'2026-09-29T09:30:00Z'}],day_passes:[]},
];
const mailTickets=[
  {order_id:mailOrders[0].id,code:'MFF-T-AAAAAAAA',holder_name:'Studente Uno',badge_code:null,tariff:'full',day_pass_code:'MFF-D-AAAAAAAA',screening:'concorso-1'},
  {order_id:mailOrders[0].id,code:'MFF-T-BBBBBBBB',holder_name:'Studente Due',badge_code:null,tariff:'reduced',day_pass_code:'MFF-D-BBBBBBBB',screening:'concorso-1'},
  {order_id:mailOrders[1].id,code:'MFF-T-CCCCCCCC',holder_name:'Studente Tre',badge_code:null,tariff:'full',day_pass_code:'MFF-D-CCCCCCCC',screening:'concorso-1'},
  {order_id:mailOrders[2].id,code:'MFF-T-DDDDDDDD',holder_name:'Reza Delavar',badge_code:'MFF-2J22-HFD8',tariff:'accredited',day_pass_code:null,screening:'concorso-2'},
];
function mailBackend(orders: typeof mailOrders){
  const seen={lists:[] as string[],mails:[] as {to:string[],html:string,key:string|null}[],marked:[] as string[]};
  const fetcher=async(input: RequestInfo|URL,init?: RequestInit)=>{
    const url=decodeURIComponent(String(input));
    if(url.includes('/rpc/security_rate_limit'))return Response.json(true);
    if(url.includes('/ticket_orders')&&init?.method==='PATCH'){seen.marked.push(url);return new Response(null,{status:204});}
    if(url.includes('/ticket_orders?')){
      seen.lists.push(url);
      const only=url.match(/id=in\.\(([^)]*)\)/)?.[1]?.split(',');
      return Response.json(orders.filter(o=>!only||only.includes(o.id)));
    }
    if(url.includes('/tickets?'))return Response.json(mailTickets.filter(t=>url.includes(t.order_id)));
    if(url.includes('/screenings?')&&url.includes('code=eq.'))return Response.json({title:'Film in concorso · Programma 1',venue:'Cinema Lux',starts_at:T});
    if(url.includes('/screenings?'))return Response.json([{code:'concorso-1',title:'Film in concorso · Programma 1',starts_at:T},{code:'concorso-2',title:'Film in concorso · Programma 2',starts_at:'2026-10-02T20:30:00+02:00'}]);
    if(url.includes('/festival_days?'))return Response.json([{day:'2026-10-02'}]);
    if(url==='https://api.resend.com/emails'){
      const body=JSON.parse(String(init?.body));
      seen.mails.push({to:body.to,html:body.html,key:new Headers(init?.headers).get('idempotency-key')});
      return Response.json({id:'email-'+seen.mails.length});
    }
    throw new Error('Unexpected network operation: '+url);
  };
  return {seen,fetcher};
}

Deno.test('list groups the waiting orders by inbox and event, and finds a teacher by a pupil',async()=>{
  const original=globalThis.fetch;const {seen,fetcher}=mailBackend(mailOrders);globalThis.fetch=fetcher;
  try{
    const data=await (await mailer(req({password:'long-test-only-password',action:'list'}))).json();
    assert(data.ok && data.session);
    assert(seen.lists[0].includes('status=eq.issued') && seen.lists[0].includes('email_sent_at=is.null'));
    const groups=data.groups as {email:string,event:string,order_ids:string[],tickets:number,holders:string[],title:string}[];
    assert(groups.length===3);
    const school=groups.find(g=>g.event==='s:concorso-1')!;
    assert(school.order_ids.length===2 && school.tickets===3);
    assert(!school.holders.includes('Studente Ritirato'));
    assert(groups.find(g=>g.event==='d:2026-10-02')!.tickets===1);
    assert(!groups.some(g=>g.email==='gone@example.invalid'));
    assert(data.events.some((e: {value:string})=>e.value==='d:2026-10-02'));

    const pupil=await (await mailer(req({session:data.session,action:'list',q:'studente tre'}))).json();
    assert(pupil.groups.length===1 && pupil.groups[0].event==='s:concorso-1');
    const all=await (await mailer(req({session:data.session,action:'list',unsent:false,event:'s:concorso-2'}))).json();
    assert(all.ok);assert(!seen.lists.at(-1)!.includes('email_sent_at=is.null') && seen.lists.at(-1)!.includes('screening=eq.concorso-2'));
  }finally{globalThis.fetch=original;}
});

Deno.test('send mails one message per inbox and event, and never twice unless asked',async()=>{
  const original=globalThis.fetch;Deno.env.set('RESEND_API_KEY','test-key');
  const orders=mailOrders.map(o=>({...o,email_sent_at:o.email_sent_at as string|null}));
  const {seen,fetcher}=mailBackend(orders as typeof mailOrders);globalThis.fetch=fetcher;
  const ids=[orders[0].id,orders[1].id,orders[2].id];
  try{
    assert((await mailer(req({password:'long-test-only-password',action:'send',order_ids:['not-an-id']}))).status===400);
    assert(seen.mails.length===0);

    const first=await (await mailer(req({password:'long-test-only-password',action:'send',order_ids:ids}))).json();
    assert(first.ok && first.results.length===2 && first.skipped===0);
    assert(seen.mails.length===2);
    const school=seen.mails.find(m=>m.to[0].toLowerCase()==='maria.siragusa@scuola.ch')!;
    assert(['MFF-T-AAAAAAAA','MFF-T-BBBBBBBB','MFF-T-CCCCCCCC'].every(c=>school.html.includes(c)));
    assert(!school.html.includes('MFF-T-DDDDDDDD'));
    assert(first.results.find((r: {email:string})=>r.email.toLowerCase()==='maria.siragusa@scuola.ch').tickets===3);
    assert(seen.marked.some(u=>u.includes(orders[0].id)&&u.includes(orders[1].id)));

    // The database now says they went out; the same list again sends nothing.
    for(const o of orders.slice(0,3))o.email_sent_at='2026-09-30T12:00:00Z';
    const again=await (await mailer(req({password:'long-test-only-password',action:'send',order_ids:ids}))).json();
    assert(again.ok && again.results.length===0 && again.skipped===3 && seen.mails.length===2);

    // An explicit resend goes out, under a key of its own.
    const rid='99999999-9999-4999-8999-999999999999';
    const resent=await (await mailer(req({password:'long-test-only-password',action:'send',order_ids:[orders[2].id],resend:true,request_id:rid}))).json();
    assert(resent.results.length===1 && resent.results[0].status==='sent' && seen.mails.length===3);
    assert(seen.mails[2].key!==seen.mails.find(m=>m.to[0]==='reza.delavar@example.invalid')!.key);
  }finally{globalThis.fetch=original;}
});

Deno.test('a refused email leaves the orders waiting, so the next send tries them again',async()=>{
  const original=globalThis.fetch;Deno.env.set('RESEND_API_KEY','test-key');
  const {seen,fetcher}=mailBackend(mailOrders.map(o=>({...o})));
  globalThis.fetch=async(input,init)=>String(input)==='https://api.resend.com/emails'
    ? Response.json({message:'daily quota'},{status:429})
    : fetcher(input,init);
  try{
    const data=await (await mailer(req({password:'long-test-only-password',action:'send',order_ids:[mailOrders[2].id]}))).json();
    assert(data.ok && data.results[0].status==='failed');
    assert(seen.marked.length===0);
  }finally{globalThis.fetch=original;}
});

Deno.test('remind writes once to every badge but staff, and records nothing if Resend refuses',async()=>{
  const original=globalThis.fetch;Deno.env.set('RESEND_API_KEY','test-key');
  const passes=[
    {id:'10000000-0000-4000-8000-000000000001',type:'industry',first_name:'Ada',email:'ada@example.invalid',badge_code:'MFF-AAAA-AAAA',locale:'it'},
    {id:'10000000-0000-4000-8000-000000000002',type:'guest',first_name:'Ben',email:'ben@example.invalid',badge_code:'MFF-BBBB-BBBB',locale:'en'},
    {id:'10000000-0000-4000-8000-000000000003',type:'guest',first_name:'Ben',email:'BEN@example.invalid',badge_code:'MFF-CCCC-CCCC',locale:'en'},
    {id:'10000000-0000-4000-8000-000000000004',type:'press',first_name:'Cleo',email:'cleo@example.invalid',badge_code:'MFF-DDDD-DDDD',locale:'de'},
    {id:'10000000-0000-4000-8000-000000000005',type:'industry',first_name:'Dan',email:'mailto:dan@example.invalid',badge_code:'MFF-EEEE-EEEE',locale:'it'},
  ];
  let events=[{pass_id:passes[3].id}];let batches:{to:string[],subject:string,html:string}[][]=[];let lists:string[]=[];let refuse=false;
  globalThis.fetch=async(input,init)=>{
    const url=decodeURIComponent(String(input));
    if(url.includes('/rpc/security_rate_limit'))return Response.json(true);
    if(url.includes('/passes?')){lists.push(url);return Response.json(passes);}
    if(url.includes('/pass_events')&&init?.method==='POST'){events=[...events,...JSON.parse(String(init.body))];return new Response(null,{status:201});}
    if(url.includes('/pass_events?'))return Response.json(events.map(e=>({pass_id:e.pass_id})));
    if(url==='https://api.resend.com/emails/batch'){
      if(refuse)return Response.json({message:'nope'},{status:500});
      batches.push(JSON.parse(String(init?.body)));return Response.json({data:[]});
    }
    throw new Error('Unexpected network operation: '+url);
  };
  try{
    const dry=await (await mailer(req({password:'long-test-only-password',action:'remind',dry_run:true}))).json();
    assert(dry.ok && dry.recipients===2 && dry.sent===0 && batches.length===0);
    assert(dry.invalid.length===1 && dry.invalid[0]==='mailto:dan@example.invalid');
    assert(lists[0].includes('type=neq.staff') && lists[0].includes('status=eq.issued'));

    refuse=true;
    const failed=await mailer(req({password:'long-test-only-password',action:'remind'}));
    assert(failed.status===502 && (await failed.json()).detail.includes('Resend 500'));assert(events.length===1);

    refuse=false;
    const sent=await (await mailer(req({password:'long-test-only-password',action:'remind'}))).json();
    assert(sent.sent===2 && sent.remaining===0 && batches.length===1 && batches[0].length===2);
    const ada=batches[0].find(m=>m.to[0]==='ada@example.invalid')!;
    assert(ada.html.includes('MFF-AAAA-AAAA') && ada.subject.startsWith('Si comincia oggi'));
    assert(batches[0].find(m=>m.to[0]==='ben@example.invalid')!.subject.startsWith('It starts today'));
    assert(events.length===3);

    const again=await (await mailer(req({password:'long-test-only-password',action:'remind'}))).json();
    assert(again.sent===0 && batches.length===1);
  }finally{globalThis.fetch=original;}
});
