// Publishable (public) key. Checkout and the Customer Portal are Stripe-hosted
// pages reached via URLs from createCheckoutSession / createPortalSession, so
// nothing loads Stripe.js yet; this is here for when something does.
export const STRIPE_PUBLISHABLE_KEY =
  'pk_live_51TJjsx0zZVFuoBJLYGFkew2vS2nCptZndnVRsYzuAbPJo0vInsgnBJ0ghE3GKLTQSc1Sy9d465VN8bTaoP3lPwII00zBhqbcBR'
