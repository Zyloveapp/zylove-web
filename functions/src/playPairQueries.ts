import type { DocumentData } from 'firebase-admin/firestore'

// playPairData's internal `users` (pairPlay.ts): the one that isn't `uid`.
export function otherUidOf(data: DocumentData, uid: string): string | null {
  const users: unknown = data.users
  if (!Array.isArray(users) || !users.includes(uid)) return null
  const other: unknown = users.find((u) => u !== uid)
  return typeof other === 'string' ? other : null
}
