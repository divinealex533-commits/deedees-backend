import pg from "pg";
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

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
}

initTables().catch((err) => console.error("Failed to init tables:", err));

async function readTable(name) {
  const res = await pool.query(`SELECT data FROM ${name}`);
  return res.rows.map((row) => row.data);
}

async function writeTable(name, rows) {
  await pool.query(`DELETE FROM ${name}`);
  for (const row of rows) {
    await pool.query(`INSERT INTO ${name} (data) VALUES ($1)`, [row]);
  }
}

export const db = {
  users: {
    all: () => readTable("users"),
    save: (rows) => writeTable("users", rows),
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
};
