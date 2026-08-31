// GET /functions/v1/pass-wallet?c=<badge code>&p=google   -> 302 to the save link
// GET /functions/v1/pass-wallet?c=<badge code>&p=apple    -> the .pkpass file
//
// Both platforms are optional. Google needs a service account (free); Apple
// needs a signing certificate from a paid developer account. When the secrets
// for one are missing this returns 501 and the badge page simply hides that
// button, so the pass works either way.

import { db, kind, signedFileUrl } from "../_shared/db.ts";
import { env } from "../_shared/env.ts";
import { html } from "../_shared/http.ts";
import { zip } from "../_shared/zip.ts";
import { passName, asLocale } from "../_shared/templates.ts";

const HEX: Record<string, string> = {
  violet: "#4B2E83",
  red: "#B3232B",
  grey: "#4A4A52",
};

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = (url.searchParams.get("c") ?? "").trim().toUpperCase();
  const platform = url.searchParams.get("p") ?? "google";

  if (!/^MFF-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) return oops("Codice non valido.", 400);

  const { data } = await db()
    .from("passes")
    .select("id, type, status, badge_code, first_name, last_name, org, photo_path, locale")
    .eq("badge_code", code)
    .maybeSingle();

  if (!data || data.status !== "issued") return oops("Badge non trovato.", 404);
  const k = await kind(data.type);
  const locale = asLocale(data.locale);

  const model = {
    code,
    name: `${data.first_name} ${data.last_name}`,
    label: k?.needs_org ? (data.org ?? "") : "",
    passLabel: passName(data.type, locale),
    letter: k?.letter ?? "?",
    colour: HEX[k?.colour ?? "violet"] ?? HEX.violet,
    photoUrl: await signedFileUrl("pass-photos", data.photo_path, 60 * 60 * 24 * 30),
  };

  try {
    if (platform === "apple") return await applePass(model);
    return await googlePass(model);
  } catch (e) {
    console.error("pass-wallet", e);
    return oops("Non riesco a generare il pass per il wallet.", 500);
  }
});

type Model = {
  code: string;
  name: string;
  label: string;
  passLabel: string;
  letter: string;
  colour: string;
  photoUrl: string | null;
};

// --- Google Wallet ----------------------------------------------------------

// The class is declared inline in the JWT rather than created up front through
// the REST API, which spares us an OAuth round trip and a provisioning step.
async function googlePass(m: Model): Promise<Response> {
  const issuerId = env.googleIssuerId();
  const raw = env.googleServiceAccount();
  if (!issuerId || !raw) return notConfigured("Google Wallet");

  const sa = JSON.parse(raw) as { client_email: string; private_key: string };
  const classId = `${issuerId}.mff_pass_2026`;
  const objectId = `${issuerId}.${m.code.replace(/-/g, "_")}`;

  const claims = {
    iss: sa.client_email,
    aud: "google",
    typ: "savetowallet",
    iat: Math.floor(Date.now() / 1000),
    origins: [env.siteUrl],
    payload: {
      genericClasses: [{
        id: classId,
        classTemplateInfo: {
          cardBarcodeSectionDetails: {
            firstTopDetail: {
              fieldSelector: { fields: [{ fieldPath: "object.textModulesData['pass']" }] },
            },
          },
        },
      }],
      genericObjects: [{
        id: objectId,
        classId,
        genericType: "GENERIC_ENTRY_TICKET",
        state: "ACTIVE",
        hexBackgroundColor: m.colour,
        cardTitle: text("Merge Film Festival 2026"),
        header: text(m.name),
        subheader: text(m.label || m.passLabel),
        logo: { sourceUri: { uri: `${env.siteUrl}/assets/img/favicon-96.png` } },
        ...(m.photoUrl ? { heroImage: { sourceUri: { uri: m.photoUrl } } } : {}),
        barcode: { type: "QR_CODE", value: m.code, alternateText: m.code },
        textModulesData: [
          { id: "pass", header: "Pass", body: m.passLabel },
          ...(m.label ? [{ id: "org", header: "Label", body: m.label }] : []),
        ],
      }],
    },
  };

  const jwt = await signRs256(claims, sa.private_key);
  return Response.redirect(`https://pay.google.com/gp/v/save/${jwt}`, 302);
}

function text(value: string) {
  return { defaultValue: { language: "it", value } };
}

