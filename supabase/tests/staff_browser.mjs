// Local static pages + intercepted API. No production calls or real admissions.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require=createRequire(process.env.MFF_BROWSER_DEPS_DIR ? path.join(process.env.MFF_BROWSER_DEPS_DIR,'package.json') : import.meta.url);
const {chromium}=require('playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const qrScript=process.env.MFF_QR_SCRIPT || require.resolve('qr-creator/dist/qr-creator.min.js');
const server=http.createServer((req,res)=>{
 let name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);if(name.endsWith('/'))name+='index.html';
 const file=path.join(root,name);if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
 try{res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));}catch{res.writeHead(404).end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,...(process.env.MFF_CHROME_PATH?{executablePath:process.env.MFF_CHROME_PATH}:{})});
let count=0;
async function test(name,fn){await fn();count++;console.log('PASS '+name);}
const shows=[{code:'staff-a',title:'Proiezione A',starts_at:'2026-10-02T18:00:00+02:00',sales_close_at:'2026-10-02T17:00:00+02:00',unlocked:true,seats_left:2,door_sold:0,door_full:0,door_reduced:0,price_cents:1500,price_reduced_cents:1000},{code:'staff-b',title:'Proiezione B',starts_at:'2026-10-02T21:00:00+02:00',unlocked:false,seats_left:20,sales_close_at:'2026-10-02T20:00:00+02:00'}];
let mode='normal',release,requests=[],sales=[],crash=[],board=shows;
const context=await browser.newContext({viewport:{width:390,height:844}});
await context.addInitScript(()=>{
 AbortSignal.timeout=undefined; // Existing code failed on older Safari.
 navigator.mediaDevices.getUserMedia=()=>Promise.reject(new Error('camera unavailable in automated test'));
});
await context.route('**/*',async route=>{
 const url=route.request().url();if(url.startsWith(base))return route.continue();
 if(!url.endsWith('/functions/v1/ticket-door'))return route.abort();
 const body=route.request().postDataJSON();requests.push(body);
 if(body.action==='scan'){
  if(mode==='scan-delay')await new Promise(r=>release=r);
  if(mode==='offline')return route.abort();
  const reason=body.code==='MFF-T-WRONGABC'?'wrong_screening':body.code==='MFF-T-USEDABCD'?'already_used':body.code==='MFF-D-OTHERDAY'?'day_pass_not_here':null;
  return route.fulfill({json:{ok:true,scan:reason?{ok:false,reason,title:'Proiezione B',starts_at:'2026-10-02T21:00:00+02:00'}:{ok:true,name:'Test Visitor',checked_in:1}}});
 }
 if(body.action==='sell'){
  sales.push(body);
  if(mode==='sell-delay')await new Promise(r=>release=r);
  if(mode==='lost-sale'){mode='normal';return route.abort();}
  if(mode==='capacity')return route.fulfill({status:409,json:{ok:false,error:'capacity'}});
 }
 if(mode==='board-delay' && !body.action)await new Promise(r=>release=r);
 return route.fulfill({json:{ok:true,session:'test-session',sale_retry:mode!=='old-server',screenings:board}});
});
const page=await context.newPage();page.on('pageerror',e=>crash.push(e.message));
async function login(url){await page.goto(base+url);if(await page.locator('[data-panel="login"]').isVisible()){await page.locator('[name=password]').fill('test-password');await page.locator('[data-login] button').click();}}
async function manual(code){await page.locator('[name=code]').fill(code);await page.locator('[data-manual] button').click();}
try{
 await test('scanner login works without AbortSignal.timeout; manual fallback is visible',async()=>{
  await login('/scan/');await page.locator('.scan__choice').first().click();await page.getByText('Telecamera non disponibile:',{exact:false}).waitFor();
  await manual('mff-t-abcdefgh');await page.getByText('ENTRA',{exact:true}).waitFor();
  assert.equal(requests.at(-1).code,'MFF-T-ABCDEFGH');
 });
 await test('scanner serializes manual reads and blocks changing screening mid-request',async()=>{
  mode='scan-delay';await page.locator('[data-verdict-close]').click();await manual('MFF-T-BCDEFGHJ');
  await page.waitForFunction(()=>document.querySelector('[data-manual] button').disabled);
  const before=requests.filter(r=>r.action==='scan').length;
  await page.locator('[data-manual]').dispatchEvent('submit');assert.equal(await page.locator('[data-back]').isDisabled(),true);
  assert.equal(requests.filter(r=>r.action==='scan').length,before);
  release();mode='normal';await page.getByText('ENTRA',{exact:true}).waitFor();
 });
 await test('wrong film, duplicate and excluded day-pass responses are clear',async()=>{
  for(const [code,word] of [['MFF-T-WRONGABC','ALTRA PROIEZIONE'],['MFF-T-USEDABCD','GIÀ ENTRATO'],['MFF-D-OTHERDAY','GIORNALIERA NON VALIDA QUI']]){
   if(await page.locator('[data-verdict-close]').isVisible())await page.locator('[data-verdict-close]').click();
   await manual(code);await page.getByText(word,{exact:true}).waitFor();
  }
 });
 await test('failed scan never displays admission and can be retried',async()=>{
  await page.locator('[data-verdict-close]').click();mode='offline';await manual('MFF-T-ABCDEFGH');
  await page.getByText('NESSUNA CONNESSIONE',{exact:true}).waitFor();assert.match(await page.locator('[data-verdict-note]').textContent(),/potrebbe essere già registrato/);
  mode='normal';await page.locator('[data-verdict-close]').click();await manual('MFF-T-ABCDEFGH');await page.getByText('ENTRA',{exact:true}).waitFor();
 });
 await test('actual QR generator output decodes for tickets, day passes and badge colours',async()=>{
  await page.addScriptTag({path:qrScript});
  const codes=['MFF-T-ABCDEFGH','MFF-D-ABCDEFGH','MFF-ABCD-EFGH'];
  const results=await page.evaluate(codes=>{
   const results=[];
   for(const code of codes)for(const colour of ['#2E1B54','#4B2E83','#B3232B','#4A4A52']){
    const host=document.createElement('div');QrCreator.render({text:code,radius:0.1,ecLevel:'M',fill:colour,background:'#ffffff',size:320},host);
    const source=host.querySelector('canvas');
    // Simulate the scanner's 480px frame and a QR taking 180px of that frame.
    const frame=document.createElement('canvas');frame.width=480;frame.height=360;
    const ctx=frame.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,480,360);ctx.drawImage(source,140,80,180,180);
    results.push(jsQR(ctx.getImageData(0,0,480,360).data,480,360,{inversionAttempts:'dontInvert'})?.data);
   }return results;
  },codes);
  assert.deepEqual(results,codes.flatMap(c=>[c,c,c,c]));
 });
 await test('camera frames flow through the real scanner to the selected screening',async()=>{
  if(await page.locator('[data-verdict-close]').isVisible())await page.locator('[data-verdict-close]').click();
  await page.locator('[data-back]').click();await page.locator('.scan__choice').first().waitFor();
  await page.evaluate(()=>{
   const host=document.createElement('div');QrCreator.render({text:'MFF-D-CAMERABC',radius:0.1,ecLevel:'M',fill:'#2E1B54',background:'#ffffff',size:320},host);
   window.testCamera=host.querySelector('canvas').captureStream(8);
   navigator.mediaDevices.getUserMedia=()=>Promise.resolve(window.testCamera);
  });
  await page.locator('.scan__choice').first().click();await page.getByText('ENTRA',{exact:true}).waitFor();
  assert.equal(requests.at(-1).code,'MFF-D-CAMERABC');assert.equal(requests.at(-1).screening,'staff-a');
  await page.locator('[data-verdict-close]').click();await page.locator('[data-back]').click();
  assert.equal(await page.evaluate(()=>window.testCamera.getVideoTracks()[0].readyState),'ended');
 });
 await test('camera permission resolving after leaving scanner releases its tracks',async()=>{
  await page.locator('.scan__choice').first().waitFor();
  await page.evaluate(()=>{
   navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>window.resolveCamera=resolve);
   window.lateCamera=document.createElement('canvas').captureStream(8);
  });
  await page.locator('.scan__choice').first().click();await page.locator('[data-back]').click();
  await page.evaluate(()=>window.resolveCamera(window.lateCamera));
  await page.waitForFunction(()=>window.lateCamera.getVideoTracks()[0].readyState==='ended');
 });
 await test('screening refresh locks choices until the refreshed list is ready',async()=>{
  release=null;mode='board-delay';await page.locator('[data-pick-refresh]').click();
  await page.waitForFunction(()=>document.querySelector('[data-pick-refresh]').disabled);
  assert.equal(await page.locator('.scan__choice').first().isDisabled(),true);
  // Wait for the intercepted request itself, not only its loading indicator.
  const deadline=Date.now()+5000;
  while(!release && Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
  assert.ok(release, 'board request was intercepted');
  release();release=null;mode='normal';
  await page.waitForFunction(()=>!document.querySelector('[data-pick-refresh]').disabled);
  assert.equal(await page.locator('.scan__choice').first().isDisabled(),false);
 });
 await test('cash desk disables zero-count subtraction and sales before online closing',async()=>{
  await login('/door/');await page.locator('.door-show').first().waitFor();
  assert.equal(await page.locator('.door-show').first().locator('.door-step').first().isDisabled(),true);
  assert.equal(await page.locator('.door-show').nth(1).locator('button').count(),0);
 });
 await test('refresh cannot overtake or duplicate an in-flight sale',async()=>{
  mode='sell-delay';await page.locator('.door-step--plus').first().click();await page.waitForFunction(()=>document.querySelector('[data-status]').textContent.includes('Verifico'));
  const before=requests.length;await page.locator('[data-refresh]').click();assert.equal(requests.length,before);
  release();mode='normal';await page.getByText('Movimento registrato.',{exact:true}).waitFor();
 });
 await test('lost sale response is recovered with same request ID, including after reload',async()=>{
  mode='lost-sale';await page.locator('.door-step--plus').first().click();await page.getByText('Risposta non ricevuta:',{exact:false}).waitFor();
  const id=sales.at(-1).request_id;assert.ok(id);
  assert.equal(await page.locator('.door-step--plus').first().isDisabled(),true);
  await page.reload();await page.getByText('Movimento registrato.',{exact:true}).waitFor();
  assert.equal(sales.at(-1).request_id,id);
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('mff_door_pending')),null);
 });
 await test('capacity refusal refreshes counters without enabling invalid minus buttons',async()=>{
  mode='capacity';await page.locator('.door-step--plus').first().click();await page.getByText('Posti esauriti oppure',{exact:false}).waitFor();
  assert.equal(await page.locator('.door-step').first().isDisabled(),true);mode='normal';
 });
 await test('older backend cannot silently accept a sale without retry protection',async()=>{
  mode='old-server';await page.reload();await page.getByText('Cassa da aggiornare sul server.',{exact:false}).waitFor();
  assert.equal(await page.locator('.door-step--plus').first().isDisabled(),true);mode='normal';
 });
 await test('mobile layouts fit viewport and scripts have no uncaught errors',async()=>{
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.deepEqual(crash,[]);
 });
 console.log(`${count} browser tests passed`);
}finally{await browser.close();await new Promise(r=>server.close(r));}
