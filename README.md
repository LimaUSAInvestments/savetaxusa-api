# SaveTaxUSA — Stripe Backend API

Complete subscription management backend for SaveTaxUSA.
Handles Stripe payments, webhooks, plan changes, and the Customer Portal.

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Server health check |
| POST | `/api/subscribe` | Create new subscription |
| POST | `/api/cancel` | Cancel subscription |
| POST | `/api/change-plan` | Upgrade or downgrade plan |
| GET | `/api/subscription/:customerId` | Get subscription status |
| POST | `/api/portal` | Generate Customer Portal URL |
| POST | `/webhook` | Stripe webhook receiver |

---

## Local Development

```bash
# 1. Install dependencies
npm install

# 2. Copy and fill in environment variables
cp .env.example .env
# Edit .env with your real Stripe keys

# 3. Start the dev server (auto-restarts on changes)
npm run dev

# 4. Test the health endpoint
curl http://localhost:3001/health

# 5. Forward webhooks to local server (Stripe CLI required)
stripe listen --forward-to localhost:3001/webhook
```

---

## Deploy to Render.com (Free)

### Step 1 — Push to GitHub
```bash
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/YOUR_USERNAME/savetaxusa-api
git push -u origin main
```

### Step 2 — Create Render Web Service
1. Go to [render.com](https://render.com) → New → Web Service
2. Connect your GitHub repo `savetaxusa-api`
3. Settings:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Plan**: Free (or Starter $7/mo for always-on)

### Step 3 — Add Environment Variables in Render Dashboard
Go to your service → Environment tab → Add these:

| Key | Value |
|-----|-------|
| `STRIPE_SECRET_KEY` | `sk_live_...` (from Stripe Dashboard) |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` (from Stripe Webhooks) |
| `NODE_ENV` | `production` |

### Step 4 — Add Custom Domain (optional)
Render Settings → Custom Domains → Add `api.savetaxusa.com`
Then add a CNAME record at your registrar pointing to your Render URL.

---

## Stripe Dashboard Setup

### 1. Create Products & Prices
1. Go to [Stripe Dashboard → Products](https://dashboard.stripe.com/products)
2. Create product: **"SaveTaxUSA Pro"**
3. Add prices:
   - Pro Monthly: **$12.00 / month** → copy `price_xxx`
   - Pro Annual: **$115.20 / year** ($9.60/mo × 12) → copy `price_xxx`
4. Create product: **"SaveTaxUSA Elite"**
5. Add prices:
   - Elite Monthly: **$29.00 / month** → copy `price_xxx`
   - Elite Annual: **$278.40 / year** ($23.20/mo × 12) → copy `price_xxx`

### 2. Set Up Webhook
1. Go to [Stripe Dashboard → Webhooks](https://dashboard.stripe.com/webhooks)
2. Click **"Add endpoint"**
3. Endpoint URL: `https://api.savetaxusa.com/webhook`
4. Select these events:
   - `invoice.paid`
   - `invoice.payment_failed`
   - `invoice.payment_action_required`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `customer.subscription.trial_will_end`
5. Click **Add endpoint** → reveal **Signing secret** → copy `whsec_...`

### 3. Enable Customer Portal
1. Go to [Stripe Dashboard → Customer Portal](https://dashboard.stripe.com/settings/billing/portal)
2. Enable the portal
3. Configure: allow cancellations, plan upgrades, payment method updates
4. Save changes

### 4. Set Up Retry Schedule (for failed payments)
1. Go to [Stripe Dashboard → Settings → Billing → Automatic collection](https://dashboard.stripe.com/settings/billing/automatic)
2. Recommended: Retry after 3, 5, 7 days → then cancel subscription

---

## Webhook Events Handled

| Event | Action |
|-------|--------|
| `invoice.paid` | ✅ Grant/renew full access |
| `customer.subscription.created` | 🆕 New subscriber — create account |
| `customer.subscription.updated` | 🔄 Plan changed — update access level |
| `customer.subscription.deleted` | ❌ Cancelled — downgrade to free |
| `invoice.payment_failed` | 🚨 Send retry email |
| `customer.subscription.trial_will_end` | ⏰ Send trial ending email |
| `invoice.payment_action_required` | 🔐 Send 3DS authentication email |

---

## Test Cards (Stripe Test Mode)

| Card Number | Scenario |
|-------------|----------|
| `4242 4242 4242 4242` | ✅ Success |
| `4000 0025 0000 3155` | 🔐 Requires 3DS authentication |
| `4000 0000 0000 9995` | ❌ Declined (insufficient funds) |
| `4000 0000 0000 0069` | ❌ Declined (expired card) |

Use any future expiry date, any 3-digit CVC, any ZIP code.

---

## Database Integration (Next Step)

Right now the webhook handler has `TODO` comments where you'd save to a database.
When you're ready, replace those with your DB calls. Recommended options:

- **Supabase** (free tier, Postgres) — savetaxusa.com can use Supabase Auth too
- **PlanetScale** (free tier, MySQL)
- **MongoDB Atlas** (free tier)

Minimal user schema you'll need:
```sql
users (
  id            UUID PRIMARY KEY,
  email         TEXT UNIQUE,
  name          TEXT,
  stripe_customer_id TEXT UNIQUE,
  plan          TEXT DEFAULT 'free',   -- free | pro | elite
  plan_status   TEXT,                  -- active | trialing | past_due | cancelled
  paid_through  TIMESTAMP,
  created_at    TIMESTAMP DEFAULT NOW()
)
```

---

## Security Notes

- ✅ Stripe webhook signature verified on every request
- ✅ CORS restricted to savetaxusa.com only
- ✅ Helmet.js adds security headers
- ✅ Secret key never exposed to frontend
- ✅ .env excluded from git via .gitignore
- ⚠️  Add rate limiting (express-rate-limit) before high traffic
- ⚠️  Add request logging to a service (Logtail, Papertrail) for production
