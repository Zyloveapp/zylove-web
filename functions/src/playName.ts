import { getFirestore } from 'firebase-admin/firestore'

function nonEmpty(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

// Someone's Play name: their Play profile's playDisplayName (the enforced
// one since Stage 2), else an older root copy, else the profile's own name,
// else 'Someone' — never the Spark
// displayName (mode sealing). Same order as modeIdentity in index.ts and
// playNameOf in the web app. For Play surfaces whose match snapshot may
// predate the Play name (older matches carry the Spark one).
export async function loadPlayName(uid: string): Promise<string> {
  if (!uid) return 'Someone'
  const db = getFirestore()
  const [root, play] = await Promise.all([
    db.doc(`users/${uid}`).get().catch(() => null),
    db.doc(`users/${uid}/playProfile/data`).get().catch(() => null),
  ])
  const r = root?.data()
  const p = play?.data()
  return nonEmpty(p?.playDisplayName) ?? nonEmpty(r?.playDisplayName) ?? nonEmpty(p?.displayName) ?? 'Someone'
}
