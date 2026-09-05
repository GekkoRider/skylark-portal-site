# Skylark Learning Club — Parent Portal

A lightweight, branded portal where parents log in (no password — a magic
link emailed to them) and see their child's cohort, weekly classroom link,
digital packs, and progress reports.

Stack: plain HTML/JS (no build step, matches the main site) + [Supabase](https://supabase.com)
for auth and data. Hosted as a static site, same as skylark.education.

## 1. Create the Supabase project

1. Go to [supabase.com](https://supabase.com) and create a free project (choose a region close to the UK, e.g. `eu-west-2` London if available).
2. Once it's ready, open the **SQL Editor** and run the contents of `schema.sql` from this folder. This creates all the tables and the security rules that keep each family's data private to them.
3. Go to **Authentication → Providers** and make sure **Email** is enabled with **"Confirm email"** OFF and **magic link / OTP** as the sign-in method (this is Supabase's default — no extra setup needed for a basic magic-link flow).
4. Go to **Authentication → URL Configuration** and set:
   - **Site URL**: `https://portal.skylark.education`
   - **Redirect URLs**: add `https://portal.skylark.education/dashboard.html`

## 2. Connect the site to your project

In **Project Settings → API**, copy:
- **Project URL**
- **anon public** key (this is safe to put in client-side code — it's a public key by design; real protection comes from the Row Level Security policies in `schema.sql`, not from hiding this key)

Paste both into the marked spots near the top of the `<script>` tag in **both** `index.html` and `dashboard.html`:

```js
const SUPABASE_URL = 'https://YOUR-PROJECT-REF.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR-ANON-PUBLIC-KEY';
```

Never paste your **service role** key here — that key bypasses all security rules and must never appear in a public website. Only use it privately (e.g. in the Stripe webhook function described below).

## 3. Deploy

This deploys exactly like your main site:

1. Create a new GitHub repo, e.g. `skylark-portal-site`.
2. Add `index.html`, `dashboard.html`, and a `CNAME` file containing `portal.skylark.education`.
3. Enable GitHub Pages on the repo (Settings → Pages → deploy from `main`, root).
4. In Squarespace DNS, add a `CNAME` record: Host `portal` → Value `<your-github-username>.github.io`.
5. Back in GitHub Pages settings, set the custom domain to `portal.skylark.education` and enable HTTPS once the DNS check passes.

## 4. Adding a new family (after they subscribe)

Right now this is a manual step your team does after each Stripe signup —
matching the "cohort placement" email you already send.

**Important correction:** `auth_user_id` does **not** link itself
automatically. A parent's row in Supabase's `auth.users` table is only
created the first time they actually sign in via magic link — and even
then, nothing connects that new auth user back to their `families` row on
its own. You have to link it by hand, once, per family:

1. Ask the parent to sign in at `portal.skylark.education` at least once
   (or do it yourself with their email) — this creates their `auth.users`
   record.
2. In the Supabase **Table Editor**, open `families` and add a row with the
   parent's `email` and `parent_name`.
3. Double-click the `auth_user_id` cell on that row. This opens a picker
   listing everyone in `auth.users` — find the row matching the parent's
   email (check **Authentication → Users** in the sidebar first if you need
   to confirm which ID belongs to which email) and select it. This is the
   step that actually links their login to their family record.
4. Add a row to `children` linked to that family (`family_id`), with the
   child's first name and year group.
5. Add a row to `enrollments` linking the child to the right `cohorts` row
   (create the cohort first, under the `cohorts` table, if it doesn't exist
   yet).

Once `auth_user_id` is linked, the parent can go to
`portal.skylark.education`, enter their email, and see their child's
dashboard. If they signed in *before* you finish linking their row, they'll
see a "couldn't load your dashboard" error until the link is made — just
finish step 3 and have them refresh.

### Automating this later

When you're ready to stop doing this by hand, a small **Supabase Edge
Function** listening for Stripe's `checkout.session.completed` webhook can
create the `families` row automatically the moment someone pays — using the
name/email Stripe Checkout collects. That covers steps 2 and 4 above.

Step 3 (linking `auth_user_id`) can also be automated with a Postgres
trigger on `auth.users` that runs on insert: match the new user's email
against any `families` row with a matching `email` and a `NULL`
`auth_user_id`, and fill it in automatically. This removes the manual
linking step entirely once a parent signs in for the first time — worth
adding once you're tired of doing step 3 by hand.

## 5. Updating weekly content

Each week, your team updates two tables directly in the Supabase Table
Editor — no code required:
- **`cohorts`**: update `classroom_link` if a session's video link changes.
- **`packs`**: add a new row each month with that cohort's PDF link (e.g. hosted on Google Drive with "anyone with the link can view" sharing).
- **`progress_reports`**: add a new row each month per child with their report text.

## Live classroom (Zoom Meeting SDK)

The weekly session runs **inside** the portal now, not on an external link:

- Tutors open a cohort's **Start session** (`tutor/session.html`) and join as
  host; students open **Join … session** (`session.html`) and join as
  participant. Both use the Zoom Meeting SDK for Web, component view (v6.2.0),
  loaded from `source.zoom.us` — same "CDN script tag, no build" approach as the
  rest of the repo.
- Two Supabase Edge Functions do everything privileged (`supabase/functions/`):
  `zoom-signature` mints a meeting-scoped SDK signature after checking the caller
  is the assigned tutor or an enrolled child's parent; `zoom-webhook` receives
  `recording.completed` and files the recording in a private Storage bucket.
- Zoom SDK secret and Server-to-Server OAuth credentials live only in Edge
  Function secrets — never in portal JS.
- Schema changes are in [`db/zoom_migration.sql`](db/zoom_migration.sql).
- **Full setup and test steps: [`ZOOM_SETUP.md`](ZOOM_SETUP.md).**
- Manual one-tap attendance in `tutor/index.html` is unchanged and remains the
  source of truth; Zoom join/leave times are captured separately as a
  supplementary signal only.

## Notes

- This is deliberately minimal — one classroom per child, one pack per
  cohort per month, one report per child per month. If Skylark's needs grow
  (multiple cohorts per child, file uploads instead of links, tutor-facing
  editing), the schema and pages here are a starting point to extend, not
  a finished product.
- Parents are read-only in this version — all writes happen via the
  Supabase dashboard by your team. That's intentional for a v1.
