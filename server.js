// ============================================================
// INVOIFY BACKEND — server.js
// Node.js + Express + Supabase
// Run: node server.js
// ============================================================

const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

// ── CONFIG (replace with your real values) ──
const SUPABASE_URL = "YOUR_SUPABASE_URL";
const SUPABASE_SERVICE_KEY = "YOUR_SUPABASE_SERVICE_KEY";
const ADMIN_SECRET = "YOUR_ADMIN_SECRET_PASSWORD"; // protect admin routes
const PORT = 3000;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ============================================================
// MIDDLEWARE — Admin auth check
// ============================================================
const adminAuth = (req, res, next) => {
  const secret = req.headers["x-admin-secret"];
  if (secret !== ADMIN_SECRET) return res.status(401).json({ error: "Unauthorized" });
  next();
};

// ============================================================
// USER ROUTES
// ============================================================

// Track page visit
app.post("/api/track/visit", async (req, res) => {
  const { page, country, userAgent } = req.body;
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  await supabase.from("visits").insert({
    page: page || "home",
    country: country || "unknown",
    ip: ip?.split(",")[0],
    user_agent: userAgent,
    created_at: new Date().toISOString(),
  });
  res.json({ ok: true });
});

// Track invoice generated
app.post("/api/track/invoice", async (req, res) => {
  const { userId, plan, currency, amount, lang, template } = req.body;
  await supabase.from("invoice_events").insert({
    user_id: userId,
    plan: plan || "free",
    currency,
    amount,
    lang,
    template,
    created_at: new Date().toISOString(),
  });
  res.json({ ok: true });
});

// Register user
app.post("/api/auth/register", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: "Missing fields" });
  const hash = crypto.createHash("sha256").update(password).digest("hex");
  const { data, error } = await supabase.from("users").insert({
    name, email,
    password_hash: hash,
    plan: "free",
    created_at: new Date().toISOString(),
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true, user: { id: data.id, name: data.name, email: data.email, plan: data.plan } });
});

// Login user
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  const hash = crypto.createHash("sha256").update(password).digest("hex");
  const { data, error } = await supabase.from("users")
    .select("*").eq("email", email).eq("password_hash", hash).single();
  if (error || !data) return res.status(401).json({ error: "Invalid credentials" });
  // Update last login
  await supabase.from("users").update({ last_login: new Date().toISOString() }).eq("id", data.id);
  res.json({ ok: true, user: { id: data.id, name: data.name, email: data.email, plan: data.plan, picture: data.picture } });
});

// Claim a license key
app.post("/api/key/claim", async (req, res) => {
  const { userId, key } = req.body;
  if (!userId || !key) return res.status(400).json({ error: "Missing fields" });

  const { data: keyData, error } = await supabase.from("license_keys")
    .select("*").eq("key", key.toUpperCase().trim()).single();

  if (error || !keyData) return res.status(404).json({ error: "Invalid key" });
  if (keyData.used) return res.status(400).json({ error: "This key has already been used" });
  if (keyData.expires_at && new Date(keyData.expires_at) < new Date()) {
    return res.status(400).json({ error: "This key has expired" });
  }

  // Mark key as used and upgrade user
  await supabase.from("license_keys").update({
    used: true, used_by: userId, used_at: new Date().toISOString()
  }).eq("key", key);

  const expiresAt = keyData.type === "lifetime" ? null :
    new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days

  await supabase.from("users").update({
    plan: keyData.plan,
    plan_expires_at: expiresAt,
    plan_type: keyData.type,
  }).eq("id", userId);

  res.json({ ok: true, plan: keyData.plan, type: keyData.type, message: `Activated! Enjoy ${keyData.plan.toUpperCase()} ${keyData.type === "lifetime" ? "lifetime" : "plan"}.` });
});

// ============================================================
// ADMIN ROUTES (protected)
// ============================================================

// Dashboard overview
app.get("/api/admin/overview", adminAuth, async (req, res) => {
  const [users, visits, invoices, keys, payments] = await Promise.all([
    supabase.from("users").select("id, plan, created_at"),
    supabase.from("visits").select("id, created_at, page, country"),
    supabase.from("invoice_events").select("id, created_at, plan, amount"),
    supabase.from("license_keys").select("id, used, type, plan"),
    supabase.from("payments").select("id, amount, plan, status, created_at"),
  ]);

  const today = new Date().toISOString().split("T")[0];
  const thisMonth = new Date().toISOString().substring(0, 7);

  const totalUsers = users.data?.length || 0;
  const proUsers = users.data?.filter(u => u.plan === "pro").length || 0;
  const maxUsers = users.data?.filter(u => u.plan === "max").length || 0;
  const todayVisits = visits.data?.filter(v => v.created_at?.startsWith(today)).length || 0;
  const totalVisits = visits.data?.length || 0;
  const totalInvoices = invoices.data?.length || 0;
  const todayInvoices = invoices.data?.filter(i => i.created_at?.startsWith(today)).length || 0;

  const confirmedPayments = payments.data?.filter(p => p.status === "confirmed") || [];
  const totalRevenue = confirmedPayments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const monthRevenue = confirmedPayments
    .filter(p => p.created_at?.startsWith(thisMonth))
    .reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);

  const keysUsed = keys.data?.filter(k => k.used).length || 0;
  const keysAvailable = keys.data?.filter(k => !k.used).length || 0;

  // Country breakdown
  const countryCounts = {};
  visits.data?.forEach(v => {
    if (v.country) countryCounts[v.country] = (countryCounts[v.country] || 0) + 1;
  });
  const topCountries = Object.entries(countryCounts)
    .sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([country, count]) => ({ country, count }));

  res.json({
    stats: {
      totalUsers, proUsers, maxUsers, freeUsers: totalUsers - proUsers - maxUsers,
      todayVisits, totalVisits, totalInvoices, todayInvoices,
      totalRevenue: totalRevenue.toFixed(2),
      monthRevenue: monthRevenue.toFixed(2),
      keysUsed, keysAvailable
    },
    topCountries,
    recentUsers: users.data?.slice(-10).reverse().map(u => ({ id: u.id, plan: u.plan, created_at: u.created_at })) || [],
  });
});

