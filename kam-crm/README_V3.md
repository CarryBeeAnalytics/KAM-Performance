# CarryBee KAM CRM — v3

Data Intelligence & Research · restructured CRM with team-based access, four
tabs, and Business Insights for the whole merchant book.

---

## 1. What changed

| Area | v2 | v3 |
|---|---|---|
| Access | lead and admin both saw everything | admin sees everything; a **lead sees only the KAMs under them** in `kam_team_directory`; a KAM sees only their own merchants |
| Tabs | Home, Merchant Performance, KAM Performance, Summery Report | **Home, Flag, Merchant Performance, Business Insights** |
| Buttons | Order Drop, Visit, Issue (all alerting) | Order Drop, **Call FollowUp** (new), Visit, Issue — **Issue no longer alerts** |
| Targets | one retention target per KAM | admin-set **New Sales**, **Same Store Incremental**, **Same Store Retention** targets with global → lead → KAM resolution |
| Analytics | 20 hand-picked merchants, Google Sheets, Apps Script dashboard | **every KAM merchant**, rolling 30 days, stored in Supabase, rendered in the CRM |

---

## 2. Files

```
supabase/schema_v3_full.sql         RUN THIS ONE — self-sufficient
supabase/schema_v3.sql              v3 additions only; needs v2 already present
scripts/carrybee_business_insights.py   merged analytics job -> Supabase
scripts/kamp_v3_patch.py            drop-in changes for the existing KAMP job
backend/src/auth.js                 replaces the v2 file
backend/src/scope.js                new — team scope resolution
backend/src/server.js               replaces the v2 file
backend/seed_users.js               replaces the v2 file
frontend/src/App.jsx                replaces the v2 file
frontend/src/components/Sidebar.jsx           replaces
frontend/src/components/Home.jsx              replaces
frontend/src/components/Flag.jsx              new
frontend/src/components/MerchantPerformance.jsx  replaces
frontend/src/components/BusinessInsights.jsx  new
frontend/src/components/FeedbackModals.jsx    replaces
frontend/src/components/EChart.jsx            new
frontend/src/styles_v3.css          append to styles.css
```

`backend/src/db.js`, `frontend/src/api.js`, `Login.jsx` and `LineChart.jsx`
are unchanged. `KamPerformance.jsx`, `SummaryReport.jsx` and `AlertPoller.jsx`
are no longer referenced and can be deleted once v3 is live.

---

## 3. Deployment order

1. **Schema.** Run `supabase/schema_v3_full.sql` in the Supabase SQL editor.
   It creates the v2 base tables if they are missing, then layers v3 on top,
   so it works on an empty project and on one that already has v2. Every
   statement is `IF NOT EXISTS` or guarded; re-running is safe.

   Use `schema_v3.sql` only if the project already carries the v2 tables — on
   an empty project it fails at section 2 with
   `42P01: relation "public.kam_daily_report" does not exist`, because the v2
   job had never created that table.

   Verified against PostgreSQL 16: clean on an empty database, clean on a
   second run, 25 tables created, 33 directory rows seeded.
2. **Patch KAMP.** Apply `scripts/kamp_v3_patch.py` to
   `KAMP_merchant_information.py` (two changes: alert rules, acquisition type),
   then run KAMP once so `kam_daily_report` carries `acquisition_type` and the
   new alert types start appearing.
3. **Business Insights job.** Run

   ```
   conda activate <env>
   cd /d "D:\Carry Bee Projects\carrybee-automation"
   python -m src.jobs.carrybee_business_insights
   ```

   First run: add `--limit-merchants 50 --output-mode csv` and reconcile the
   CSVs against the current Top Merchant sheet before going full scale.
4. **Backend.** Copy the four backend files, `npm install`, `npm run seed`,
   restart. The seed prints a warning for any app user missing from
   `kam_team_directory` — fix those before handing out logins.
5. **Frontend.** Copy the components, append `styles_v3.css` to `styles.css`,
   add `echarts` to `package.json` (`npm i echarts`), rebuild.

---

## 4. Access model

`kam_team_directory` is the only source of truth. Roles:

- **admin** — Imtiaz, Ojhor, Muqtadir, Sufian, Mahir. Every team.
- **lead** — sees exactly the KAMs whose `lead_name` matches their own
  `kam_name`, plus their own book.
- **kam** — their own merchants only.

Every scoped query goes through `resolveScope()`, which produces an array
membership test on a **normalised** `kam_name`. A `?kam=` / `?lead=` / `?team=`
filter can only narrow what the role already allows. Casing variants in the
source list (`MD Solayman Shadik Shady` vs `Md Solayman Shadik Shady`) were
folded into one canonical spelling in the directory seed.

Three names in the source mapping are placeholders rather than people —
`Internal`, `Not Specified`, `Mahmudul (Inbound)`. They are seeded so their
merchants stay visible to the right lead; no login is created for `Internal`
or `Not Specified`.

