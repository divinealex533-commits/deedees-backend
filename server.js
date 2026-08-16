import express from "express";
import cors from "cors";
import crypto from "crypto";

// ============================================================
// TONYIX API
// ============================================================

const TONYIX_BASE_URL = "https://tonyixlog.com/v1";
const TONYIX_MARKUP = 0.70;

async function tonyixRequest(endpoint, options = {}) {
  const apiKey = process.env.TONYIX_API_KEY;

  if (!apiKey) {
    throw new Error("TONYIX_API_KEY is not configured");
  }

  const separator = endpoint.includes("?") ? "&" : "?";

  const response = await fetch(
    `${TONYIX_BASE_URL}${endpoint}${separator}api_key=${encodeURIComponent(apiKey)}`,
    {
      ...options,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    }
  );

  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error(
      `Tonyix returned an invalid response (${response.status})`
    );
  }

  if (!response.ok || data.success === false) {
    throw new Error(
      data.message ||
        data.msg ||
        `Tonyix request failed (${response.status})`
    );
  }

  return data;
}

async function tonyixPurchase(productId, quantity) {
  return tonyixRequest("/purchase", {
    method: "POST",
    body: JSON.stringify({
      product: Number(productId),
      qty: Number(quantity),
    }),
  });
}

import path from "path";
import dotenv from "dotenv";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";

import { db, initDatabase } from "./db.js";

import {
  hashPassword,
  checkPassword,
  createToken,
  requireAuth,
  requireAdmin,
  createPasswordResetToken,
} from "./auth.js";

import {
  initializeTransaction,
  verifyTransaction,
} from "./paystack.js";

dotenv.config();

const resend = new Resend(process.env.RESEND_API_KEY);

const FRONTEND_URL =
  process.env.FRONTEND_URL ||
  "https://deedees-frontend.onrender.com";

const PASSWORD_RESET_EXPIRY_MS =
  60 * 60 * 1000;

const app = express();

app.use(cors());

// ============================================================
// SUPABASE STORAGE
// ============================================================

const SUPABASE_URL =
  "https://rujxebbeufilpqlszzwz.supabase.co";

const SUPABASE_BUCKET =
  "payment-screenshots";

const supabase = createClient(
  SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ============================================================
// PAYSTACK WEBHOOK
// ============================================================

app.post(
  "/api/webhooks/paystack",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const signature =
        req.headers["x-paystack-signature"];

      const expected = crypto
        .createHmac(
          "sha512",
          process.env.PAYSTACK_SECRET_KEY || ""
        )
        .update(req.body)
        .digest("hex");

      if (signature !== expected) {
        return res
          .status(401)
          .send("Invalid signature");
      }

      const event = JSON.parse(
        req.body.toString()
      );

      if (
        event.event ===
        "charge.success"
      ) {
        await creditDepositByReference(
          event.data.reference,
          event.data.amount / 100
        );
      }

      res.sendStatus(200);
    } catch (err) {
      console.error(
        "Paystack webhook error:",
        err
      );

      res.sendStatus(500);
    }
  }
);

app.use(express.json());

// ============================================================
// FILE UPLOADS
// ============================================================

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

async function uploadScreenshot(file) {
  const ext =
    path.extname(file.originalname) ||
    ".jpg";

  const filename =
    `${crypto.randomUUID()}${ext}`;

  const {
    error: uploadError,
  } =
    await supabase.storage
      .from(SUPABASE_BUCKET)
      .upload(
        filename,
        file.buffer,
        {
          contentType:
            file.mimetype,
          upsert: false,
        }
      );

  if (uploadError) {
    throw new Error(
      `Screenshot upload failed: ${uploadError.message}`
    );
  }

  const { data } =
    supabase.storage
      .from(SUPABASE_BUCKET)
      .getPublicUrl(filename);

  return data.publicUrl;
}

// ============================================================
// PAYMENT CREDIT
// ============================================================

async function creditDepositByReference(
  reference,
  amountNaira
) {
  const deposits =
    await db.deposits.all();

  const deposit =
    deposits.find(
      (d) => d.reference === reference
    );

  if (
    !deposit ||
    deposit.status === "completed"
  ) {
    return;
  }

  deposit.status = "completed";

  await db.deposits.save(
    deposits
  );

  const users =
    await db.users.all();

  const user =
    users.find(
      (u) => u.id === deposit.userId
    );

  if (user) {
    user.walletBalance =
      Number(
        user.walletBalance || 0
      ) +
      Number(
        amountNaira ||
          deposit.amount ||
          0
      );

    await db.users.save(users);
  }
}

// ============================================================
// STOCK HELPERS
// ============================================================

function stockCountOf(item) {
  if (
    Array.isArray(
      item.accessLinks
    )
  ) {
    return item.accessLinks.length;
  }

  if (
    item.quantity != null
  ) {
    return Math.max(
      0,
      Number(item.quantity)
    );
  }

  return item.sold ? 0 : 1;
}

// ============================================================
// TONYIX PRODUCT SYNC
// ============================================================

function getTonyixProductsPayload(
  result
) {
  if (Array.isArray(result))
    return result;

  if (
    Array.isArray(
      result.products
    )
  ) {
    return result.products;
  }

  if (
    Array.isArray(result.data)
  ) {
    return result.data;
  }

  if (
    Array.isArray(
      result.data?.products
    )
  ) {
    return result.data.products;
  }

  return [];
}

function getTonyixProductId(
  product
) {
  return (
    product.id ??
    product.product_id ??
    product.productId ??
    product.product ??
    null
  );
}

function getTonyixProductName(
  product
) {
  return (
    product.name ??
    product.product_name ??
    product.productName ??
    `Tonyix Product ${getTonyixProductId(product)}`
  );
}

function getTonyixProductPrice(
  product
) {
  const value =
    product.price ??
    product.product_price ??
    product.productPrice ??
    product.cost ??
    product.amount ??
    product.selling_price;

  const number =
    Number(value);

  return Number.isFinite(
    number
  )
    ? number
    : null;
}

async function syncTonyixProducts() {
  try {
    const result =
      await tonyixRequest(
        "/products"
      );

    const products =
      getTonyixProductsPayload(
        result
      );

    if (!products.length) {
      console.log(
        "Tonyix sync: no products returned."
      );

      return;
    }

    const items =
      await db.items.all();

    let created = 0;
    let updated = 0;

    for (
      const product of products
    ) {
      const tonyixProductId =
        getTonyixProductId(
          product
        );

      const supplierPrice =
        getTonyixProductPrice(
          product
        );

      if (
        tonyixProductId == null ||
        supplierPrice == null
      ) {
        continue;
      }

      const deeDeePrice =
        Math.round(
          supplierPrice *
            (1 + TONYIX_MARKUP)
        );

      let item =
        items.find(
          (existing) =>
            Number(
              existing.tonyixProductId
            ) ===
            Number(
              tonyixProductId
            )
        );

      if (!item) {
        item = {
          id:
            crypto.randomUUID(),

          name:
            getTonyixProductName(
              product
            ),

          description:
            product.description ||
            "",

          price:
            deeDeePrice,

          tonyixProductId:
            Number(
              tonyixProductId
            ),

          tonyixSupplierPrice:
            supplierPrice,

          imageUrl:
            product.image ||
            product.image_url ||
            product.imageUrl ||
            "",

          categoryId:
            null,

          accessLinks: [],

          quantity: null,

          inStock: true,

          createdAt:
            new Date().toISOString(),
        };

        items.push(item);
        created++;
      } else {
        item.name =
          getTonyixProductName(
            product
          );

        item.tonyixSupplierPrice =
          supplierPrice;

        item.price =
          deeDeePrice;

        if (
          product.description !==
          undefined
        ) {
          item.description =
            product.description ||
            "";
        }

        if (
          product.image ||
          product.image_url ||
          product.imageUrl
        ) {
          item.imageUrl =
            product.image ||
            product.image_url ||
            product.imageUrl;
        }

        updated++;
      }
    }

    await db.items.save(items);

    console.log(
      `Tonyix sync complete: ${created} created, ${updated} updated.`
    );
  } catch (error) {
    console.error(
      "Tonyix automatic sync failed:",
      error.message
    );
  }
}

// ============================================================
// REFERRALS
// ============================================================

function generateReferralCode() {
  return crypto
    .randomBytes(4)
    .toString("hex")
    .toUpperCase();
}
function createSellerProfile() {
  return {
    isSeller: false,

    sellerPlan: null,
    sellerPlanStatus: "inactive",
    sellerPlanExpiresAt: null,
    sellerSubscriptionReference: null,

    sellerRenewalReminderSentAt: null,
    sellerFrozenAt: null,
    sellerFreezeReason: null,
    sellerRenewalPaymentReference: null,
    
    sellerStoreName: "",
    sellerStoreSlug: "",
    sellerDescription: "",
    sellerLogoUrl: "",

    sellerMarkup: 0,

    sellerSupportEmail: "",
    sellerWhatsappLink: "",

    sellerPayoutEmail: "",
    sellerPayoutAccountName: "",
    sellerPayoutAccountNumber: "",
    sellerPayoutBankCode: "",
  };
}


// ============================================================
// ADMIN EMAIL SYNC
// ============================================================

function syncAdminStatus(user) {
  const adminEmail =
    (
      process.env.ADMIN_EMAIL ||
      ""
    )
      .trim()
      .toLowerCase();

  if (!adminEmail) {
    return false;
  }

  const isAdmin =
    String(user.email || "")
      .trim()
      .toLowerCase() ===
    adminEmail;

  user.isAdmin =
    isAdmin;

  return isAdmin;
}

// ============================================================
// PUBLIC USER
// ============================================================

