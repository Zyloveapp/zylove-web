import { onSchedule } from 'firebase-functions/v2/scheduler'
import { logger } from 'firebase-functions'
import { Timestamp, getFirestore } from 'firebase-admin/firestore'

// 3am Central: flags men whose 30-day trial has ended (trialExpired: true).
// subscriptionTier is left alone — Stripe sets it when they pay. Only
// trialEndsAt is queried (a single-field index), so the tier filter runs here.
export const checkTrialStatus = onSchedule(
  { schedule: '0 3 * * *', timeZone: 'America/Chicago', timeoutSeconds: 300, memory: '256MiB' },
  async () => {
    const db = getFirestore()
    const ended = await db.collection('users').where('trialEndsAt', '<', Timestamp.now()).get()
    const expiring = ended.docs.filter((d) => {
      const data = d.data()
      return (data.subscriptionTier ?? 'free') === 'free' && data.trialExpired !== true
    })
    for (let i = 0; i < expiring.length; i += 450) {
      const batch = db.batch()
      for (const d of expiring.slice(i, i + 450)) batch.update(d.ref, { trialExpired: true })
      await batch.commit()
    }
    logger.info('checkTrialStatus', { trialsEnded: ended.size, markedExpired: expiring.length })
  },
)
