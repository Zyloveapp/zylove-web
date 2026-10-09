// functions/src/notifications.ts
//
// Shared push-notification helper. All server-side senders (onLike,
// sendSuperLike, onMessageCreate, onBotMessage, onDailySchedule,
// onPhotoUpload) call sendPush(). Failures never throw — push is best-
// effort and must never block a Firestore write.
//
// Quiet hours: 11pm–8am CT (no message pushes).
// Daily message cap: 3/day per recipient (notificationCaps/{uid}_{date}).
// Token validation: only ExponentPushToken-prefixed tokens are accepted;
// declined users persist `null` and are filtered out client-side.

import * as admin from 'firebase-admin'
import { loadInternal } from '../userData'

// Lazy db getter — admin.initializeApp() runs in index.ts, but this module
// is imported transitively before that line executes. Calling
// admin.firestore() at module top level throws app/no-app at load time.
function db() {
  return admin.firestore()
}

interface PushMessage {
  to: string
  title: string
  body: string
  data?: Record<string, string>
  sound?: string
}

function isQuietHours(): boolean {
  const now = new Date()
  const ct = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }))
  const hour = ct.getHours()
  return hour >= 23 || hour < 8
}

export async function sendPush(
  tokens: string[],
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<void> {
  const valid = tokens.filter(t => t && t.startsWith('ExponentPushToken'))
  if (valid.length === 0) return

  const messages: PushMessage[] = valid.map(token => ({
    to: token,
    title,
    body,
    data: data ?? {},
    sound: 'default',
  }))

  for (let i = 0; i < messages.length; i += 100) {
    const batch = messages.slice(i, i + 100)
    try {
      await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(batch),
      })
    } catch (e) {
      console.error('[notifications] Push batch failed:', e)
    }
  }
}

export async function getToken(uid: string): Promise<string | null> {
  const token = (await loadInternal(uid)).expoPushToken
  return token && typeof token === 'string' && token.startsWith('ExponentPushToken')
    ? token
    : null
}

export async function isMessageCapReached(uid: string): Promise<boolean> {
  const today = new Date().toISOString().split('T')[0]
  const capRef = db().doc(`notificationCaps/${uid}_${today}`)
  const snap = await capRef.get()
  const count = snap.data()?.messageCount ?? 0
  return count >= 3
}

export async function incrementMessageCap(uid: string): Promise<void> {
  const today = new Date().toISOString().split('T')[0]
  const capRef = db().doc(`notificationCaps/${uid}_${today}`)
  await capRef.set(
    // updatedAt: what retention.ts purges by.
    { messageCount: admin.firestore.FieldValue.increment(1), updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  )
}

export { isQuietHours }