// Get all users
app.get("/api/admin/users", adminAuth, async (req, res) => {
  const { data, error } = await supabase.from("users")
    .select("id, name, email, plan, plan_type, created_at, last_login, plan_expires_at")
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ users: data });
});

// Update user plan (manual upgrade/downgrade)
app.patch("/api/admin/users/:id", adminAuth, async (req, res) => {
  const { id } = req.params;
  const { plan, plan_type, note } = req.body;
  const expiresAt = plan_type === "lifetime" ? null :
    new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await supabase.from("users").update({
    plan, plan_type: plan_type || "monthly",
    plan_expires_at: expiresAt,
    admin_note: note
  }).eq("id", id);
  res.json({ ok: true, message: `User ${id} updated to ${plan} (${plan_type})` });
});

// Delete user
app.delete("/api/admin/users/:id", adminAuth, async (req, res) => {
  await supabase.from("users").delete().eq("id", req.params.id);
  res.json({ ok: true });
});

// Generate license keys
app.post("/api/admin/keys/generate", adminAuth, async (req, res) => {
  const { plan = "pro", type = "monthly", count = 1, note = "" } = req.body;
  const keys = [];
  for (let i = 0; i < Math.min(count, 100); i++) {
    const key = [
      plan.toUpperCase(),
      crypto.randomBytes(3).toString("hex").toUpperCase(),
      crypto.randomBytes(3).toString("hex").toUpperCase(),
      crypto.randomBytes(3).toString("hex").toUpperCase(),
    ].join("-");
    keys.push({ key, plan, type, note, used: false, created_at: new Date().toISOString() });
  }
  const { data, error } = await supabase.from("license_keys").insert(keys).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, keys: data.map(k => k.key) });
});

// Get all keys
app.get("/api/admin/keys", adminAuth, async (req, res) => {
  const { data } = await supabase.from("license_keys")
    .select("*").order("created_at", { ascending: false });
  res.json({ keys: data || [] });
});

// Delete key
app.delete("/api/admin/keys/:id", adminAuth, async (req, res) => {
  await supabase.from("license_keys").delete().eq("id", req.params.id);
  res.json({ ok: true });
});

// Get payments / revenue
app.get("/api/admin/payments", adminAuth, async (req, res) => {
  const { data } = await supabase.from("payments")
    .select("*").order("created_at", { ascending: false });
  res.json({ payments: data || [] });
});

// Confirm payment manually
app.patch("/api/admin/payments/:id/confirm", adminAuth, async (req, res) => {
  const { userId, plan } = req.body;
  await supabase.from("payments").update({ status: "confirmed" }).eq("id", req.params.id);
  if (userId && plan) {
    await supabase.from("users").update({
      plan, plan_type: "monthly",
      plan_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    }).eq("id", userId);
  }
  res.json({ ok: true });
});

// Update payment status (approve / reject / processing)
app.patch("/api/admin/payments/:id/status", adminAuth, async (req, res) => {
  const { status, userId, plan } = req.body;
  await supabase.from("payments").update({ status, admin_reviewed_at: new Date().toISOString() }).eq("id", req.params.id);
  // If confirmed, activate user plan
  if (status === "confirmed" && userId && plan) {
    await supabase.from("users").update({
      plan, plan_type: "monthly",
      plan_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    }).eq("id", userId);
  }
  res.json({ ok: true, status });
});

// Customer submits manual payment with receipt
app.post("/api/payments/submit", async (req, res) => {
  const { userId, email, customerName, plan, amount, method, receiptNote, receiptUrl } = req.body;
  const { data, error } = await supabase.from("payments").insert({
    user_id: userId,
    email,
    customer_name: customerName,
    plan,
    amount,
    method: method || "Bank Transfer",
    receipt_note: receiptNote,
    receipt_url: receiptUrl,
    status: "pending",
    created_at: new Date().toISOString(),
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, paymentId: data.id, message: "Payment submitted. Admin will review within 24 hours." });
});

// Get visits / analytics
app.get("/api/admin/analytics", adminAuth, async (req, res) => {
  const { data: visits } = await supabase.from("visits")
    .select("created_at, page, country").order("created_at", { ascending: false }).limit(1000);
  const { data: invoices } = await supabase.from("invoice_events")
    .select("created_at, plan, currency").order("created_at", { ascending: false }).limit(1000);

  // Daily visits last 30 days
  const daily = {};
  const now = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now - i * 86400000).toISOString().split("T")[0];
    daily[d] = 0;
  }
  visits?.forEach(v => {
    const d = v.created_at?.split("T")[0];
    if (d && daily[d] !== undefined) daily[d]++;
  });

  res.json({
    dailyVisits: Object.entries(daily).map(([date, count]) => ({ date, count })),
    totalVisits: visits?.length || 0,
    invoicesByPlan: {
      free: invoices?.filter(i => i.plan === "free").length || 0,
      pro: invoices?.filter(i => i.plan === "pro").length || 0,
      max: invoices?.filter(i => i.plan === "max").length || 0,
    }
  });
});

app.listen(PORT, () => console.log(`Invoify backend running on port ${PORT}`));
