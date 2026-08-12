# CarryBee KAM CRM

End-to-end CRM for the KAM team: the nightly `kamlk.py` job mirrors merchant
performance into Supabase, KAMs submit feedback in the web app in real time,
and all feedback/alert/call history is stored permanently in Supabase.

```
kam-crm/
├── supabase/schema.sql   ← run FIRST in the Supabase SQL editor
├── scripts/kamlk.py      ← replaces src/jobs/kamlk.py in carrybee-automation
├── backend/              ← Node.js (Express) API, premade username/password login
└── frontend/             ← React (Vite) app, CarryBee dark/light theme
```

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

The edited `kamlk.py` also applies the same DDL on every run, so a missed
migration self-heals.

## 2. Nightly job

Copy `scripts/kamlk.py` over `src/jobs/kamlk.py` in the carrybee-automation
project. Same run command as before:

```
python -m src.jobs.kamlk --cutoff-date 2026-08-12
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
   `kam_summary_daily` (powers the Summery Report tab history).

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
