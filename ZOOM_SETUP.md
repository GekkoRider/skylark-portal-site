# Zoom Meeting SDK — setup & deployment runbook

This turns the external "classroom link" into an in-portal join experience:
tutors join as **host** and students as **participant**, both embedded inside
the Skylark portal (Zoom Meeting SDK for Web, **component view**, v6.2.0).

Nothing here can be done from the Claude Code environment — no GitHub push
credentials, no Supabase CLI token, no Zoom account. The code is committed; the
steps below are for a person (or a Cowork session with the GitHub + Supabase
connectors).

---

## 0. How the auth model works (why the steps are what they are)

- **Every meeting is created inside Skylark's own Zoom account.** Tutors are
  licensed users *in that account*; students join a meeting *owned by that
  account*. That means the March 2026 OBF-token requirement (for apps joining
  meetings **outside** their own account, e.g. notetaker bots) **does not apply**
  — no app review, no OBF.
- The web client needs a **Meeting SDK signature** (a short-lived JWT, HS256,
  signed with the Meeting SDK app's *Client Secret*). It is minted only by the
  `zoom-signature` Edge Function and is **scoped to one meeting** — the recurring
  meeting that belongs to that cohort.
- To *start* a meeting as host, the web client also needs the host user's **ZAK**
  token. The Edge Function fetches it server-side with Server-to-Server OAuth
  (`GET /users/{zoom_user_id}/token?type=zak`) — no interactive per-tutor OAuth,
  because the tutor's Zoom user is in our account.
- **Server-to-Server OAuth** (`account_credentials` grant) authenticates every
  REST call: create meeting, get ZAK, download recording.
- The **webhook** is verified with the Meeting SDK app's *Secret Token*
  (`v0:{timestamp}:{raw body}` → HMAC-SHA256 → compare `x-zm-signature`).

---

## 1. Zoom account — one licensed user per active tutor

The cohort's recurring meeting is **owned by the assigned tutor's Zoom user**, so
tutors' concurrent cohorts don't collide.

1. In the Zoom admin panel, create/confirm a **Licensed** user for each active
   tutor (their Skylark email is fine as the Zoom login).
2. Note each tutor's Zoom user id — the login email works as the id.
3. In the portal: **/admin/ → cohort card → Edit tutor → "Zoom user"** field.
   Save. (This writes `tutors.zoom_user_id`, keyed by the tutor's login email, so
   it's shared across all their cohorts.)

The cohort card shows **"tutor has no Zoom user — set it below"** until this is
done, and starting a session returns a clear "Zoom not set up yet" message.

---

## 2. Zoom Marketplace — Server-to-Server OAuth app

**Develop → Build App → Server-to-Server OAuth.**

- Scopes (grant the `:admin` variants so meetings owned by any tutor user are
  reachable — confirm exact strings in the picker, names drift):
  - `meeting:write:admin` — create the recurring meeting
  - `meeting:read:admin`
  - `user:read:admin` — fetch the host ZAK (`/users/{id}/token?type=zak`)
  - `cloud_recording:read:admin` — download completed recordings
- Activate the app.
- Copy **Account ID**, **Client ID**, **Client Secret**.

---

## 3. Zoom Marketplace — Meeting SDK app

**Develop → Build App → Meeting SDK.**

- Copy **Client ID** (this is the `SDK key`) and **Client Secret**.
- **Embed / Allow-list domains:** add `https://portal.skylark.education`
  (and, for local testing, `http://localhost:*` as your setup allows).
- **Feature → Event Subscriptions** → add a subscription:
  - **Event notification endpoint URL:**
    `https://clsbenbapgvgmubzbgxw.supabase.co/functions/v1/zoom-webhook`
  - Events:
    - `Recording → All Recordings have completed` (`recording.completed`)
    - `Meeting → Participant/Host joined meeting` (`meeting.participant_joined`)
    - `Meeting → Participant/Host left meeting` (`meeting.participant_left`)
  - Copy the **Secret Token**.
  - Click **Validate** — the function answers the CRC challenge. It must go green
    *before* you deploy secrets? No — deploy step 5 first, then Validate.

---

## 4. Enable cloud recording (Zoom account settings)

- **Account Settings → Recording → Cloud recording: ON.**
- The meeting is created with `auto_recording: "cloud"`, so sessions record
  automatically. If your plan has no cloud storage, either buy the add-on or set
  `auto_recording` to `"none"` in
  `supabase/functions/_shared/zoom.ts → createRecurringMeeting` and the recording
  webhook simply never fires.

---

## 5. Deploy the Edge Functions

From a checkout of this repo, with the Supabase CLI logged in:

```bash
supabase functions deploy zoom-signature --project-ref clsbenbapgvgmubzbgxw
supabase functions deploy zoom-webhook  --project-ref clsbenbapgvgmubzbgxw --no-verify-jwt
```

`zoom-webhook` **must** be `--no-verify-jwt` (Zoom calls it, not a logged-in
user; it does its own signature check). `zoom-signature` keeps JWT verification.

Set the secrets (once):

```bash
supabase secrets set --project-ref clsbenbapgvgmubzbgxw \
  ZOOM_S2S_ACCOUNT_ID=xxxxx \
  ZOOM_S2S_CLIENT_ID=xxxxx \
  ZOOM_S2S_CLIENT_SECRET=xxxxx \
  ZOOM_MEETING_SDK_KEY=xxxxx \
  ZOOM_MEETING_SDK_SECRET=xxxxx \
  ZOOM_WEBHOOK_SECRET_TOKEN=xxxxx
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` are injected
automatically — do not set them.

Then go back to **step 3** and click **Validate** on the event subscription.

---

## 6. Run the database migration

Supabase Dashboard → **SQL Editor** → paste and run
[`db/zoom_migration.sql`](db/zoom_migration.sql).

First, in a scratch query, review existing policies (names are inconsistent in
this project):

```sql
select * from pg_policies where schemaname = 'public' order by tablename;
```

The migration:
- adds `zoom_*` columns to `cohorts` and `zoom_user_id` to `tutors`
- creates `session_recordings` and `session_zoom_participation` (+ RLS)
- adds `current_parent_cohort_ids()` (SECURITY DEFINER)
- creates the **private** `session-recordings` Storage bucket (+ object policies)
- adds a staff-write policy on `tutors`

After running: **Storage → session-recordings → confirm "Public" is OFF.**

---

## 7. Ship the site

Push to `main`. GitHub Pages redeploys `portal.skylark.education`. New/changed
files:

- `session.html` — parent/student embedded join (participant)
- `tutor/session.html` — tutor embedded join (host + host tools)
- `tutor/index.html` — "Start session" replaces "Open classroom"
- `dashboard.html` — "Join … session" now points at `/session.html`
- `admin/index.html` — tutor "Zoom user" field + Zoom status pills

`classroom_link` is left in the schema and still shown to tutors as a small
"Open old external link" fallback for one cycle.

---

## 8. Test with a 4-student meeting BEFORE a real cohort

Use a **Zoom developer/sandbox** account. Component view has tighter limits than
the native client — Chromium-only, and without cross-origin isolation headers
(GitHub Pages can't send `COOP`/`COEP`, so `SharedArrayBuffer` is off and the SDK
runs its compatibility path). Confirm it holds at real cohort size.

1. Seed a test cohort, assign a test tutor, set that tutor's **Zoom user** in
   `/admin/`.
2. Tutor opens **Start session** → check a meeting appears in the Zoom account
   with **Waiting room ON**, tutor is host inside the portal (no external tab).
3. Four browsers (real Chrome profiles or machines) open the parent
   **Join … session** → they land in the waiting room → tutor uses **Admit
   waiting** / the Participants panel to let them in.
4. From the tutor view confirm: **Mute everyone**, **Lock room**, and
   per-pupil **mute / remove** from the Participants panel all work.
5. Hold the 5-way call ~10 min on Chrome. Watch audio/video stability.
6. End the meeting → wait for the cloud recording → check:
   - Supabase → Edge Functions → `zoom-webhook` logs show `recording.completed`
   - a file exists under `session-recordings/<cohort_id>/<date>/…`
   - a `session_recordings` row exists, `consent_missing_child_ids` reflects the
     test children's `session_recording` consent state
7. Check `session_zoom_participation` got join/leave rows, and that
   `attendance` was **not** touched — the tutor's one-tap register in
   `tutor/index.html` still works and is still the source of truth.
8. Negative checks: a parent not enrolled in that cohort, and a tutor not
   assigned to it, both get **403** from `zoom-signature`.

---

## Rollout

Switch **one** real cohort to the embedded flow, confirm at true size for a
week, then let the rest follow (nothing to change per-cohort — the meeting is
created on the tutor's first Start). Drop the `classroom_link` fallback in a
later change once every cohort has run embedded.

---

## Operational notes

- **Recordings are stored regardless of consent.** The webhook attaches
  `consent_missing_child_ids` (enrolled children with no current
  `session_recording` consent) to each `session_recordings` row for staff to act
  on. It does not block or delete. If a child never has consent, handle that
  operationally per the Membership Agreement.
- **Large recordings:** files over 250 MB are catalogued (`stored = false`,
  `skipped_reason = 'oversized'`) but not copied into the bucket — pull those
  from Zoom manually or raise `MAX_STORE_BYTES` in `zoom-webhook/index.ts`.
- **A tutor changing cohorts:** update the tutor email on the cohort in
  `/admin/`. The existing `zoom_meeting_id` stays (meeting still owned by the old
  Zoom user). To re-own it, clear `cohorts.zoom_meeting_id` (and the other
  `zoom_*` columns) for that cohort in the Table Editor; the next Start recreates
  it under the new tutor.
- **SDK version:** pinned to `6.2.0` in the two `session.html` files. Each page
  loads, in order: the five Zoom vendor globals
  (`react`, `react-dom`, `redux`, `redux-thunk`, `lodash` from
  `source.zoom.us/6.2.0/lib/vendor/…`), then
  `zoom-meeting-embedded-6.2.0.min.js`, then sets
  `assetPath: https://source.zoom.us/6.2.0/lib/av`. Bump every one of those
  together — the component-view bundle throws `React is not defined` if the
  vendor scripts are missing or a different version.
