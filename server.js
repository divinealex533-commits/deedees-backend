import express from "express";
import cors from "cors";
import crypto from "crypto";
import path from "path";
import dotenv from "dotenv";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import { db } from "./db.js";
import {
  hashPassword,
  checkPassword,
  createToken,
  requireAuth,
  requireAdmin,
} from "./auth.js";
import { initializeTransaction, verifyTransaction } from "./paystack.js";

dotenv.config();

// Payment screenshots are uploaded here instead of local disk, since
// Render's filesystem is wiped on every redeploy — Supabase Storage keeps
// them permanently. The project URL isn't sensitive; only the service
// role key (read from the environment) is.
const SUPABASE_URL = "https://rujxebbeufilpqlszzwz.supabase.co";
const SUPABASE_BUCKET = "payment-screenshots";
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const app = express();
app.use(cors());

// NOTE: the Paystack webhook route needs the raw request body to check the
// signature, so it's registered separately, BEFORE express.json() below.
app.post(
  "/api/webhooks/paystack",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["x-paystack-signature"];
    const expected = crypto
      .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY || "")
      .update(req.body)
      .digest("hex");

    if (signature !== expected) {
      return res.status(401).send("Invalid signature");
    }

    const event = JSON.parse(req.body.toString());

    if (event.event === "charge.success") {
      await creditDepositByReference(event.data.reference, event.data.amount / 100);
    }

    res.sendStatus(200);
  }
);

app.use(express.json());

// Files are uploaded in memory, then pushed to Supabase Storage — nothing
// is ever written to local disk, so nothing is lost on redeploy.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// Uploads a payment screenshot to Supabase Storage and returns its public
// URL. Throws if the upload fails.
async function uploadScreenshot(file) {
  const ext = path.extname(file.originalname) || ".jpg";
  const filename = `${crypto.randomUUID()}${ext}`;

  const { error: uploadError } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .upload(filename, file.buffer, {
      contentType: file.mimetype,
      upsert: false,
    });

  if (uploadError) {
    throw new Error(`Screenshot upload failed: ${uploadError.message}`);
  }

  const { data } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(filename);
  return data.publicUrl;
}

// Credits a wallet exactly once for a given deposit reference.
// Used by both the webhook and the verify endpoint so a payment
// can never be credited twice.
async function creditDepositByReference(reference, amountNaira) {
  const deposits = await db.deposits.all();
  const deposit = deposits.find((d) => d.reference === reference);
  if (!deposit || deposit.status === "completed") return; // already handled

  deposit.status = "completed";
  await db.deposits.save(deposits);

  const users = await db.users.all();
  const user = users.find((u) => u.id === deposit.userId);
  if (user) {
    user.walletBalance += amountNaira;
    await db.users.save(users);
  }
}

// Returns how many unassigned units an item has. Items with an
// accessLinks pool are counted by remaining pool size; items using the
// simpler single-accessLink + quantity model fall back to quantity;
// anything else falls back to a plain sold flag (1 unit, once).
function stockCountOf(item) {
  if (Array.isArray(item.accessLinks) && item.accessLinks.length > 0) return item.accessLinks.length;
  if (item.quantity != null) return item.quantity;
  return item.sold ? 0 : 1;
}

// Strips the admin-only credentials (accessLinks pool, and the single
// accessLink used by the simpler model) so they never reach shoppers who
// haven't bought the item, and replaces them with a plain stockCount +
// effective inStock flag for display. `quantity`, if the item has one,
// passes through unchanged so the UI can keep showing "X in stock".
function publicItem(item) {
  const { accessLinks, accessLink, ...safe } = item;
  const stockCount = stockCountOf(item);
  return {
    ...safe,
    stockCount,
    inStock: item.inStock !== false && stockCount > 0,
  };
}

function generateReferralCode() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

// ============================================================
// HEALTH CHECK
// ============================================================
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "DeeDee's Marketplace API is running" });
});

// ============================================================
// AUTH — signup & login
// ============================================================

