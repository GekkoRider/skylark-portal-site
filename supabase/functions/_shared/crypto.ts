// Small crypto helpers used by the Zoom Edge Functions. No external deps — the
// Web Crypto API is enough for HS256 and the webhook HMAC, and keeping it
// dependency-free means nothing to drift or audit.

const enc = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** Hex HMAC-SHA256 — used for Zoom webhook signature + CRC validation. */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string compare. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

/**
 * Sign a Zoom Meeting SDK JWT (component view, SDK v5+/v6).
 * alg HS256, secret = the Meeting SDK app's Client Secret.
 * Required claims for web: appKey, sdkKey, mn, role, iat, exp, tokenExp.
 * See https://developers.zoom.us/docs/meeting-sdk/auth/
 */
export async function signMeetingSdkJwt(opts: {
  sdkKey: string;
  sdkSecret: string;
  meetingNumber: string;
  role: 0 | 1;
  /** seconds; how long the signature (and the SDK session token) stays valid */
  expiresInSeconds?: number;
}): Promise<string> {
  const iat = Math.floor(Date.now() / 1000) - 30; // small skew allowance
  // Zoom requires exp >= iat + 1800 and <= iat + 48h.
  const ttl = Math.min(Math.max(opts.expiresInSeconds ?? 60 * 60 * 3, 1800), 60 * 60 * 47);
  const exp = iat + ttl;

  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    appKey: opts.sdkKey,
    sdkKey: opts.sdkKey,
    mn: opts.meetingNumber,
    role: opts.role,
    iat,
    exp,
    tokenExp: exp,
  };

  const signingInput = `${base64url(enc.encode(JSON.stringify(header)))}.${
    base64url(enc.encode(JSON.stringify(payload)))
  }`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(opts.sdkSecret), enc.encode(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(sig))}`;
}
