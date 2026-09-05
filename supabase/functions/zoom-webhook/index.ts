// zoom-webhook
// ----------------------------------------------------------------------------
// Public endpoint. Zoom calls it. Every request (except the one-off CRC
// handshake) is verified against ZOOM_WEBHOOK_SECRET_TOKEN before the payload
// is trusted.
//
// Handles:
//   endpoint.url_validation       -> CRC response
//   recording.completed           -> download each file with the S2S token,
//                                    store it in the private 'session-recordings'
//                                    bucket, and record a session_recordings row
//                                    (with per-child consent status attached).
//   meeting.participant_joined
//   meeting.participant_left      -> supplementary join/leave timestamps in
//                                    session_zoom_participation. This is NOT
//                                    attendance — the tutor's one-tap register
//                                    stays the source of truth and is untouched.
// ----------------------------------------------------------------------------

import { createClient } from "jsr:@supabase/supabase-js@2";
import { hmacSha256Hex, timingSafeEqual } from "../_shared/crypto.ts";
import { fetchRecording } from "../_shared/zoom.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("ZOOM_WEBHOOK_SECRET_TOKEN")!;
const BUCKET = "session-recordings";
const MAX_STORE_BYTES = 250 * 1024 * 1024; // files larger than this are catalogued but not copied

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// deno-lint-ignore no-explicit-any
declare const EdgeRuntime: any;
function runInBackground(p: Promise<unknown>) {
  try {
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(p);
    else p.catch((e) => console.error(e));
  } catch {
    p.catch((e) => console.error(e));
  }
}

function londonDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(+d)) return null;
  return d.toLocaleDateString("en-CA", { timeZone: "Europe/London" }); // YYYY-MM-DD
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const raw = await req.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("bad json", { status: 400 });
  }

  // --- CRC handshake (no signature on this one) ---
  if (body.event === "endpoint.url_validation") {
    const plainToken = (body.payload as { plainToken?: string })?.plainToken ?? "";
    const encryptedToken = await hmacSha256Hex(WEBHOOK_SECRET, plainToken);
    return new Response(JSON.stringify({ plainToken, encryptedToken }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // --- verify every real event ---
  const ts = req.headers.get("x-zm-request-timestamp") ?? "";
  const given = req.headers.get("x-zm-signature") ?? "";
  const expected = `v0=${await hmacSha256Hex(WEBHOOK_SECRET, `v0:${ts}:${raw}`)}`;
  if (!ts || !given || !timingSafeEqual(given, expected)) {
    return new Response("invalid signature", { status: 401 });
  }

  const event = String(body.event ?? "");
  const object = ((body.payload as Record<string, unknown>)?.object ?? {}) as Record<string, unknown>;

  try {
    if (event === "recording.completed") {
      // Ack fast; Zoom retries on non-2xx and the downloads take a while.
      runInBackground(handleRecordingCompleted(object, body));
      return new Response("accepted", { status: 200 });
    }
    if (event === "meeting.participant_joined" || event === "meeting.participant_left") {
      runInBackground(handleParticipant(event, object));
      return new Response("accepted", { status: 200 });
    }
  } catch (e) {
    console.error(`handler error for ${event}`, e);
  }
  return new Response("ignored", { status: 200 });
});

// ----------------------------------------------------------------------------

async function cohortForMeeting(meetingId: unknown) {
  const { data } = await admin
    .from("cohorts")
    .select("id, strand, zoom_meeting_id")
    .eq("zoom_meeting_id", String(meetingId ?? ""))
    .maybeSingle();
  return data;
}

async function consentMissingChildIds(cohortId: string): Promise<string[]> {
  const { data: enr } = await admin
    .from("enrollments").select("child_id").eq("cohort_id", cohortId).eq("active", true);
  const childIds = [...new Set((enr ?? []).map((e) => e.child_id).filter(Boolean))];
  if (childIds.length === 0) return [];

  const { data: consents } = await admin
    .from("child_consents_current")
    .select("child_id, granted")
    .eq("consent_type", "session_recording")
    .in("child_id", childIds);

  const granted = new Map((consents ?? []).map((c) => [c.child_id, !!c.granted]));
  return childIds.filter((id) => granted.get(id) !== true);
}

async function handleRecordingCompleted(object: Record<string, unknown>, fullEvent: unknown) {
  const meetingId = object.id;
  const meetingUuid = String(object.uuid ?? "");
  const startTime = object.start_time as string | undefined;
  const sessionDate = londonDate(startTime);
  const cohort = await cohortForMeeting(meetingId);
  const missing = cohort ? await consentMissingChildIds(cohort.id) : [];

  const files = (object.recording_files ?? []) as Array<Record<string, unknown>>;
  for (const f of files) {
    const fileType = String(f.file_type ?? "").toUpperCase();
    const ext = String(f.file_extension ?? fileType).toLowerCase();
    const bytes = Number(f.file_size ?? 0);
    const downloadUrl = String(f.download_url ?? "");
    const playUrl = f.play_url ? String(f.play_url) : null;
    const recStart = (f.recording_start as string | undefined) ?? startTime;
    if (!downloadUrl) continue;

    const baseRow = {
      cohort_id: cohort?.id ?? null,
      zoom_meeting_id: String(meetingId ?? ""),
      zoom_meeting_uuid: meetingUuid,
      session_date: sessionDate,
      recording_started_at: recStart ?? null,
      file_type: fileType,
      file_extension: ext,
      bytes: bytes || null,
      zoom_play_url: playUrl,
      consent_missing_child_ids: missing,
      raw_event: fullEvent,
    };

    let storagePath: string | null = null;
    let stored = false;
    let skipped: string | null = null;

    if (bytes > MAX_STORE_BYTES) {
      skipped = "oversized";
    } else {
      const folder = `${cohort?.id ?? "unmatched"}/${sessionDate ?? "unknown-date"}`;
      storagePath = `${folder}/${meetingUuid.replace(/[^a-zA-Z0-9_-]/g, "_")}-${fileType}.${ext}`;
      try {
        const res = await fetchRecording(downloadUrl);
        const contentType = res.headers.get("Content-Type") ??
          (fileType === "MP4" ? "video/mp4" : fileType === "M4A" ? "audio/mp4" : "application/octet-stream");
        const { error: upErr } = await admin.storage.from(BUCKET).upload(storagePath, res.body!, {
          contentType,
          upsert: true,
        });
        if (upErr) throw upErr;
        stored = true;
      } catch (e) {
        console.error("recording store failed", storagePath, e);
        skipped = "download_failed";
        storagePath = null;
      }
    }

    const { error } = await admin
      .from("session_recordings")
      .upsert({ ...baseRow, storage_path: storagePath, stored, skipped_reason: skipped }, {
        onConflict: "zoom_meeting_uuid,file_type",
      });
    if (error) console.error("session_recordings upsert failed", error);
  }

  console.log(
    `recording.completed meeting=${meetingId} cohort=${cohort?.id ?? "none"} files=${files.length} consent_missing=${missing.length}`,
  );
}

async function handleParticipant(event: string, object: Record<string, unknown>) {
  const meetingId = object.id;
  const meetingUuid = String(object.uuid ?? "");
  const p = (object.participant ?? {}) as Record<string, unknown>;
  const cohort = await cohortForMeeting(meetingId);
  if (!cohort) return; // meeting we don't know about — nothing useful to record

  const email = (p.email ? String(p.email) : "").trim().toLowerCase();
  const participantUuid = String(p.participant_uuid ?? p.id ?? p.user_id ?? "");
  const displayName = p.user_name ? String(p.user_name) : null;
  const sessionDate = londonDate((p.join_time as string) ?? (p.leave_time as string) ?? (object.start_time as string));

  // Best-effort child mapping via the parent's email.
  let childId: string | null = null;
  if (email) {
    const { data: fam } = await admin.from("families").select("id").ilike("email", email).maybeSingle();
    if (fam) {
      const { data: kids } = await admin.from("children").select("id").eq("family_id", fam.id);
      const kidIds = (kids ?? []).map((k) => k.id);
      if (kidIds.length) {
        const { data: enr } = await admin
          .from("enrollments").select("child_id")
          .eq("cohort_id", cohort.id).eq("active", true).in("child_id", kidIds);
        if ((enr ?? []).length === 1) childId = enr![0].child_id;
      }
    }
  }

  if (event === "meeting.participant_joined") {
    await admin.from("session_zoom_participation").insert({
      cohort_id: cohort.id,
      zoom_meeting_id: String(meetingId ?? ""),
      zoom_meeting_uuid: meetingUuid,
      session_date: sessionDate,
      zoom_participant_uuid: participantUuid,
      zoom_user_email: email || null,
      display_name: displayName,
      child_id: childId,
      joined_at: (p.join_time as string) ?? new Date().toISOString(),
    });
    return;
  }

  // participant_left: close the most recent open row, or record a bare leave.
  const { data: open } = await admin
    .from("session_zoom_participation")
    .select("id")
    .eq("zoom_meeting_uuid", meetingUuid)
    .eq("zoom_participant_uuid", participantUuid)
    .is("left_at", null)
    .order("joined_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (open) {
    await admin.from("session_zoom_participation").update({
      left_at: (p.leave_time as string) ?? new Date().toISOString(),
    }).eq("id", open.id);
  } else {
    await admin.from("session_zoom_participation").insert({
      cohort_id: cohort.id,
      zoom_meeting_id: String(meetingId ?? ""),
      zoom_meeting_uuid: meetingUuid,
      session_date: sessionDate,
      zoom_participant_uuid: participantUuid,
      zoom_user_email: email || null,
      display_name: displayName,
      child_id: childId,
      left_at: (p.leave_time as string) ?? new Date().toISOString(),
    });
  }
}
