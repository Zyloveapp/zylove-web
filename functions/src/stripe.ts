// Stripe subscriptions: Checkout for new subscribers, the Customer Portal for
// managing one, and a webhook that keeps userInternal/{uid} (server-only;
// mirrored to the user's private/account) in step with Stripe.
//
// The stored stripeCustomerId is still never trusted on its own (older
// accounts' copy sat on the client-writable root doc): a customer belongs to
// a user only if the customer's Stripe metadata.uid — set here, server-side —
// says so. The webhook finds the user the same way.

import { HttpsError, onCall, onRequest } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'
import { logger } from 'firebase-functions'
import { FieldValue } from 'firebase-admin/firestore'
import Stripe = require('stripe')
import { SMS_SECRETS, sendSMS, smsTarget } from './sms'
import { internalRef, loadInternal } from './userData'

const stripeSecretKey = defineSecret('STRIPE_SECRET_KEY')
const stripeWebhookSecret = defineSecret('STRIPE_WEBHOOK_SECRET')

type PaidTier = 'spark_plus' | 'elite'

const PRICE_IDS: Record<PaidTier, string> = {
  spark_plus: 'price_1UMhth0zZVFuoBJLuhimNJrB',
  elite: 'price_1UMhuh0zZVFuoBJLqUDoGdl2',
}

const UPGRADE_URL = 'https://www.zylove.app/upgrade'

// Subscriptions in these states still bill (or are about to): a second
// Checkout would double-charge, so plan changes go through the portal.
const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid'])

let client: Stripe | null = null
function stripe(): Stripe {
  client ??= new Stripe(stripeSecretKey.value())
  return client
}

function tierForPrice(priceId: string | undefined): PaidTier | null {
  if (priceId === PRICE_IDS.spark_plus) return 'spark_plus'
  if (priceId === PRICE_IDS.elite) return 'elite'
  return null
}

function idOf(v: string | { id: string } | null | undefined): string | null {
  if (!v) return null
  return typeof v === 'string' ? v : v.id
}

// Billing state lives in userInternal (server-only).
const billingRef = internalRef

// The customer's uid from Stripe metadata, or null if it isn't one of ours.
async function uidForCustomer(customerId: string): Promise<string | null> {
  const customer = await stripe().customers.retrieve(customerId)
  if (customer.deleted) return null
  const uid = customer.metadata?.uid
  return typeof uid === 'string' && uid ? uid : null
}

// The caller's Stripe customer id if users/{uid}.stripeCustomerId points at a
// live customer whose metadata names this uid; null otherwise.
async function verifiedCustomerId(uid: string): Promise<string | null> {
  const stored: unknown = (await loadInternal(uid)).stripeCustomerId
  if (typeof stored !== 'string' || !stored.startsWith('cus_')) return null
  try {
    return (await uidForCustomer(stored)) === uid ? stored : null
  } catch (err) {
    logger.warn('Stored Stripe customer unusable', { message: err instanceof Error ? err.message : String(err) })
    return null
  }
}

function parseTier(data: unknown): PaidTier {
  const tier = typeof data === 'object' && data !== null ? (data as Record<string, unknown>).tier : undefined
  if (tier !== 'spark_plus' && tier !== 'elite') throw new HttpsError('invalid-argument', "tier must be 'spark_plus' or 'elite'")
  return tier
}

// ─── createCheckoutSession ───────────────────────────────────────────────────

export const createCheckoutSession = onCall(
  { timeoutSeconds: 60, memory: '256MiB', secrets: [stripeSecretKey], invoker: 'public' },
  async (request): Promise<{ url: string }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const uid = request.auth.uid
    const tier = parseTier(request.data)

    let customerId = await verifiedCustomerId(uid)
    if (customerId) {
      const subs = await stripe().subscriptions.list({ customer: customerId, status: 'all', limit: 20 })
      if (subs.data.some((s) => LIVE_STATUSES.has(s.status))) {
        throw new HttpsError('already-exists', 'You already have a subscription. Use Manage subscription to change plans.')
      }
    } else {
      const email = typeof request.auth.token.email === 'string' ? request.auth.token.email : undefined
      // Keyed on uid so a double tap doesn't create two customers.
      const customer = await stripe().customers.create(
        { metadata: { uid }, ...(email ? { email } : {}) },
        { idempotencyKey: `zylove-customer-${uid}` },
      )
      customerId = customer.id
      await billingRef(uid).set({ stripeCustomerId: customerId }, { merge: true })
    }

    const session = await stripe().checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: uid,
      line_items: [{ price: PRICE_IDS[tier], quantity: 1 }],
      success_url: `${UPGRADE_URL}?success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${UPGRADE_URL}?canceled=true`,
      metadata: { uid, tier },
      subscription_data: { metadata: { uid, tier } },
      allow_promotion_codes: true,
    })
    if (!session.url) throw new HttpsError('internal', 'Checkout is unavailable right now')
    logger.info('createCheckoutSession', { tier })
    return { url: session.url }
  },
)

// ─── createPortalSession ─────────────────────────────────────────────────────

export const createPortalSession = onCall(
  { timeoutSeconds: 30, memory: '256MiB', secrets: [stripeSecretKey], invoker: 'public' },
  async (request): Promise<{ url: string }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required')
    const customerId = await verifiedCustomerId(request.auth.uid)
    if (!customerId) throw new HttpsError('failed-precondition', 'No subscription to manage')
    const portal = await stripe().billingPortal.sessions.create({ customer: customerId, return_url: UPGRADE_URL })
    return { url: portal.url }
  },
)