function publicUser(user) {
  const {
    passwordHash,
    passwordResetTokenHash,
    passwordResetTokenExpiresAt,
    ...safe
  } = user;

  return safe;
}

// ============================================================
// PASSWORD RESET EMAIL
// ============================================================

async function sendPasswordResetEmail(
  user,
  rawToken
) {
  if (
    !process.env.RESEND_API_KEY
  ) {
    throw new Error(
      "RESEND_API_KEY is not configured"
    );
  }

  const resetUrl =
    `${FRONTEND_URL}/reset-password?token=${encodeURIComponent(
      rawToken
    )}`;

  const fromAddress =
    process.env.RESEND_FROM_EMAIL ||
    "DeeDee's <onboarding@resend.dev>";

  const { error } =
    await resend.emails.send({
      from: fromAddress,
      to: user.email,
      subject:
        "Reset your DeeDee's password",
      html: `
        <div style="
          font-family: Arial, sans-serif;
          max-width: 600px;
          margin: 0 auto;
          padding: 30px;
          color: #111827;
        ">
          <h2>Reset your DeeDee's password</h2>

          <p>
            Hello ${escapeHtml(
              user.name || "there"
            )},
          </p>

          <p>
            We received a request to reset
            the password for your DeeDee's account.
          </p>

          <p>
            Click the button below to create
            a new password.
            This link expires in
            <strong>1 hour</strong>.
          </p>

          <p style="margin: 30px 0;">
            <a
              href="${resetUrl}"
              style="
                display: inline-block;
                padding: 12px 22px;
                background: #2563eb;
                color: white;
                text-decoration: none;
                border-radius: 8px;
                font-weight: bold;
              "
            >
              Reset Password
            </a>
          </p>

          <p>
            If you did not request this,
            you can safely ignore this email.
          </p>

          <p>
            For security, the reset link
            can only be used once.
          </p>

          <hr style="
            margin-top: 30px;
            border: 0;
            border-top: 1px solid #ddd;
          " />

          <p style="
            font-size: 12px;
            color: #6b7280;
          ">
            DeeDee's Marketplace
          </p>
        </div>
      `,
    });

  if (error) {
    throw new Error(
      error.message ||
      "Failed to send reset email"
    );
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll(
      "&",
      "&amp;"
    )
    .replaceAll(
      "<",
      "&lt;"
    )
    .replaceAll(
      ">",
      "&gt;"
    )
    .replaceAll(
      '"',
      "&quot;"
    )
    .replaceAll(
      "'",
      "&#039;"
    );
}

// ============================================================
// TONYIX TEST — PRODUCTS
// ============================================================

app.get(
  "/api/tonyix/products",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const result =
        await tonyixRequest(
          "/products"
        );

      res.json(result);
    } catch (error) {
      console.error(
        "Tonyix products error:",
        error
      );

      res.status(502).json({
        error:
          error.message ||
          "Unable to connect to Tonyix",
      });
    }
  }
);

// ============================================================
// HEALTH CHECK
// ============================================================

app.get(
  "/",
  (req, res) => {
    res.json({
      status: "ok",
      message:
        "DeeDee's Marketplace API is running",
    });
  }
);

// ============================================================
// AUTH — SIGNUP
// ============================================================

app.post(
  "/api/auth/signup",
  async (req, res) => {
    const {
      name,
      email,
      password,
      referralCode,
    } = req.body;

    if (
      !name ||
      !email ||
      !password
    ) {
      return res.status(400).json({
        error:
          "name, email and password are required",
      });
    }

    const users =
      await db.users.all();

    const normalizedEmail =
      email
        .trim()
        .toLowerCase();

    if (
      users.find(
        (u) =>
          u.email.toLowerCase() ===
          normalizedEmail
      )
    ) {
      return res.status(409).json({
        error:
          "An account with that email already exists",
      });
    }

    let referredBy = null;

    if (referralCode) {
      const referrer =
        users.find(
          (u) =>
            u.referralCode ===
            referralCode
              .trim()
              .toUpperCase()
        );

      if (referrer) {
        referredBy =
          referrer.id;
      }
    }

    const adminEmail =
      (
        process.env.ADMIN_EMAIL ||
        ""
      )
        .trim()
        .toLowerCase();

 const newUser = {
  id:
    crypto.randomUUID(),

  name:
    name.trim(),

  // ============================================================
  // SELLER FOUNDATION
  // ============================================================

  ...createSellerProfile(),

  email:
    normalizedEmail,

  passwordHash:
    hashPassword(password),

  walletBalance: 0,

  isAdmin:
    adminEmail !== "" &&
    normalizedEmail ===
      adminEmail,

  purchasedItemIds: [],

  referralCode:
    generateReferralCode(),

  referredBy,

  referralRewardProcessed:
    false,

  createdAt:
    new Date().toISOString(),
};

    users.push(newUser);

    await db.users.save(
      users
    );

    const token =
      createToken(newUser);

    res.status(201).json({
      token,
      user:
        publicUser(newUser),
    });
  }
);

// ============================================================
// SELLER SUBSCRIPTION PLANS
// ============================================================

const SELLER_PLANS = {
  standard_seller: {
    id: "standard_seller",
    name: "Standard Seller",
    price: 50000,
    currency: "NGN",
    billing: "one_time",

    features: [
      "verified_seller",
      "seller_dashboard",
      "own_products",
      "seller_earnings",
      "withdraw_earnings",
    ],
  },

  premium_monthly: {
    id: "premium_monthly",
    name: "Premium Monthly",
    price: 30000,
    currency: "NGN",
    billing: "monthly",

    features: [
      "verified_seller",
      "seller_dashboard",
      "own_products",
      "seller_earnings",
      "withdraw_earnings",
      "storefront_link",
      "custom_branding",
      "tonyix_products",
      "support_details",
      "product_markup",
    ],
  },

  premium_yearly: {
    id: "premium_yearly",
    name: "Premium Yearly",
    price: 120000,
    currency: "NGN",
    billing: "yearly",

    features: [
      "verified_seller",
      "seller_dashboard",
      "own_products",
      "seller_earnings",
      "withdraw_earnings",
      "storefront_link",
      "custom_branding",
      "tonyix_products",
      "support_details",
      "product_markup",
    ],
  },
};

function getSellerPlan(user) {
  const planId =
    user?.sellerPlan || null;

  if (!planId) {
    return null;
  }

  return (
    SELLER_PLANS[planId] ||
    null
  );
}

function isPremiumSeller(user) {
  const plan = getSellerPlan(user);

  if (!plan) {
    return false;
  }

  if (
    plan.id !==
      "premium_monthly" &&
    plan.id !==
      "premium_yearly"
  ) {
    return false;
  }

  const expiresAt =
    Number(
      user.sellerPlanExpiresAt || 0
    );

  if (
    !expiresAt ||
    Date.now() >= expiresAt
  ) {
    return false;
  }

  return (
    user.sellerPlanStatus ===
      "active"
  );
}

function isStandardSeller(user) {
  return (
    user?.sellerPlan ===
      "standard_seller" &&
    user?.sellerPlanStatus ===
      "active"
  );
}

function hasSellerAccess(user) {
  return (
    isStandardSeller(user) ||
    isPremiumSeller(user)
  );
}

function hasSellerFeature(
  user,
  feature
) {
  const plan =
    getSellerPlan(user);

  if (!plan) {
    return false;
  }

  if (
    plan.id !==
      "standard_seller" &&
    !isPremiumSeller(user)
  ) {
    return false;
  }

  return plan.features.includes(
    feature
  );
}

function syncSellerSubscription(user) {
  if (!user) {
    return false;
  }

  let changed = false;

  if (
    user.sellerPlanStatus ===
    undefined
  ) {
    user.sellerPlanStatus =
      "inactive";
    changed = true;
  }

  // ============================================================
// SELLER SUBSCRIPTION — FROZEN ACCOUNT PAYMENT DETAILS
// ============================================================
const SELLER_RENEWAL_PAYMENT_DETAILS = {
  accountName:
    process.env.SELLER_RENEWAL_ACCOUNT_NAME || "",
  accountNumber:
    process.env.SELLER_RENEWAL_ACCOUNT_NUMBER || "",
  bankName:
    process.env.SELLER_RENEWAL_BANK_NAME || "",
  paymentInstructions:
    process.env.SELLER_RENEWAL_PAYMENT_INSTRUCTIONS ||
    "Make your subscription renewal payment to the account shown above, then contact support/admin for verification.",
};

  function getSellerSubscriptionState(user) {
  if (!user) {
    return {
      isSeller: false,
      isFrozen: false,
      plan: null,
    };
  }
  const plan = getSellerPlan(user);
  const isFrozen =
    user.sellerPlanStatus === "frozen";
  return {
    isSeller: !!user.isSeller,
    isFrozen,
    plan,
  };
}
  const plan =
    getSellerPlan(user);

  if (
    plan &&
    (
      plan.id ===
        "premium_monthly" ||
      plan.id ===
        "premium_yearly"
    )
  ) {
    const expiresAt =
      Number(
        user.sellerPlanExpiresAt ||
          0
      );

    if (
      user.sellerPlanStatus ===
        "active" &&
      expiresAt > 0 &&
      Date.now() >= expiresAt
    ) {
      user.sellerPlanStatus =
        "expired";

      changed = true;
    }
  }

  return changed;
}

async function getCurrentSellerUser(
  req
) {
  const users =
    await db.users.all();

  const user =
    users.find(
      (u) =>
        u.id ===
        req.user.id
    );

  if (!user) {
    return null;
  }

  const changed =
    syncSellerSubscription(
      user
    );

  if (changed) {
    await db.users.save(users);
  }

  return user;
}

