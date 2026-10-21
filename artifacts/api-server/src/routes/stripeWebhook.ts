import type { Request, Response } from "express";
import type Stripe from "stripe";
import { getStripe, getWebhookSecret } from "../lib/stripe";
import { supabase } from "../lib/supabase";
import { grantCredits } from "../lib/credits";
import { TOPUP_PACKS, SUBSCRIPTION_TIERS } from "../lib/billingPlans";

const idOf = (v: string | { id: string } | null | undefined): string | null =>
  !v ? null : typeof v === "string" ? v : v.id;

async function userIdForCustomer(customerId: string | null): Promise<string | null> {
  if (!customerId) return null;
  const { data } = await supabase
    .from("profiles")
    .select("id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  return (data?.id as string) ?? null;
}

// Fires for one-time top-ups AND the first subscription payment
async function handleCheckoutPaid(session: Stripe.Checkout.Session) {
  if (session.payment_status !== "paid") return; // async methods: wait for async_payment_succeeded

  const userId = session.metadata?.user_id ?? session.client_reference_id;
  if (!userId) return;

  // ── One-time top-up ──
  if (session.metadata?.type === "topup") {
    const pack = session.metadata.pack_id ? TOPUP_PACKS[session.metadata.pack_id] : null;
    if (!pack) return;

    await grantCredits(userId, pack.credits, "topup", `Credit top-up: ${pack.name}`, session.id);

    await supabase
      .from("topup_purchases")
      .update({
        status: "completed",
        stripe_payment_intent_id: idOf(session.payment_intent as any),
      })
      .eq("stripe_session_id", session.id);
    return;
  }

  // ── First subscription payment ──
  if (session.metadata?.type === "subscription") {
    const tier = session.metadata.tier;
    if (!tier || !SUBSCRIPTION_TIERS[tier]) return;

    await grantCredits(
      userId,
      SUBSCRIPTION_TIERS[tier].credits,
      "subscription_grant",
      `${tier} plan credits`,
      session.id,
    );

    await supabase.from("subscriptions").upsert(
      {
        user_id: userId,
        tier,
        status: "active",
        stripe_customer_id: idOf(session.customer as any),
        stripe_subscription_id: idOf(session.subscription as any),
        credits_granted_this_period: true,
      },
      { onConflict: "user_id" },
    );

    await supabase
      .from("profiles")
      .update({ subscription_tier: tier, subscription_status: "active" })
      .eq("id", userId);
  }
}

// Monthly renewals: grant that month's credits
async function handleInvoicePaid(invoice: Stripe.Invoice) {
  if (invoice.billing_reason !== "subscription_cycle") return; // first payment handled above

  const userId = await userIdForCustomer(idOf(invoice.customer as any));
  if (!userId) return;

  const { data: sub } = await supabase
    .from("subscriptions")
    .select("tier")
    .eq("user_id", userId)
    .maybeSingle();

  const tier = sub?.tier as string | undefined;
  if (!tier || !SUBSCRIPTION_TIERS[tier]) return;

  await grantCredits(
    userId,
    SUBSCRIPTION_TIERS[tier].credits,
    "subscription_grant",
    `${tier} plan credits (renewal)`,
    invoice.id as string,
  );

  const periodEnd = invoice.lines?.data?.[0]?.period?.end;
  await supabase
    .from("subscriptions")
    .update({
      status: "active",
      credits_granted_this_period: true,
      ...(periodEnd ? { current_period_end: new Date(periodEnd * 1000).toISOString() } : {}),
    })
    .eq("user_id", userId);

  await supabase.from("profiles").update({ subscription_status: "active" }).eq("id", userId);
}

async function handleInvoiceFailed(invoice: Stripe.Invoice) {
  const userId = await userIdForCustomer(idOf(invoice.customer as any));
  if (!userId) return;
  await supabase.from("profiles").update({ subscription_status: "past_due" }).eq("id", userId);
}

// Subscription ended (cancelled in dashboard, or dunning gave up)
async function handleSubscriptionDeleted(sub: Stripe.Subscription) {
  const userId = await userIdForCustomer(idOf(sub.customer as any));
  if (!userId) return;

  const { data: row } = await supabase
    .from("subscriptions")
    .select("stripe_subscription_id")
    .eq("user_id", userId)
    .maybeSingle();

  // Ignore if user already moved to a newer subscription
  if (row?.stripe_subscription_id && row.stripe_subscription_id !== sub.id) return;

  await supabase.from("subscriptions").update({ status: "cancelled" }).eq("user_id", userId);
  await supabase
    .from("profiles")
    .update({ subscription_status: "inactive", subscription_tier: "free" })
    .eq("id", userId);
}

export async function stripeWebhookHandler(req: Request, res: Response): Promise<void> {
  const signature = req.headers["stripe-signature"];
  if (!signature) {
    res.status(400).send("Missing stripe-signature header");
    return;
  }

  let event: Stripe.Event;
  try {
    // req.body MUST be the raw Buffer (mounted with express.raw before express.json)
    event = getStripe().webhooks.constructEvent(req.body, signature, getWebhookSecret());
  } catch (err: any) {
    res.status(400).send(`Webhook signature verification failed: ${err.message}`);
    return;
  }

  // Idempotency: claim the event id; duplicate delivery = skip
  const { error: claimError } = await supabase
    .from("stripe_events")
    .insert({ id: event.id, type: event.type });

  if (claimError) {
    if (claimError.code === "23505") {
      res.json({ received: true, duplicate: true });
      return;
    }
        console.error("Stripe webhook: failed to record event", claimError);
    res.status(500).send("Failed to record event");
    return;
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        await handleCheckoutPaid(event.data.object as Stripe.Checkout.Session);
        break;
      case "invoice.paid":
        await handleInvoicePaid(event.data.object as Stripe.Invoice);
        break;
      case "invoice.payment_failed":
        await handleInvoiceFailed(event.data.object as Stripe.Invoice);
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;
      default:
        break;
    }
    res.json({ received: true });
  } catch (err) {
    console.error("Stripe webhook handler failed", event.type, err);
    // release the claim so Stripe's retry can reprocess
    await supabase.from("stripe_events").delete().eq("id", event.id);
    res.status(500).send("Webhook handler failed");
  }
}
