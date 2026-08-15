import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not configured");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const TABLES = new Set([
  "users",
  "items",
  "deposits",
  "purchases",
  "categories",
  "tickets",
]);

function validateTable(name) {
  if (!TABLES.has(name)) {
    throw new Error(`Invalid database table: ${name}`);
  }
}

async function initTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      data JSONB NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      data JSONB NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS deposits (
      id SERIAL PRIMARY KEY,
      data JSONB NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS purchases (
      id SERIAL PRIMARY KEY,
      data JSONB NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      data JSONB NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id SERIAL PRIMARY KEY,
      data JSONB NOT NULL
    );
  `);
}

export async function initDatabase() {
  await initTables();
}

async function readTable(name) {
  validateTable(name);

  const result = await pool.query(
    `SELECT data FROM ${name} ORDER BY id ASC`
  );

  return result.rows.map((row) => row.data);
}

async function writeTable(name, rows) {
  validateTable(name);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`DELETE FROM ${name}`);

    for (const row of rows) {
      await client.query(
        `INSERT INTO ${name} (data) VALUES ($1::jsonb)`,
        [row]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/*
 * FAST USER LOOKUP
 *
 * Login no longer needs to load the entire users table.
 * PostgreSQL finds the matching email directly.
 */
async function findUserByEmail(email) {
  const result = await pool.query(
    `
      SELECT data
      FROM users
      WHERE LOWER(data->>'email') = LOWER($1)
      LIMIT 1
    `,
    [email]
  );

  return result.rows[0]?.data || null;
}

/*
 * FAST USER UPDATE
 *
 * Updates only the matching user instead of deleting
 * and reinserting the entire users table.
 */
async function updateUserById(userId, user) {
  await pool.query(
    `
      UPDATE users
      SET data = $1::jsonb
      WHERE data->>'id' = $2
    `,
    [user, String(userId)]
  );
}

export const db = {
  users: {
    all: () => readTable("users"),
    save: (rows) => writeTable("users", rows),

    // New fast login helpers
    findByEmail: (email) => findUserByEmail(email),
    updateById: (userId, user) =>
      updateUserById(userId, user),
  },

  items: {
    all: () => readTable("items"),
    save: (rows) => writeTable("items", rows),
  },

  deposits: {
    all: () => readTable("deposits"),
    save: (rows) => writeTable("deposits", rows),
  },

  purchases: {
    all: () => readTable("purchases"),
    save: (rows) => writeTable("purchases", rows),
  },

  categories: {
    all: () => readTable("categories"),
    save: (rows) => writeTable("categories", rows),
  },

  tickets: {
    all: () => readTable("tickets"),
    save: (rows) => writeTable("tickets", rows),
  },
};

export { pool };