// ============================================================
// SELLER SUBSCRIPTION — RENEWAL / FREEZE HELPERS
// ============================================================

const SELLER_RENEWAL_REMINDER_DAYS = 14;

function sellerSubscriptionNeedsRenewalReminder(user) {
  if (!user) {
    return false;
  }

  const plan = getSellerPlan(user);

  if (!plan) {
    return false;
  }

  // Standard Seller does not use the subscription-expiry system.
  if (plan.id === "standard_seller") {
    return false;
  }

  if (
    plan.id !== "premium_monthly" &&
    plan.id !== "premium_yearly"
  ) {
    return false;
  }

  if (
    user.sellerPlanStatus !== "active"
  ) {
    return false;
  }

  const expiresAt =
    Number(
      user.sellerPlanExpiresAt || 0
    );

  if (!expiresAt) {
    return false;
  }

  const now = Date.now();

  const reminderWindow =
    SELLER_RENEWAL_REMINDER_DAYS *
    24 *
    60 *
    60 *
    1000;

  const reminderStart =
    expiresAt - reminderWindow;

  return (
    now >= reminderStart &&
    now < expiresAt &&
    !user.sellerRenewalReminderSentAt
  );
}

function freezeExpiredSeller(user) {
  if (!user) {
    return false;
  }

  const plan = getSellerPlan(user);

  if (!plan) {
    return false;
  }

  if (
    plan.id !== "premium_monthly" &&
    plan.id !== "premium_yearly"
  ) {
    return false;
  }

  const expiresAt =
    Number(
      user.sellerPlanExpiresAt || 0
    );

  if (
    user.sellerPlanStatus !== "active" ||
    !expiresAt ||
    Date.now() < expiresAt
  ) {
    return false;
  }

  user.sellerPlanStatus =
    "frozen";

  user.sellerFrozenAt =
    new Date().toISOString();

  user.sellerFreezeReason =
    "Subscription expired and was not renewed";

  return true;
}

function isSellerFrozen(user) {
  return (
    user?.sellerPlanStatus ===
    "frozen"
  );
}

