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

  // Seller marketplace
  "seller_storefronts",
  "seller_subscriptions",
  "seller_orders",
  "seller_withdrawals",
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

  // ============================================================
  // SELLER MARKETPLACE TABLES
  // ============================================================

  await pool.query(`
    CREATE TABLE IF NOT EXISTS seller_storefronts (
      id SERIAL PRIMARY KEY,
      data JSONB NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS seller_subscriptions (
      id SERIAL PRIMARY KEY,
      data JSONB NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS seller_orders (
      id SERIAL PRIMARY KEY,
      data JSONB NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS seller_withdrawals (
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

/*
 * Atomically process a referral reward.
 *
 * This prevents the same referred user from triggering
 * the ₦500 reward more than once.
 */
async function processReferralReward(userId) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const userResult = await client.query(
      `
        SELECT data
        FROM users
        WHERE data->>'id' = $1
        FOR UPDATE
      `,
      [String(userId)]
    );

    const user = userResult.rows[0]?.data;

    if (!user) {
      await client.query("ROLLBACK");

      return {
        rewarded: false,
        reason: "user_not_found",
      };
    }

    if (
      !user.referredBy ||
      user.referralRewardProcessed
    ) {
      await client.query("COMMIT");

      return {
        rewarded: false,
        reason: "not_eligible",
      };
    }

    const referrerResult = await client.query(
      `
        SELECT data
        FROM users
        WHERE data->>'id' = $1
        FOR UPDATE
      `,
      [String(user.referredBy)]
    );

    const referrer =
      referrerResult.rows[0]?.data;

    if (!referrer) {
      await client.query("COMMIT");

      return {
        rewarded: false,
        reason: "referrer_not_found",
      };
    }

    user.referralRewardProcessed = true;

    referrer.walletBalance =
      Number(referrer.walletBalance || 0) + 500;

    await client.query(
      `
        UPDATE users
        SET data = $1::jsonb
        WHERE data->>'id' = $2
      `,
      [user, String(user.id)]
    );

    await client.query(
      `
        UPDATE users
        SET data = $1::jsonb
        WHERE data->>'id' = $2
      `,
      [referrer, String(referrer.id)]
    );

    await client.query("COMMIT");

    return {
      rewarded: true,
      rewardAmount: 500,
      referrerId: referrer.id,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export const db = {
  users: {
    all: () => readTable("users"),

    save: (rows) =>
      writeTable("users", rows),

    findByEmail: (email) =>
      findUserByEmail(email),

    updateById: (userId, user) =>
      updateUserById(userId, user),

    processReferralReward: (userId) =>
      processReferralReward(userId),
  },

  items: {
    all: () =>
      readTable("items"),

    save: (rows) =>
      writeTable("items", rows),
  },

  deposits: {
    all: () =>
      readTable("deposits"),

    save: (rows) =>
      writeTable("deposits", rows),
  },

  purchases: {
    all: () =>
      readTable("purchases"),

    save: (rows) =>
      writeTable("purchases", rows),
  },

  categories: {
    all: () =>
      readTable("categories"),

    save: (rows) =>
      writeTable("categories", rows),
  },

  tickets: {
    all: () =>
      readTable("tickets"),

    save: (rows) =>
      writeTable("tickets", rows),
  },

  // ============================================================
  // SELLER MARKETPLACE
  // ============================================================

  sellerStorefronts: {
    all: () =>
      readTable("seller_storefronts"),

    save: (rows) =>
      writeTable("seller_storefronts", rows),
  },

  sellerSubscriptions: {
    all: () =>
      readTable("seller_subscriptions"),

    save: (rows) =>
      writeTable("seller_subscriptions", rows),
  },

  sellerOrders: {
    all: () =>
      readTable("seller_orders"),

    save: (rows) =>
      writeTable("seller_orders", rows),
  },

  sellerWithdrawals: {
    all: () =>
      readTable("seller_withdrawals"),

    save: (rows) =>
      writeTable("seller_withdrawals", rows),
  },
};

export { pool };