app.post("/api/auth/signup", async (req, res) => {
  const { name, email, password, referralCode } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: "name, email and password are required" });
  }

  const users = await db.users.all();
  if (users.find((u) => u.email.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ error: "An account with that email already exists" });
  }

  let referredBy = null;
  if (referralCode) {
    const referrer = users.find((u) => u.referralCode === referralCode.toUpperCase());
    if (referrer) referredBy = referrer.id;
  }

  const newUser = {
    id: crypto.randomUUID(),
    name,
    email,
    passwordHash: hashPassword(password),
    walletBalance: 0,
    isAdmin: users.length === 0, // first person to sign up becomes admin
    purchasedItemIds: [],
    referralCode: generateReferralCode(),
    referredBy,
    referralRewardProcessed: false,
    createdAt: new Date().toISOString(),
  };

  users.push(newUser);
  await db.users.save(users);

  const token = createToken(newUser);
  res.status(201).json({
    token,
    user: publicUser(newUser),
  });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  const users = await db.users.all();
  const user = users.find((u) => u.email.toLowerCase() === (email || "").toLowerCase());

  if (!user || !checkPassword(password || "", user.passwordHash)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const token = createToken(user);
  res.json({ token, user: publicUser(user) });
});

function publicUser(user) {
  const { passwordHash, ...safe } = user;
  return safe;
}

// ============================================================
// DASHBOARD — logged-in user's own info
// ============================================================

// Returns the user's profile PLUS their purchased items in full,
// including the specific credential assigned to each purchase — this is
// one of the two places that's allowed to reach the customer, since
// they've paid for it. Falls back to the item's flat accessLink (the
// simple single-credential model) when there's no per-purchase pool
// assignment.
app.get("/api/me", requireAuth, async (req, res) => {
  const users = await db.users.all();
  const user = users.find((u) => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: "User not found" });

  const [items, purchases] = await Promise.all([db.items.all(), db.purchases.all()]);
  const myPurchases = purchases.filter((p) => p.buyerId === user.id);
  const purchasedItems = items
    .filter((i) => user.purchasedItemIds.includes(i.id))
    .map((i) => {
      const relatedPurchases = myPurchases.filter((p) => p.itemId === i.id);
      const assignedCredentials = relatedPurchases.flatMap((p) => p.assignedCredentials || []);
      const accessLink = assignedCredentials[0] || i.accessLink || null;
      return { ...publicItem(i), assignedCredentials, accessLink };
    });

  res.json({
    ...publicUser(user),
    purchasedItems,
  });
});

// Customer: their own purchase history, including the specific
// credential assigned to each order — falls back to the item's flat
// accessLink (the simple single-credential model) when this order didn't
// draw from a per-item pool.
app.get("/api/my-orders", requireAuth, async (req, res) => {
  const [purchases, items] = await Promise.all([db.purchases.all(), db.items.all()]);
  const myPurchases = purchases.filter((p) => p.buyerId === req.user.id);

  const orders = myPurchases.map((p) => {
    const item = items.find((i) => i.id === p.itemId);
    const assignedCredentials = p.assignedCredentials || [];
    const accessLink = assignedCredentials[0] || (item && item.accessLink) || null;
    return {
      id: p.id,
      purchasedAt: p.createdAt,
      price: p.price,
      assignedCredentials,
      item: item ? { ...publicItem(item), accessLink } : null,
    };
  });

  res.json({ orders });
});

// Customer: their referral code and how much they've earned so far
app.get("/api/my-referrals", requireAuth, async (req, res) => {
  const users = await db.users.all();
  const user = users.find((u) => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: "User not found" });

  const referredUsers = users.filter((u) => u.referredBy === user.id);
  const successfulReferrals = referredUsers.filter((u) => u.referralRewardProcessed).length;

  res.json({
    referralCode: user.referralCode,
    totalReferred: referredUsers.length,
    successfulReferrals,
    totalEarned: successfulReferrals * 500,
  });
});

// ============================================================
// ITEMS — browsing the marketplace (public — credentials stripped)
// ============================================================

app.get("/api/items", async (req, res) => {
  const items = await db.items.all();
  res.json(items.map(publicItem));
});

