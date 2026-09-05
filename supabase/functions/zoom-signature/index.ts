// zoom-signature
// ----------------------------------------------------------------------------
// POST { cohort_id: uuid, role: "host" | "participant" }
// Authorization: Bearer <supabase access token>   (+ apikey: <anon key>)
//
// Returns a Meeting SDK signature that is scoped to exactly one meeting — the
// recurring Zoom meeting that belongs to `cohort_id`. It never returns a
// general-purpose signature, and it never returns a meeting's start_url.
//
//   host        -> caller must be the tutor assigned to that cohort.
//                  The cohort's recurring meeting is created lazily on the
//                  first host call, then reused. Response includes the host ZAK.
//   participant -> caller must be a parent of a child with an active
//                  enrollment in that cohort. No ZAK. If the room has not been
//                  opened by the tutor yet, returns { status: "room_not_open" }.
// ----------------------------------------------------------------------------

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/http.ts";
import { signMeetingSdkJwt } from "../_shared/crypto.ts";
import { createRecurringMeeting, getZak } from "../_shared/zoom.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SDK_KEY = Deno.env.get("ZOOM_MEETING_SDK_KEY")!;
const SDK_SECRET = Deno.env.get("ZOOM_MEETING_SDK_SECRET")!;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);

  // --- who is calling ---
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return json(req, { error: "not_authenticated" }, 401);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return json(req, { error: "not_authenticated" }, 401);

  // --- input ---
  let payload: { cohort_id?: string; role?: string };
  try {
    payload = await req.json();
  } catch {
    return json(req, { error: "bad_request" }, 400);
  }
  const cohortId = (payload.cohort_id ?? "").trim();
  const role = payload.role === "host" ? "host" : payload.role === "participant" ? "participant" : null;
  if (!cohortId || !role) return json(req, { error: "cohort_id and role are required" }, 400);

  // --- load the cohort (service role; we do our own authz below) ---
  const { data: cohort, error: cohortErr } = await admin
    .from("cohorts")
    .select("id, strand, year_range, day_of_week, session_time, tutor_email, tutor_name, zoom_meeting_id, zoom_join_url, zoom_password, zoom_owner_user_id")
    .eq("id", cohortId)
    .maybeSingle();
  if (cohortErr) return json(req, { error: "lookup_failed" }, 500);
  if (!cohort) return json(req, { error: "cohort_not_found" }, 404);

  // ========================================================================
  // HOST
  // ========================================================================
  if (role === "host") {
    const { data: isTutor } = await userClient.rpc("is_tutor");
    const emailMatches = !!cohort.tutor_email &&
      cohort.tutor_email.trim().toLowerCase() === (user.email ?? "").trim().toLowerCase();
    if (!isTutor || !emailMatches) return json(req, { error: "not_authorised_for_cohort" }, 403);

    // The recurring meeting is owned by the tutor's Zoom user, and the host ZAK
    // must be fetched for that same user — so resolve it up front, whether or
    // not the meeting already exists.
    const { data: tutorRow } = await admin
      .from("tutors")
      .select("zoom_user_id, name")
      .ilike("email", cohort.tutor_email!)
      .maybeSingle();
    const zoomUserId = (cohort.zoom_owner_user_id || tutorRow?.zoom_user_id || "").trim();
    if (!zoomUserId) {
      return json(req, {
        error: "tutor_zoom_user_missing",
        message: "This tutor has no Zoom user set. Add it in the admin portal under the cohort's tutor before starting a session.",
      }, 409);
    }

    let meetingNumber = cohort.zoom_meeting_id;
    let meetingPassword = cohort.zoom_password ?? "";

    // Lazily create the cohort's recurring meeting on first host join.
    if (!meetingNumber) {
      let meeting;
      try {
        meeting = await createRecurringMeeting({
          hostUserId: zoomUserId,
          topic: `Skylark · ${cohort.strand} · ${cohort.year_range ?? "Any year"}`,
          agenda: `${cohort.day_of_week ?? ""} ${cohort.session_time ?? ""} — Skylark Learning Club`.trim(),
        });
      } catch (e) {
        console.error("createRecurringMeeting failed", e);
        return json(req, { error: "zoom_create_failed" }, 502);
      }

      // Persist only if nobody beat us to it (one tutor per cohort, so this is
      // really just guarding a double-click). If someone did, use theirs.
      const { data: updated } = await admin
        .from("cohorts")
        .update({
          zoom_meeting_id: String(meeting.id),
          zoom_join_url: meeting.join_url,
          zoom_password: meeting.password ?? "",
          zoom_owner_user_id: zoomUserId,
          zoom_meeting_created_at: new Date().toISOString(),
        })
        .eq("id", cohort.id)
        .is("zoom_meeting_id", null)
        .select("zoom_meeting_id, zoom_password")
        .maybeSingle();

      if (updated?.zoom_meeting_id) {
        meetingNumber = updated.zoom_meeting_id;
        meetingPassword = updated.zoom_password ?? "";
      } else {
        const { data: fresh } = await admin
          .from("cohorts").select("zoom_meeting_id, zoom_password").eq("id", cohort.id).single();
        meetingNumber = fresh!.zoom_meeting_id;
        meetingPassword = fresh!.zoom_password ?? "";
      }
    }

    let zak: string;
    try {
      zak = await getZak(zoomUserId);
    } catch (e) {
      console.error("getZak failed", e);
      return json(req, { error: "zak_failed" }, 502);
    }

    const signature = await signMeetingSdkJwt({
      sdkKey: SDK_KEY,
      sdkSecret: SDK_SECRET,
      meetingNumber: meetingNumber!,
      role: 1,
    });

    return json(req, {
      status: "ok",
      role: "host",
      sdkKey: SDK_KEY,
      signature,
      meetingNumber: meetingNumber,
      password: meetingPassword,
      userName: tutorRow?.name || cohort.tutor_name || "Skylark Tutor",
      zak,
    });
  }

  // ========================================================================
  // PARTICIPANT
  // ========================================================================
  // Parent of a child with an active enrollment in this cohort.
  const { data: family } = await admin
    .from("families").select("id, parent_name").eq("auth_user_id", user.id).maybeSingle();
  if (!family) return json(req, { error: "not_authorised_for_cohort" }, 403);

  const { data: kids } = await admin
    .from("children").select("id, first_name").eq("family_id", family.id);
  const childIds = (kids ?? []).map((k) => k.id);
  if (childIds.length === 0) return json(req, { error: "not_authorised_for_cohort" }, 403);

  const { data: enrollment } = await admin
    .from("enrollments")
    .select("id, child_id")
    .eq("cohort_id", cohort.id)
    .eq("active", true)
    .in("child_id", childIds)
    .limit(1)
    .maybeSingle();
  if (!enrollment) return json(req, { error: "not_authorised_for_cohort" }, 403);

  if (!cohort.zoom_meeting_id) {
    return json(req, { status: "room_not_open" });
  }

  const signature = await signMeetingSdkJwt({
    sdkKey: SDK_KEY,
    sdkSecret: SDK_SECRET,
    meetingNumber: cohort.zoom_meeting_id,
    role: 0,
  });

  const childName = (kids ?? []).find((k) => k.id === enrollment.child_id)?.first_name || "Skylark student";

  return json(req, {
    status: "ok",
    role: "participant",
    sdkKey: SDK_KEY,
    signature,
    meetingNumber: cohort.zoom_meeting_id,
    password: cohort.zoom_password ?? "",
    userName: childName,
  });
});
