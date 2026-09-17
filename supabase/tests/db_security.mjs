// npm install --prefix supabase/tests && npm test --prefix supabase/tests
// Uses an isolated, in-memory PostgreSQL; NEVER connects to production.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(process.env.MFF_TEST_DEPS_DIR ? path.join(process.env.MFF_TEST_DEPS_DIR,'package.json') : import.meta.url);
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
const { citext } = require('@electric-sql/pglite/contrib/citext');
const db = new PGlite({extensions:{pgcrypto,citext}});
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../migrations');
let count = 0;
async function test(name,fn){await fn();count++;console.log('PASS '+name)}
const q = async (sql,args=[]) => (await db.query(sql,args)).rows;
await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
create schema extensions; create schema storage;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
for(const file of fs.readdirSync(dir).filter(f=>f.endsWith('.sql')).sort()) {
  try { await db.exec(fs.readFileSync(path.join(dir,file),'utf8')); }
  catch(e){console.error('Migration failed:',file,e.message);process.exit(1)}
}
console.log('All migrations applied to isolated PostgreSQL');
await test('private RPCs reject anonymous and authenticated callers',async()=>{
 const rows=await q(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef and (has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE'))`);assert.deepEqual(rows,[]);
});
await test('personal-data tables have RLS and no public policies',async()=>{
 for(const table of ['passes','pass_access_codes','pass_badge_codes','ticket_orders','tickets','security_request_buckets']){
 assert.equal((await q(`select relrowsecurity as r from pg_class where oid=$1::regclass`,['public.'+table]))[0].r,true);
 assert.equal((await q(`select count(*)::int as n from pg_policies where schemaname='public' and tablename=$1`,[table]))[0].n,0);
 }
});
await test('rate limits persist across callers and enforce both budgets',async()=>{
 const run=async key=>(await q(`select public.security_rate_limit('test',$1,2,4,3600) as ok`,[key.repeat(64)]))[0].ok;
 assert.equal(await run('a'),true);assert.equal(await run('a'),true);assert.equal(await run('a'),false);
 assert.equal(await run('b'),true);assert.equal(await run('c'),false);
});
await test('ticket codes always have eight nonambiguous characters',async()=>{
 for(const r of await q(`select public.ticket_random_suffix() as c from generate_series(1,1000)`)) assert.match(r.c,/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
});
const pass=(await q(`insert into passes(type,first_name,last_name,email,amount_cents,status) values('guest','Test','Security','test@example.invalid',4000,'awaiting_payment') returning id`))[0].id;
await test('unpaid passes cannot be issued even by the issue RPC',async()=>{await assert.rejects(q('select pass_issue($1)',[pass]),/payment required/)});
await test('paid pass issuance is idempotent and claims one code',async()=>{
 await q(`update passes set status='paid' where id=$1`,[pass]);
 const a=(await q(`select pass_issue($1) as v`,[pass]))[0].v;
 const b=(await q(`select pass_issue($1) as v`,[pass]))[0].v;
 assert.equal(a.code,b.code);assert.equal(b.already,true);
 assert.equal((await q('select count(*)::int n from pass_badge_codes where pass_id=$1',[pass]))[0].n,1);
});
const badge=(await q('select badge_code from passes where id=$1',[pass]))[0].badge_code;
await db.exec(`insert into screenings(code,title,starts_at,opens_at,closes_at,is_published,is_ticketed,capacity,price_cents,price_reduced_cents) values
 ('test-show','Test',now()+interval '3 hours',now()+interval '5 hours',now()+interval '6 hours',true,true,2,1500,1000),
 ('test-other','Other',now()+interval '3 hours',now()+interval '5 hours',now()+interval '6 hours',true,true,2,1500,1000);`);
const reserve=async seats=>(await q(`select ticket_reserve('test-show','Test','User','test@example.invalid',$1::jsonb,'it',35) as r`,[JSON.stringify(seats)]))[0].r;
let free,paid;
await test('fake badges cannot reserve a free seat',async()=>{assert.equal((await reserve([{badge:'MFF-FAKE-FAKE'}])).reason,'unknown_badge')});
await test('forged accredited tariff without badge is charged in database',async()=>{
 assert.equal((await reserve([{tariff:'accredited'}])).reason,'bad_tariff');
 paid=await reserve([{tariff:'full'}]);assert.equal(paid.ok,true);assert.equal(paid.free,false);assert.equal(paid.amount_cents,1500);
});
await test('valid accreditation gets only one free seat per screening',async()=>{
 free=await reserve([{badge}]);assert.equal(free.ok,true);assert.equal(free.free,true);
 assert.equal((await reserve([{badge}])).reason,'badge_already_used');
});
await test('full room refuses further holds',async()=>{assert.equal((await reserve([{}])).ok,false)});
await test('wrong door does not consume a valid ticket; duplicate scan is refused',async()=>{
 const scan=async screening=>(await q(`select ticket_check_in($1,$2) as r`,[free.codes[0],screening]))[0].r;
 assert.equal((await scan('test-other')).reason,'wrong_screening');assert.equal((await scan('test-show')).ok,true);assert.equal((await scan('test-show')).reason,'already_used');
});
await test('unpaid ticket is refused at the door',async()=>{
 assert.equal((await q(`select ticket_check_in($1,'test-show') as r`,[paid.codes[0]]))[0].r.reason,'not_valid');
});
await test('expired hold cannot be revived after seats become available',async()=>{
 await q(`update ticket_orders set holds_until=now()-interval '1 minute' where id=$1`,[paid.order_id]);
 assert.equal((await q(`select ticket_order_issue($1,'pi_test') as r`,[paid.order_id]))[0].r.reason,'expired_hold');
 assert.equal((await q(`select status from ticket_orders where id=$1`,[paid.order_id]))[0].status,'cancelled');
});
await test('door sales cannot bypass the online sales window',async()=>{
 assert.equal((await q(`select ticket_door_sell('test-other',1,'full','test') as r`))[0].r.reason,'sales_not_closed');
 await db.exec(`update screenings set starts_at=now()+interval '30 minutes' where code='test-other'`);
 assert.equal((await q(`select ticket_door_sell('test-other',2,'full','test') as r`))[0].r.ok,true);
 assert.equal((await q(`select ticket_door_sell('test-other',1,'full','test') as r`))[0].r.reason,'capacity');
 assert.equal((await q(`select ticket_door_sell('test-other',-1,'reduced','test') as r`))[0].r.reason,'capacity');
});

// Operational acceptance cases: use the same reservation and issuance RPCs as
// real sales; all names, orders and screenings below live only in this database.
await db.exec(`insert into screenings(code,title,starts_at,opens_at,closes_at,is_published,is_ticketed,capacity,wheelchair_spaces,price_cents,price_reduced_cents) values
 ('staff-a','Staff A',current_date+interval '2 days 12 hours',current_date+interval '2 days 12 hours',current_date+interval '2 days 14 hours',true,true,20,2,1500,1000),
 ('staff-b','Staff B',current_date+interval '2 days 16 hours',current_date+interval '2 days 16 hours',current_date+interval '2 days 18 hours',true,true,20,2,1500,1000),
 ('staff-closed','Earlier film',current_date+interval '2 days 10 hours',current_date+interval '2 days 10 hours',current_date+interval '2 days 12 hours',true,true,20,2,1500,1000),
 ('staff-till','Till',now()+interval '30 minutes',now(),now()+interval '2 hours',true,true,3,2,1500,1000);
 update screenings set sales_close_at=now()-interval '1 minute' where code='staff-closed';
 insert into festival_days(day,code,price_cents,price_reduced_cents,is_on_sale) values(current_date+2,'staff-day',3000,2500,true);`);
const book=async(show,seats)=>(await q(`select ticket_reserve($1,'Staff','Test','staff@example.invalid',$2::jsonb,'it',20) as r`,[show,JSON.stringify(seats)]))[0].r;
const scan=async(code,show)=>(await q(`select ticket_check_in($1,$2) as r`,[code,show]))[0].r;
const issue=async(order)=>(await q(`select ticket_order_issue($1,'pi_isolated_test') as r`,[order.order_id]))[0].r;
let accreditedA,accreditedB,day;
await test('badge without reservation is refused without consuming other bookings',async()=>{
 assert.equal((await scan(badge,'staff-a')).reason,'badge_not_booked');
 accreditedA=await book('staff-a',[{badge}]);accreditedB=await book('staff-b',[{badge}]);
 assert.equal(accreditedA.ok,true);assert.equal(accreditedB.ok,true);
});
await test('one badge admits to each booked screening independently',async()=>{
 assert.equal((await scan(badge,'staff-a')).ok,true);
 assert.equal((await scan(badge,'staff-a')).reason,'already_used');
 assert.equal((await scan(badge,'staff-b')).ok,true);
});
await test('badge QR and its ticket QR share the same admission',async()=>{
 assert.equal((await scan(accreditedA.codes[0],'staff-a')).reason,'already_used');
});
await test('revoked accreditation cannot bypass revocation using the ticket QR',async()=>{
 await q(`update passes set status='cancelled' where id=$1`,[pass]);
 assert.equal((await scan(accreditedB.codes[0],'staff-b')).reason,'not_valid');
 await q(`update passes set status='issued' where id=$1`,[pass]);
});
await test('day pass reserves only screenings included at purchase time',async()=>{
 day=(await q(`select ticket_day_pass_reserve(current_date+2,'Day','Visitor','day@example.invalid','[{"tariff":"reduced","holder":"Day Visitor"}]'::jsonb,'it',20) as r`))[0].r;
 assert.equal(day.ok,true);assert.deepEqual(day.screenings,['staff-a','staff-b']);assert.equal(day.amount_cents,2500);
});
await test('unpaid and unknown day passes have explicit rejection reasons',async()=>{
 assert.equal((await scan(day.codes[0],'staff-a')).reason,'not_valid');
 assert.equal((await scan('MFF-D-UNKNOWNX','staff-a')).reason,'unknown_ticket');
 assert.equal((await issue(day)).ok,true);
});
await test('day pass refuses another day and excluded screening without consumption',async()=>{
 assert.equal((await scan(day.codes[0],'test-show')).reason,'day_pass_not_here');
 assert.equal((await scan(day.codes[0],'staff-closed')).reason,'day_pass_not_here');
 assert.equal((await q(`select count(*)::int n from tickets where order_id=$1 and checked_in_at is not null`,[day.order_id]))[0].n,0);
});
await test('day pass admits once per included film with reduced-price warning',async()=>{
 const a=await scan(day.codes[0],'staff-a');assert.equal(a.ok,true);assert.equal(a.tariff,'reduced');assert.equal(a.name,'Day Visitor');
 assert.equal((await scan(day.codes[0],'staff-a')).reason,'already_used');
 assert.equal((await scan(day.codes[0],'staff-b')).ok,true);
 const ticket=(await q(`select code from tickets where day_pass_code=$1 and screening='staff-a'`,[day.codes[0]]))[0].code;
 assert.equal((await scan(ticket,'staff-a')).reason,'already_used');
});
await test('cancelled day pass is refused even with a previously issued QR',async()=>{
 await q(`update ticket_orders set status='cancelled' where id=$1`,[day.order_id]);assert.equal((await scan(day.codes[0],'staff-b')).reason,'not_valid');
});
await test('group purchase gives each visitor one independently usable code',async()=>{
 const group=await book('staff-a',[{holder:'Full Visitor',tariff:'full'},{holder:'Wheelchair Visitor',tariff:'reduced',wheelchair:true}]);
 assert.equal(group.ok,true);assert.equal((await issue(group)).ok,true);
 assert.equal((await scan(group.codes[0],'staff-b')).reason,'wrong_screening');
 assert.equal((await scan(group.codes[0],'staff-a')).name,'Full Visitor');
 const chair=await scan(group.codes[1],'staff-a');assert.equal(chair.ok,true);assert.equal(chair.wheelchair,true);assert.equal(chair.tariff,'reduced');
});
await test('all three QR types require a selected screening even at database level',async()=>{
 for(const code of [accreditedA.codes[0],badge,day.codes[0]])assert.equal((await scan(code,null)).reason,'screening_required');
});
await test('cancelled single ticket never admits',async()=>{
 const o=await book('staff-b',[{tariff:'full'}]);await issue(o);await q(`update tickets set cancelled_at=now() where order_id=$1`,[o.order_id]);
 assert.equal((await scan(o.codes[0],'staff-b')).reason,'not_valid');
});
const movement=async(id,delta=1,tariff='full',show='staff-till')=>(await q(`select ticket_door_sell_once($1,$2,$3,$4,'test') as r`,[id,show,delta,tariff]))[0].r;
const request='11111111-1111-4111-8111-111111111111';
await test('retry after lost sale response produces only one ledger movement',async()=>{
 assert.equal((await movement(request)).ok,true);assert.equal((await movement(request)).ok,true);
 assert.equal((await q(`select door_sold,seats_left from screening_availability where code='staff-till'`))[0].door_sold,1);
});
await test('reusing a movement ID with different parameters is refused',async()=>{
 assert.equal((await movement(request,-1)).reason,'request_conflict');
 assert.equal((await movement(request,1,'reduced')).reason,'request_conflict');
 assert.equal((await movement(request,1,'full','staff-a')).reason,'request_conflict');
});
await test('counter full/reduced totals and negative correction stay consistent',async()=>{
 assert.equal((await movement('22222222-2222-4222-8222-222222222222',1,'reduced')).ok,true);
 assert.equal((await movement('33333333-3333-4333-8333-333333333333',-1,'full')).ok,true);
 assert.equal((await movement('33333333-3333-4333-8333-333333333333',-1,'full')).ok,true);
 const v=(await q(`select door_sold,door_full,door_reduced,seats_left from screening_availability where code='staff-till'`))[0];
 assert.deepEqual(v,{door_sold:1,door_full:0,door_reduced:1,seats_left:2});
});
await test('refused movement remains refused on retry after availability changes',async()=>{
 const id='44444444-4444-4444-8444-444444444444';assert.equal((await movement(id,3)).reason,'capacity');
 await movement('55555555-5555-4555-8555-555555555555',-1,'reduced');
 assert.equal((await movement(id,3)).reason,'capacity');
});
await test('request ledger is protected by row-level security',async()=>{
 assert.equal((await q(`select relrowsecurity as r from pg_class where oid='public.ticket_door_requests'::regclass`))[0].r,true);
 assert.equal((await q(`select count(*)::int n from pg_policies where tablename='ticket_door_requests'`))[0].n,0);
});

// Live captions: the audience reads one row, and only the regia that holds the
// room may write it. Everything below uses a room that exists only in this test.
await db.exec(`insert into live_caption_rooms(id) values('talk')`);
const regiaA='aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', regiaB='bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const claim=async(publisher,title='Talk',minutes=30,language='en')=>(await q(`select live_caption_claim('talk',$1,$2,$3,$4) as r`,[publisher,title,minutes,language]))[0].r;
const caption=async(publisher,sequence,state,text)=>(await q(`select live_caption_update('talk',$1,$2,$3,$4,$5) as r`,[publisher,sequence,state,text,text]))[0].r;
const room=async()=>(await q(`select * from live_caption_rooms where id='talk'`))[0];
await test('the audience can read captions and nothing else',async()=>{
 assert.equal((await q(`select relrowsecurity as r from pg_class where oid='public.live_caption_rooms'::regclass`))[0].r,true);
 assert.deepEqual(await q(`select cmd from pg_policies where tablename='live_caption_rooms'`),[{cmd:'SELECT'}]);
 assert.equal((await q(`select count(*)::int n from pg_policies where tablename='live_caption_publishers'`))[0].n,0);
 for(const role of ['anon','authenticated']){
  assert.equal((await q(`select has_table_privilege($1,'public.live_caption_rooms','UPDATE') as p`,[role]))[0].p,false);
  assert.equal((await q(`select has_table_privilege($1,'public.live_caption_publishers','SELECT') as p`,[role]))[0].p,false);
 }
});
await test('a second regia cannot take over a live room, and a repeated start keeps the text',async()=>{
 assert.equal((await claim(regiaA)).ok,true);
 assert.equal((await caption(regiaA,1,'live','Buonasera')).ok,true);
 assert.equal((await claim(regiaB)).error,'room_busy');
 assert.equal((await claim(regiaA)).snapshot.translated,'Buonasera');
 assert.equal((await caption(regiaB,2,'live','pirata')).error,'lease_lost');
 assert.equal((await claim(regiaA,'Talk',600)).error,'bad_request');
 assert.equal((await claim(regiaA,'Talk',30,'de')).error,'bad_request');
 assert.equal((await room()).translated,'Buonasera');
});
await test('a delayed retry never rewinds the captions on screen',async()=>{
 assert.equal((await caption(regiaA,5,'live','ultimo')).ok,true);
 const revision=(await room()).revision;
 assert.equal((await caption(regiaA,4,'live','vecchio')).ok,true);
 assert.deepEqual([(await room()).translated,(await room()).revision],['ultimo',revision]);
});
await test('a stopped session cannot resume, and the room frees up for the next talk',async()=>{
 assert.equal((await caption(regiaA,6,'ended','grazie')).ok,true);
 assert.equal((await caption(regiaA,7,'live','ancora')).error,'lease_lost');
 assert.equal((await room()).state,'ended');
 assert.equal((await claim(regiaB,'Secondo talk',30,'it')).ok,true);
 const next=await room();
 assert.deepEqual([next.state,next.title,next.translated,next.language],['connecting','Secondo talk','','it']);
});
console.log(`${count} database security tests passed`);
await db.close();
