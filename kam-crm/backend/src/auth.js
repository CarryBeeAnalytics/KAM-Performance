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

/** lead and admin see everything; a kam sees only their own kam_name. */
export function canAccessKam(user, kamName) {
  if (user.role === "lead" || user.role === "admin") return true;
  return normalize(user.kam_name) === normalize(kamName);
}

/** Target edit: lead and admin only (approved rule). */
export function canEditTarget(user) {
  return user.role === "lead" || user.role === "admin";
}

export function normalize(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Middleware factory: reject if the :kam or ?kam scope is not accessible. */
export function requireKamScope(getKamName) {
  return (req, res, next) => {
    const kamName = getKamName(req);
    if (!kamName)
      return res.status(400).json({ error: "A KAM name is required." });
    if (!canAccessKam(req.user, kamName)) {
      return res
        .status(403)
        .json({ error: "This KAM's data is locked for your account." });
    }
    next();
  };
}