async function signRs256(claims: unknown, privateKeyPem: string): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;

  const der = pemToDer(privateKeyPem);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(body),
  );
  return `${body}.${b64urlBytes(new Uint8Array(sig))}`;
}

function pemToDer(pem: string): Uint8Array {
  const base64 = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

function b64url(s: string): string {
  return b64urlBytes(new TextEncoder().encode(s));
}

function b64urlBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// --- Apple Wallet -----------------------------------------------------------

// A .pkpass is a zip of pass.json plus its images, a manifest of SHA-1 digests,
// and a detached PKCS#7 signature over that manifest.
async function applePass(m: Model): Promise<Response> {
  const teamId = env.appleTeamId();
  const passTypeId = env.applePassTypeId();
  const certPem = env.applePassCertificate();
  const keyPem = env.applePassKey();
  const wwdrPem = env.appleWwdrCertificate();
  if (!teamId || !passTypeId || !certPem || !keyPem || !wwdrPem) {
    return notConfigured("Apple Wallet");
  }

  const passJson = {
    formatVersion: 1,
    passTypeIdentifier: passTypeId,
    teamIdentifier: teamId,
    organizationName: "Merge Film Festival",
    description: `${m.passLabel} — Merge Film Festival 2026`,
    serialNumber: m.code,
    backgroundColor: hexToRgb(m.colour),
    foregroundColor: "rgb(243,242,239)",
    labelColor: "rgb(243,242,239)",
    logoText: "Merge Film Festival",
    barcodes: [{
      format: "PKBarcodeFormatQR",
      message: m.code,
      messageEncoding: "iso-8859-1",
      altText: m.code,
    }],
    generic: {
      primaryFields: [{ key: "name", label: m.passLabel, value: m.name }],
      secondaryFields: m.label ? [{ key: "org", label: "Label", value: m.label }] : [],
      auxiliaryFields: [{ key: "type", label: "Tipo", value: `${m.passLabel} (${m.letter})` }],
      backFields: [
        { key: "code", label: "Codice accredito", value: m.code },
        { key: "site", label: "Info", value: `${env.siteUrl}/badge/?c=${m.code}` },
      ],
    },
  };

  const icon = await fetchBytes(`${env.siteUrl}/assets/img/favicon-96.png`);
  const files: { name: string; data: Uint8Array }[] = [
    { name: "pass.json", data: new TextEncoder().encode(JSON.stringify(passJson)) },
    { name: "icon.png", data: icon },
    { name: "icon@2x.png", data: icon },
    { name: "logo.png", data: icon },
  ];

  const manifest: Record<string, string> = {};
  for (const f of files) manifest[f.name] = await sha1Hex(f.data);
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));

  const signature = await signManifest(manifestBytes, certPem, keyPem, wwdrPem);

  const bundle = zip([
    ...files,
    { name: "manifest.json", data: manifestBytes },
    { name: "signature", data: signature },
  ]);

  return new Response(bundle, {
    headers: {
      "content-type": "application/vnd.apple.pkpass",
      "content-disposition": `attachment; filename="${m.code}.pkpass"`,
      "cache-control": "no-store",
    },
  });
}

async function signManifest(
  manifest: Uint8Array,
  certPem: string,
  keyPem: string,
  wwdrPem: string,
): Promise<Uint8Array> {
  // node-forge is the only practical way to build PKCS#7 here: WebCrypto signs
  // bytes but has no notion of CMS structures or certificate chains.
  const forge = (await import("npm:node-forge@1.3.1")).default;

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(
    String.fromCharCode(...manifest),
  );
  p7.addCertificate(forge.pki.certificateFromPem(certPem));
  p7.addCertificate(forge.pki.certificateFromPem(wwdrPem));
  p7.addSigner({
    key: forge.pki.privateKeyFromPem(keyPem),
    certificate: forge.pki.certificateFromPem(certPem),
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date().toISOString() },
    ],
  });
  p7.sign({ detached: true });

  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  const out = new Uint8Array(der.length);
  for (let i = 0; i < der.length; i++) out[i] = der.charCodeAt(i) & 0xff;
  return out;
}

async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

function hexToRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`;
}

// --- shared -----------------------------------------------------------------

function notConfigured(what: string): Response {
  return html(
    `<p style="font:16px system-ui;padding:24px">${what} non è ancora configurato.</p>`,
    501,
  );
}

function oops(message: string, status: number): Response {
  return html(`<p style="font:16px system-ui;padding:24px">${message}</p>`, status);
}
