import { onObjectDeleted } from 'firebase-functions/v2/storage'
import { forgetPhoto } from './photoHashes'

// T&S Phase 5 — a profile photo's file was deleted: its hash goes with it
// (kept in its own module: a Storage trigger needs the bucket at import).
export const photoHashOnDelete = onObjectDeleted({ memory: '256MiB', timeoutSeconds: 60 }, async (event) => {
  const path = event.data.name
  if (!path || !/^photos\/[^/]+\/(spark|play)\//.test(path)) return
  await forgetPhoto(path)
})
