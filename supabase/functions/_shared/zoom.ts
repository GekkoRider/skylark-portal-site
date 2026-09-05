// Zoom REST client for the Edge Functions.
//
// Auth model (current as of 2026):
//   * Server-to-Server OAuth ("account_credentials" grant) for all REST calls —
//     creating meetings, fetching a host ZAK, downloading recordings.
//   * The March 2026 OBF/ZAK-for-external-meetings rule does NOT apply here:
//     every meeting is created inside Skylark's own Zoom account and everyone
//     joins a meeting owned by that account, so a plain SDK signature (+ the
//     host's ZAK to *start*) is all the web client needs.

const OAUTH_URL = "https://zoom.us/oauth/token";
const API_BASE = "https://api.zoom.us/v2";

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}
let cached: CachedToken | null = null;

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

/** Account-credentials access token, cached in-memory for the life of the isolate. */
export async function getS2SToken(): Promise<string> {
  if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token;

  const accountId = env("ZOOM_S2S_ACCOUNT_ID");
  const basic = btoa(`${env("ZOOM_S2S_CLIENT_ID")}:${env("ZOOM_S2S_CLIENT_SECRET")}`);

  const res = await fetch(`${OAUTH_URL}?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}` },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Zoom OAuth failed (${res.status}): ${JSON.stringify(body)}`);

  cached = {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  return cached.token;
}

/** Thin wrapper around the Zoom REST API. Throws with the response body on non-2xx. */
export async function zoomApi<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getS2SToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw Object.assign(new Error(`Zoom API ${init.method ?? "GET"} ${path} -> ${res.status}: ${text}`), {
      status: res.status,
      body,
    });
  }
  return body as T;
}

/** ZAK for a user in our account — required for the web SDK to *start* a meeting as host. */
export async function getZak(zoomUserId: string): Promise<string> {
  const body = await zoomApi<{ token: string }>(`/users/${encodeURIComponent(zoomUserId)}/token?type=zak`);
  return body.token;
}

export interface ZoomMeeting {
  id: number;
  uuid: string;
  join_url: string;
  password?: string;
  encrypted_password?: string;
  host_email?: string;
}

/**
 * Create the cohort's recurring meeting (type 3 — recurring, no fixed time).
 * Waiting room + "no join before host" are hard-coded: this is under-18 tuition
 * and those are not per-cohort options.
 */
export async function createRecurringMeeting(opts: {
  hostUserId: string;
  topic: string;
  agenda?: string;
}): Promise<ZoomMeeting> {
  return await zoomApi<ZoomMeeting>(`/users/${encodeURIComponent(opts.hostUserId)}/meetings`, {
    method: "POST",
    body: JSON.stringify({
      topic: opts.topic.slice(0, 200),
      type: 3,
      agenda: (opts.agenda ?? "").slice(0, 2000),
      default_password: true,
      settings: {
        waiting_room: true,
        join_before_host: false,
        jbh_time: 0,
        meeting_authentication: false,
        approval_type: 2, // no registration
        auto_recording: "cloud",
        mute_upon_entry: true,
        participant_video: false,
        host_video: true,
        allow_multiple_devices: false,
        email_notification: false,
      },
    }),
  });
}

/** Download a Zoom recording file as a streaming Response (S2S bearer auth). */
export async function fetchRecording(downloadUrl: string): Promise<Response> {
  const token = await getS2SToken();
  const res = await fetch(downloadUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Recording download failed (${res.status}) for ${downloadUrl.split("?")[0]}`);
  }
  return res;
}