app.get("/api/items/:id", async (req, res) => {
  const items = await db.items.all();
  const item = items.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Item not found" });
  res.json(publicItem(item));
});

// ============================================================
// ADMIN — item management (full data, including credentials)
// ============================================================

// Admin: see every item with full details (including the raw
// accessLinks pool and/or the flat accessLink + quantity), so the
// dashboard can show exactly how much stock is left and let the admin
// edit or top it up.
app.get("/api/admin/items", requireAuth, requireAdmin, async (req, res) => {
  const items = await db.items.all();
  res.json(items);
});

// Admin: add a new item to sell. Supports two stock models:
//   - Simple: a single `accessLink` (same credential shown to every
//     buyer) plus a `quantity` that decreases with each sale — this is
//     what the current product form sends.
//   - Pool: an `accessLinks` array, one credential per unit, each buyer
//     gets a different line, consumed on purchase — used by the
//     top-up-stock endpoint below.
// Both can coexist; stockCountOf() prefers the pool when it has entries.
app.post("/api/items", requireAuth, requireAdmin, async (req, res) => {
  const {
    name,
    description,
    price,
    image,
    imageUrl,
    categoryId,
    inStock,
    accessLinks,
    accessLink,
    quantity,
  } = req.body;

  if (!name || price == null) {
    return res.status(400).json({ error: "name and price are required" });
  }

  const items = await db.items.all();
  const newItem = {
    id: crypto.randomUUID(),
    name,
    description: description || "",
    price,
    imageUrl: imageUrl || image || "",
    categoryId: categoryId || null,
    accessLinks: Array.isArray(accessLinks) ? accessLinks.filter(Boolean) : [],
    accessLink: accessLink || undefined,
    quantity: quantity != null ? Number(quantity) : undefined,
    inStock: inStock !== undefined ? inStock : true,
    createdAt: new Date().toISOString(),
  };

  items.push(newItem);
  await db.items.save(items);
  res.status(201).json(newItem);
});

// Admin: update an existing item's details — name, price, category,
// image, description, the manual in-stock override, and (for the simple
// model) the flat accessLink and/or quantity directly. This intentionally
// never touches the accessLinks POOL — use "Add Stock" below for that, so
// past buyers' assigned pool credentials are never disturbed.
app.put("/api/items/:id", requireAuth, requireAdmin, async (req, res) => {
  const items = await db.items.all();
  const item = items.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Item not found" });

  const { name, description, price, image, imageUrl, categoryId, inStock, accessLink, quantity } = req.body;
  if (name !== undefined) item.name = name;
  if (description !== undefined) item.description = description;
  if (price !== undefined) item.price = price;
  if (imageUrl !== undefined) item.imageUrl = imageUrl;
  else if (image !== undefined) item.imageUrl = image;
  if (categoryId !== undefined) item.categoryId = categoryId;
  if (inStock !== undefined) item.inStock = inStock;
  if (accessLink !== undefined) item.accessLink = accessLink;
  if (quantity !== undefined) item.quantity = Number(quantity);

  await db.items.save(items);
  res.json(item);
});

// Admin: top up stock by adding more credentials to the POOL model.
// Existing pool entries and already-assigned credentials are untouched.
app.post("/api/items/:id/add-access-links", requireAuth, requireAdmin, async (req, res) => {
  const { credentials } = req.body;
  if (!Array.isArray(credentials) || credentials.filter(Boolean).length === 0) {
    return res.status(400).json({ error: "At least one credential is required" });
  }

  const items = await db.items.all();
  const item = items.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Item not found" });

  if (!Array.isArray(item.accessLinks)) item.accessLinks = [];
  const cleaned = credentials.map((c) => c.trim()).filter(Boolean);
  item.accessLinks.push(...cleaned);

  await db.items.save(items);
  res.json({
    message: `Added ${cleaned.length} credential(s)`,
    stockCount: item.accessLinks.length,
  });
});

