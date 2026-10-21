import { Router, type IRouter } from "express";
import { getStripe } from "../lib/stripe";
import { supabase } from "../lib/supabase";
import { spendCreditsFixed, getCreditBalance } from "../lib/credits";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth";
import { TOPUP_PACKS, SUBSCRIPTION_TIERS } from "../lib/billingPlans";

const router: IRouter = Router();


async function getOrCreateCustomer(
  userId: string,
  email?: string | null,
  name?: string | null,
): Promise<string> {
  const { data } = await supabase
    .from("profiles")
    .select("stripe_customer_id")
    .eq("id", userId)
    .single();

  if (data?.stripe_customer_id) return data.stripe_customer_id as string;

  const customer = await getStripe().customers.create({
    email: email || undefined,
    name: name || undefined,
    metadata: { user_id: userId },
  });

  await supabase
    .from("profiles")
    .update({ stripe_customer_id: customer.id })
    .eq("id", userId);

  return customer.id;
}

// ── POST /billing/create-checkout-session ─────────────────────────────
router.post(
  "/billing/create-checkout-session",
  requireAuth,
  async (req: AuthenticatedRequest, res): Promise<void> => {
    const { type, tier, pack_id, currency = "INR" } = req.body as {
      type: "subscription" | "topup";
      tier?: string;
      pack_id?: string;
      currency?: "INR" | "USD";
    };

    if (type !== "subscription" && type !== "topup") {
      res.status(400).json({ error: "type must be 'subscription' or 'topup'" });
      return;
    }
    if (currency !== "INR" && currency !== "USD") {
      res.status(400).json({ error: "currency must be 'INR' or 'USD'" });
      return;
    }

    try {
      const { data: profile } = await supabase
        .from("profiles")
        .select("email, full_name")
        .eq("id", req.userId!)
        .single();

      const stripe = getStripe();
      const customerId = await getOrCreateCustomer(
        req.userId!,
        profile?.email as string | undefined,
        profile?.full_name as string | undefined,
      );

      const appUrl = process.env.APP_URL ?? (req.headers.origin as string) ?? "http://localhost:5173";
      const success_url = `${appUrl}/dashboard/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`;
const cancel_url = `${appUrl}/dashboard/billing?checkout=cancelled`;
const stripeCurrency = currency.toLowerCase();
      

      // ── One-time top-up ──
      if (type === "topup") {
        const pack = pack_id ? TOPUP_PACKS[pack_id] : null;
        if (!pack) {
          res.status(400).json({ error: "pack_id must be 'small', 'medium', 'large', or 'xl'" });
          return;
        }
        const amount = currency === "USD" ? pack.amount_usd : pack.amount_inr;

        const session = await stripe.checkout.sessions.create({
          mode: "payment",
          customer: customerId,
          client_reference_id: req.userId!,
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: stripeCurrency,
                unit_amount: amount,
                product_data: { name: pack.name },
              },
            },
          ],
          metadata: {
            user_id: req.userId!,
            type: "topup",
            pack_id: pack_id!,
            credits: String(pack.credits),
          },
          success_url,
          cancel_url,
        });

        await supabase.from("topup_purchases").insert({
          user_id: req.userId!,
          pack_id,
          credits: pack.credits,
          amount_paid_cents: amount,
          stripe_session_id: session.id,
          status: "pending",
        });

        res.json({ url: session.url, session_id: session.id });
        return;
      }

      // ── Recurring subscription ──
      if (tier !== "starter" && tier !== "growth" && tier !== "scale") {
        res.status(400).json({ error: "tier must be 'starter', 'growth', or 'scale'" });
        return;
      }

      const { data: existing } = await supabase
        .from("subscriptions")
        .select("status")
        .eq("user_id", req.userId!)
        .maybeSingle();

      if (existing?.status === "active") {
        res.status(409).json({
          error: "You already have an active subscription. Cancel it first to switch plans.",
        });
        return;
      }

      const tierConfig = SUBSCRIPTION_TIERS[tier];
      const amount = currency === "USD" ? tierConfig.amount_usd : tierConfig.amount_inr;
      const label = tier.charAt(0).toUpperCase() + tier.slice(1);

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        client_reference_id: req.userId!,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: stripeCurrency,
              unit_amount: amount,
              recurring: { interval: "month" },
              product_data: { name: `${label} plan — ${tierConfig.credits} credits/month` },
            },
          },
        ],
        metadata: {
          user_id: req.userId!,
          type: "subscription",
          tier,
          credits: String(tierConfig.credits),
        },
        subscription_data: { metadata: { user_id: req.userId!, tier } },
        success_url,
        cancel_url,
      });

      res.json({ url: session.url, session_id: session.id });
    } catch (err) {
      req.log.error({ err }, "Failed to create Stripe checkout session");
      res.status(500).json({ error: "Failed to create checkout session" });
    }
  },
);

