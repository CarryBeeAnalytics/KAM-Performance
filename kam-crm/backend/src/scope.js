import { query } from "./db.js";
import { normalize } from "./auth.js";

/**
 * Access scoping for the v3 CRM.
 *
 *   admin  every KAM, every team
 *   lead   every KAM whose kam_team_directory.lead_name matches the lead's own
 *          kam_name (their own book is included because a lead carries
 *          merchants too)
 *   kam    their own kam_name only
 *
 * The directory is the only source of truth. Nothing about team membership is
 * hardcoded in the backend, so re-seeding kam_team_directory is all it takes
 * to move a KAM between leads.
 *
 * Every scoped query filters on a NORMALISED kam_name array, which is why the
 * casing variants in the source list ("MD Solayman..." vs "Md Solayman...")
 * cannot leak a merchant to the wrong lead.
 */

const CACHE_TTL_MS = 60_000;
let directoryCache = { at: 0, rows: [] };

export async function loadDirectory(force = false) {
  const now = Date.now();
  if (!force && now - directoryCache.at < CACHE_TTL_MS) return directoryCache.rows;
  const { rows } = await query(
    `SELECT kam_name, lead_name, team_name
     FROM kam_team_directory
     WHERE is_active
     ORDER BY team_name, kam_name`
  );
  directoryCache = { at: now, rows };
  return rows;
}

/** Every KAM name this user may read. Empty array = nothing (should not happen). */
export async function visibleKams(user) {
  const directory = await loadDirectory();
  if (user.role === "admin") return directory.map((row) => row.kam_name);
  if (user.role === "lead") {
    const own = normalize(user.kam_name);
    const names = directory
      .filter((row) => normalize(row.lead_name) === own)
      .map((row) => row.kam_name);
    // A lead who is not listed as anyone's lead still sees their own book.
    if (!names.some((name) => normalize(name) === own)) names.push(user.kam_name);
    return names;
  }
  return [user.kam_name];
}

export async function canAccessKam(user, kamName) {
  if (user.role === "admin") return true;
  const allowed = await visibleKams(user);
  return allowed.some((name) => normalize(name) === normalize(kamName));
}

export async function canAccessLead(user, leadName) {
  if (user.role === "admin") return true;
  if (user.role === "lead") return normalize(user.kam_name) === normalize(leadName);
  return false;
}

/**
 * Build a SQL predicate limiting an aliased table to the caller's scope,
 * optionally narrowed by ?kam= / ?lead= / ?team=.
 *
 * Returns { where, params } where params start at $startIndex, or
 * { error, status } when the requested narrowing is out of scope.
 *
 * The predicate is always an array membership test on normalised kam_name, so
 * a narrowing filter can only ever REDUCE what the role already allows.
 */
export async function resolveScope(req, alias = "d", startIndex = 1) {
  const requestedKam = String(req.query.kam || "").trim();
  const requestedLead = String(req.query.lead || "").trim();
  const requestedTeam = String(req.query.team || "").trim();

  const directory = await loadDirectory();
  let allowed = await visibleKams(req.user);

  if (requestedLead) {
    if (!(await canAccessLead(req.user, requestedLead))) {
      return { error: "This lead's data is locked for your account.", status: 403 };
    }
    const inLead = directory
      .filter((row) => normalize(row.lead_name) === normalize(requestedLead))
      .map((row) => row.kam_name);
    allowed = allowed.filter((name) =>
      inLead.some((other) => normalize(other) === normalize(name))
    );
  }

  if (requestedTeam) {
    const inTeam = directory
      .filter((row) => normalize(row.team_name) === normalize(requestedTeam))
      .map((row) => row.kam_name);
    allowed = allowed.filter((name) =>
      inTeam.some((other) => normalize(other) === normalize(name))
    );
    if (!allowed.length) {
      return { error: "This team is locked for your account.", status: 403 };
    }
  }

  if (requestedKam) {
    if (!allowed.some((name) => normalize(name) === normalize(requestedKam))) {
      return { error: "This KAM's data is locked for your account.", status: 403 };
    }
    allowed = [requestedKam];
  }

  const normalised = allowed.map((name) => normalize(name));
  return {
    where: `lower(btrim(${alias}.kam_name)) = ANY($${startIndex}::text[])`,
    params: [normalised],
    kams: allowed,
  };
}

/**
 * A merchant a user may write against. Returns the merchant row, null when it
 * does not exist, or the string "forbidden".
 */
export async function loadMerchantForUser(user, businessId) {
  const { rows } = await query(
    `SELECT business_id, business_name, kam_name, lead_name, reporting_date,
            visit, risk, order_gap_with_previous_day, last_order_date
     FROM kam_daily_report WHERE business_id = $1`,
    [businessId]
  );
  const merchant = rows[0];
  if (!merchant) return null;
  if (!(await canAccessKam(user, merchant.kam_name))) return "forbidden";
  return merchant;
}
