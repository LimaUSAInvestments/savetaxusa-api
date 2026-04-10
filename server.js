/**
 * SaveTaxUSA — Stripe Backend Server
 * ====================================
 * Full subscription lifecycle management:
 *   - Create customers + subscriptions
 *   - Handle 3D Secure / SCA payment confirmation
 *   - Webhook listener (paid, failed, cancelled, updated)
 *   - Customer Portal (self-serve cancel / upgrade / billing)
 *   - Health check endpoint
 *
 * Deploy to Render.com (free) or any Node host.
 * Set env vars in your host dashboard — never commit .env to git.
 */

require("dotenv").config();
const express   = require("express");
const stripe    = require("stripe")(process.env.STRIPE_SECRET_KEY);
const cors      = require("cors");
const helmet    = require("helmet");
const morgan    = require("morgan");
const crypto    = require("crypto");
const { createClient } = require("@supabase/supabase-js");

// ─── Supabase admin client (uses service_role key — never expose this!) ───────
const SUPABASE_URL = process.env.SUPABASE_URL || "https://aonzignujpwjekmnlslg.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

const supabase = SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  : null;

// ─── Resend Email Client ─────────────────────────────────────────────────────
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const FROM_EMAIL     = process.env.FROM_EMAIL || "reminders@savetaxusa.com";

async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) { console.log("⚠️ No Resend key — email skipped"); return; }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
    });
    const data = await res.json();
    if (res.ok) console.log(`✅ Email sent to ${to}: ${data.id}`);
    else console.error(`❌ Email failed to ${to}:`, data);
    return data;
  } catch(e) {
    console.error("Email send error:", e.message);
  }
}

// ─── IRS Quarterly Dates ──────────────────────────────────────────────────────
const QUARTERLY_DATES = [
  { q:"Q1", due:"April 15",    month:3,  day:15 },
  { q:"Q2", due:"June 16",     month:5,  day:16 },
  { q:"Q3", due:"September 15",month:8,  day:15 },
  { q:"Q4", due:"January 15",  month:0,  day:15 },
];

function daysUntil(month, day) {
  const now  = new Date();
  const year = now.getFullYear();
  let target = new Date(year, month, day);
  if (target < now) target = new Date(year + 1, month, day);
  return Math.ceil((target - now) / (1000 * 60 * 60 * 24));
}

const REMINDER_DAYS = [7, 1]; // Send exactly 7 days and 1 day before deadline

function getQuartersDueForReminder() {
  const results = [];
  for (const q of QUARTERLY_DATES) {
    const d = daysUntil(q.month, q.day);
    if (REMINDER_DAYS.includes(d)) results.push({ ...q, daysLeft: d });
  }
  return results;
}

