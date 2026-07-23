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
  (req, res) => {
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
      creditDepositByReference(event.data.reference, event.data.amount / 100);
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
function creditDepositByReference(reference, amountNaira) {
  const deposits = db.deposits.all();
  const deposit = deposits.find((d) => d.reference === reference);
  if (!deposit || deposit.status === "completed") return; // already handled

  deposit.status = "completed";
  db.deposits.save(deposits);

  const users = db.users.all();
  const user = users.find((u) => u.id === deposit.userId);
  if (user) {
    user.walletBalance += amountNaira;
    db.users.save(users);
  }
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

app.post("/api/auth/signup", (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: "name, email and password are required" });
  }

  const users = db.users.all();
  if (users.find((u) => u.email.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ error: "An account with that email already exists" });
  }

  const newUser = {
    id: crypto.randomUUID(),
    name,
    email,
    passwordHash: hashPassword(password),
    walletBalance: 0,
    isAdmin: users.length === 0, // first person to sign up becomes admin
    purchasedItemIds: [],
    createdAt: new Date().toISOString(),
  };

  users.push(newUser);
  db.users.save(users);

  const token = createToken(newUser);
  res.status(201).json({
    token,
    user: publicUser(newUser),
  });
});

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body;
  const users = db.users.all();
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

app.get("/api/me", requireAuth, (req, res) => {
  const users = db.users.all();
  const user = users.find((u) => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: "User not found" });

  const items = db.items.all();
  const purchasedItems = items.filter((i) => user.purchasedItemIds.includes(i.id));

  res.json({
    ...publicUser(user),
    purchasedItems,
  });
});

// ============================================================
// ITEMS — browsing the marketplace
// ============================================================

app.get("/api/items", (req, res) => {
  const items = db.items.all();
  res.json(items);
});

app.get("/api/items/:id", (req, res) => {
  const items = db.items.all();
  const item = items.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Item not found" });
  res.json(item);
});

// Admin: add a new item to sell
app.post("/api/items", requireAuth, requireAdmin, (req, res) => {
  const { name, description, price, image } = req.body;
  if (!name || price == null) {
    return res.status(400).json({ error: "name and price are required" });
  }

  const items = db.items.all();
  const newItem = {
    id: crypto.randomUUID(),
    name,
    description: description || "",
    price,
    image: image || "",
    sold: false,
    createdAt: new Date().toISOString(),
  };

  items.push(newItem);
  db.items.save(items);
  res.status(201).json(newItem);
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

  const users = db.users.all();
  const user = users.find((u) => u.id === req.user.id);
  const reference = `dep_${crypto.randomUUID()}`;

  try {
    const paystackData = await initializeTransaction({
      email: user.email,
      amountNaira: amount,
      reference,
      callback_url: process.env.PAYSTACK_CALLBACK_URL, // where Paystack sends them back after paying
    });

    const deposits = db.deposits.all();
    deposits.push({
      id: crypto.randomUUID(),
      userId: user.id,
      amount,
      method: "instant",
      status: "pending", // becomes "completed" once webhook/verify confirms payment
      reference,
      createdAt: new Date().toISOString(),
    });
    db.deposits.save(deposits);

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
      creditDepositByReference(req.params.reference, result.amount / 100);
    }

    const users = db.users.all();
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
  (req, res) => {
    const { amount } = req.body;
    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ error: "A positive amount is required" });
    }
    if (!req.file) {
      return res.status(400).json({ error: "A payment screenshot is required" });
    }

    const deposits = db.deposits.all();
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
    db.deposits.save(deposits);
    res.status(201).json(deposit);
  }
);

// Customer: see their own deposit history (both instant and manual)
app.get("/api/wallet/deposits", requireAuth, (req, res) => {
  const deposits = db.deposits.all().filter((d) => d.userId === req.user.id);
  res.json(deposits);
});

// Admin: see all deposits (filter client-side, or add ?status=pending)
app.get("/api/admin/deposits", requireAuth, requireAdmin, (req, res) => {
  let deposits = db.deposits.all();
  if (req.query.status) {
    deposits = deposits.filter((d) => d.status === req.query.status);
  }
  res.json(deposits);
});

// Admin: approve a MANUAL deposit after checking the screenshot -> credits wallet
app.post("/api/admin/deposits/:id/approve", requireAuth, requireAdmin, (req, res) => {
  const deposits = db.deposits.all();
  const deposit = deposits.find((d) => d.id === req.params.id);
  if (!deposit) return res.status(404).json({ error: "Deposit not found" });
  if (deposit.status !== "pending") {
    return res.status(400).json({ error: `Deposit already ${deposit.status}` });
  }

  deposit.status = "completed";
  db.deposits.save(deposits);

  const users = db.users.all();
  const user = users.find((u) => u.id === deposit.userId);
  user.walletBalance += deposit.amount;
  db.users.save(users);

  res.json({ deposit, newBalance: user.walletBalance });
});

// Admin: reject a manual deposit (e.g. fake or unclear screenshot)
app.post("/api/admin/deposits/:id/reject", requireAuth, requireAdmin, (req, res) => {
  const deposits = db.deposits.all();
  const deposit = deposits.find((d) => d.id === req.params.id);
  if (!deposit) return res.status(404).json({ error: "Deposit not found" });
  if (deposit.status !== "pending") {
    return res.status(400).json({ error: `Deposit already ${deposit.status}` });
  }

  deposit.status = "rejected";
  db.deposits.save(deposits);
  res.json({ deposit });
});

// ============================================================
// PURCHASE — spend wallet balance to buy an item
// ============================================================

app.post("/api/purchase", requireAuth, (req, res) => {
  const { itemId } = req.body;
  if (!itemId) return res.status(400).json({ error: "itemId is required" });

  const items = db.items.all();
  const item = items.find((i) => i.id === itemId);
  if (!item) return res.status(404).json({ error: "Item not found" });
  if (item.sold) return res.status(400).json({ error: "Item already sold" });

  const users = db.users.all();
  const user = users.find((u) => u.id === req.user.id);
  if (user.walletBalance < item.price) {
    return res.status(400).json({ error: "Insufficient wallet balance" });
  }

  user.walletBalance -= item.price;
  user.purchasedItemIds.push(item.id);
  item.sold = true;
  item.ownerId = user.id;

  db.users.save(users);
  db.items.save(items);

  res.json({
    message: "Purchase successful",
    item,
    newBalance: user.walletBalance,
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