// ─── stripeWebhook ───────────────────────────────────────────────────────────

// Applies a subscription's state to its user. Events for a subscription other
// than the one on file are stale (an old, replaced subscription) and ignored —
// unless none is on file yet, as when this arrives before checkout's event.
async function applySubscription(sub: Stripe.Subscription, deleted: boolean): Promise<void> {
  const customerId = idOf(sub.customer)
  const uid = customerId ? await uidForCustomer(customerId) : null
  if (!uid) return void logger.warn('Subscription event for unknown customer', { subscription: sub.id })

  const ref = billingRef(uid)
  const onFile: unknown = (await loadInternal(uid)).stripeSubscriptionId
  if (typeof onFile === 'string' && onFile && onFile !== sub.id) {
    return void logger.info('Ignoring event for replaced subscription', { subscription: sub.id })
  }

  const now = FieldValue.serverTimestamp()
  if (deleted) {
    await ref.set(
      { subscriptionTier: 'free', subscriptionStatus: 'canceled', stripeSubscriptionId: null, subscriptionUpdatedAt: now },
      { merge: true },
    )
    return void logger.info('Subscription deleted', { subscription: sub.id })
  }

  switch (sub.status) {
    case 'active':
    case 'trialing': {
      // Read the tier off the price so a plan switch in the portal lands too.
      const tier = tierForPrice(sub.items.data[0]?.price?.id)
      await ref.set(
        {
          ...(tier ? { subscriptionTier: tier } : {}),
          subscriptionStatus: 'active',
          stripeSubscriptionId: sub.id,
          trialExpired: false,
          subscriptionUpdatedAt: now,
        },
        { merge: true },
      )
      break
    }
    case 'past_due':
      // Stripe is retrying the charge; access stays until it gives up.
      await ref.set({ subscriptionStatus: 'past_due', subscriptionUpdatedAt: now }, { merge: true })
      break
    case 'canceled':
    case 'unpaid':
    case 'incomplete_expired':
    case 'paused':
      await ref.set(
        { subscriptionTier: 'free', subscriptionStatus: sub.status === 'unpaid' ? 'unpaid' : 'canceled', subscriptionUpdatedAt: now },
        { merge: true },
      )
      break
    default:
      // 'incomplete': checkout hasn't finished; its own event takes over.
      break
  }
  logger.info('Subscription updated', { subscription: sub.id, status: sub.status })
}

async function onCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  if (session.mode !== 'subscription') return
  if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
    return void logger.warn('Checkout completed without payment', { session: session.id, status: session.payment_status })
  }
  const uid = session.metadata?.uid
  const tier = session.metadata?.tier
  const subscriptionId = idOf(session.subscription)
  if (!uid || (tier !== 'spark_plus' && tier !== 'elite') || !subscriptionId) {
    return void logger.error('Checkout session missing uid, tier or subscription', { session: session.id })
  }
  await billingRef(uid).set(
    {
      subscriptionTier: tier,
      stripeSubscriptionId: subscriptionId,
      subscriptionStatus: 'active',
      subscriptionUpdatedAt: FieldValue.serverTimestamp(),
      trialExpired: false,
    },
    { merge: true },
  )
  logger.info('Checkout completed', { tier })
}

async function onPaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  const customerId = idOf(invoice.customer)
  const uid = customerId ? await uidForCustomer(customerId) : null
  if (!uid) return void logger.warn('Payment failed for unknown customer', { invoice: invoice.id })
  await billingRef(uid).set({ subscriptionStatus: 'past_due', subscriptionUpdatedAt: FieldValue.serverTimestamp() }, { merge: true })

  // One text per invoice (Stripe retries several times), only for people with
  // texts on in either mode, and never in their quiet hours.
  if (invoice.attempt_count !== 1) return
  const target = (await smsTarget(uid, 'billing', 'spark')) ?? (await smsTarget(uid, 'billing', 'play'))
  if (target) await sendSMS(target.phone, 'Your Zylove payment failed. Update your payment method at zylove.app/upgrade')
}

export const stripeWebhook = onRequest(
  {
    timeoutSeconds: 60,
    memory: '256MiB',
    secrets: [stripeSecretKey, stripeWebhookSecret, ...SMS_SECRETS],
    invoker: 'public',
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).send('Method not allowed')
      return
    }
    const signature = req.headers['stripe-signature']
    let event: Stripe.Event
    try {
      if (typeof signature !== 'string') throw new Error('Missing stripe-signature header')
      event = stripe().webhooks.constructEvent(req.rawBody, signature, stripeWebhookSecret.value())
    } catch (err) {
      logger.warn('stripeWebhook: signature check failed', { message: err instanceof Error ? err.message : String(err) })
      res.status(400).send('Invalid signature')
      return
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed':
          await onCheckoutCompleted(event.data.object)
          break
        case 'customer.subscription.updated':
          await applySubscription(event.data.object, false)
          break
        case 'customer.subscription.deleted':
          await applySubscription(event.data.object, true)
          break
        case 'invoice.payment_failed':
          await onPaymentFailed(event.data.object)
          break
        default:
          break
      }
      res.status(200).json({ received: true })
    } catch (err) {
      // Non-2xx makes Stripe retry the event later.
      logger.error('stripeWebhook: handler failed', { type: event.type, message: err instanceof Error ? err.message : String(err) })
      res.status(500).send('Handler failed')
    }
  },
)
