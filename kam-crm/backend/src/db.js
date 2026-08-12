import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const required = ["SUPABASE_DB_HOST", "SUPABASE_DB_USER", "SUPABASE_DB_PASSWORD"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  throw new Error(`Missing Supabase configuration: ${missing.join(", ")}`);
}

export const pool = new pg.Pool({
  host: process.env.SUPABASE_DB_HOST,
  port: Number(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME || "postgres",
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl:
    (process.env.SUPABASE_DB_SSLMODE || "require") === "disable"
      ? false
      : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30_000,
});

export async function query(text, params = []) {
  const result = await pool.query(text, params);
  return result;
}
