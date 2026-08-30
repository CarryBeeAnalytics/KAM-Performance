# CRM v3: corrected Render deployment package

## Why the frontend failed

The original v3 archive is an update package: its README tells you to copy its
components over a working v2 application. It includes the same 13 frontend
files as the earlier `frontend.zip`, but not the files that start a Vite/React
application. Deploying those files alone fails with:

```text
Could not resolve entry module "index.html".
```

This corrected package adds the missing startup files. It does not change
your business logic or database schema.

## What changed

| Added file | Purpose |
| --- | --- |
| `frontend/index.html` | Vite entry document containing the React root element and the module script. |
| `frontend/src/main.jsx` | Mounts the existing `App.jsx`; loads base styles before the v3 add-on styles. |
| `frontend/vite.config.js` | Enables the React plugin and the automatic JSX transform; supplies the development-only `/api` proxy to localhost port 4000. |
| `frontend/src/styles.css` | Compatible base styling because the original archive contained only `styles_v3.css`. |
| `frontend/package-lock.json` | Records the frontend dependency versions used for the passing build. |
| `backend/package-lock.json` | Records the backend dependency versions used for the local startup checks. |
| `RENDER_DEPLOYMENT.md` | These instructions. |

All 24 files from the original inner project archive are preserved byte for
byte. The SQL files, user seed, Python jobs, API routes, reporting formulas,
authentication code, and role filters have not been changed. No SQL, seed,
or reporting job was run.

The supplied base stylesheet is a compatible replacement, not a recovery of
the exact v2 design. If your existing repository already has the original
`frontend/src/styles.css`, retain that file instead; `main.jsx` loads it before
`styles_v3.css`.

## Extract and upload

1. Extract the outer corrected `CRM_V3.zip`.
2. Extract the `kam-crm-v3.zip` inside it. That archive contains the project
   folder `kam-crm-v3`.
3. Merge the **contents** of that project folder into the existing `kam-crm`
   folder in your GitHub repository, matching the path shown in your Render
   error log. Do not add an extra nested project folder.
4. Commit and push the added files to the branch Render uses.

The service settings below assume GitHub contains `kam-crm/frontend` and
`kam-crm/backend`. If your repository instead contains `kam-crm-v3/frontend`
and `kam-crm-v3/backend`, use those exact paths as the two Root Directory
values. If the repository starts directly with `frontend` and `backend`, use
`frontend` and `backend`. The Root Directory must match the actual repository,
not just the name of a downloaded ZIP.

`node_modules`, `dist`, and real environment/credential files are not included
in this corrected archive. Render installs packages and builds the frontend.
Do not remove unrelated files from your existing repository.

## Two Render services

The frontend is a static Vite build. The backend is the existing Express API.
The backend does not serve the frontend's `dist` folder, so deploy them as
separate services.

| Setting | Frontend: Static Site | Backend: Web Service |
| --- | --- | --- |
| Root Directory | `kam-crm/frontend` | `kam-crm/backend` |
| Build Command | `npm ci --include=dev && npm run build` | `npm ci` |
| Publish Directory | `dist` | Not applicable |
| Start Command | Not applicable | `npm start` |
| Health Check Path | Not applicable | `/api/health` |

The frontend build explicitly includes development dependencies because Vite
and its React plugin are build tools. They are not a production web server.
Do not use `vite preview` as the frontend's production server.

Your log already selects Node 22.22.0. There is no need to change that setting
to address the missing entry file. The backend reads Render's `PORT`; leave
Render in control of the port.

## Frontend environment variable

| Variable | Value |
| --- | --- |
| `VITE_API_URL` | The existing backend's HTTPS origin, with no trailing slash and no `/api` suffix. |

Set this on the **frontend Static Site before its build**. For example, use
the origin of your backend Web Service, not the frontend URL and not a
Supabase URL. The existing client already appends `/api/login`, `/api/me`,
and the other route paths.

