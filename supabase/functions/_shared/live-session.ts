// Separate signing domain: box-office sessions cannot authorize audio spending.
const enc = new TextEncoder();
const encode = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const decode = (s: string) => Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')), c=>c.charCodeAt(0));
async function key(secret: string) {
  return crypto.subtle.importKey('raw',enc.encode(`mff-live-session-v1:${secret}`),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
}
export async function createLiveSession(secret: string, now=Date.now()) {
  const payload=encode(enc.encode(JSON.stringify({aud:'mff-live',exp:Math.floor(now/1000)+12*3600,nonce:crypto.randomUUID()})));
  const signature=await crypto.subtle.sign('HMAC',await key(secret),enc.encode(payload));
  return `${payload}.${encode(new Uint8Array(signature))}`;
}
export async function validLiveSession(token: unknown, secret: string, now=Date.now()) {
  if (!secret || typeof token!=='string' || token.length>512) return false;
  try {
    const parts=token.split('.');
    if(parts.length!==2 || !await crypto.subtle.verify('HMAC',await key(secret),decode(parts[1]),enc.encode(parts[0]))) return false;
    const c=JSON.parse(new TextDecoder().decode(decode(parts[0])));
    return c.aud==='mff-live' && Number.isSafeInteger(c.exp) && c.exp>Math.floor(now/1000) && c.exp<=Math.floor(now/1000)+12*3600;
  } catch { return false; }
}