function canSellerUsePlatform(user) {
  if (!user) {
    return false;
  }

  // ============================================================
// SELLER SUBSCRIPTION — 14-DAY RENEWAL REMINDER
// ============================================================
async function sendSellerRenewalReminder(user) {
  if (!user) {
    return false;
  }
  const plan = getSellerPlan(user);
  if (!plan) {
    return false;
  }
  // Standard Seller does not use subscription renewal reminders.
  if (plan.id === "standard_seller") {
    return false;
  }
  if (
    plan.id !== "premium_monthly" &&
    plan.id !== "premium_yearly"
  ) {
    return false;
  }
  if (
    user.sellerPlanStatus !== "active"
  ) {
    return false;
  }
  const expiresAt =
    Number(
      user.sellerPlanExpiresAt || 0
    );
  if (!expiresAt) {
    return false;
  }
  if (
    !sellerSubscriptionNeedsRenewalReminder(
      user
    )
  ) {
    return false;
  }
  const users =
    await db.users.all();
  const currentUser =
    users.find(
      (u) =>
        u.id === user.id
    );
  if (!currentUser) {
    return false;
  }
  // ============================================================
// SELLER SUBSCRIPTION — AUTOMATIC CHECKER
// ============================================================
let sellerSubscriptionCheckRunning = false;
async function runSellerSubscriptionCheck() {
  if (sellerSubscriptionCheckRunning) {
    return;
  }
  sellerSubscriptionCheckRunning = true;
  try {
    const users = await db.users.all();
    let changed = false;
    for (const user of users) {
      if (!user) {
        continue;
      }
      const plan = getSellerPlan(user);
      if (!plan) {
        continue;
      }
      // Standard Seller does not use Premium subscription expiry.
      if (plan.id === "standard_seller") {
        continue;
      }
      if (
        plan.id !== "premium_monthly" &&
        plan.id !== "premium_yearly"
      ) {
        continue;
      }
      // First synchronize an already-expired subscription.
      if (
        syncSellerSubscription(user)
      ) {
        changed = true;
      }
      // Send the 14-day renewal reminder.
      if (
        sellerSubscriptionNeedsRenewalReminder(
          user
        )
      ) {
        await sendSellerRenewalReminder(
          user
        );
        changed = true;
      }
      // Freeze the seller after expiry if
      // the subscription was not renewed.
      if (
        freezeExpiredSeller(user)
      ) {
        changed = true;
        console.log(
          "Seller subscription frozen:",
          user.id
        );
      }
    }
    if (changed) {
      await db.users.save(users);
    }
  } catch (err) {
    console.error(
      "Seller subscription check failed:",
      err
    );
  } finally {
    sellerSubscriptionCheckRunning = false;
  }
}
// Run once when the server starts.
runSellerSubscriptionCheck();
// Then check every hour.
setInterval(
  runSellerSubscriptionCheck,
  60 * 60 * 1000
);
  
  // Double-check so repeated calls cannot send
  // the same reminder again.
  if (
    currentUser.sellerRenewalReminderSentAt
  ) {
    return false;
  }
  const email =
    currentUser.email ||
    currentUser.sellerSupportEmail ||
    "";
  if (!email) {
    console.warn(
      "Seller has no email for renewal reminder:",
      currentUser.id
    );
    return false;
  }
  const expiresDate =
    new Date(
      expiresAt
    ).toLocaleDateString(
      "en-NG",
      {
        year: "numeric",
        month: "long",
        day: "numeric",
      }
    );
  try {
    await resend.emails.send({
      from:
        process.env.RESEND_FROM_EMAIL ||
        "DeeDee's Marketplace <onboarding@resend.dev>",
      to: email,
      subject:
        "Your DeeDee's Seller Subscription Renews Soon",
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.6;">
          <h2>Seller Subscription Renewal Reminder</h2>
          <p>
            Hello ${
              currentUser.name ||
              currentUser.username ||
              "Seller"
            },
          </p>
          <p>
            Your
            <strong>${plan.name}</strong>
            seller subscription will expire on
            <strong>${expiresDate}</strong>.
          </p>
          <p>
            You have about
            <strong>14 days</strong>
            to renew your subscription and keep
            your seller access active.
          </p>
          <p>
            If your subscription expires without
            renewal, your seller access will be
            frozen until payment is confirmed and
            an administrator unfreezes the account.
          </p>
          <p>
            Please renew before the expiry date to
            avoid interruption to your seller
            activities.
          </p>
          <p>
            Regards,<br />
            <strong>DeeDee's Marketplace</strong>
          </p>
        </div>
      `,
    });
    currentUser.sellerRenewalReminderSentAt =
      new Date().toISOString();
    await db.users.save(users);
    console.log(
      "Seller renewal reminder sent:",
      currentUser.id
    );
    return true;
  } catch (err) {
    console.error(
      "Seller renewal reminder failed:",
      err
    );
    return false;
  }
}

  return hasSellerAccess(user);
}

// Seller must have an active Standard or Premium plan.
async function requireSellerAccess(
  req,
  res,
  next
) {
  try {
    const user =
      await getCurrentSellerUser(
        req
      );

    if (!user) {
      return res.status(404).json({
        error:
          "User not found",
      });
    }

    if (
      !hasSellerAccess(user)
    ) {
      return res.status(403).json({
        error:
          "An active seller subscription is required",
        code:
          "SELLER_SUBSCRIPTION_REQUIRED",
      });
    }

    req.sellerUser =
      user;

    next();
  } catch (error) {
    console.error(
      "Seller access check error:",
      error
    );

    res.status(500).json({
      error:
        "Unable to verify seller access",
    });
  }
}

// Premium Monthly/Yearly only.
async function requirePremiumSeller(
  req,
  res,
  next
) {
  try {
    const user =
      await getCurrentSellerUser(
        req
      );

    if (!user) {
      return res.status(404).json({
        error:
          "User not found",
      });
    }

    if (
      !isPremiumSeller(user)
    ) {
      return res.status(403).json({
        error:
          "Premium Seller subscription is required for this feature",
        code:
          "PREMIUM_SUBSCRIPTION_REQUIRED",
      });
    }

    req.sellerUser =
      user;

    next();
  } catch (error) {
    console.error(
      "Premium seller access check error:",
      error
    );

    res.status(500).json({
      error:
        "Unable to verify premium seller access",
    });
  }
}

// ============================================================
// AUTH — LOGIN
// ============================================================

app.post(
  "/api/auth/login",
  async (req, res) => {
    try {
      const {
        email,
        password,
      } = req.body;

      const normalizedEmail =
        (email || "")
          .trim()
          .toLowerCase();

      if (
        !normalizedEmail ||
        !password
      ) {
        return res.status(400).json({
          error:
            "Email and password are required",
        });
      }

      const user =
        await db.users.findByEmail(
          normalizedEmail
        );

      if (!user) {
        return res.status(401).json({
          error:
            "Invalid email or password",
        });
      }

      const oldAdminStatus =
        !!user.isAdmin;

      syncAdminStatus(user);

      if (
        oldAdminStatus !==
        !!user.isAdmin
      ) {
        await db.users.updateById(
          user.id,
          user
        );
      }

      const passwordValid =
        checkPassword(
          password,
          user.passwordHash
        );

      if (!passwordValid) {
        return res.status(401).json({
          error:
            "Invalid email or password",
        });
      }

      const token =
        createToken(user);

      return res.json({
        token,
        user:
          publicUser(user),
      });
    } catch (error) {
      console.error(
        "Login error:",
        error
      );

      return res.status(500).json({
        error:
          "Unable to login right now. Please try again.",
      });
    }
  }
);

// ============================================================
// FORGOT PASSWORD
// ============================================================

app.post(
  "/api/auth/forgot-password",
  async (req, res) => {
    const { email } =
      req.body;

    if (!email) {
      return res.status(400).json({
        error:
          "Email is required",
      });
    }

    const users =
      await db.users.all();

    const user =
      users.find(
        (u) =>
          u.email.toLowerCase() ===
          email
            .trim()
            .toLowerCase()
      );

    if (!user) {
      return res.json({
        message:
          "If an account exists for that email, a password reset link has been sent.",
      });
    }

    try {
      const {
        token,
        tokenHash,
      } =
        createPasswordResetToken();

      user.passwordResetTokenHash =
        tokenHash;

      user.passwordResetTokenExpiresAt =
        Date.now() +
        PASSWORD_RESET_EXPIRY_MS;

      await db.users.save(
        users
      );

      await sendPasswordResetEmail(
        user,
        token
      );

      res.json({
        message:
          "If an account exists for that email, a password reset link has been sent.",
      });
    } catch (err) {
      console.error(
        "Forgot password error:",
        err
      );

      res.status(500).json({
        error:
          "Unable to send the password reset email. Please try again later.",
      });
    }
  }
);

// ============================================================
// RESEND PASSWORD RESET
// ============================================================

app.post(
  "/api/auth/resend-password-reset",
  async (req, res) => {
    const { email } =
      req.body;

    if (!email) {
      return res.status(400).json({
        error:
          "Email is required",
      });
    }

    const users =
      await db.users.all();

    const user =
      users.find(
        (u) =>
          u.email.toLowerCase() ===
          email
            .trim()
            .toLowerCase()
      );

    if (!user) {
      return res.json({
        message:
          "If an account exists for that email, a new password reset link has been sent.",
      });
    }

    try {
      const {
        token,
        tokenHash,
      } =
        createPasswordResetToken();

      user.passwordResetTokenHash =
        tokenHash;

      user.passwordResetTokenExpiresAt =
        Date.now() +
        PASSWORD_RESET_EXPIRY_MS;

      await db.users.save(
        users
      );

      await sendPasswordResetEmail(
        user,
        token
      );

      res.json({
        message:
          "If an account exists for that email, a new password reset link has been sent.",
      });
    } catch (err) {
      console.error(
        "Resend password reset error:",
        err
      );

      res.status(500).json({
        error:
          "Unable to resend the password reset email. Please try again later.",
      });
    }
  }
);

// ============================================================
// RESET PASSWORD
// ============================================================

app.post(
  "/api/auth/reset-password",
  async (req, res) => {
    const {
      token,
      password,
    } = req.body;

    if (
      !token ||
      !password
    ) {
      return res.status(400).json({
        error:
          "Reset token and new password are required",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error:
          "Password must be at least 6 characters",
      });
    }

    const tokenHash =
      crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");

    const users =
      await db.users.all();

    const user =
      users.find(
        (u) =>
          u.passwordResetTokenHash ===
          tokenHash
      );

    if (!user) {
      return res.status(400).json({
        error:
          "This password reset link is invalid or has already been used.",
      });
    }

    if (
      !user.passwordResetTokenExpiresAt ||
      Date.now() >
        user.passwordResetTokenExpiresAt
    ) {
      return res.status(400).json({
        error:
          "This password reset link has expired. Please request a new one.",
      });
    }

    user.passwordHash =
      hashPassword(password);

    delete user.passwordResetTokenHash;
    delete user.passwordResetTokenExpiresAt;

    await db.users.save(
      users
    );

    res.json({
      message:
        "Password reset successfully. You can now log in with your new password.",
    });
  }
);

// ============================================================
// DASHBOARD — CURRENT USER
// ============================================================

app.get(
  "/api/me",
  requireAuth,
  async (req, res) => {
    const users =
      await db.users.all();

    const user =
      users.find(
        (u) => u.id === req.user.id
      );

    if (!user) {
      return res.status(404).json({
        error:
          "User not found",
      });
    }

    const oldAdminStatus =
      !!user.isAdmin;

    syncAdminStatus(user);

    if (
      oldAdminStatus !==
      !!user.isAdmin
    ) {
      await db.users.save(
        users
      );
    }

    const [
      items,
      purchases,
    ] =
      await Promise.all([
        db.items.all(),
        db.purchases.all(),
      ]);

    const myPurchases =
      purchases.filter(
        (p) =>
          p.buyerId ===
          user.id
      );

    const purchasedItems =
      items
        .filter((i) =>
          user.purchasedItemIds.includes(
            i.id
          )
        )
        .map((i) => {
          const relatedPurchases =
            myPurchases.filter(
              (p) =>
                p.itemId ===
                i.id
            );

          const assignedCredentials =
            relatedPurchases.flatMap(
              (p) =>
                p.assignedCredentials ||
                []
            );

          const accessLink =
            assignedCredentials[0] ||
            i.accessLink ||
            null;

          return {
            ...publicItem(i),
            assignedCredentials,
            accessLink,
          };
        });

    res.json({
      ...publicUser(user),
      purchasedItems,
    });
  }
);

// ============================================================
// MY ORDERS
// ============================================================

app.get(
  "/api/my-orders",
  requireAuth,
  async (req, res) => {
    const [
      purchases,
      items,
    ] =
      await Promise.all([
        db.purchases.all(),
        db.items.all(),
      ]);

    const myPurchases =
      purchases.filter(
        (p) =>
          p.buyerId ===
          req.user.id
      );

    const orders =
      myPurchases.map(
        (p) => {
          const item =
            items.find(
              (i) =>
                i.id ===
                p.itemId
            );

          const assignedCredentials =
            p.assignedCredentials ||
            [];

          const accessLink =
            assignedCredentials[0] ||
            (item &&
              item.accessLink) ||
            null;

          return {
            id: p.id,
            purchasedAt:
              p.createdAt,
            price: p.price,
            quantity:
              p.quantity || 1,
            assignedCredentials,
            item: item
              ? {
                  ...publicItem(
                    item
                  ),
                  accessLink,
                }
              : null,
          };
        }
      );

    res.json({
      orders,
    });
  }
);

// ============================================================
// REFERRALS
// ============================================================

app.get(
  "/api/my-referrals",
  requireAuth,
  async (req, res) => {
    const users = await db.users.all();

    const user = users.find(
      (u) => u.id === req.user.id
    );

    if (!user) {
      return res.status(404).json({
        error: "User not found",
      });
    }

    // Generate a referral code for older accounts
    // that were created before referrals were added.
    if (!user.referralCode) {
      user.referralCode = generateReferralCode();

      if (user.referralRewardProcessed === undefined) {
        user.referralRewardProcessed = false;
      }

      await db.users.save(users);
    }

    const referredUsers =
      users.filter(
        (u) => u.referredBy === user.id
      );

    const successfulReferrals =
      referredUsers.filter(
        (u) => u.referralRewardProcessed
      ).length;

    res.json({
      referralCode: user.referralCode,
      totalReferred: referredUsers.length,
      successfulReferrals,
      totalEarned:
        successfulReferrals * 500,
    });
  }
);

// ============================================================
// SELLER FOUNDATION
// ============================================================

// Get the current user's seller profile.
app.get(
  "/api/seller/products",
  requireAuth,
  requireSellerAccess,
  async (req, res) => {
    const users =
      await db.users.all();

    const user =
      users.find(
        (u) =>
          u.id === req.user.id
      );

    if (!user) {
      return res.status(404).json({
        error:
          "User not found",
      });
    }

    // Give older accounts the new seller fields.
    let changed = false;

    if (user.isSeller === undefined) {
      user.isSeller = false;
      changed = true;
    }

    if (user.sellerStoreName === undefined) {
      user.sellerStoreName = "";
      changed = true;
    }

    if (user.sellerStoreSlug === undefined) {
      user.sellerStoreSlug = "";
      changed = true;
    }

    if (user.sellerDescription === undefined) {
      user.sellerDescription = "";
      changed = true;
    }

    if (user.sellerLogoUrl === undefined) {
      user.sellerLogoUrl = "";
      changed = true;
    }

    if (user.sellerMarkup === undefined) {
      user.sellerMarkup = 0;
      changed = true;
    }

    if (user.sellerPayoutEmail === undefined) {
      user.sellerPayoutEmail = "";
      changed = true;
    }

    if (user.sellerPayoutAccountName === undefined) {
      user.sellerPayoutAccountName = "";
      changed = true;
    }

    if (user.sellerPayoutAccountNumber === undefined) {
      user.sellerPayoutAccountNumber = "";
      changed = true;
    }

    if (user.sellerPayoutBankCode === undefined) {
      user.sellerPayoutBankCode = "";
      changed = true;
    }

    if (changed) {
      await db.users.save(users);
    }

    res.json({
      isSeller:
        !!user.isSeller,

      storeName:
        user.sellerStoreName || "",

      storeSlug:
        user.sellerStoreSlug || "",

      description:
        user.sellerDescription || "",

      logoUrl:
        user.sellerLogoUrl || "",

      markup:
        Number(
          user.sellerMarkup || 0
        ),

      payoutEmail:
        user.sellerPayoutEmail || "",

      payoutAccountName:
        user.sellerPayoutAccountName || "",

      payoutAccountNumber:
        user.sellerPayoutAccountNumber || "",

      payoutBankCode:
        user.sellerPayoutBankCode || "",
    });
  }
);

// Create/update seller profile.
app.put(
  "/api/seller/profile",
  requireAuth,
  async (req, res) => {
    const {
      storeName,
      storeSlug,
      description,
      logoUrl,
      markup,
      payoutEmail,
      payoutAccountName,
      payoutAccountNumber,
      payoutBankCode,
    } = req.body;

    const users =
      await db.users.all();

    const user =
      users.find(
        (u) =>
          u.id === req.user.id
      );

    if (!user) {
      return res.status(404).json({
        error:
          "User not found",
      });
    }

    if (
      !storeName ||
      !String(storeName).trim()
    ) {
      return res.status(400).json({
        error:
          "Store name is required",
      });
    }

    const markupNumber =
      markup == null
        ? 0
        : Number(markup);

    if (
      !Number.isFinite(
        markupNumber
      ) ||
      markupNumber < 0
    ) {
      return res.status(400).json({
        error:
          "Markup must be a valid number greater than or equal to 0",
      });
    }

    user.isSeller = true;

    user.sellerStoreName =
      String(storeName).trim();

    user.sellerStoreSlug =
      String(
        storeSlug ||
          storeName
      )
        .trim()
        .toLowerCase()
        .replace(
          /[^a-z0-9]+/g,
          "-"
        )
        .replace(
          /^-+|-+$/g,
          ""
        );

    user.sellerDescription =
      String(
        description || ""
      ).trim();

    user.sellerLogoUrl =
      String(
        logoUrl || ""
      ).trim();

    user.sellerMarkup =
      markupNumber;

    user.sellerPayoutEmail =
      String(
        payoutEmail ||
          user.email ||
          ""
      ).trim();

    user.sellerPayoutAccountName =
      String(
        payoutAccountName ||
          ""
      ).trim();

    user.sellerPayoutAccountNumber =
      String(
        payoutAccountNumber ||
          ""
      ).trim();

    user.sellerPayoutBankCode =
      String(
        payoutBankCode ||
          ""
      ).trim();

    await db.users.save(users);

    res.json({
      message:
        "Seller profile saved successfully",

      seller: {
        isSeller:
          user.isSeller,

        storeName:
          user.sellerStoreName,

        storeSlug:
          user.sellerStoreSlug,

        description:
          user.sellerDescription,

        logoUrl:
          user.sellerLogoUrl,

        markup:
          user.sellerMarkup,

        payoutEmail:
          user.sellerPayoutEmail,

        payoutAccountName:
          user.sellerPayoutAccountName,

        payoutAccountNumber:
          user.sellerPayoutAccountNumber,

        payoutBankCode:
          user.sellerPayoutBankCode,
      },
    });
  }
);

// ============================================================
// PUBLIC ITEMS
// ============================================================

app.get(
  "/api/items",
  async (req, res) => {
    const items =
      await db.items.all();

    res.json(
      items.map(
        publicItem
      )
    );
  }
);

app.get(
  "/api/items/:id",
  async (req, res) => {
    const items =
      await db.items.all();

    const item =
      items.find(
        (i) =>
          i.id ===
          req.params.id
      );

    if (!item) {
      return res.status(404).json({
        error:
          "Item not found",
      });
    }

    res.json(
      publicItem(item)
    );
  }
);

function publicItem(item) {
  const {
    accessLinks,
    accessLink,
    ...safe
  } = item;

  const stockCount =
    stockCountOf(item);

  return {
    ...safe,

    ownerType:
      getProductOwnerType(item),

    // Never expose another seller's private ownership
    // information through the public product API.
    ownerId:
      isSellerProduct(item)
        ? item.ownerId
        : null,

    sourceItemId:
      item.sourceItemId || null,

    stockCount,

    inStock:
      item.inStock !== false &&
      stockCount > 0,
  };
}

function getProductOwnerType(item) {
  return item.ownerType === "seller"
    ? "seller"
    : "deedee";
}

function isDeeDeeProduct(item) {
  return getProductOwnerType(item) === "deedee";
}

function isSellerProduct(item) {
  return getProductOwnerType(item) === "seller";
}

function sellerOwnsProduct(item, sellerId) {
  return (
    isSellerProduct(item) &&
    String(item.ownerId) ===
      String(sellerId)
  );
}

function createProductOwnershipFields({
  ownerType = "deedee",
  ownerId = null,
  sourceItemId = null,
}) {
  return {
    ownerType,
    ownerId,
    sourceItemId,
  };
}

// ============================================================
// ADMIN ITEMS
// ============================================================

app.get(
  "/api/admin/items",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const items =
      await db.items.all();

    res.json(items);
  }
);

app.post(
  "/api/items",
  requireAuth,
  requireAdmin,
  async (req, res) => {
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
      tonyixProductId,
    } = req.body;

    if (
      !name ||
      price == null
    ) {
      return res.status(400).json({
        error:
          "name and price are required",
      });
    }

    const items =
      await db.items.all();

    const newItem = {
  id:
    crypto.randomUUID(),
  name,
  description:
    description || "",
  price:
    Number(price),
  tonyixProductId:
    tonyixProductId != null
      ? Number(
          tonyixProductId
        )
      : null,
  imageUrl:
    imageUrl ||
    image ||
    "",
  categoryId:
    categoryId || null,
  accessLinks:
    Array.isArray(
      accessLinks
    )
      ? accessLinks
          .map((x) =>
            String(x).trim()
          )
          .filter(Boolean)
      : [],
  accessLink:
    accessLink ||
    undefined,
  quantity:
    quantity != null
      ? Number(quantity)
      : undefined,
  inStock:
    inStock !== undefined
      ? inStock
      : true,
  // ============================================================
  // PRODUCT OWNERSHIP
  // ============================================================
  // Products created by DeeDee/Admin belong to DeeDee.
  // Sellers will NOT use this route to create their products.
  // ============================================================
  ...createProductOwnershipFields({
    ownerType:
      "deedee",
    ownerId:
      null,
    sourceItemId:
      null,
  }),
  createdAt:
    new Date().toISOString(),
};
      items.push(
      newItem
    );

    await db.items.save(
      items
    );

    res.status(201).json(
      newItem
    );
  }
);

// ============================================================
// SELLER — CREATE OWN PRODUCT
// ============================================================
app.post(
  "/api/seller/products",
  requireAuth,
  requireSellerAccess,
  async (req, res) => {
    try {
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
      if (
        !name ||
        price == null
      ) {
        return res.status(400).json({
          error:
            "name and price are required",
        });
      }
      const priceNumber =
        Number(price);
      if (
        !Number.isFinite(
          priceNumber
        ) ||
        priceNumber < 0
      ) {
        return res.status(400).json({
          error:
            "price must be a valid number",
        });
      }
      const users =
        await db.users.all();
      const user =
        users.find(
          (u) =>
            u.id === req.user.id
        );
      if (!user) {
        return res.status(404).json({
          error:
            "User not found",
        });      
       }

      const items =
        await db.items.all();
      const newItem = {
        id:
          crypto.randomUUID(),
        name:
          String(name).trim(),
        description:
          String(
            description || ""
          ).trim(),
        price:
          priceNumber,
        tonyixProductId:
          null,
        tonyixSupplierPrice:
          null,
        imageUrl:
          imageUrl ||
          image ||
          "",
        categoryId:
          categoryId || null,
        accessLinks:
          Array.isArray(
            accessLinks
          )
            ? accessLinks
                .map((x) =>
                  String(x).trim()
                )
                .filter(Boolean)
            : [],
        accessLink:
          accessLink ||
          undefined,
        quantity:
          quantity != null
            ? Number(quantity)
            : undefined,
        inStock:
          inStock !== undefined
            ? inStock
            : true,
        // ========================================================
        // THIS PRODUCT BELONGS TO THE SELLER
        // ========================================================
        ownerType:
          "seller",
        ownerId:
          user.id,
        sourceItemId:
          null,
        createdAt:
          new Date().toISOString(),
      };
      items.push(
        newItem
      );
      await db.users.save(
        users
      );
      await db.items.save(
        items
      );
      res.status(201).json({
        message:
          "Seller product created successfully",
        item:
          publicItem(
            newItem
          ),
      });
    } catch (error) {
      console.error(
        "Seller product creation error:",
        error
      );
      res.status(500).json({
        error:
          error.message ||
          "Unable to create seller product",
      });
    }
  }
);

// ============================================================
// SELLER — MY PRODUCTS
// ============================================================
// ============================================================
// SELLER — MY PRODUCTS
// ============================================================

app.get(
  "/api/seller/products",
  requireAuth,
  async (req, res) => {
    const items =
      await db.items.all();

    const myProducts =
      items.filter(
        (item) =>
          sellerOwnsProduct(
            item,
            req.user.id
          )
      );

    res.json(
      myProducts.map(
        publicItem
      )
    );
  }
);
  
    
app.put(
  "/api/items/:id",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const items =
      await db.items.all();

    const item =
      items.find(
        (i) =>
          i.id ===
          req.params.id
      );

    if (!item) {
      return res.status(404).json({
        error:
          "Item not found",
      });
    }

    const {
      name,
      description,
      price,
      tonyixProductId,
      image,
      imageUrl,
      categoryId,
      inStock,
      accessLinks,
      accessLink,
      quantity,
    } = req.body;

    if (
      name !== undefined
    )
      item.name = name;

    if (
      description !==
      undefined
    )
      item.description =
        description;

    if (
      price !== undefined
    )
      item.price =
        Number(price);

    if (
      imageUrl !==
      undefined
    )
      item.imageUrl =
        imageUrl;
    else if (
      image !== undefined
    )
      item.imageUrl =
        image;

    if (
      categoryId !==
      undefined
    )
      item.categoryId =
        categoryId;

    if (
      inStock !==
      undefined
    )
      item.inStock =
        inStock;

    if (
      accessLinks !==
      undefined &&
      Array.isArray(
        accessLinks
      )
    ) {
      item.accessLinks =
        accessLinks
          .map((x) =>
            String(x).trim()
          )
          .filter(Boolean);
    }

    if (
      accessLink !==
      undefined
    )
      item.accessLink =
        accessLink;

    if (
      quantity !==
      undefined
    )
      item.quantity =
        Number(quantity);

    if (
      tonyixProductId !==
      undefined
    )
      item.tonyixProductId =
        tonyixProductId != null
          ? Number(
              tonyixProductId
            )
          : null;

    await db.items.save(
      items
    );

    res.json(item);
  }
);

// ============================================================
// ADD CREDENTIALS
// ============================================================

app.post(
  "/api/items/:id/add-access-links",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const {
      credentials,
    } = req.body;

    if (
      !Array.isArray(
        credentials
      ) ||
      credentials.filter(Boolean)
        .length === 0
    ) {
      return res.status(400).json({
        error:
          "At least one credential is required",
      });
    }

    const items =
      await db.items.all();

    const item =
      items.find(
        (i) =>
          i.id ===
          req.params.id
      );

    if (!item) {
      return res.status(404).json({
        error:
          "Item not found",
      });
    }

    if (
      !Array.isArray(
        item.accessLinks
      )
    ) {
      item.accessLinks =
        [];
    }

    const cleaned =
      credentials
        .map((c) =>
          String(c).trim()
        )
        .filter(Boolean);

    item.accessLinks.push(
      ...cleaned
    );

    item.quantity =
      item.accessLinks.length;

    item.inStock = true;

    await db.items.save(
      items
    );

    res.json({
      message:
        `Added ${cleaned.length} credential(s)`,

      stockCount:
        item.accessLinks.length,
    });
  }
);

// ============================================================
// TOGGLE STOCK
// ============================================================

app.post(
  "/api/items/:id/toggle-stock",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const items =
      await db.items.all();

    const item =
      items.find(
        (i) =>
          i.id ===
          req.params.id
      );

    if (!item) {
      return res.status(404).json({
        error:
          "Item not found",
      });
    }

    item.inStock =
      !item.inStock;

    await db.items.save(
      items
    );

    res.json(item);
  }
);

// ============================================================
// DELETE ITEM
// ============================================================

app.delete(
  "/api/items/:id",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const items =
      await db.items.all();

    const item =
      items.find(
        (i) =>
          i.id ===
          req.params.id
      );

    if (!item) {
      return res.status(404).json({
        error:
          "Item not found",
      });
    }

    const remaining =
      items.filter(
        (i) =>
          i.id !==
          req.params.id
      );

    await db.items.save(
      remaining
    );

    res.json({
      message:
        "Item deleted",
    });
  }
);

// ============================================================
// CATEGORIES
// ============================================================

const DEFAULT_CATEGORIES = [
  {
    name:
      "Social Media Growth",
    description:
      "Followers, likes, views and engagement boosts",
    icon: "Shield",
  },
  {
    name:
      "Buy Account",
    description:
      "Verified, ready-to-use social media accounts",
    icon: "Shield",
  },
  {
    name: "Other",
    description:
      "Everything else",
    icon: "Shield",
  },
];

app.get(
  "/api/categories",
  async (req, res) => {
    let categories =
      await db.categories.all();

    if (
      categories.length ===
      0
    ) {
      categories =
        DEFAULT_CATEGORIES.map(
          (c) => ({
            id:
              crypto.randomUUID(),
            ...c,
            createdAt:
              new Date().toISOString(),
          })
        );

      await db.categories.save(
        categories
      );
    }

    res.json(categories);
  }
);

app.post(
  "/api/categories",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const {
      name,
      description,
      icon,
    } = req.body;

    if (
      !name ||
      !name.trim()
    ) {
      return res.status(400).json({
        error:
          "name is required",
      });
    }

    const categories =
      await db.categories.all();

    const newCategory = {
      id:
        crypto.randomUUID(),

      name:
        name.trim(),

      description:
        description || "",

      icon:
        icon || "Shield",

      createdAt:
        new Date().toISOString(),
    };

    categories.push(
      newCategory
    );

    await db.categories.save(
      categories
    );

    res.status(201).json(
      newCategory
    );
  }
);

app.put(
  "/api/categories/:id",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const categories =
      await db.categories.all();

    const category =
      categories.find(
        (c) =>
          c.id ===
          req.params.id
      );

    if (!category) {
      return res.status(404).json({
        error:
          "Category not found",
      });
    }

    const {
      name,
      description,
      icon,
    } = req.body;

    if (
      name !== undefined
    )
      category.name =
        name;

    if (
      description !==
      undefined
    )
      category.description =
        description;

    if (
      icon !== undefined
    )
      category.icon =
        icon;

    await db.categories.save(
      categories
    );

    res.json(category);
  }
);

app.delete(
  "/api/categories/:id",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const categories =
      await db.categories.all();

    const category =
      categories.find(
        (c) =>
          c.id ===
          req.params.id
      );

    if (!category) {
      return res.status(404).json({
        error:
          "Category not found",
      });
    }

    const remaining =
      categories.filter(
        (c) =>
          c.id !==
          req.params.id
      );

    await db.categories.save(
      remaining
    );

    res.json({
      message:
        "Category deleted",
    });
  }
);

// ============================================================
// WALLET — INSTANT PAYSTACK DEPOSIT
// ============================================================

app.post(
  "/api/wallet/deposit/instant/initialize",
  requireAuth,
  async (req, res) => {
    const {
      amount,
    } = req.body;

    const amountNumber =
      Number(amount);

    if (
      !Number.isFinite(
        amountNumber
      ) ||
      amountNumber <= 0
    ) {
      return res.status(400).json({
        error:
          "A positive amount is required",
      });
    }

    const users =
      await db.users.all();

    const user =
      users.find(
        (u) =>
          u.id ===
          req.user.id
      );

    if (!user) {
      return res.status(404).json({
        error:
          "User not found",
      });
    }

    const reference =
      `dep_${crypto.randomUUID()}`;

    try {
      const paystackData =
        await initializeTransaction(
          {
            email:
              user.email,

            amountNaira:
              amountNumber,

            reference,

            callback_url:
              process.env
                .PAYSTACK_CALLBACK_URL,
          }
        );

      const deposits =
        await db.deposits.all();

      deposits.push({
        id:
          crypto.randomUUID(),

        userId:
          user.id,

        amount:
          amountNumber,

        method:
          "instant",

        status:
          "pending",

        reference,

        createdAt:
          new Date().toISOString(),
      });

      await db.deposits.save(
        deposits
      );

      res.status(201).json({
        authorizationUrl:
          paystackData.authorization_url,

        reference,
      });
    } catch (err) {
      console.error(
        "Paystack initialize error:",
        err
      );

      res.status(502).json({
        error:
          err.message ||
          "Unable to initialize payment",
      });
    }
  }
);

// ============================================================
// VERIFY PAYSTACK PAYMENT
// ============================================================

app.get(
  "/api/wallet/deposit/instant/verify/:reference",
  requireAuth,
  async (req, res) => {
    try {
      const result =
        await verifyTransaction(
          req.params.reference
        );

      if (
        result.status ===
        "success"
      ) {
        await creditDepositByReference(
          req.params.reference,
          result.amount / 100
        );
      }

      const users =
        await db.users.all();

      const user =
        users.find(
          (u) =>
            u.id ===
            req.user.id
        );

      if (!user) {
        return res.status(404).json({
          error:
            "User not found",
        });
      }

      res.json({
        paymentStatus:
          result.status,

        walletBalance:
          user.walletBalance,
      });
    } catch (err) {
      console.error(
        "Paystack verification error:",
        err
      );

      res.status(502).json({
        error:
          err.message ||
          "Payment verification failed",
      });
    }
  }
);

// ============================================================
// MANUAL DEPOSIT
// ============================================================

app.post(
  "/api/wallet/deposit/manual",
  requireAuth,
  upload.single(
    "screenshot"
  ),
  async (req, res) => {
    const amount =
      Number(
        req.body.amount
      );

    if (
      !Number.isFinite(
        amount
      ) ||
      amount <= 0
    ) {
      return res.status(400).json({
        error:
          "A positive amount is required",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error:
          "A payment screenshot is required",
      });
    }

    let screenshotUrl;

    try {
      screenshotUrl =
        await uploadScreenshot(
          req.file
        );
    } catch (err) {
      console.error(err);

      return res.status(502).json({
        error:
          "Could not upload screenshot. Please try again.",
      });
    }

    const deposits =
      await db.deposits.all();

    const deposit = {
      id:
        crypto.randomUUID(),

      userId:
        req.user.id,

      amount,

      method:
        "manual",

      status:
        "pending",

      screenshotUrl,

      createdAt:
        new Date().toISOString(),
    };

    deposits.push(
      deposit
    );

    await db.deposits.save(
      deposits
    );

    res.status(201).json(
      deposit
    );
  }
);

// ============================================================
// CUSTOMER DEPOSITS
// ============================================================

app.get(
  "/api/wallet/deposits",
  requireAuth,
  async (req, res) => {
    const deposits =
      (
        await db.deposits.all()
      ).filter(
        (d) =>
          d.userId ===
          req.user.id
      );

    res.json(deposits);
  }
);

// ============================================================
// ADMIN DEPOSITS
// ============================================================

app.get(
  "/api/admin/deposits",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    let deposits =
      await db.deposits.all();

    if (req.query.status) {
      deposits =
        deposits.filter(
          (d) =>
            d.status ===
            req.query.status
        );
    }

    res.json(deposits);
  }
);

// ============================================================
// APPROVE MANUAL DEPOSIT
// ============================================================

app.post(
  "/api/admin/deposits/:id/approve",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const deposits =
      await db.deposits.all();

    const deposit =
      deposits.find(
        (d) =>
          d.id ===
          req.params.id
      );

    if (!deposit) {
      return res.status(404).json({
        error:
          "Deposit not found",
      });
    }

    if (
      deposit.status !==
      "pending"
    ) {
      return res.status(400).json({
        error:
          `Deposit already ${deposit.status}`,
      });
    }

    deposit.status =
      "completed";

    await db.deposits.save(
      deposits
    );

    const users =
      await db.users.all();

    const user =
      users.find(
        (u) =>
          u.id ===
          deposit.userId
      );

    if (!user) {
      return res.status(404).json({
        error:
          "User not found",
      });
    }

    user.walletBalance =
      Number(
        user.walletBalance || 0
      ) +
      Number(
        deposit.amount || 0
      );

    await db.users.save(
      users
    );

    res.json({
      deposit,

      newBalance:
        user.walletBalance,
    });
  }
);

// ============================================================
// REJECT MANUAL DEPOSIT
// ============================================================

app.post(
  "/api/admin/deposits/:id/reject",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const deposits =
      await db.deposits.all();

    const deposit =
      deposits.find(
        (d) =>
          d.id ===
          req.params.id
      );

    if (!deposit) {
      return res.status(404).json({
        error:
          "Deposit not found",
      });
    }

    if (
      deposit.status !==
      "pending"
    ) {
      return res.status(400).json({
        error:
          `Deposit already ${deposit.status}`,
      });
    }

    deposit.status =
      "rejected";

    await db.deposits.save(
      deposits
    );

    res.json({
      deposit,
    });
  }
);

// ============================================================
// PURCHASE
// ============================================================

app.post(
  "/api/purchase",
  requireAuth,
  async (req, res) => {
    try {
      const {
        itemId,
        quantity,
      } = req.body;

      if (!itemId) {
        return res.status(400).json({
          error:
            "itemId is required",
        });
      }

      const qtyToBuy =
        quantity != null
          ? Number(quantity)
          : 1;

      if (
        !Number.isInteger(
          qtyToBuy
        ) ||
        qtyToBuy < 1
      ) {
        return res.status(400).json({
          error:
            "Quantity must be a positive whole number",
        });
      }

      const items =
        await db.items.all();

      const item =
        items.find(
          (i) =>
            i.id ===
            itemId
        );

      if (!item) {
        return res.status(404).json({
          error:
            "Item not found",
        });
      }

      // ============================================================
      // TONYIX PRODUCT PURCHASE
      // ============================================================

      if (
        item.tonyixProductId
      ) {
        const users =
          await db.users.all();

        const user =
          users.find(
            (u) =>
              u.id ===
              req.user.id
          );

        if (!user) {
          return res.status(404).json({
            error:
              "User not found",
          });
        }

        const totalPrice =
          Number(item.price) *
          qtyToBuy;

        if (
          Number(
            user.walletBalance ||
              0
          ) <
          totalPrice
        ) {
          return res.status(400).json({
            error:
              "Insufficient wallet balance",
          });
        }

        const tonyixResult =
          await tonyixPurchase(
            item.tonyixProductId,
            qtyToBuy
          );

        if (
          !tonyixResult ||
          tonyixResult.success ===
            false
        ) {
          return res.status(502).json({
            error:
              tonyixResult?.message ||
              tonyixResult?.msg ||
              "Tonyix could not complete the order",
          });
        }

        user.walletBalance =
          Number(
            user.walletBalance ||
              0
          ) -
          totalPrice;

        if (
          !Array.isArray(
            user.purchasedItemIds
          )
        ) {
          user.purchasedItemIds =
            [];
        }

        if (
          !user.purchasedItemIds.includes(
            item.id
          )
        ) {
          user.purchasedItemIds.push(
            item.id
          );
        }

        const purchases =
          await db.purchases.all();

        const tonyixOrderId =
          tonyixResult
            ?.data
            ?.order_id ||
          null;

        const deliveredItems =
          Array.isArray(
            tonyixResult
              ?.data
              ?.items
          )
            ? tonyixResult.data.items.map(
                (product) => ({
                  productName:
                    product.product_name ||
                    null,

                  details:
                    product.details ||
                    null,

                  url:
                    product.url ||
                    null,
                })
              )
            : [];

        purchases.push({
          id:
            crypto.randomUUID(),

          itemId:
            item.id,

          buyerId:
            user.id,

          buyerName:
            user.name,

          buyerEmail:
            user.email,

          price:
            totalPrice,

          quantity:
            qtyToBuy,

          tonyixOrderId,

          assignedCredentials:
            deliveredItems,

          createdAt:
            new Date().toISOString(),
        });

        await db.users.save(
          users
        );

        await db.purchases.save(
          purchases
        );

        return res.json({
          message:
            "Purchase successful",

          orderId:
            tonyixOrderId,

          item: {
            ...publicItem(item),
            assignedCredentials:
              deliveredItems,
          },

          newBalance:
            user.walletBalance,

          tonyix:
            tonyixResult,
        });
      }

      // ============================================================
      // NORMAL DEEDEE PRODUCT PURCHASE
      // ============================================================

      if (
        item.inStock === false
      ) {
        return res.status(400).json({
          error:
            "This item is currently out of stock",
        });
      }

      const availableQty =
        stockCountOf(item);

      if (
        availableQty <
        qtyToBuy
      ) {
        return res.status(400).json({
          error:
            `Only ${availableQty} left in stock`,
        });
      }

      const users =
        await db.users.all();

      const user =
        users.find(
          (u) =>
            u.id ===
            req.user.id
        );

      if (!user) {
        return res.status(404).json({
          error:
            "User not found",
        });
      }

      const purchases =
        await db.purchases.all();

      // ============================================================
      // REFERRAL ELIGIBILITY
      // ============================================================

      const isFirstPurchase =
        !purchases.some(
          (p) =>
            p.buyerId ===
            user.id
        );

      const eligibleForReferralDiscount =
        isFirstPurchase &&
        !!user.referredBy &&
        !user.referralRewardProcessed;

      let totalPrice =
        Number(item.price) *
        qtyToBuy;

      let discountApplied = 0;

      // ============================================================
      // 5% FIRST PURCHASE REFERRAL DISCOUNT
      // ============================================================

      if (
        eligibleForReferralDiscount
      ) {
        discountApplied =
          Math.round(
            totalPrice *
              0.05
          );

        totalPrice -=
          discountApplied;
      }

      if (
        Number(
          user.walletBalance ||
            0
        ) <
        totalPrice
      ) {
        return res.status(400).json({
          error:
            "Insufficient wallet balance",
        });
      }

      user.walletBalance =
        Number(
          user.walletBalance ||
            0
        ) -
        totalPrice;

      if (
        !Array.isArray(
          user.purchasedItemIds
        )
      ) {
        user.purchasedItemIds =
          [];
      }

      if (
        !user.purchasedItemIds.includes(
          item.id
        )
      ) {
        user.purchasedItemIds.push(
          item.id
        );
      }

      let assignedCredentials =
        [];

      if (
        Array.isArray(
          item.accessLinks
        ) &&
        item.accessLinks
          .length > 0
      ) {
        assignedCredentials =
          item.accessLinks.splice(
            0,
            qtyToBuy
          );

        item.quantity =
          item.accessLinks.length;
      } else if (
        item.quantity != null
      ) {
        item.quantity =
          Math.max(
            0,
            Number(
              item.quantity
            ) -
              qtyToBuy
          );

        if (
          item.accessLink
        ) {
          assignedCredentials =
            Array(
              qtyToBuy
            ).fill(
              item.accessLink
            );
        }
      } else {
        item.sold = true;
      }

      // ============================================================
      // REFERRAL REWARD
      // ============================================================

      if (
        eligibleForReferralDiscount
      ) {
        const referrer =
          users.find(
            (u) =>
              u.id ===
              user.referredBy
          );

        if (referrer) {
          // Prevent this referral reward
          // from ever being processed twice.
          user.referralRewardProcessed =
            true;

          // Give the referrer ₦500.
          referrer.walletBalance =
            Number(
              referrer.walletBalance ||
                0
            ) + 500;
        }
      }

      await db.users.save(
        users
      );

      await db.items.save(
        items
      );

      purchases.push({
        id:
          crypto.randomUUID(),

        itemId:
          item.id,

        buyerId:
          user.id,

        buyerName:
          user.name,

        buyerEmail:
          user.email,

        price:
          totalPrice,

        quantity:
          qtyToBuy,

        assignedCredentials,

        referralDiscountApplied:
          discountApplied ||
          undefined,

        createdAt:
          new Date().toISOString(),
      });

      await db.purchases.save(
        purchases
      );

      return res.json({
        message:
          "Purchase successful",

        item: {
          ...publicItem(item),

          assignedCredentials,

          accessLink:
            assignedCredentials[0] ||
            null,
        },

        newBalance:
          user.walletBalance,

        discountApplied,
      });
    } catch (error) {
      console.error(
        "Purchase error:",
        error
      );

      return res.status(500).json({
        error:
          error.message ||
          "Unable to complete purchase",
      });
    }
  }
);

// ============================================================
// ADMIN SALES
// ============================================================

app.get(
  "/api/admin/sales",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const [
      purchases,
      items,
    ] =
      await Promise.all([
        db.purchases.all(),
        db.items.all(),
      ]);

    const sales =
      purchases.map(
        (p) => {
          const item =
            items.find(
              (i) =>
                i.id ===
                p.itemId
            );

          return {
            ...(item
              ? publicItem(item)
              : {}),

            id:
              p.id,

            price:
              p.price,

            quantity:
              p.quantity || 1,

            buyerName:
              p.buyerName,

            buyerEmail:
              p.buyerEmail,

            createdAt:
              p.createdAt,
          };
        }
      );

    res.json(sales);
  }
);

// ============================================================
// SUPPORT TICKETS
// ============================================================

app.post(
  "/api/support/tickets",
  async (req, res) => {
    const {
      name,
      email,
      subject,
      message,
    } = req.body;

    if (
      !name ||
      !email ||
      !subject ||
      !message
    ) {
      return res.status(400).json({
        error:
          "name, email, subject and message are required",
      });
    }

    const tickets =
      await db.tickets.all();

    const newTicket = {
      id:
        crypto.randomUUID(),

      name,

      email,

      subject,

      message,

      status:
        "open",

      replies: [],

      createdAt:
        new Date().toISOString(),
    };

    tickets.push(
      newTicket
    );

    await db.tickets.save(
      tickets
    );

    res.status(201).json(
      newTicket
    );
  }
);

// ============================================================
// ADMIN SUPPORT TICKETS
// ============================================================

app.get(
  "/api/admin/support/tickets",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const tickets =
      await db.tickets.all();

    tickets.sort(
      (a, b) =>
        new Date(
          b.createdAt
        ) -
        new Date(
          a.createdAt
        )
    );

    res.json(tickets);
  }
);

app.post(
  "/api/admin/support/tickets/:id/reply",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const {
      message,
    } = req.body;

    if (
      !message ||
      !message.trim()
    ) {
      return res.status(400).json({
        error:
          "message is required",
      });
    }

    const tickets =
      await db.tickets.all();

    const ticket =
      tickets.find(
        (t) =>
          t.id ===
          req.params.id
      );

    if (!ticket) {
      return res.status(404).json({
        error:
          "Ticket not found",
      });
    }

    if (
      !Array.isArray(
        ticket.replies
      )
    ) {
      ticket.replies =
        [];
    }

    ticket.replies.push({
      message:
        message.trim(),

      createdAt:
        new Date().toISOString(),
    });

    await db.tickets.save(
      tickets
    );

    res.json(ticket);
  }
);

app.post(
  "/api/admin/support/tickets/:id/status",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const {
      status,
    } = req.body;

    if (
      ![
        "open",
        "resolved",
      ].includes(status)
    ) {
      return res.status(400).json({
        error:
          'status must be "open" or "resolved"',
      });
    }

    const tickets =
      await db.tickets.all();

    const ticket =
      tickets.find(
        (t) =>
          t.id ===
          req.params.id
      );

    if (!ticket) {
      return res.status(404).json({
        error:
          "Ticket not found",
      });
    }

    ticket.status =
      status;

    await db.tickets.save(
      tickets
    );

    res.json(ticket);
  }
);

// ============================================================
// SELLER SUBSCRIPTION PAYMENT
// ============================================================

// Return the available seller plans.
app.get(
  "/api/seller/plans",
  async (req, res) => {
    try {
      return res.json({
        plans: Object.values(
          SELLER_PLANS
        ),
      });
    } catch (error) {
      console.error(
        "Seller plans error:",
        error
      );

      return res.status(500).json({
        error:
          "Unable to load seller plans",
      });
    }
  }
);

// Start a seller subscription payment.
app.post(
  "/api/seller/subscription/initialize",
  requireAuth,
  async (req, res) => {
    try {
      const {
        planId,
      } = req.body;

      const plan =
        SELLER_PLANS[planId];

      if (!plan) {
        return res.status(400).json({
          error:
            "Invalid seller plan",
        });
      }

      const users =
        await db.users.all();

      const user =
        users.find(
          (u) =>
            u.id ===
            req.user.id
        );

      if (!user) {
        return res.status(404).json({
          error:
            "User not found",
        });
      }

      if (!user.email) {
        return res.status(400).json({
          error:
            "A valid email address is required before purchasing a seller plan",
        });
      }

      const reference =
        `SELLER-${user.id}-${plan.id}-${Date.now()}`;

      const payment =
        await initializeTransaction({
          email: user.email,
          amountNaira:
            plan.price,
          reference,
          callback_url:
            `${FRONTEND_URL}/seller/subscription/callback`,
        });

      return res.json({
        success: true,

        plan: {
          id: plan.id,
          name: plan.name,
          price: plan.price,
          currency: plan.currency,
          billing: plan.billing,
        },

        reference:
          payment.reference,

        authorization_url:
          payment.authorization_url,

        access_code:
          payment.access_code,
      });
    } catch (error) {
      console.error(
        "Seller subscription initialization error:",
        error
      );

      return res.status(500).json({
        error:
          error.message ||
          "Unable to initialize seller subscription payment",
      });
    }
  }
);

// Verify seller subscription payment
// and activate the purchased plan.
app.post(
  "/api/seller/subscription/verify",
  requireAuth,
  async (req, res) => {
    try {
      const {
        reference,
      } = req.body;

      if (!reference) {
        return res.status(400).json({
          error:
            "Payment reference is required",
        });
      }

      const payment =
        await verifyTransaction(
          reference
        );

      if (
        payment.status !==
        "success"
      ) {
        return res.status(400).json({
          error:
            "Seller subscription payment was not successful",
        });
      }

      const users =
        await db.users.all();

      const user =
        users.find(
          (u) =>
            u.id ===
            req.user.id
        );

      if (!user) {
        return res.status(404).json({
          error:
            "User not found",
        });
      }

      // Make sure this payment belongs
      // to a seller subscription.
      if (
        !reference.startsWith(
          `SELLER-${user.id}-`
        )
      ) {
        return res.status(403).json({
          error:
            "This payment does not belong to this seller account",
        });
      }

      const parts =
        reference.split("-");

      const planId =
        parts.slice(2, -1).join("-");

      const plan =
        SELLER_PLANS[planId];

      if (!plan) {
        return res.status(400).json({
          error:
            "Unable to determine seller plan from payment",
        });
      }

      const expectedAmount =
        Math.round(
          plan.price * 100
        );

      if (
        Number(payment.amount) !==
        expectedAmount
      ) {
        return res.status(400).json({
          error:
            "Payment amount does not match the selected seller plan",
        });
      }

      // Prevent the same Paystack reference
      // from being used more than once.
      if (
        user.sellerSubscriptionReference ===
        reference &&
        user.sellerPlanStatus ===
        "active"
      ) {
        return res.json({
          success: true,
          alreadyActivated: true,
          plan: {
            id: plan.id,
            name: plan.name,
            billing: plan.billing,
          },
        });
      }

      const now =
        Date.now();

      let expiresAt =
        null;

      if (
        plan.billing ===
        "monthly"
      ) {
        expiresAt =
          new Date(
            now
          );

        expiresAt.setMonth(
          expiresAt.getMonth() +
            1
        );

        expiresAt =
          expiresAt.getTime();
      }

      if (
        plan.billing ===
        "yearly"
      ) {
        expiresAt =
          new Date(
            now
          );

        expiresAt.setFullYear(
          expiresAt.getFullYear() +
            1
        );

        expiresAt =
          expiresAt.getTime();
      }

      user.isSeller =
        true;

      user.sellerPlan =
        plan.id;

      user.sellerPlanStatus =
        "active";

      user.sellerPlanExpiresAt =
        expiresAt;

      user.sellerSubscriptionReference =
        reference;

      await db.users.save(
        users
      );

      return res.json({
        success: true,

        message:
          "Seller subscription activated successfully",

        plan: {
          id: plan.id,
          name: plan.name,
          price: plan.price,
          currency: plan.currency,
          billing: plan.billing,
          expiresAt,
          features:
            plan.features,
        },

        user:
          publicUser(user),
      });
    } catch (error) {
      console.error(
        "Seller subscription verification error:",
        error
      );

      return res.status(500).json({
        error:
          error.message ||
          "Unable to verify seller subscription payment",
      });
    }
  }
);

// Get the current seller subscription.
app.get(
  "/api/seller/subscription",
  requireAuth,
  async (req, res) => {
    try {
      const user =
        await getCurrentSellerUser(
          req
        );

      if (!user) {
        return res.status(404).json({
          error:
            "User not found",
        });
      }

      const plan =
        getSellerPlan(user);

      return res.json({
        isSeller:
          !!user.isSeller,

        plan: plan
          ? {
              id: plan.id,
              name: plan.name,
              price: plan.price,
              currency:
                plan.currency,
              billing:
                plan.billing,
              features:
                plan.features,
            }
          : null,

        status:
          user.sellerPlanStatus ||
          "inactive",

        expiresAt:
          user.sellerPlanExpiresAt ||
          null,

        subscriptionReference:
          user.sellerSubscriptionReference ||
          null,
        subscriptionReference:
  user.sellerSubscriptionReference ||
  null,
isSellerFrozen:
  user.sellerPlanStatus === "frozen",
freezeReason:
  user.sellerFreezeReason || "",
frozenAt:
  user.sellerFrozenAt || null,
renewalPaymentDetails:
  user.sellerPlanStatus === "frozen"
    ? SELLER_RENEWAL_PAYMENT_DETAILS
    : null,
        
      });
    } catch (error) {
      console.error(
        "Seller subscription status error:",
        error
      );

      return res.status(500).json({
        error:
          "Unable to load seller subscription",
      });
    }
  }
);

// ============================================================
// START SERVER
// ============================================================

const PORT =
  process.env.PORT ||
  3001;

async function startServer() {
  try {
    await initDatabase();

    // Sync Tonyix products when backend starts.
    await syncTonyixProducts();

    // Refresh Tonyix products every 15 minutes.
    setInterval(
      syncTonyixProducts,
      15 * 60 * 1000
    );

    app.listen(
      PORT,
      () => {
        console.log(
          `Server running on http://localhost:${PORT}`
        );
      }
    );
  } catch (error) {
    console.error(
      "Failed to initialize database:",
      error
    );

    process.exit(1);
  }
}

startServer();