Vite embeds this value into JavaScript at build time. Rebuild/redeploy the
frontend whenever you change it. Do not put database credentials, a JWT
secret, or other private values in any `VITE_` variable: these values become
public browser assets.

An empty value is only appropriate if production already routes `/api` on
the frontend's own origin to this backend. The local Vite proxy does not run
on a deployed Static Site.

## Backend environment variables

Set these only on the backend Web Service. Use your existing Supabase
PostgreSQL connection details; no real values have been added to this ZIP.

| Variable | Required setting |
| --- | --- |
| `SUPABASE_DB_HOST` | Host from the chosen Supabase PostgreSQL connection method. |
| `SUPABASE_DB_PORT` | Matching port from that same connection method; the code defaults to `5432`. |
| `SUPABASE_DB_NAME` | Database name; the code defaults to `postgres`. |
| `SUPABASE_DB_USER` | Matching database username. Pooler and direct connection usernames can differ. |
| `SUPABASE_DB_PASSWORD` | Your database password. |
| `SUPABASE_DB_SSLMODE` | `require` for production. |
| `JWT_SECRET` | A strong, private, randomly generated signing secret; do not leave it blank or use a placeholder. |
| `TOKEN_TTL_HOURS` | Optional; defaults to `12`. |
| `CORS_ORIGINS` | Your frontend's exact HTTPS origin, without a trailing slash or a path. |

`CORS_ORIGINS` is plural. The existing server reads that exact variable and
supports multiple allowed origins separated by commas. It defaults to
`http://localhost:5173`, so a production frontend will not have browser access
until its origin is configured. Include a custom frontend domain too if one
is used. Redeploy/restart the backend after changing this value.

Database host, port, and user must all come from the same Supabase connection
method. Do not use a Supabase project API URL as `SUPABASE_DB_HOST`, and do not
use an anon or service-role API key as the PostgreSQL password.

## Deployment order and checks

1. Deploy the backend with its database settings and a strong `JWT_SECRET`.
2. Open its `/api/health` route. With database connectivity working, the
   response should be `{"ok":true}`. This endpoint performs `SELECT 1`; it
   verifies connectivity, not the presence of every application table.
3. Set the backend origin as the frontend's `VITE_API_URL`, then deploy the
   frontend Static Site.
4. Set the frontend origin as the backend's `CORS_ORIGINS`, then redeploy the
   backend if this changes the setting.
5. Open the frontend and sign in using an existing provisioned account.

If the page opens but login fails, check the browser Network response and the
backend log. A CORS error indicates an origin setting mismatch; a database
error requires checking the Supabase configuration and required schema.

The missing HTML file does not require resetting the database, rerunning
migrations, or recreating users. Do not run `npm run seed` as a Render build
or start command. The included original README documents the v3 schema/data
migration separately; review those steps against the state of your existing
database before applying them.

## Verification performed

- A fresh frontend dependency install using the supplied lockfile completed.
- `npm run build` passed with Vite 5.4.21: 597 modules transformed and
  `dist/index.html`, JavaScript, and CSS produced.
- All five backend JavaScript files passed syntax checks.
- The backend started locally with synthetic settings pointing only to
  localhost. `/api/me` correctly rejected an unauthenticated request, and
  `/api/login` rejected an empty request before any database query.
- CORS preflight checks permitted the configured frontend origin and the
  authorization/content-type headers. An unconfigured origin received no
  CORS access permission.
- The backend dependency audit reported zero known vulnerabilities at the
  time of this check. The frontend lockfile retains the earlier audit result:
  3 vulnerabilities, comprising 2 moderate and 1 high. These require a
  separate dependency review; this patch does not change dependency ranges.
- Vite's JavaScript chunk-size warning remains non-fatal. The chart library
  contributes to the large bundle.

Checks ran locally on Node 24.19.0, not inside your Render account. No real
database, live login, authenticated dashboard queries, browser rendering, or
production deployment was tested. No real credentials were used. This is a
verified build/startup repair, not a validation of all CRM data or metrics.
