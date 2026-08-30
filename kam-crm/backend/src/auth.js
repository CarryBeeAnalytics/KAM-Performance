import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "";
if (!JWT_SECRET || JWT_SECRET === "CHANGE_ME_TO_A_LONG_RANDOM_STRING") {
  console.warn(
    "WARNING: JWT_SECRET is not set to a strong value. Set it in .env before production."
  );
}

export function signToken(user) {
  const ttlHours = Number(process.env.TOKEN_TTL_HOURS || 12);
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
      kam_name: user.kam_name,
    },
    JWT_SECRET,
    { expiresIn: `${ttlHours}h` }
  );
}

/** Require a valid Bearer token; attaches req.user. */
export function authRequired(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Sign in to continue." });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Session expired. Sign in again." });
  }
}

/** Admin-only actions: targets, unlock thresholds, user administration. */
export function isAdmin(user) {
  return user.role === "admin";
}

/**
 * v3 change: a lead is NO LONGER a global viewer. A lead sees exactly the KAMs
 * whose lead_name in kam_team_directory equals the lead's own kam_name, plus
 * their own book. Only role = 'admin' sees everything. The KAM name set is
 * resolved in scope.js against the directory, never hardcoded here.
 */
export function normalize(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}
