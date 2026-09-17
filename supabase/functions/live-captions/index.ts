import { db } from '../_shared/db.ts';
import { json, fail } from '../_shared/http.ts';
import { secured, rateLimit } from '../_shared/security.ts';
import { passwordMatches } from '../_shared/request.ts';
import { createLiveSession, validLiveSession } from '../_shared/live-session.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
Deno.serve(secured(async req => {
  const body = await req.json().catch(()=>null);
  if (!body || typeof body!=='object' || Array.isArray(body)) return fail(req,'bad_request');
  // Public connection metadata only; no Soniox credentials or publisher IDs.
  if (body.action==='config') {
    const publicKey=Deno.env.get('SUPABASE_ANON_KEY');
    if(!publicKey) return fail(req,'service_unavailable',503);
    return json(req,{ok:true,url:Deno.env.get('SUPABASE_URL'),public_key:publicKey});
  }
  const secret=Deno.env.get('LIVE_CAPTIONS_PASSWORD');
  if(!secret || secret.length<16) return fail(req,'not_configured',503);
  if(body.action==='login') {
    const blocked=await rateLimit(req,'live-login',8,60,300);
    if(blocked) return blocked;
    if(!passwordMatches(body.password,secret)) return fail(req,'unauthorised',401);
    return json(req,{ok:true,session:await createLiveSession(secret),configured:!!Deno.env.get('SONIOX_API_KEY')});
  }
  if(!await validLiveSession(body.session,secret)) return fail(req,'unauthorised',401);
  if(body.action==='check') return json(req,{ok:true,configured:!!Deno.env.get('SONIOX_API_KEY')});
  if(!['start','key','publish'].includes(body.action) || typeof body.room!=='string' ||
    !/^[a-z0-9][a-z0-9-]{0,39}$/.test(body.room) || typeof body.publisher!=='string' || !uuid.test(body.publisher)) return fail(req,'bad_request');

  if(body.action==='start') {
    if(!Deno.env.get('SONIOX_API_KEY')) return fail(req,'not_configured',503);
    if(typeof body.title!=='string' || !body.title.trim() || body.title.length>120 ||
      !Number.isInteger(body.minutes) || body.minutes<5 || body.minutes>240 ||
      !['en','it'].includes(body.language)) return fail(req,'bad_request');
    const blocked=await rateLimit(req,'live-start',12,80,60);
    if(blocked) return blocked;
    const {data,error}=await db().rpc('live_caption_claim',{
      p_room:body.room,p_publisher:body.publisher,p_title:body.title.trim(),p_minutes:body.minutes,
      p_language:body.language,
    });
    if(error) return fail(req,'service_unavailable',503);
    return json(req,data,data?.ok?200:409);
  }
  if(body.action==='publish') {
    if(!Number.isSafeInteger(body.sequence) || body.sequence<1 || body.sequence>10000000 ||
      !['connecting','live','reconnecting','ended'].includes(body.state) ||
      typeof body.original!=='string' || body.original.length>1500 ||
      typeof body.translated!=='string' || body.translated.length>1500) return fail(req,'bad_request');
    const blocked=await rateLimit(req,'live-publish',150,1000,60);
    if(blocked) return blocked;
    const {data,error}=await db().rpc('live_caption_update',{
      p_room:body.room,p_publisher:body.publisher,p_sequence:body.sequence,
      p_state:body.state,p_original:body.original,p_translated:body.translated,
    });
    if(error) return fail(req,'service_unavailable',503);
    return json(req,data,data?.ok?200:409);
  }
  const blocked=await rateLimit(req,'live-key',8,60,60);
  if(blocked) return blocked;
  const {data:lease,error}=await db().from('live_caption_publishers').select('publisher,lease_until,ends_at').eq('room',body.room).maybeSingle();
  if(error) return fail(req,'service_unavailable',503);
  const seconds=Math.floor((Date.parse(lease?.ends_at)-Date.now())/1000);
  if(!lease || lease.publisher!==body.publisher || Date.parse(lease.lease_until)<=Date.now() || seconds<1) return fail(req,'lease_lost',409);
  const apiKey=Deno.env.get('SONIOX_API_KEY');
  if(!apiKey) return fail(req,'not_configured',503);
  // Single-use, time-limited key. Never return or log the account's master key.
  const res=await fetch('https://api.soniox.com/v1/auth/temporary-api-key',{
    method:'POST',headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json'},
    body:JSON.stringify({usage_type:'transcribe_websocket',expires_in_seconds:60,single_use:true,
      max_session_duration_seconds:Math.min(seconds,14400),client_reference_id:`mff:${body.room}:${body.publisher}`}),
    signal:AbortSignal.timeout(10000),
  });
  if(!res.ok) return fail(req,res.status===429?'soniox_capacity':'soniox_unavailable',503);
  const key=await res.json();
  if(typeof key.api_key!=='string') return fail(req,'soniox_unavailable',503);
  return json(req,{ok:true,api_key:key.api_key,ends_at:lease.ends_at,
    websocket_url:'wss://stt-rt.soniox.com/transcribe-websocket',model:'stt-rt-v5'});
},{scope:'live-captions',methods:['POST'],maxBytes:16384}));
