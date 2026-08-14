import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.warn("WARNING: JWT_SECRET is not set in environment variables.");
}

export function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

export function checkPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

export function createToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      isAdmin: !!user.isAdmin,
    },
    JWT_SECRET || "temporary-dev-secret",
    { expiresIn: "7d" }
  );
}

// Creates a cryptographically secure password-reset token.
// The raw token is sent to the user's email.
// Only the SHA-256 hash is stored in the database.
export function createPasswordResetToken() {
  const token = crypto.randomBytes(32).toString("hex");

  const tokenHash = crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");

  return {
    token,
    tokenHash,
  };
}

// Middleware: require a logged-in user.
// Reads "Authorization: Bearer <token>"
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ")
    ? header.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({ error: "Not logged in" });
  }

  try {
    const payload = jwt.verify(
      token,
      JWT_SECRET || "temporary-dev-secret"
    );

    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({
      error: "Invalid or expired session",
    });
  }
}

// Middleware: require an admin account
export function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) {
    return res.status(403).json({
      error: "Admin access required",
    });
  }

  next();
}
