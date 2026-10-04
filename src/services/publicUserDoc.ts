import { doc, getDoc, type DocumentData } from 'firebase/firestore'
import { db } from './firebase'

// One users/{uid} read per uid per session, shared by the badges on lists
// built from snapshots (matches, sparks) that don't carry tier or founder.
const cache = new Map<string, Promise<DocumentData | null>>()

export function fetchPublicUserDoc(uid: string): Promise<DocumentData | null> {
  let request = cache.get(uid)
  if (!request) {
    request = getDoc(doc(db, 'users', uid))
      .then((snap) => snap.data() ?? null)
      .catch(() => null)
    cache.set(uid, request)
  }
  return request
}
