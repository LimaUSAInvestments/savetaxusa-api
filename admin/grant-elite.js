#!/usr/bin/env node
/**
 * Grant Elite access to a user by email (no charge).
 *
 * Usage:
 *   node admin/grant-elite.js user@example.com
 *   node admin/grant-elite.js user@example.com --revoke   (downgrade back to free)
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_KEY in ../.env
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL || "https://aonzignujpwjekmnlslg.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_SERVICE_KEY) {
  console.error("ERROR: SUPABASE_SERVICE_KEY not set in .env");
  process.exit(1);
}

const email = process.argv[2];
const revoke = process.argv.includes("--revoke");

if (!email || email.startsWith("-")) {
  console.log("Usage:  node admin/grant-elite.js <email>");
  console.log("        node admin/grant-elite.js <email> --revoke");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function run() {
  // Find user by email
  const { data: user, error } = await supabase
    .from("users")
    .select("id, email, plan, plan_status")
    .eq("email", email)
    .single();

  if (error || !user) {
    console.error(`User not found: ${email}`);
    console.error("Make sure they have signed up and have a row in the users table.");
    process.exit(1);
  }

  console.log(`Found: ${user.email} (current plan: ${user.plan}, status: ${user.plan_status})`);

  if (revoke) {
    const { error: updateErr } = await supabase
      .from("users")
      .update({ plan: "free", plan_status: "inactive", updated_at: new Date().toISOString() })
      .eq("id", user.id);

    if (updateErr) { console.error("Update failed:", updateErr.message); process.exit(1); }
    console.log(`Downgraded ${email} to free.`);
  } else {
    if (user.plan === "elite" && user.plan_status === "active") {
      console.log("Already has Elite access — nothing to do.");
      process.exit(0);
    }

    const { error: updateErr } = await supabase
      .from("users")
      .update({ plan: "elite", plan_status: "active", updated_at: new Date().toISOString() })
      .eq("id", user.id);

    if (updateErr) { console.error("Update failed:", updateErr.message); process.exit(1); }
    console.log(`Granted Elite access to ${email}.`);
  }
}

run().catch(err => { console.error(err.message); process.exit(1); });
