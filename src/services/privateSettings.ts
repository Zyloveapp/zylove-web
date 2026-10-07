import { doc, getDoc, onSnapshot, setDoc, type DocumentData, type Unsubscribe } from 'firebase/firestore'
import { db } from './firebase'
import { accountDoc } from './subscription'

// The user's own preferences live in users/{uid}/private/settings (only the
// owner reads or writes it; the rules allow these keys and nothing else):
//
//   smsNotificationsEnabled, smsNotifications, smsQuietHours   texts
//   photoAnalysisConsent                                        AI photo coaching
//
// SMS consent (with the verified phone number) is server-written, in
// private/account. Accounts from before the move still have the old copies on
// the public doc; those count until migrated.

export const settingsDoc = (uid: string) => doc(db, 'users', uid, 'private', 'settings')

const SETTINGS_KEYS = ['smsNotificationsEnabled', 'smsNotifications', 'smsQuietHours', 'photoAnalysisConsent'] as const

function settingsView(root: DocumentData | undefined, settings: DocumentData | undefined, account: DocumentData | undefined): DocumentData {
  const view: DocumentData = {}
  for (const k of SETTINGS_KEYS) view[k] = settings?.[k] !== undefined ? settings[k] : root?.[k]
  view.smsConsent = account?.smsConsent ?? root?.smsConsent ?? null
  // Set by the server when they reply STOP; cleared by START or a new opt-in.
  view.smsOptOut = account?.smsOptOut ?? null
  return view
}

export async function loadSettingsView(uid: string): Promise<DocumentData> {
  const [root, settings, account] = await Promise.all([
    getDoc(doc(db, 'users', uid)).catch(() => null),
    getDoc(settingsDoc(uid)).catch(() => null),
    getDoc(accountDoc(uid)).catch(() => null),
  ])
  return settingsView(root?.data(), settings?.data(), account?.data())
}

// Live settings view. Fires once all three docs have answered; an unreadable
// private doc counts as empty, an unreadable settings doc is an error.
export function subscribeSettingsView(uid: string, onChange: (view: DocumentData) => void, onError: () => void): Unsubscribe {
  const docs: { root?: DocumentData; settings?: DocumentData; account?: DocumentData } = {}
  const seen = new Set<string>()
  const emit = () => {
    if (seen.size === 3) onChange(settingsView(docs.root, docs.settings, docs.account))
  }
  const listen = (key: 'root' | 'settings' | 'account', ref: ReturnType<typeof doc>, fatal: boolean) =>
    onSnapshot(
      ref,
      (snap) => {
        docs[key] = snap.data()
        seen.add(key)
        emit()
      },
      () => {
        if (fatal) return onError()
        docs[key] = undefined
        seen.add(key)
        emit()
      },
    )
  const offs = [
    listen('root', doc(db, 'users', uid), false),
    listen('settings', settingsDoc(uid), true),
    listen('account', accountDoc(uid), false),
  ]
  return () => offs.forEach((off) => off())
}

// Merges `patch` (nested maps merge too) into private/settings.
export async function saveSettings(uid: string, patch: DocumentData): Promise<void> {
  await setDoc(settingsDoc(uid), patch, { merge: true })
}
