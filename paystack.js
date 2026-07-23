// Small wrapper around the Paystack API.
// Docs: https://paystack.com/docs/payments/accept-payments/

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE = "https://api.paystack.co";

function authHeaders() {
  return {
    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
    "Content-Type": "application/json",
  };
}

// Start a payment. Returns a checkout URL to redirect/open for the customer.
export async function initializeTransaction({ email, amountNaira, reference, callback_url }) {
  const res = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      email,
      amount: Math.round(amountNaira * 100), // Paystack expects kobo
      reference,
      callback_url,
    }),
  });
  const data = await res.json();
  if (!data.status) throw new Error(data.message || "Could not start payment");
  return data.data; // { authorization_url, access_code, reference }
}

// Confirm a payment actually succeeded before crediting a wallet.
export async function verifyTransaction(reference) {
  const res = await fetch(`${PAYSTACK_BASE}/transaction/verify/${reference}`, {
    headers: authHeaders(),
  });
  const data = await res.json();
  if (!data.status) throw new Error(data.message || "Could not verify payment");
  return data.data; // { status: "success" | ..., amount, reference, ... }
}
