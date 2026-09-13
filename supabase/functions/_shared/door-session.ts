const enc = new TextEncoder();
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const decode = (s: string) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
async function key(secret: string) {
  return await crypto.subtle.importKey("raw", enc.encode(`mff-door-session-v1:${secret}`),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function createDoorSession(secret: string, now = Date.now()): Promise<string> {
  const payload = encode(enc.encode(JSON.stringify({ aud: "mff-door", exp: Math.floor(now / 1000) + 8 * 3600, nonce: crypto.randomUUID() })));
  const signature = await crypto.subtle.sign("HMAC", await key(secret), enc.encode(payload));
  return `${payload}.${encode(new Uint8Array(signature))}`;
}
export async function validDoorSession(token: unknown, secret: string, now = Date.now()): Promise<boolean> {
  if (!secret || typeof token !== "string" || token.length > 512) return false;
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return false;
    const [payload, signature] = parts;
    if (!await crypto.subtle.verify("HMAC", await key(secret), decode(signature), enc.encode(payload))) return false;
    const claims = JSON.parse(new TextDecoder().decode(decode(payload)));
    return claims.aud === "mff-door" && Number.isSafeInteger(claims.exp) &&
      claims.exp > Math.floor(now / 1000) && claims.exp <= Math.floor(now / 1000) + 8 * 3600;
  } catch { return false; }
}
