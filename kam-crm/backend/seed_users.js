/**
 * Seed the v3 app users.
 *
 *   admin  full access to every team: Imtiaz, Ojhor, Muqtadir, Sufian, Mahir
 *   lead   sees only the KAMs listed under them in kam_team_directory
 *   kam    sees only their own merchants
 *
 * kam_name for role 'kam' and role 'lead' MUST match kam_team_directory.kam_name
 * (and therefore kam_daily_report.kam_name) exactly, spelling and casing
 * aside - matching is done on a normalised name, so extra spaces are safe but
 * a different spelling is not.
 *
 * Usage:  npm run seed
 * Everyone starts with SEED_DEFAULT_PASSWORD from .env. Rerunning updates
 * names and roles but NEVER overwrites an existing password.
 *
 * Note on Sufian Ahmed: he is the lead of the Organic team AND an approved
 * admin. Admin wins, so he is seeded as admin and sees every team. If he
 * should instead be scoped to Organic only, change his role to 'lead' and set
 * kam_name to 'Sufian Ahmed'.
 */
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import { pool } from "./src/db.js";

dotenv.config();

const USERS = [
  // ---- Admins (all access) ----
  { username: "imtiaz",   full_name: "Imtiaz",         role: "admin", kam_name: "" },
  { username: "ojhor",    full_name: "Ojhor",          role: "admin", kam_name: "" },
  { username: "muqtadir", full_name: "Muqtadir",       role: "admin", kam_name: "" },
  { username: "sufian",   full_name: "Sufian Ahmed",   role: "admin", kam_name: "" },
  { username: "mahir",    full_name: "Mahir",          role: "admin", kam_name: "" },

  // ---- Leads (their own team only) ----
  { username: "asif.rashid", full_name: "Ahmed Asif Rashid",     role: "lead", kam_name: "Ahmed Asif Rashid" },
  { username: "akash.saha",  full_name: "Akash Saha",            role: "lead", kam_name: "Akash Saha" },
  { username: "ibrahim",     full_name: "Md Ibrahim Mojumder",   role: "lead", kam_name: "Md Ibrahim Mojumder" },
  { username: "asif.rayhan", full_name: "Md. Asif Rayhan",       role: "lead", kam_name: "Md. Asif Rayhan" },
  { username: "raian.rudra", full_name: "Raian Islam Rudra",     role: "lead", kam_name: "Raian Islam Rudra" },
  { username: "shuvo",       full_name: "Shohanur Rahman Shuvo", role: "lead", kam_name: "Shohanur Rahman Shuvo" },

  // ---- KAMs (own book only) ----
  { username: "solayman",   full_name: "Md Solayman Shadik Shady", role: "kam", kam_name: "Md Solayman Shadik Shady" },
  { username: "nahid",      full_name: "Nuruzzaman Nahid",         role: "kam", kam_name: "Nuruzzaman Nahid" },
  { username: "anik",       full_name: "Md. Anik Ahamed",          role: "kam", kam_name: "Md. Anik Ahamed" },
  { username: "abdul.goni", full_name: "Abdul Goni Howlader",      role: "kam", kam_name: "Abdul Goni Howlader" },
  { username: "istiaque",   full_name: "Md. Istiaque Ahamed",      role: "kam", kam_name: "Md. Istiaque Ahamed" },
  { username: "jaber",      full_name: "Jaber Al Aunto",           role: "kam", kam_name: "Jaber Al Aunto" },
  { username: "komayel",    full_name: "Md Komayel Hossain",       role: "kam", kam_name: "Md Komayel Hossain" },
  { username: "shabib",     full_name: "Shabib Md Shahnawaj",      role: "kam", kam_name: "Shabib Md Shahnawaj" },
  { username: "tanvir",     full_name: "Tanvir Ahmmed",            role: "kam", kam_name: "Tanvir Ahmmed" },
  { username: "munim",      full_name: "Mubassir Ahmed Munim",     role: "kam", kam_name: "Mubassir Ahmed Munim" },
  { username: "sahabul",    full_name: "Md. Sahabul Alam",         role: "kam", kam_name: "Md. Sahabul Alam" },
  { username: "fardin",     full_name: "SK Fardin Osi",            role: "kam", kam_name: "SK Fardin Osi" },
  { username: "mahmudul",   full_name: "Md. Mahmudul Hasan",       role: "kam", kam_name: "Md. Mahmudul Hasan" },
  { username: "fayezul",    full_name: "Fayezul Islam Khan",       role: "kam", kam_name: "Fayezul Islam Khan" },
  { username: "mahmudul.inbound", full_name: "Mahmudul (Inbound)", role: "kam", kam_name: "Mahmudul (Inbound)" },
  { username: "sazzad",     full_name: "Sazzad Haider",            role: "kam", kam_name: "Sazzad Haider" },
  { username: "nusrat",     full_name: "Nusrat Zahan",             role: "kam", kam_name: "Nusrat Zahan" },
  { username: "rakib",      full_name: "MD Rakib Chowdhury",       role: "kam", kam_name: "MD Rakib Chowdhury" },
  { username: "rahul.roy",  full_name: "Rahul Roy",                role: "kam", kam_name: "Rahul Roy" },
  { username: "hasib",      full_name: "Hasib Islam",              role: "kam", kam_name: "Hasib Islam" },
  { username: "sohel.rana", full_name: "MD Sohel Rana",            role: "kam", kam_name: "MD Sohel Rana" },
  { username: "jubayer",    full_name: "Jubayer Rahman",           role: "kam", kam_name: "Jubayer Rahman" },
  { username: "rizvi",      full_name: "Rizvi Ahmed",              role: "kam", kam_name: "Rizvi Ahmed" },
  { username: "shihab",     full_name: "S. M Shihab",              role: "kam", kam_name: "S. M Shihab" },
  { username: "kayef",      full_name: "MD.kayef Ahmed Shajib",    role: "kam", kam_name: "MD.kayef Ahmed Shajib" },
];

async function main() {
  const defaultPassword = process.env.SEED_DEFAULT_PASSWORD || "Carrybee@2026";
  const hash = await bcrypt.hash(defaultPassword, 10);

  for (const user of USERS) {
    await pool.query(
      `INSERT INTO app_users (username, password_hash, full_name, role, kam_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (username) DO UPDATE SET
           full_name = EXCLUDED.full_name,
           role = EXCLUDED.role,
           kam_name = EXCLUDED.kam_name,
           is_active = true`,
      [user.username, hash, user.full_name, user.role, user.kam_name]
    );
    console.log(`seeded ${user.role.padEnd(5)} ${user.username} (${user.full_name})`);
  }

  // Every non-admin app user must exist in the directory, otherwise their
  // scope resolves to nothing and the app looks broken rather than locked.
  const { rows: orphans } = await pool.query(
    `SELECT u.username, u.kam_name
     FROM app_users u
     LEFT JOIN kam_team_directory t
            ON lower(btrim(t.kam_name)) = lower(btrim(u.kam_name))
     WHERE u.role <> 'admin' AND u.kam_name <> '' AND t.kam_name IS NULL`
  );
  if (orphans.length) {
    console.warn(
      "\nWARNING: these users are not in kam_team_directory and will see nothing:"
    );
    orphans.forEach((row) => console.warn(`  ${row.username} -> "${row.kam_name}"`));
    console.warn("Add them to the directory (schema_v3.sql section 1) and re-run.\n");
  }

  console.log(
    `\n${USERS.length} users ready. Initial password: ${defaultPassword}\n` +
      "Existing passwords were NOT overwritten."
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