**Sufian Ahmed** appears both as the Organic lead and on the admin list. He is
seeded as **admin**, so he sees every team. To scope him to Organic instead,
change his role to `lead` and set `kam_name = 'Sufian Ahmed'`.

---

## 5. Metric definitions (Home tab)

All figures respect the 06:00–06:00 BD operational day and count
`COUNT(DISTINCT consignment_id)` on the standard processed status set.

| KPI | Definition |
|---|---|
| Total Merchant | merchants in the current `kam_daily_report` book |
| Total Order Previous Day | `SUM(last_day_order)` on the latest reporting day |
| Total Order This Month | processed orders with a BD business date in the current month |
| Total Order Last Week | last **completed** Monday–Sunday BD week |
| Total Order Last Month | full previous calendar month |
| Total Active Merchant | at least one processed order in the trailing 30 days |
| Total Inactive Merchant | the remainder of the book |
| New Onboard Merchant | first qualifying processed order **ever** falls in this month |
| Churn Win Merchant | ordered this month, had prior history, and ≥ 30 days between the last pre-month order and the first order this month |
| Total Alerts / Worked / Not Worked | `kam_alerts` (order drop, call follow-up, visit) |
| Call Tracker Alerts | merchants owing a call in the current BD week |

Classification priority is **New Onboard → Churn Win → Existing → Inactive**;
each merchant lands in exactly one bucket per month.

### New Sales

- **Achievement Revenue** = this month's revenue from New Onboard + Churn Win
  merchants.
- **Total Revenue** = this month's revenue, all merchants in scope.
- **Achievement %** = Achievement Revenue ÷ Target Revenue.
- **2% of Current Revenue** = `incentive_pct` % of Achievement Revenue. The
  card stays locked until Achievement % reaches `unlock_threshold_pct`. Both
  values are admin-set.
- Revenue is **Final Fee** on terminal parcels: status 17 →
  `delivery_fee − discount`; otherwise `delivery_fee + cod_fee − discount`.

### Same Store Incremental

Same store = merchants classified **Existing** that also ordered last month, so
a new merchant can never inflate growth.

- Increment Order = current-month orders − previous-month orders for that set.
- Increment Revenue = same, on revenue.
- Achievement % = actual growth % ÷ target growth %.

### Same Store Retention

- Base = merchants with orders last month. Retained = base with orders this
  month.
- Retention % = retained ÷ base. Achievement % = retention % ÷ target %.
- Total Discount % = `discount ÷ (delivery fee + COD fee)` on terminal parcels.

---

## 6. Flag tab rules

| Button | Fires when | Alerts? |
|---|---|---|
| Order Drop | `order_gap_with_previous_day < 0` | yes |
| Call FollowUp | exactly **2** days since the last order | yes |
| Visit | **3 or more** days since the last order, or never ordered | yes |
| Issue | always available | **no** |

Gap = `reporting_date − last_order_date::date`, so the button a KAM sees and
the alert the nightly job writes cannot disagree. Call and Visit are mutually
exclusive, per the approved split.

---

## 7. Business Insights

`carrybee_business_insights.py` is the merged job. It keeps every analytical
rule from `selected_merchant_5_tab_backfill` verbatim — the OMS/Pegasus/Mohajon
SQL, the aging brackets, the SLA rule, the Final Fee formula, the FID ↔ Sorted
Cohort reconciliation check — and changes only three things:

1. the merchant list comes from Supabase instead of a hardcoded tuple;
2. the window is a rolling 30 days instead of a fixed backfill range;
3. output goes to Supabase instead of Google Sheets.

Merchants are processed in batches (default 400) so no `IN` list grows
unbounded. Windowed tables delete exactly the rebuilt date range before
inserting; snapshot tables (FID/RID in process and their parcel-level detail)
are truncated and rebuilt, because they represent *now*, not a history.

The `Hub Info` worksheet is still the only geography source, exactly as before.

**Schedule:** run KAMP first, then this job. It reads `kam_daily_report`, so
running it before KAMP on a new merchant means that merchant is missing from
Business Insights for one day.

---

## 8. Things to confirm before go-live

1. **Row volume.** Parcel-level `ba_fid_detail` / `ba_rid_detail` for the full
   book is much larger than for twenty merchants. Run once with
   `--limit-merchants 200`, check the row counts in `ba_refresh_log`, and
   extrapolate against the Supabase plan's storage before the first full run.
2. **Runtime.** Each batch runs the full five-dataset pipeline. Time one batch,
   multiply by the batch count, and confirm it fits the nightly window.
3. **Reconciliation.** Compare the first run's `ba_cohort_daily` against the
   existing Top Merchant sheet for the twenty original merchants over the same
   dates. The totals must match exactly — the logic is identical, so any
   difference is a scope or window bug, not a calculation one.
4. **`acquisition_type` coverage.** Merchants whose Merchant Information "Type"
   cell is blank show as "Not Specified" in the Flag table.
5. **Supabase password rotation.** Still outstanding from the v2 build.