// Admin: flip an item's manual in-stock override on/off
app.post("/api/items/:id/toggle-stock", requireAuth, requireAdmin, async (req, res) => {
  const items = await db.items.all();
  const item = items.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Item not found" });

  item.inStock = !item.inStock;
  await db.items.save(items);
  res.json(item);
});

// Admin: delete an item
app.delete("/api/items/:id", requireAuth, requireAdmin, async (req, res) => {
  const items = await db.items.all();
  const item = items.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Item not found" });

  const remaining = items.filter((i) => i.id !== req.params.id);
  await db.items.save(remaining);
  res.json({ message: "Item deleted" });
});

// ============================================================
// CATEGORIES — shared across every visitor (stored in the database,
// not per-device) so a new category or product shows up for everyone,
// not just the admin who added it.
// ============================================================

const DEFAULT_CATEGORIES = [
  { name: "Social Media Growth", description: "Followers, likes, views and engagement boosts", icon: "Shield" },
  { name: "Buy Account", description: "Verified, ready-to-use social media accounts", icon: "Shield" },
  { name: "Other", description: "Everything else", icon: "Shield" },
];

// Public: anyone browsing the store needs this to render category filters
app.get("/api/categories", async (req, res) => {
  let categories = await db.categories.all();

  // First-run seed: if nobody's ever added a category, start with sensible
  // defaults instead of an empty filter bar.
  if (categories.length === 0) {
    categories = DEFAULT_CATEGORIES.map((c) => ({
      id: crypto.randomUUID(),
      ...c,
      createdAt: new Date().toISOString(),
    }));
    await db.categories.save(categories);
  }

  res.json(categories);
});

// Admin: add a new category
app.post("/api/categories", requireAuth, requireAdmin, async (req, res) => {
  const { name, description, icon } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }

  const categories = await db.categories.all();
  const newCategory = {
    id: crypto.randomUUID(),
    name: name.trim(),
    description: description || "",
    icon: icon || "Shield",
    createdAt: new Date().toISOString(),
  };

  categories.push(newCategory);
  await db.categories.save(categories);
  res.status(201).json(newCategory);
});

// Admin: update a category
app.put("/api/categories/:id", requireAuth, requireAdmin, async (req, res) => {
  const categories = await db.categories.all();
  const category = categories.find((c) => c.id === req.params.id);
  if (!category) return res.status(404).json({ error: "Category not found" });

  const { name, description, icon } = req.body;
  if (name !== undefined) category.name = name;
  if (description !== undefined) category.description = description;
  if (icon !== undefined) category.icon = icon;

  await db.categories.save(categories);
  res.json(category);
});

// Admin: delete a category
app.delete("/api/categories/:id", requireAuth, requireAdmin, async (req, res) => {
  const categories = await db.categories.all();
  const category = categories.find((c) => c.id === req.params.id);
  if (!category) return res.status(404).json({ error: "Category not found" });

  const remaining = categories.filter((c) => c.id !== req.params.id);
  await db.categories.save(remaining);
  res.json({ message: "Category deleted" });
});

// ============================================================
// WALLET — deposits
//   Path A: instant, automatic via Paystack
//   Path B: manual, customer uploads a payment screenshot for review
// ============================================================

// ---- Path A: instant payment ----

