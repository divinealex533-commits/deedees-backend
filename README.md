# DeeDee's Marketplace — Backend (Accounts, Wallet, Purchases)

This backend gives your site:
- **Sign up / login** for customers
- **A wallet** — customers request a deposit, you (admin) approve it, their
  balance goes up
- **Buying items** — spends wallet balance, marks the item as theirs, shows
  up on their dashboard

It stores everything in JSON files under `data/` — no separate database
to install to get started.

## 1. Run it

Requires [Node.js](https://nodejs.org) 18+.

```bash
cd backend
npm install
cp .env.example .env
npm start
```

Visit http://localhost:3001 — you should see a status message.

**Important:** open `.env` and change `JWT_SECRET` to a long random string
before you put this online. This is what keeps login sessions secure.

**The first account that signs up automatically becomes the admin** — the
one who can add items and approve deposits. Sign up as yourself first.

## 2. The API

**Auth**
| Method | URL | Body | Notes |
|---|---|---|---|
| POST | `/api/auth/signup` | `{name, email, password}` | Returns `{token, user}` |
| POST | `/api/auth/login` | `{email, password}` | Returns `{token, user}` |
| GET | `/api/me` | — | Needs auth header. Returns profile + wallet + purchased items |

**Items**
| Method | URL | Notes |
|---|---|---|
| GET | `/api/items` | Public, list everything for sale |
| POST | `/api/items` | Admin only — add a new item |

**Wallet — instant payment (Paystack, automatic)**
| Method | URL | Notes |
|---|---|---|
| POST | `/api/wallet/deposit/instant/initialize` | `{amount}` — returns a checkout URL to send the customer to |
| GET | `/api/wallet/deposit/instant/verify/:reference` | Confirms payment and credits wallet (safety net alongside the webhook) |
| POST | `/api/webhooks/paystack` | Paystack calls this automatically — this is what actually credits the wallet in most cases |

**Wallet — manual payment (screenshot review)**
| Method | URL | Notes |
|---|---|---|
| POST | `/api/wallet/deposit/manual` | Multipart form: `amount` + `screenshot` file. Status starts "pending" |
| GET | `/api/wallet/deposits` | Customer's own deposit history (both methods) |
| GET | `/api/admin/deposits?status=pending` | Admin — see deposits, optionally filtered |
| POST | `/api/admin/deposits/:id/approve` | Admin — after checking the screenshot, credits the wallet |
| POST | `/api/admin/deposits/:id/reject` | Admin — e.g. screenshot is fake or unclear |


**Purchase**
| Method | URL | Notes |
|---|---|---|
| POST | `/api/purchase` | `{itemId}` — deducts balance, marks item sold |

Every route marked "needs auth header" requires this on the request:
```
Authorization: Bearer <token>
```
(the token you got back from signup/login)

## 3. Add this to your frontend

Paste this near the top of your site's JavaScript (or in a `<script>` tag).
It handles login, signup, loading items, depositing, and buying — using
`localStorage` to remember who's logged in.

```html
<script>
const API_URL = "http://localhost:3001"; // change after deploying, see step 5

// ---- helpers ----
function getToken() {
  return localStorage.getItem("token");
}

function saveSession(token, user) {
  localStorage.setItem("token", token);
  localStorage.setItem("user", JSON.stringify(user));
}

function logout() {
  localStorage.removeItem("token");
  localStorage.removeItem("user");
}

async function apiRequest(path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
      ...options.headers,
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

// ---- sign up ----
async function signup(name, email, password) {
  const data = await apiRequest("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ name, email, password }),
  });
  saveSession(data.token, data.user);
  return data.user;
}

// ---- log in ----
async function login(email, password) {
  const data = await apiRequest("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  saveSession(data.token, data.user);
  return data.user;
}

// ---- load items for the shop page ----
async function loadItems() {
  return apiRequest("/api/items");
}

// ---- load the logged-in customer's dashboard (wallet + purchases) ----
async function loadDashboard() {
  return apiRequest("/api/me");
}

// ---- instant deposit: sends the customer to Paystack to pay ----
async function startInstantDeposit(amount) {
  const data = await apiRequest("/api/wallet/deposit/instant/initialize", {
    method: "POST",
    body: JSON.stringify({ amount }),
  });
  window.location.href = data.authorizationUrl; // send them to pay
}

// ---- call this on your dashboard/callback page, after they return from paying ----
async function checkInstantDepositStatus(reference) {
  return apiRequest(`/api/wallet/deposit/instant/verify/${reference}`);
}

// ---- manual deposit: customer uploads a screenshot for you to review ----
async function submitManualDeposit(amount, fileInput) {
  const formData = new FormData();
  formData.append("amount", amount);
  formData.append("screenshot", fileInput.files[0]);

  const res = await fetch(`${API_URL}/api/wallet/deposit/manual`, {
    method: "POST",
    headers: { Authorization: `Bearer ${getToken()}` }, // no Content-Type — the browser sets it for FormData
    body: formData,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

// ---- buy an item ----
async function buyItem(itemId) {
  return apiRequest("/api/purchase", {
    method: "POST",
    body: JSON.stringify({ itemId }),
  });
}
</script>
```

### Wiring it to your buttons

Wherever your site has a "Buy" button on a product, call `buyItem`:

```html
<button onclick="handleBuy('ITEM_ID_HERE')">Buy now</button>

<script>
async function handleBuy(itemId) {
  try {
    const result = await buyItem(itemId);
    alert(`Purchased! New balance: ${result.newBalance}`);
  } catch (err) {
    alert(err.message); // e.g. "Insufficient wallet balance"
  }
}
</script>
```

For an instant-payment deposit button (redirects to Paystack):

```html
<input id="instantAmount" type="number" placeholder="Amount" />
<button onclick="handleInstantDeposit()">Pay now</button>

<script>
async function handleInstantDeposit() {
  const amount = Number(document.getElementById("instantAmount").value);
  try {
    await startInstantDeposit(amount); // this redirects the page to Paystack
  } catch (err) {
    alert(err.message);
  }
}
</script>
```

After Paystack redirects the customer back to your `PAYSTACK_CALLBACK_URL`
page, read the `reference` from the URL and confirm it:

```html
<script>
const params = new URLSearchParams(window.location.search);
const reference = params.get("reference");
if (reference) {
  checkInstantDepositStatus(reference).then((result) => {
    alert(`Payment ${result.paymentStatus}. Balance: ${result.walletBalance}`);
  });
}
</script>
```

For a manual deposit form (screenshot upload):

```html
<input id="manualAmount" type="number" placeholder="Amount" />
<input id="manualScreenshot" type="file" accept="image/*" />
<button onclick="handleManualDeposit()">Submit for review</button>

<script>
async function handleManualDeposit() {
  const amount = Number(document.getElementById("manualAmount").value);
  const fileInput = document.getElementById("manualScreenshot");
  try {
    await submitManualDeposit(amount, fileInput);
    alert("Screenshot submitted — you'll be credited once it's reviewed.");
  } catch (err) {
    alert(err.message);
  }
}
</script>
```

For the customer dashboard page:

```html
<div id="walletBalance"></div>
<div id="purchasedItems"></div>

<script>
loadDashboard().then((me) => {
  document.getElementById("walletBalance").textContent =
    `Balance: ${me.walletBalance}`;
  document.getElementById("purchasedItems").textContent =
    me.purchasedItems.map((i) => i.name).join(", ");
});
</script>
```

## 4. Where to paste this in Kimi

Kimi-built sites are usually plain HTML/JS pages. Look for an editor view
or "code" tab where you can see the page's `<script>` tags — paste the
integration script there, then add the `onclick` handlers to your existing
buy/deposit buttons. If Kimi doesn't expose raw HTML editing, tell me and
I can help you find another way (like exporting the site or adding a
custom code block, if the platform supports one).

## 5. Put it online

Same as before — push the `backend` folder to GitHub, deploy it on
[Render](https://render.com) or [Railway](https://railway.app) with the
start command `npm start`, set the `JWT_SECRET` environment variable in
their dashboard (don't commit your real `.env` file), then change
`API_URL` in your frontend script to the live URL you're given.

## 6. Setting up Paystack (for instant payments)

1. Create a free account at [paystack.com](https://paystack.com).
2. In the dashboard, go to **Settings → API Keys & Webhooks** and copy
   your **Secret Key** into `.env` as `PAYSTACK_SECRET_KEY`. Use the
   test key while developing.
3. On the same page, set your **Webhook URL** to
   `https://your-deployed-backend.com/api/webhooks/paystack` — this is
   what lets payments credit wallets automatically without you doing
   anything. (This only works once the backend is deployed with a public
   URL — it won't work on `localhost`.)
4. Set `PAYSTACK_CALLBACK_URL` in `.env` to a page on your frontend where
   customers should land after paying (e.g. your dashboard page).

## About the two deposit methods

**Instant payment:** the customer clicks pay, is sent to Paystack's
checkout page, and pays by card/bank/USSD. Paystack calls your webhook
the moment payment succeeds, which credits their wallet automatically —
no action needed from you. The "verify" endpoint is a backup in case the
webhook is ever delayed.

**Manual payment:** the customer pays you directly (e.g. bank transfer)
and uploads a screenshot as proof. It sits as "pending" until you open
`/api/admin/deposits?status=pending`, look at the screenshot (served
from `/uploads/...`), and approve or reject it. Nothing is credited
automatically — you're the one confirming the payment really happened.
