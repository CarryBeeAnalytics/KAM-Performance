/**
 * Seed the 12 approved app users (7 KAMs, 1 Lead, 4 Admins).
 *
 * Usage:  npm run seed
 * Every user starts with SEED_DEFAULT_PASSWORD from .env (share it privately
 * and ask everyone to request a change; rerunning updates names/roles but
 * NEVER overwrites an existing password).
 *
 * kam_name for role='kam' must EXACTLY match kam_daily_report.kam_name.
 */
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import { pool } from "./src/db.js";

dotenv.config();

const USERS = [
  // role 'kam': sees ONLY merchants where kam_name matches (approved B1).
  { username: "abdul.goni",    full_name: "Abdul Goni Howlader",     role: "kam",   kam_name: "Abdul Goni Howlader" },
  { username: "jaber.aunto",   full_name: "Jaber Al Aunto",          role: "kam",   kam_name: "Jaber Al Aunto" },
  { username: "anik.ahamed",   full_name: "Md. Anik Ahamed",         role: "kam",   kam_name: "Md. Anik Ahamed" },
  { username: "asif.rayhan",   full_name: "Md. Asif Rayhan",         role: "kam",   kam_name: "Md. Asif Rayhan" },
  { username: "istiaque",      full_name: "Md. Istiaque Ahamed",     role: "kam",   kam_name: "Md. Istiaque Ahamed" },
  { username: "raian.rudra",   full_name: "Raian Islam Rudra",       role: "kam",   kam_name: "Raian Islam Rudra" },
  { username: "akash.saha",    full_name: "Akash Saha",              role: "lead",  kam_name: "Akash Saha" },
  // Admins: full access to every team.
  { username: "mahir.faisal",  full_name: "Mahir Faisal Chowdhury",  role: "admin", kam_name: "" },
  { username: "imtiaz",        full_name: "Imtiaz Hossain",          role: "admin", kam_name: "" },
  { username: "zubayer",       full_name: "Md. Zubayer",             role: "admin", kam_name: "" },
  { username: "muktadir",      full_name: "Md. Golam Muktadir",      role: "admin", kam_name: "" },
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
  console.log(
    `\nAll 12 users ready. Initial password: ${defaultPassword}\n` +
      "Existing passwords were NOT overwritten."
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