// ─── Beautiful HTML Email Template ───────────────────────────────────────────
function buildReminderEmail({ name, email, quarter, dueDate, daysLeft }) {
  const firstName = name ? name.split(" ")[0] : "there";
  const urgency   = daysLeft <= 2 ? "🚨 URGENT" : daysLeft <= 5 ? "⚠️ Coming Up" : "📅 Reminder";
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>IRS Payment Due — SaveTaxUSA</title></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px;">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#1e4d8c 0%,#2d5fa8 100%);border-radius:16px 16px 0 0;padding:28px 32px;text-align:center;">
      <div style="font-size:22px;font-weight:800;letter-spacing:0.5px;margin-bottom:4px;">
        <span style="color:#ef4444;">SAVE</span><span style="color:#fff;">TAX</span><span style="color:#ef4444;">USA</span>
      </div>
      <div style="color:rgba(255,255,255,0.75);font-size:11px;letter-spacing:1.5px;text-transform:uppercase;">Real Estate Tax Intelligence</div>
    </div>

    <!-- Body -->
    <div style="background:#fff;padding:32px;border:1px solid #e2e8f0;border-top:none;">
      <div style="display:inline-block;background:#fef3c7;color:#92400e;font-size:12px;font-weight:700;padding:4px 14px;border-radius:20px;margin-bottom:20px;">${urgency}</div>

      <h1 style="font-size:22px;font-weight:800;color:#0f172a;margin:0 0 8px;">Hi ${firstName},</h1>
      <p style="color:#64748b;font-size:15px;line-height:1.7;margin:0 0 24px;">
        Your <strong style="color:#1e293b;">${quarter} estimated tax payment</strong> is due in 
        <strong style="color:#9b1c1c;">${daysLeft} day${daysLeft===1?"":"s"}</strong> on <strong style="color:#1e293b;">${dueDate}</strong>.
      </p>

      <!-- Due Date Card -->
      <div style="background:#fff0f0;border:1.5px solid #fecaca;border-radius:12px;padding:20px;margin-bottom:24px;text-align:center;">
        <div style="font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Payment Due Date</div>
        <div style="font-size:28px;font-weight:800;color:#9b1c1c;">${dueDate}</div>
        <div style="font-size:13px;color:#64748b;margin-top:4px;">${daysLeft} day${daysLeft===1?"":"s"} remaining</div>
      </div>

      <!-- Action Button -->
      <div style="text-align:center;margin-bottom:24px;">
        <a href="https://savetaxusa.com/app/quarterly" 
           style="display:inline-block;background:#1e4d8c;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 32px;border-radius:10px;">
          Calculate My Payment →
        </a>
      </div>

      <!-- Steps -->
      <div style="background:#f8fafc;border-radius:10px;padding:16px 20px;margin-bottom:24px;">
        <div style="font-size:13px;font-weight:700;color:#1e293b;margin-bottom:12px;">How to pay in 3 steps:</div>
        ${["Go to IRS Direct Pay at <strong>irs.gov/payments</strong>","Select 'Estimated Tax' as payment type","Pay your estimated amount before midnight on " + dueDate].map((s,i)=>`
        <div style="display:flex;gap:10px;margin-bottom:8px;align-items:flex-start;">
          <div style="min-width:22px;height:22px;border-radius:50%;background:#1e4d8c;color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;">${i+1}</div>
          <div style="font-size:13px;color:#475569;line-height:1.5;">${s}</div>
        </div>`).join("")}
      </div>

      <p style="font-size:12px;color:#94a3b8;line-height:1.6;margin:0;">
        Missing this deadline may result in IRS underpayment penalties. 
        Log into SaveTaxUSA to check your quarterly estimates and set-aside amounts.
      </p>
    </div>

    <!-- Footer -->
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 16px 16px;padding:16px 32px;text-align:center;">
      <p style="font-size:11px;color:#94a3b8;margin:0 0 6px;">
        You're receiving this because you have an active SaveTaxUSA account.
      </p>
      <p style="font-size:11px;color:#94a3b8;margin:0;">
        <a href="https://savetaxusa.com" style="color:#1e4d8c;">savetaxusa.com</a> · 
        This is not official tax advice. Consult a licensed CPA for your specific situation.
      </p>
    </div>

  </div>
</body></html>`;
}

// ─── Dedup key: "Q2-2026-7" means Q2 2026 reminder for 7-days-before ────────
// Stored in-memory + checked against Supabase to survive restarts.
const sentReminders = new Set();

async function wasReminderAlreadySent(reminderKey) {
  // Check memory first (fast path for same-process re-runs)
  if (sentReminders.has(reminderKey)) return true;
  // Check Supabase reminder_log table (survives restarts)
  if (!supabase) return false;
  const { data } = await supabase
    .from("reminder_log")
    .select("id")
    .eq("reminder_key", reminderKey)
    .limit(1);
  if (data?.length) { sentReminders.add(reminderKey); return true; }
  return false;
}

async function markReminderSent(reminderKey) {
  sentReminders.add(reminderKey);
  if (!supabase) return;
  await supabase.from("reminder_log").insert({ reminder_key: reminderKey, sent_at: new Date().toISOString() }).select();
}

// ─── Send reminder to all Pro/Elite users ────────────────────────────────────
async function sendQuarterlyReminders() {
  if (!supabase) { console.log("⚠️ No Supabase — skipping reminders"); return; }
  const quarters = getQuartersDueForReminder();
  if (!quarters.length) { console.log("📅 No reminders due today (only sent 7 days and 1 day before)"); return; }

  for (const quarter of quarters) {
    const { daysLeft } = quarter;
    const today = new Date();
    const reminderKey = `${quarter.q}-${today.getFullYear()}-${daysLeft}d`;

    // Skip if already sent today
    if (await wasReminderAlreadySent(reminderKey)) {
      console.log(`⏭ Reminder "${reminderKey}" already sent — skipping`);
      continue;
    }

    console.log(`📧 Sending ${quarter.q} reminders (due in ${daysLeft} days)...`);

    // Get all Pro/Elite users
    const { data: users, error } = await supabase
      .from("users")
      .select("id, email, name, plan, plan_status")
      .in("plan", ["pro", "elite"])
      .in("plan_status", ["active", "trialing"]);

    if (error) { console.error("Failed to fetch users:", error); return; }
    if (!users?.length) { console.log("No Pro/Elite users found"); continue; }

    console.log(`Found ${users.length} users to remind`);
    let sent = 0;
    for (const user of users) {
      if (!user.email) continue;
      await sendEmail({
        to: user.email,
        subject: `⏰ ${quarter.q} IRS Payment Due in ${daysLeft} Day${daysLeft===1?"":"s"} — ${quarter.due}`,
        html: buildReminderEmail({
          name: user.name || "",
          email: user.email,
          quarter: quarter.q,
          dueDate: quarter.due,
          daysLeft,
        }),
      });
      sent++;
      // Small delay to avoid rate limits
      await new Promise(r => setTimeout(r, 100));
    }

    await markReminderSent(reminderKey);
    console.log(`✅ Sent ${sent} reminder emails for ${quarter.q} (${daysLeft} days before) — logged as "${reminderKey}"`);
  }
}

async function updateUserPlan(stripeCustomerId, plan, status) {
  if (!supabase) return;
  try {
    await supabase
      .from("users")
      .update({ plan, plan_status: status, updated_at: new Date().toISOString() })
      .eq("stripe_customer_id", stripeCustomerId);
    console.log(`✅ Plan updated in DB: ${stripeCustomerId} → ${plan} (${status})`);
  } catch(e) {
    console.error("Supabase update error:", e.message);
  }
}

async function saveStripeCustomerId(email, customerId, subscriptionId) {
  if (!supabase) return;
  try {
    await supabase
      .from("users")
      .update({
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        updated_at: new Date().toISOString(),
      })
      .eq("email", email);
    console.log(`✅ Stripe IDs saved for ${email}`);
  } catch(e) {
    console.error("Supabase saveStripeCustomerId error:", e.message);
  }
}

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── Allowed origins ─────────────────────────────────────────────────────────
// Allow all origins during development — tighten once savetaxusa.com domain is live
function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (origin.includes("localhost")) return true;
  if (origin.includes("savetaxusa.com")) return true;
  if (origin.includes("vercel.app")) return true;
  if (origin.includes("onrender.com")) return true;
  return false;
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet());
app.use(morgan("combined"));
app.use(cors({
  origin: (origin, cb) => {
    if (isAllowedOrigin(origin)) return cb(null, true);
    console.log("CORS blocked: " + origin);
    cb(null, true); // allow all for now
  },
  credentials: true,
}));

// ── Stripe webhooks need raw body — mount BEFORE express.json() ──────────────
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  handleWebhook
);

// ── All other routes use JSON ─────────────────────────────────────────────────
app.use(express.json());

// ═════════════════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ═════════════════════════════════════════════════════════════════════════════
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "SaveTaxUSA API",
    timestamp: new Date().toISOString(),
    stripe: !!process.env.STRIPE_SECRET_KEY,
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CREATE SUBSCRIPTION
// POST /api/subscribe
// Body: { paymentMethodId, priceId, email, name, billingCycle }
// Returns: { clientSecret?, subscriptionId, customerId, status }
// ═════════════════════════════════════════════════════════════════════════════
app.post("/api/subscribe", async (req, res) => {
  const { paymentMethodId, priceId, email, name, billingCycle } = req.body;

  if (!paymentMethodId || !priceId || !email || !name) {
    return res.status(400).json({ error: "Missing required fields: paymentMethodId, priceId, email, name" });
  }

  try {
    // 1️⃣  Check for existing customer by email (avoid duplicates)
    let customer;
    const existing = await stripe.customers.list({ email, limit: 1 });
    if (existing.data.length > 0) {
      customer = existing.data[0];
      // Attach new payment method to existing customer
      await stripe.paymentMethods.attach(paymentMethodId, { customer: customer.id });
      await stripe.customers.update(customer.id, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });
    } else {
      // 2️⃣  Create new Stripe customer
      customer = await stripe.customers.create({
        email,
        name,
        payment_method: paymentMethodId,
        invoice_settings: { default_payment_method: paymentMethodId },
        metadata: { source: "savetaxusa_web", billingCycle: billingCycle || "monthly" },
      });
    }

    // 3️⃣  Create subscription (incomplete until payment confirmed)
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceId }],
      payment_behavior: "default_incomplete",
      payment_settings: {
        payment_method_types: ["card"],
        save_default_payment_method: "on_subscription",
      },
      expand: ["latest_invoice.payment_intent"],
      metadata: { source: "savetaxusa_web", billingCycle: billingCycle || "monthly" },
      trial_period_days: 7,   // 7-day free trial
    });

    const paymentIntent = subscription.latest_invoice?.payment_intent;

    // Save Stripe customer ID to Supabase
    await saveStripeCustomerId(email, customer.id, subscription.id);

    res.json({
      subscriptionId: subscription.id,
      customerId: customer.id,
      status: subscription.status,
      clientSecret: paymentIntent?.client_secret || null,
    });

  } catch (err) {
    console.error("Subscribe error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// CANCEL SUBSCRIPTION
// POST /api/cancel
// Body: { subscriptionId, cancelImmediately? }
// ═════════════════════════════════════════════════════════════════════════════
app.post("/api/cancel", async (req, res) => {
  const { subscriptionId, cancelImmediately = false } = req.body;
  if (!subscriptionId) return res.status(400).json({ error: "subscriptionId required" });

  try {
    let result;
    if (cancelImmediately) {
      result = await stripe.subscriptions.cancel(subscriptionId);
    } else {
      // Cancel at end of current billing period (recommended UX)
      result = await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: true,
      });
    }
    res.json({ status: result.status, cancelAtPeriodEnd: result.cancel_at_period_end });
  } catch (err) {
    console.error("Cancel error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// UPGRADE / DOWNGRADE PLAN
// POST /api/change-plan
// Body: { subscriptionId, newPriceId }
// ═════════════════════════════════════════════════════════════════════════════
app.post("/api/change-plan", async (req, res) => {
  const { subscriptionId, newPriceId } = req.body;
  if (!subscriptionId || !newPriceId) return res.status(400).json({ error: "subscriptionId and newPriceId required" });

  try {
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const updatedSub = await stripe.subscriptions.update(subscriptionId, {
      items: [{ id: sub.items.data[0].id, price: newPriceId }],
      proration_behavior: "always_invoice",  // Charge / credit immediately
    });
    res.json({ status: updatedSub.status, subscriptionId: updatedSub.id });
  } catch (err) {
    console.error("Change plan error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET SUBSCRIPTION STATUS
// GET /api/subscription/:customerId
// ═════════════════════════════════════════════════════════════════════════════
app.get("/api/subscription/:customerId", async (req, res) => {
  const { customerId } = req.params;
  try {
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 5,
      expand: ["data.default_payment_method"],
    });

    const active = subscriptions.data.find(s =>
      ["active", "trialing", "past_due"].includes(s.status)
    );

    if (!active) return res.json({ plan: "free", status: "none" });

    const priceId = active.items.data[0]?.price?.id;
    const amount  = active.items.data[0]?.price?.unit_amount;
    const card    = active.default_payment_method?.card;

    res.json({
      subscriptionId: active.id,
      status: active.status,
      priceId,
      amount: amount ? (amount / 100).toFixed(2) : null,
      cancelAtPeriodEnd: active.cancel_at_period_end,
      currentPeriodEnd: new Date(active.current_period_end * 1000).toISOString(),
      trialEnd: active.trial_end ? new Date(active.trial_end * 1000).toISOString() : null,
      card: card ? { brand: card.brand, last4: card.last4, expMonth: card.exp_month, expYear: card.exp_year } : null,
    });
  } catch (err) {
    console.error("Subscription status error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// CUSTOMER PORTAL (self-serve billing management)
// POST /api/portal
// Body: { customerId }
// Returns: { url } — redirect user to this URL
// ═════════════════════════════════════════════════════════════════════════════
app.post("/api/portal", async (req, res) => {
  const { customerId } = req.body;
  if (!customerId) return res.status(400).json({ error: "customerId required" });

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: "https://savetaxusa.com/app",
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("Portal error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// STRIPE WEBHOOK HANDLER
// POST /webhook  (raw body — mounted before express.json())
// ═════════════════════════════════════════════════════════════════════════════
async function handleWebhook(req, res) {
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`Webhook received: ${event.type}`);

  try {
    switch (event.type) {

      // ── Payment succeeded (initial or renewal) ───────────────────────────
      case "invoice.paid": {
        const invoice    = event.data.object;
        const customerId = invoice.customer;
        const subId      = invoice.subscription;
        const amount     = invoice.amount_paid / 100;
        const email      = invoice.customer_email;
        console.log(`✅ Payment received: $${amount} from ${email} (sub: ${subId})`);
        // Determine plan from subscription price
        if (subId) {
          const sub = await stripe.subscriptions.retrieve(subId);
          const priceId = sub.items.data[0]?.price?.id || "";
          const plan = priceId.includes("elite") ? "elite" : "pro";
          await updateUserPlan(customerId, plan, "active");
        }
        break;
      }

      // ── Subscription activated / trial started ───────────────────────────
      case "customer.subscription.created": {
        const sub = event.data.object;
        console.log(`🆕 Subscription created: ${sub.id} status=${sub.status}`);
        const priceId = sub.items.data[0]?.price?.id || "";
        const plan = priceId.includes("elite") ? "elite" : "pro";
        await updateUserPlan(sub.customer, plan, sub.status);
        break;
      }

      // ── Subscription upgraded / downgraded ───────────────────────────────
      case "customer.subscription.updated": {
        const sub     = event.data.object;
        const prevSub = event.data.previous_attributes;
        console.log(`🔄 Subscription updated: ${sub.id} status=${sub.status}`);
        if (prevSub?.items) {
          // Plan changed — update access level in your DB
          // TODO: const newPriceId = sub.items.data[0].price.id;
        }
        if (sub.cancel_at_period_end) {
          console.log(`⚠️  Subscription ${sub.id} set to cancel at period end`);
          // TODO: Send cancellation confirmation email
        }
        break;
      }

      // ── Subscription cancelled / expired ─────────────────────────────────
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        console.log(`❌ Subscription cancelled: ${sub.id}`);
        await updateUserPlan(sub.customer, "free", "cancelled");
        break;
      }

      // ── Payment failed ───────────────────────────────────────────────────
      case "invoice.payment_failed": {
        const invoice = event.data.object;
        console.log(`🚨 Payment failed: ${invoice.id} for ${invoice.customer_email}`);
        // Stripe auto-retries per your retry schedule (Stripe Dashboard → Settings → Billing)
        // TODO: Send "payment failed" email to customer
        // TODO: If final retry failed, downgrade to free
        break;
      }

      // ── Trial ending soon (3 days before) ────────────────────────────────
      case "customer.subscription.trial_will_end": {
        const sub = event.data.object;
        console.log(`⏰ Trial ending soon: ${sub.id}`);
        // TODO: Send "your trial ends in 3 days" email
        break;
      }

      // ── 3DS / payment action required ────────────────────────────────────
      case "invoice.payment_action_required": {
        const invoice = event.data.object;
        console.log(`🔐 Payment action required: ${invoice.id}`);
        // TODO: Email customer with link to complete authentication
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }
  } catch (err) {
    console.error(`Error handling ${event.type}:`, err);
    // Return 200 anyway so Stripe doesn't keep retrying
  }

  res.json({ received: true });
}

// ═════════════════════════════════════════════════════════════════════════════
// QUARTERLY REMINDER ENDPOINT + CRON
// ═════════════════════════════════════════════════════════════════════════════

// Manual trigger endpoint (also used by external cron services)
app.post("/api/send-reminders", async (req, res) => {
  const secret = req.headers["x-cron-secret"];
  if (secret !== process.env.CRON_SECRET && process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    await sendQuarterlyReminders();
    res.json({ success: true, message: "Reminders processed" });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Test endpoint — send a test email to a specific address
app.post("/api/test-email", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "email required" });
  try {
    await sendEmail({
      to: email,
      subject: "✅ SaveTaxUSA Email Test",
      html: buildReminderEmail({
        name: "Fernando",
        email,
        quarter: "Q2",
        dueDate: "June 16",
        daysLeft: 5,
      }),
    });
    res.json({ success: true, message: `Test email sent to ${email}` });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Built-in daily check — runs every 24 hours
// For production, also set up an external cron at cron-job.org hitting /api/send-reminders
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
setInterval(async () => {
  console.log("⏰ Daily reminder check running...");
  await sendQuarterlyReminders();
}, TWENTY_FOUR_HOURS);

// Run once on startup (after 30 seconds) — dedup guard prevents duplicate emails
setTimeout(async () => {
  console.log("🚀 Startup reminder check (dedup-protected)...");
  await sendQuarterlyReminders();
}, 30000);

// ═════════════════════════════════════════════════════════════════════════════
// ELITE-TIER MIDDLEWARE & ENDPOINTS
// ═════════════════════════════════════════════════════════════════════════════

// ─── Require Elite Plan Middleware ───────────────────────────────────────────
async function requireElite(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "Authorization required" });
  // Verify with Supabase - extract user from JWT
  if (!supabase) return res.status(500).json({ error: "Database not configured" });
  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: "Invalid token" });
  // Check plan
  const { data: profile } = await supabase.from("users").select("plan,plan_status").eq("id", user.id).single();
  if (!profile || profile.plan !== "elite" || !["active","trialing"].includes(profile.plan_status)) {
    return res.status(403).json({ error: "Elite plan required" });
  }
  req.user = user;
  req.userProfile = profile;
  next();
}

// ─── Federal Tax Bracket Calculator ─────────────────────────────────────────
const FEDERAL_BRACKETS = [
  { min:0, max:11600, rate:0.10 },
  { min:11600, max:47150, rate:0.12 },
  { min:47150, max:100525, rate:0.22 },
  { min:100525, max:191950, rate:0.24 },
  { min:191950, max:243725, rate:0.32 },
  { min:243725, max:609350, rate:0.35 },
  { min:609350, max:Infinity, rate:0.37 },
];

function calcFederalTax(income) {
  let tax = 0;
  for (const b of FEDERAL_BRACKETS) {
    if (income <= 0) break;
    const t = Math.min(income, b.max - b.min);
    tax += t * b.rate;
    income -= t;
  }
  return tax;
}

// ═════════════════════════════════════════════════════════════════════════════
// TEAM MANAGEMENT ENDPOINTS (Elite only)
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/team — Create team
app.post("/api/team", requireElite, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "Team name is required" });

    // Check user doesn't already own a team
    const { data: existingTeam } = await supabase
      .from("teams")
      .select("id")
      .eq("owner_id", req.user.id)
      .single();

    if (existingTeam) {
      return res.status(409).json({ error: "You already own a team" });
    }

    // Insert into teams table
    const { data: team, error: teamError } = await supabase
      .from("teams")
      .insert({ name, owner_id: req.user.id })
      .select()
      .single();

    if (teamError) {
      console.error("Create team error:", teamError);
      return res.status(500).json({ error: "Failed to create team" });
    }

    // Add owner as first team_member
    const { error: memberError } = await supabase
      .from("team_members")
      .insert({
        team_id: team.id,
        user_id: req.user.id,
        email: req.user.email,
        role: "owner",
        status: "active",
      });

    if (memberError) {
      console.error("Add owner member error:", memberError);
      return res.status(500).json({ error: "Failed to add owner as team member" });
    }

    res.json({ team });
  } catch (err) {
    console.error("POST /api/team error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/team — Get user's team
app.get("/api/team", requireElite, async (req, res) => {
  try {
    const { data: team, error: teamError } = await supabase
      .from("teams")
      .select("*")
      .eq("owner_id", req.user.id)
      .single();

    if (teamError || !team) {
      return res.json({ team: null, members: [] });
    }

    const { data: members, error: membersError } = await supabase
      .from("team_members")
      .select("*")
      .eq("team_id", team.id);

    if (membersError) {
      console.error("Fetch team members error:", membersError);
      return res.status(500).json({ error: "Failed to fetch team members" });
    }

    res.json({ team, members: members || [] });
  } catch (err) {
    console.error("GET /api/team error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/team/invite — Invite member
app.post("/api/team/invite", requireElite, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });

    // Verify team exists and user is owner
    const { data: team } = await supabase
      .from("teams")
      .select("id, max_seats")
      .eq("owner_id", req.user.id)
      .single();

    if (!team) {
      return res.status(404).json({ error: "You don't own a team. Create one first." });
    }

    // Check seat count
    const { data: currentMembers } = await supabase
      .from("team_members")
      .select("id")
      .eq("team_id", team.id)
      .in("status", ["active", "pending"]);

    if (currentMembers && currentMembers.length >= (team.max_seats || 5)) {
      return res.status(400).json({ error: "Team has reached maximum seat count" });
    }

    // Check email not already invited
    const { data: existingMember } = await supabase
      .from("team_members")
      .select("id, status")
      .eq("team_id", team.id)
      .eq("email", email)
      .in("status", ["active", "pending"])
      .single();

    if (existingMember) {
      return res.status(409).json({ error: "This email has already been invited" });
    }

    // Insert team_member with status='pending'
    const { data: member, error: insertError } = await supabase
      .from("team_members")
      .insert({
        team_id: team.id,
        email,
        role: "member",
        status: "pending",
      })
      .select()
      .single();

    if (insertError) {
      console.error("Invite member error:", insertError);
      return res.status(500).json({ error: "Failed to invite member" });
    }

    res.json({ member });
  } catch (err) {
    console.error("POST /api/team/invite error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/team/member/:memberId — Remove member
app.delete("/api/team/member/:memberId", requireElite, async (req, res) => {
  try {
    const { memberId } = req.params;

    // Verify user owns the team
    const { data: team } = await supabase
      .from("teams")
      .select("id")
      .eq("owner_id", req.user.id)
      .single();

    if (!team) {
      return res.status(404).json({ error: "You don't own a team" });
    }

    // Get the member
    const { data: member } = await supabase
      .from("team_members")
      .select("id, role, team_id")
      .eq("id", memberId)
      .eq("team_id", team.id)
      .single();

    if (!member) {
      return res.status(404).json({ error: "Member not found" });
    }

    // Can't remove the owner
    if (member.role === "owner") {
      return res.status(400).json({ error: "Cannot remove the team owner" });
    }

    // Update status to 'removed'
    const { error: updateError } = await supabase
      .from("team_members")
      .update({ status: "removed" })
      .eq("id", memberId);

    if (updateError) {
      console.error("Remove member error:", updateError);
      return res.status(500).json({ error: "Failed to remove member" });
    }

    res.json({ success: true, message: "Member removed" });
  } catch (err) {
    console.error("DELETE /api/team/member error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// API KEY MANAGEMENT (Elite only)
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/keys — Generate new API key
app.post("/api/keys", requireElite, async (req, res) => {
  try {
    const { name = "Default" } = req.body;

    // Generate a random key: "stx_" + 32 random hex chars
    const rawKey = "stx_" + crypto.randomBytes(16).toString("hex");
    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
    const keyPrefix = rawKey.substring(0, 12); // e.g. "stx_abcd1234"

    const { data: apiKey, error } = await supabase
      .from("api_keys")
      .insert({
        user_id: req.user.id,
        key_hash: keyHash,
        key_prefix: keyPrefix,
        name,
        is_active: true,
      })
      .select("id, key_prefix, name, is_active, created_at")
      .single();

    if (error) {
      console.error("Create API key error:", error);
      return res.status(500).json({ error: "Failed to create API key" });
    }

    // Return the FULL key (only time it's shown)
    res.json({ ...apiKey, key: rawKey });
  } catch (err) {
    console.error("POST /api/keys error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/keys — List user's API keys
app.get("/api/keys", requireElite, async (req, res) => {
  try {
    const { data: keys, error } = await supabase
      .from("api_keys")
      .select("id, key_prefix, name, is_active, last_used_at, created_at")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("List API keys error:", error);
      return res.status(500).json({ error: "Failed to list API keys" });
    }

    res.json({ keys: keys || [] });
  } catch (err) {
    console.error("GET /api/keys error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/keys/:keyId — Revoke API key
app.delete("/api/keys/:keyId", requireElite, async (req, res) => {
  try {
    const { keyId } = req.params;

    const { error } = await supabase
      .from("api_keys")
      .update({ is_active: false })
      .eq("id", keyId)
      .eq("user_id", req.user.id);

    if (error) {
      console.error("Revoke API key error:", error);
      return res.status(500).json({ error: "Failed to revoke API key" });
    }

    res.json({ success: true, message: "API key revoked" });
  } catch (err) {
    console.error("DELETE /api/keys error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// PUBLIC API — TAX CALCULATION (Authenticated via API Key)
// POST /api/v1/calculate
// ═════════════════════════════════════════════════════════════════════════════
app.post("/api/v1/calculate", async (req, res) => {
  try {
    const apiKey = req.headers["x-api-key"];
    if (!apiKey) {
      return res.status(401).json({ error: "API key required. Pass x-api-key header." });
    }

    if (!supabase) {
      return res.status(500).json({ error: "Database not configured" });
    }

    // Validate the API key: hash it, look up in api_keys table
    const keyHash = crypto.createHash("sha256").update(apiKey).digest("hex");

    const { data: keyRecord, error: keyError } = await supabase
      .from("api_keys")
      .select("id, user_id, is_active")
      .eq("key_hash", keyHash)
      .eq("is_active", true)
      .single();

    if (keyError || !keyRecord) {
      return res.status(401).json({ error: "Invalid or revoked API key" });
    }

    // Update last_used_at
    await supabase
      .from("api_keys")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", keyRecord.id);

    // Check the key owner has elite plan
    const { data: owner } = await supabase
      .from("users")
      .select("plan, plan_status")
      .eq("id", keyRecord.user_id)
      .single();

    if (!owner || owner.plan !== "elite" || !["active","trialing"].includes(owner.plan_status)) {
      return res.status(403).json({ error: "API key owner must have an active Elite plan" });
    }

    // Validate request body
    const { income, filingStatus, state, deductions } = req.body;
    if (income === undefined || income === null) {
      return res.status(400).json({ error: "income is required" });
    }

    const grossIncome = Number(income);
    if (isNaN(grossIncome) || grossIncome < 0) {
      return res.status(400).json({ error: "income must be a non-negative number" });
    }

    const totalDeductions = Number(deductions) || 0;

    // Self-employment tax (15.3% on 92.35% of income)
    const seBase = grossIncome * 0.9235;
    const seTax = seBase * 0.153;

    // Taxable income after deductions and half of SE tax
    const taxableIncome = Math.max(0, grossIncome - totalDeductions - (seTax / 2));

    // Federal tax
    const federalTax = calcFederalTax(taxableIncome);

    // State tax (simple flat estimate — 5% default, can be expanded later)
    const STATE_RATES = {
      "CA": 0.0930, "NY": 0.0685, "TX": 0, "FL": 0, "WA": 0, "NV": 0,
      "IL": 0.0495, "PA": 0.0307, "OH": 0.04, "NJ": 0.0637, "GA": 0.055,
      "NC": 0.0525, "MA": 0.05, "VA": 0.0575, "CO": 0.044, "AZ": 0.025,
      "TN": 0, "WY": 0, "SD": 0, "AK": 0, "NH": 0,
    };
    const stateCode = (state || "").toUpperCase();
    const stateRate = STATE_RATES[stateCode] !== undefined ? STATE_RATES[stateCode] : 0.05;
    const stateTax = taxableIncome * stateRate;

    const totalTax = seTax + federalTax + stateTax;
    const netIncome = grossIncome - totalTax;
    const effectiveRate = grossIncome > 0 ? totalTax / grossIncome : 0;
    const quarterlyPayment = totalTax / 4;

    res.json({
      gross: Math.round(grossIncome * 100) / 100,
      netIncome: Math.round(netIncome * 100) / 100,
      seTax: Math.round(seTax * 100) / 100,
      federalTax: Math.round(federalTax * 100) / 100,
      stateTax: Math.round(stateTax * 100) / 100,
      totalTax: Math.round(totalTax * 100) / 100,
      effectiveRate: Math.round(effectiveRate * 10000) / 10000,
      quarterlyPayment: Math.round(quarterlyPayment * 100) / 100,
    });
  } catch (err) {
    console.error("POST /api/v1/calculate error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// WHITE-LABEL BRANDING SETTINGS (Elite only)
// ═════════════════════════════════════════════════════════════════════════════

// PUT /api/branding — Update company branding
app.put("/api/branding", requireElite, async (req, res) => {
  try {
    const { companyName, companyLogoUrl, brandColor } = req.body;

    const { data, error } = await supabase
      .from("users")
      .update({
        company_name: companyName || null,
        company_logo_url: companyLogoUrl || null,
        brand_color: brandColor || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", req.user.id)
      .select("company_name, company_logo_url, brand_color")
      .single();

    if (error) {
      console.error("Update branding error:", error);
      return res.status(500).json({ error: "Failed to update branding" });
    }

    res.json(data);
  } catch (err) {
    console.error("PUT /api/branding error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/branding — Get branding settings
app.get("/api/branding", requireElite, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("users")
      .select("company_name, company_logo_url, brand_color")
      .eq("id", req.user.id)
      .single();

    if (error) {
      console.error("Get branding error:", error);
      return res.status(500).json({ error: "Failed to fetch branding" });
    }

    res.json(data || { company_name: null, company_logo_url: null, brand_color: null });
  } catch (err) {
    console.error("GET /api/branding error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GLOBAL ERROR HANDLER
// ═════════════════════════════════════════════════════════════════════════════
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err.message);
  res.status(500).json({ error: "Internal server error" });
});

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🦅 SaveTaxUSA API running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Stripe key set: ${!!process.env.STRIPE_SECRET_KEY}`);
  console.log(`   Webhook secret set: ${!!process.env.STRIPE_WEBHOOK_SECRET}`);
  console.log(`   Resend email set: ${!!process.env.RESEND_API_KEY}`);
  console.log(`   Supabase set: ${!!process.env.SUPABASE_SERVICE_KEY}\n`);
});