// ── GET /billing/status ──────────────────────────────────────────────
router.get("/billing/status", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  try {
    const [{ data: profile }, { data: sub }, { data: txns }] = await Promise.all([
      supabase
        .from("profiles")
        .select("credit_balance, subscription_tier, subscription_status")
        .eq("id", req.userId!)
        .single(),
      supabase
        .from("subscriptions")
        .select("tier, status, current_period_end")
        .eq("user_id", req.userId!)
        .maybeSingle(),
      supabase
        .from("credit_transactions")
        .select("id, type, amount, balance_after, description, created_at")
        .eq("user_id", req.userId!)
        .order("created_at", { ascending: false })
        .limit(10),
    ]);

    res.json({
      credit_balance: (profile?.credit_balance as number) ?? 0,
      subscription_tier: (profile?.subscription_tier as string) ?? "free",
      subscription_status: (profile?.subscription_status as string) ?? "inactive",
      current_period_end: sub?.current_period_end ?? null,
      transactions: txns ?? [],
    });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch billing status");
    res.status(500).json({ error: "Failed to fetch billing status" });
  }
});

// ── POST /billing/spend-fixed ─────────────────────────────────────────
router.post("/billing/spend-fixed", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const { amount, description } = req.body as { amount?: unknown; description?: unknown };

  if (typeof amount !== "number" || amount <= 0 || !Number.isInteger(amount)) {
    res.status(400).json({ error: "amount must be a positive integer" });
    return;
  }

  const spend = await spendCreditsFixed(req.userId!, amount, String(description ?? "domain_purchase"));
  if (!spend.success) {
    const balance = await getCreditBalance(req.userId!);
    res.status(402).json({ error: "Insufficient credits", required: spend.required ?? amount, balance });
    return;
  }

  res.json({ success: true, newBalance: spend.newBalance });
});

// ── GET /billing/credit-costs ────────────────────────────────────────
router.get("/billing/credit-costs", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  try {
    const { data, error } = await supabase
      .from("credit_action_costs")
      .select("action_type, credits_cost, description");

    if (error) throw error;

    const costs: Record<string, number> = {};
    for (const row of data ?? []) {
      costs[row.action_type as string] = row.credits_cost as number;
    }
    res.json(costs);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch credit costs");
    res.status(500).json({ error: "Failed to fetch credit costs" });
  }
});

// ── POST /billing/cancel-subscription ───────────────────────────────
router.post("/billing/cancel-subscription", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  try {
    const { data: sub } = await supabase
      .from("subscriptions")
      .select("stripe_subscription_id")
      .eq("user_id", req.userId!)
      .maybeSingle();

    // Cancel in Stripe first so the customer is not billed again
    if (sub?.stripe_subscription_id) {
      try {
        await getStripe().subscriptions.cancel(sub.stripe_subscription_id as string);
      } catch (err: any) {
        if (err?.code !== "resource_missing") throw err; // already gone = fine
      }
    }

    await supabase
      .from("subscriptions")
      .update({ status: "cancelled" })
      .eq("user_id", req.userId!);

    await supabase
      .from("profiles")
      .update({ subscription_status: "inactive", subscription_tier: "free" })
      .eq("id", req.userId!);

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to cancel subscription");
    res.status(500).json({ error: "Failed to cancel subscription" });
  }
});

export default router;
