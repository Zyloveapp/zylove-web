import { signOut } from 'firebase/auth'
import { auth } from './firebase'
import { deletePrivateKey } from './keys'
import { getBackupInfo } from './keyBackup'

// Signing out leaves nothing of the account in this browser (Stage B): every
// zylove_* entry in localStorage and sessionStorage (drafts — Play ones
// included — caches, seen-flags) goes, and so does the chat key unless the
// user chose "Remember this device". 'ifNoBackup' (sign-out buttons outside
// Settings, which don't ask) keeps the key only when there's no chat PIN
// backup to bring it back — forgetting it then would lose their messages.
export async function signOutAndWipe({ keepChatKey }: { keepChatKey: boolean | 'ifNoBackup' }): Promise<void> {
  const uid = auth.currentUser?.uid ?? null
  let keep = keepChatKey === true
  if (keepChatKey === 'ifNoBackup') keep = !(await getBackupInfo().then((b) => b.exists, () => false))
  await signOut(auth).catch(() => {})
  for (const store of [localStorageSafe(), sessionStorageSafe()]) {
    if (!store) continue
    try {
      for (const k of Object.keys(store)) if (k.startsWith('zylove_')) store.removeItem(k)
    } catch {
      // ignore
    }
  }
  if (uid && !keep) await deletePrivateKey(uid)
  // A fresh page: nothing decrypted or cached stays in memory either.
  window.location.assign('/login')
}

function localStorageSafe(): Storage | null {
  try {
    return localStorage
  } catch {
    return null
  }
}
function sessionStorageSafe(): Storage | null {
  try {
    return sessionStorage
  } catch {
    return null
  }
}
