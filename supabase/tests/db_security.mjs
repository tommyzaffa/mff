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
console.log(`${count} database security tests passed`);
await db.close();
