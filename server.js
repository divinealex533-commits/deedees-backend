import express from "express";
import cors from "cors";
import crypto from "crypto";
import dotenv from "dotenv";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

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

// Serve uploaded payment screenshots so admin can view them
app.use("/uploads", express.static(UPLOADS_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

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

// Strips the admin-only accessLink field (ebook link / credentials) so it
// never reaches shoppers who haven't bought the item.
function publicItem(item) {
  const { accessLink, ...safe } = item;
  return safe;
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

function generateReferralCode() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

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
// including accessLink (ebook link / credentials) — this is the
// one place accessLink is allowed to reach the customer, since
// they've paid for it.
app.get("/api/me", requireAuth, async (req, res) => {
  const users = await db.users.all();
  const user = users.find((u) => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: "User not found" });

  const items = await db.items.all();
  const purchasedItems = items.filter((i) => user.purchasedItemIds.includes(i.id));

  res.json({
    ...publicUser(user),
    purchasedItems,
  });
});

// Customer: their own purchase history, including accessLink for
// each item (ebook link / credentials) since they've paid for it.
app.get("/api/my-orders", requireAuth, async (req, res) => {
  const [purchases, items] = await Promise.all([db.purchases.all(), db.items.all()]);
  const myPurchases = purchases.filter((p) => p.buyerId === req.user.id);

  const orders = myPurchases.map((p) => ({
    id: p.id,
    purchasedAt: p.createdAt,
    price: p.price,
    item: items.find((i) => i.id === p.itemId) || null,
  }));
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
  res.json({ orders });
});

// ============================================================
// ITEMS — browsing the marketplace (public — accessLink stripped)
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
// ADMIN — item management (full data, including accessLink)
// ============================================================

// Admin: see every item with full details (including accessLink),
// so the dashboard can display/edit the ebook link or credentials.
app.get("/api/admin/items", requireAuth, requireAdmin, async (req, res) => {
  const items = await db.items.all();
  res.json(items);
});

// Admin: add a new item to sell. Accepts an optional accessLink
// (ebook link / login credentials) that only a buyer will ever see,
// and a quantity for how many copies/units are available.
app.post("/api/items", requireAuth, requireAdmin, async (req, res) => {
  const { name, description, price, image, imageUrl, categoryId, inStock, accessLink, quantity } = req.body;
  if (!name || price == null) {
    return res.status(400).json({ error: "name and price are required" });
  }

  const qty = quantity != null ? Number(quantity) : 1;
  const items = await db.items.all();
  const newItem = {
    id: crypto.randomUUID(),
    name,
    description: description || "",
    price,
    imageUrl: imageUrl || image || "",
    categoryId: categoryId || null,
    quantity: qty,
    inStock: inStock !== undefined ? inStock : qty > 0,
    sold: false,
    accessLink: accessLink || "",
    createdAt: new Date().toISOString(),
  };

  items.push(newItem);
  await db.items.save(items);
  res.status(201).json(newItem);
});

// Admin: update an existing item — name, price, category, image,
// stock quantity, and/or accessLink (ebook link / credentials).
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
  if (accessLink !== undefined) item.accessLink = accessLink;
  if (quantity !== undefined) {
    item.quantity = Number(quantity);
    item.inStock = item.quantity > 0;
  }
  if (inStock !== undefined) item.inStock = inStock;

  await db.items.save(items);
  res.json(item);
});

// Admin: flip an item's in-stock status on/off
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
// Sent as multipart/form-data with fields: amount, and a file field "screenshot".
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

    const deposits = await db.deposits.all();
    const deposit = {
      id: crypto.randomUUID(),
      userId: req.user.id,
      amount: Number(amount),
      method: "manual",
      status: "pending", // admin must approve or reject
      screenshotUrl: `/uploads/${req.file.filename}`,
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
// PURCHASE — spend wallet balance to buy an item (supports quantity)
// ============================================================

app.post("/api/purchase", requireAuth, async (req, res) => {
  const { itemId, quantity } = req.body;
  if (!itemId) return res.status(400).json({ error: "itemId is required" });

  const qtyToBuy = quantity != null ? Number(quantity) : 1;
  if (qtyToBuy < 1) return res.status(400).json({ error: "Quantity must be at least 1" });

  const items = await db.items.all();
  const item = items.find((i) => i.id === itemId);
  if (!item) return res.status(404).json({ error: "Item not found" });

  const availableQty = item.quantity != null ? item.quantity : (item.sold ? 0 : 1);
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

  if (item.quantity != null) {
    item.quantity -= qtyToBuy;
    item.inStock = item.quantity > 0;
  } else {
    item.sold = true;
    item.inStock = false;
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
    referralDiscountApplied: discountApplied || undefined,
    createdAt: new Date().toISOString(),
  });
  await db.purchases.save(purchases);

  res.json({
    message: "Purchase successful",
    item, // includes accessLink — this is the buyer, so it's OK
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
      ...(item || {}),
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
