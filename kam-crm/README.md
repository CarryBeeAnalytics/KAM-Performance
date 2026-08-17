# CarryBee KAM CRM

End-to-end CRM for the KAM team: the nightly `kamlk.py` job mirrors merchant
performance into Supabase, KAMs submit feedback in the web app in real time,
and all feedback/alert/call history is stored permanently in Supabase.

```
kam-crm/
├── supabase/schema.sql   ← run FIRST in the Supabase SQL editor
├── scripts/KAMP.py       ← replaces the KAM job in carrybee-automation
├── backend/              ← Node.js (Express) API, premade username/password login
└── frontend/             ← React (Vite) app, Pipedrive-style UI, Normal/Dark themes
```

## What's new in v2

- **Pipedrive-style redesign**: dark #181818 left sidebar with the four tabs
  (Home, Merchant Performance, KAM Performance, Summery Report); Lead & KAM
  filters appear in the sidebar under the active tab. Yellow #FFCC00 is the
  primary action color. Two themes: **Normal (white, default)** and **Dark**.
- **Home tab** (landing page): total merchants, total order prev. day, total
  reason alerts, worked / not worked, call tracker alerts and pending — plus
  a last-7-day Worked vs Not Worked trendline and a Total Order trendline.
- **Merchant Performance** is now three tables: **Lifetime** (with the
  editable Promised Order button and the Avg. Order / Promised ratio),
  **Daily Performance** (current-day metrics and the action buttons), and
  **DOD Order Count** (merchant-wise daily orders with real date columns and
  a month selector).
- **KAM Performance**: reason buttons are now solid yellow pulsing buttons
  that turn green once feedback is saved.
- **Script**: KAM DOD day columns are real dates ("Aug 1", "Aug 2", …);
  months use their true 28/29/30/31-day length; every month's data is stored
  permanently in `kam_dod_monthly`, so nothing is lost at month rollover.
  The DOD month follows the **report business day** (cutoff − 1): the
  `--cutoff-date 2026-09-01` run still reports August in full; September's
  DOD starts on the `--cutoff-date 2026-09-02` run.


## 0. Security first

- **Rotate the Supabase database password now** (Dashboard → Settings →
  Database → Reset password). It was shared in plain text during planning.
- Never commit `.env`. Both `backend/.gitignore` and the automation repo's
  gitignore must keep it out.

## 1. Supabase (one time)

Open the Supabase SQL editor and run `supabase/schema.sql`. It:
- renames `onboarded_date → registration_date`,
  `day_over_day_change → order_gap_with_previous_day`,
  `report_date → reporting_date` on `kam_daily_report` (safe to re-run);
- creates `app_users`, `feedback_order_drop`, `feedback_visit`,
  `feedback_issue`, `issue_reasons`, `kam_alerts`, `weekly_call_log`,
  `kam_summary_daily` with RLS enabled (the backend connects as table owner).

The edited `KAMP.py` also applies the same DDL on every run, so a missed
migration self-heals. **Note:** on first run of v2, the legacy wide
`kam_dod` (day_01..day_30) is dropped and recreated in the new jsonb shape —
it is a current-state table rebuilt nightly, so no history is lost, and the
permanent archive lives in `kam_dod_monthly` from that run onward.

## 2. Nightly job

Copy `scripts/KAMP.py` over the KAM job in the carrybee-automation project.
Same run command as before:

```
python -m src.jobs.KAMP --cutoff-date 2026-08-17
```

New behaviour in each run, in order:
1. **Alert generation (before sync):** every merchant whose Order Drop /
   Visit / Issues button was active for the previous reporting date and has
   no matching feedback gets a permanent `Not Worked` row in `kam_alerts`.
2. Normal Sheets + Supabase current-state sync (renamed columns, new Visit
   logic).
3. **Weekly call backfill:** merchants not called in the last completed
   Monday-start BD week get a permanent `Not Worked` row in `weekly_call_log`.
4. **Summary snapshot:** one row per KAM per reporting date into
   `kam_summary_daily` (powers the Summery Report tab history and the Home
   trendlines).
5. **DOD archive:** the month's DOD state is upserted into `kam_dod_monthly`
   (keyed by business + month, never deleted). The web DOD table reads this
   archive, so it fills after the first v2 run and keeps every past month.

`--skip-alerts` skips steps 1 and 3; `--skip-supabase` behaves as before.

## 3. Backend

```
cd backend
cp .env.example .env        # fill in the NEW rotated password + a long JWT_SECRET
npm install
npm run seed                # creates the 12 users (initial password from .env)
npm start                   # listens on :4000
```

Seeded accounts (initial password = `SEED_DEFAULT_PASSWORD`, default
`Carrybee@2026` — share privately and change it):

| Username | Role | Sees |
|---|---|---|
| abdul.goni, jaber.aunto, anik.ahamed, asif.rayhan, istiaque, raian.rudra | kam | only merchants where `kam_name` equals their own name |
| akash.saha | lead | all teams (and his own KAM book button) |
| mahir.faisal, imtiaz, zubayer, muktadir | admin | everything + target editing |

Rerunning `npm run seed` updates names/roles but never overwrites a changed
password.

## 4. Frontend

```
cd frontend
npm install
npm run dev        # local: proxies /api to localhost:4000
npm run build      # production: dist/
```

For production, set `VITE_API_URL=https://your-backend-host` at build time and
add the frontend origin to `CORS_ORIGINS` in the backend `.env`.

## Business rules implemented (as approved)

- **Visit:** ≥3 days since last order → Must visit; 1–2 days → Call Mandatory;
  ordered on the report day → No need; never ordered → Must visit.
- **Order Drop button:** active when Order Gap with Previous Day < 0.
- **Issues button:** active when Risk ≠ "No risk" (includes "No Order");
  reasons are a growing dropdown — a typed new reason is saved for everyone.
- **Feedback:** one editable entry per merchant per reporting date, 1000-char
  limit, full history kept forever (no FK to the refreshed table).
- **Alerts:** generated daily by the job for unworked buttons; submitting
  feedback flips the alert to Worked automatically; a popup every 10 minutes
  shows the pending count (KAM: own; Lead/Admin: combined).
- **Weekly Call Tracker:** all merchants per KAM, resets each Monday (BD);
  a saved drive link = Worked; missed weeks are stored permanently as
  Not Worked by the nightly job; pending rows render in alert colour.
- **Target:** editable by Lead/Admin only; entering `10` means +10% and is
  stored as 0.10. Web targets flow back into the Google Sheet on the next run.
- **Summery Report:** per-day snapshots stored in `kam_summary_daily`;
  Today's Order = the latest reporting day's orders.
- **Promised Order:** set per merchant by its KAM, any Lead, or an Admin;
  stored in `merchant_promised_order` (survives nightly refreshes); the
  ratio column = Avg. Order ÷ Promised Order.
- **Lead filters:** Lead/Admin only; a KAM account sees Lead filters locked
  and only their own KAM book unlocked.
