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

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── Allowed origins ─────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  "https://savetaxusa.com",
  "https://www.savetaxusa.com",
  "http://localhost:5173",   // Vite dev server
  "http://localhost:3000",
];

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet());
app.use(morgan("combined"));
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
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

    res.json({
      subscriptionId: subscription.id,
      customerId: customer.id,
      status: subscription.status,
      // clientSecret is only present when payment confirmation is needed (e.g. 3DS)
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
        const invoice  = event.data.object;
        const customerId = invoice.customer;
        const subId    = invoice.subscription;
        const amount   = invoice.amount_paid / 100;
        const email    = invoice.customer_email;
        console.log(`✅ Payment received: $${amount} from ${email} (sub: ${subId})`);
        // TODO: Update your database — grant full access
        // await db.users.update({ stripeCustomerId: customerId }, { plan: 'pro', paidThrough: invoice.period_end })
        break;
      }

      // ── Subscription activated / trial started ───────────────────────────
      case "customer.subscription.created": {
        const sub = event.data.object;
        console.log(`🆕 Subscription created: ${sub.id} status=${sub.status}`);
        // TODO: Create user account or update plan in your DB
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
        // TODO: Downgrade user to free plan in your DB
        // await db.users.update({ stripeCustomerId: sub.customer }, { plan: 'free' })
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
  console.log(`   Webhook secret set: ${!!process.env.STRIPE_WEBHOOK_SECRET}\n`);
});