// Customer: start an instant payment. Returns a Paystack checkout URL —
// send the customer there (redirect or open in a new tab) to pay by
// card/bank/USSD. Their wallet is credited automatically once paid.
app.post("/api/wallet/deposit/instant/initialize", requireAuth, async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: "A positive amount is required" });
  }

  const users = await db.users.all();
  const user = users.find((u) => u.id === req.user.id);
  const reference = `dep_${crypto.randomUUID()}`;

  try {
    const paystackData = await initializeTransaction({
      email: user.email,
      amountNaira: amount,
      reference,
      callback_url: process.env.PAYSTACK_CALLBACK_URL, // where Paystack sends them back after paying
    });

    const deposits = await db.deposits.all();
    deposits.push({
      id: crypto.randomUUID(),
      userId: user.id,
      amount,
      method: "instant",
      status: "pending", // becomes "completed" once webhook/verify confirms payment
      reference,
      createdAt: new Date().toISOString(),
    });
    await db.deposits.save(deposits);

    res.status(201).json({
      authorizationUrl: paystackData.authorization_url,
      reference,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Called after the customer returns from the Paystack checkout page —
// double-checks the payment directly with Paystack and credits the
// wallet if it hasn't been credited already (the webhook usually beats
// this, but this is a safety net in case the webhook is delayed).
app.get("/api/wallet/deposit/instant/verify/:reference", requireAuth, async (req, res) => {
  try {
    const result = await verifyTransaction(req.params.reference);
    if (result.status === "success") {
      await creditDepositByReference(req.params.reference, result.amount / 100);
    }

    const users = await db.users.all();
    const user = users.find((u) => u.id === req.user.id);
    res.json({ paymentStatus: result.status, walletBalance: user.walletBalance });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- Path B: manual payment with screenshot ----

// Customer: submit proof of payment (a screenshot) for admin to review.
// Sent as multipart/form-data with fields: amount, and a file field
// "screenshot". The file is uploaded straight to Supabase Storage —
// never written to local disk — so it survives every redeploy.
app.post(
  "/api/wallet/deposit/manual",
  requireAuth,
  upload.single("screenshot"),
  async (req, res) => {
    const { amount } = req.body;
    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ error: "A positive amount is required" });
    }
    if (!req.file) {
      return res.status(400).json({ error: "A payment screenshot is required" });
    }

    let screenshotUrl;
    try {
      screenshotUrl = await uploadScreenshot(req.file);
    } catch (err) {
      console.error(err);
      return res.status(502).json({ error: "Could not upload screenshot. Please try again." });
    }

    const deposits = await db.deposits.all();
    const deposit = {
      id: crypto.randomUUID(),
      userId: req.user.id,
      amount: Number(amount),
      method: "manual",
      status: "pending", // admin must approve or reject
      screenshotUrl,
      createdAt: new Date().toISOString(),
    };

    deposits.push(deposit);
    await db.deposits.save(deposits);
    res.status(201).json(deposit);
  }
);

// Customer: see their own deposit history (both instant and manual)
app.get("/api/wallet/deposits", requireAuth, async (req, res) => {
  const deposits = (await db.deposits.all()).filter((d) => d.userId === req.user.id);
  res.json(deposits);
});

// Admin: see all deposits (filter client-side, or add ?status=pending)
app.get("/api/admin/deposits", requireAuth, requireAdmin, async (req, res) => {
  let deposits = await db.deposits.all();
  if (req.query.status) {
    deposits = deposits.filter((d) => d.status === req.query.status);
  }
  res.json(deposits);
});

// Admin: approve a MANUAL deposit after checking the screenshot -> credits wallet
app.post("/api/admin/deposits/:id/approve", requireAuth, requireAdmin, async (req, res) => {
  const deposits = await db.deposits.all();
  const deposit = deposits.find((d) => d.id === req.params.id);
  if (!deposit) return res.status(404).json({ error: "Deposit not found" });
  if (deposit.status !== "pending") {
    return res.status(400).json({ error: `Deposit already ${deposit.status}` });
  }

  deposit.status = "completed";
  await db.deposits.save(deposits);

  const users = await db.users.all();
  const user = users.find((u) => u.id === deposit.userId);
  user.walletBalance += deposit.amount;
  await db.users.save(users);

  res.json({ deposit, newBalance: user.walletBalance });
});

// Admin: reject a manual deposit (e.g. fake or unclear screenshot)
app.post("/api/admin/deposits/:id/reject", requireAuth, requireAdmin, async (req, res) => {
  const deposits = await db.deposits.all();
  const deposit = deposits.find((d) => d.id === req.params.id);
  if (!deposit) return res.status(404).json({ error: "Deposit not found" });
  if (deposit.status !== "pending") {
    return res.status(400).json({ error: `Deposit already ${deposit.status}` });
  }

  deposit.status = "rejected";
  await db.deposits.save(deposits);
  res.json({ deposit });
});

// ============================================================
// PURCHASE — spend wallet balance to buy qty units of an item,
// assigning each buyer their own credential(s). Also applies a
// first-purchase referral discount when eligible.
// ============================================================

app.post("/api/purchase", requireAuth, async (req, res) => {
  const { itemId, quantity } = req.body;
  if (!itemId) return res.status(400).json({ error: "itemId is required" });

  const qtyToBuy = quantity != null ? Number(quantity) : 1;
  if (qtyToBuy < 1) return res.status(400).json({ error: "Quantity must be at least 1" });

  const items = await db.items.all();
  const item = items.find((i) => i.id === itemId);
  if (!item) return res.status(404).json({ error: "Item not found" });

  const availableQty = stockCountOf(item);
  if (availableQty < qtyToBuy) {
    return res.status(400).json({ error: `Only ${availableQty} left in stock` });
  }

  const users = await db.users.all();
  const user = users.find((u) => u.id === req.user.id);

  const purchases = await db.purchases.all();
  const isFirstPurchase = !purchases.some((p) => p.buyerId === user.id);
  const eligibleForReferralDiscount =
    isFirstPurchase && !!user.referredBy && !user.referralRewardProcessed;

  let totalPrice = item.price * qtyToBuy;
  let discountApplied = 0;
  if (eligibleForReferralDiscount) {
    discountApplied = Math.round(totalPrice * 0.05);
    totalPrice -= discountApplied;
  }

  if (user.walletBalance < totalPrice) {
    return res.status(400).json({ error: "Insufficient wallet balance" });
  }

  user.walletBalance -= totalPrice;
  if (!user.purchasedItemIds.includes(item.id)) {
    user.purchasedItemIds.push(item.id);
  }

  // Assign this buyer their credential(s):
  //   - Pool model: pull qtyToBuy distinct lines off the pool.
  //   - Simple model: same flat accessLink repeated (there's only one),
  //     quantity just decreases.
  //   - Neither: nothing to assign, fall back to a one-time sold flag.
  let assignedCredentials = [];
  if (Array.isArray(item.accessLinks) && item.accessLinks.length > 0) {
    assignedCredentials = item.accessLinks.splice(0, qtyToBuy);
  } else if (item.quantity != null) {
    item.quantity -= qtyToBuy;
    if (item.accessLink) {
      assignedCredentials = [item.accessLink];
    }
  } else {
    item.sold = true;
  }

  // First-purchase referral reward: 5% off for the new customer,
  // ₦500 wallet credit for whoever referred them. Only ever fires once.
  if (eligibleForReferralDiscount) {
    user.referralRewardProcessed = true;
    const referrer = users.find((u) => u.id === user.referredBy);
    if (referrer) {
      referrer.walletBalance += 500;
    }
  }

  await db.users.save(users);
  await db.items.save(items);

  purchases.push({
    id: crypto.randomUUID(),
    itemId: item.id,
    buyerId: user.id,
    buyerName: user.name,
    buyerEmail: user.email,
    price: totalPrice,
    quantity: qtyToBuy,
    assignedCredentials,
    referralDiscountApplied: discountApplied || undefined,
    createdAt: new Date().toISOString(),
  });
  await db.purchases.save(purchases);

  res.json({
    message: "Purchase successful",
    item: { ...publicItem(item), assignedCredentials, accessLink: assignedCredentials[0] || null }, // buyer-specific, OK to include
    newBalance: user.walletBalance,
    discountApplied,
  });
});

// Admin: full sales history (used by the Sales tab in the dashboard)
app.get("/api/admin/sales", requireAuth, requireAdmin, async (req, res) => {
  const [purchases, items] = await Promise.all([db.purchases.all(), db.items.all()]);
  const sales = purchases.map((p) => {
    const item = items.find((i) => i.id === p.itemId);
    return {
      ...(item ? publicItem(item) : {}),
      id: p.id,
      price: p.price,
      buyerName: p.buyerName,
      buyerEmail: p.buyerEmail,
      createdAt: p.createdAt,
    };
  });
  res.json(sales);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
