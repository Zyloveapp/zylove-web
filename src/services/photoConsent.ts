import { doc, getDoc, onSnapshot, serverTimestamp, updateDoc, type Unsubscribe } from 'firebase/firestore'
import { db } from './firebase'

// Opt-in AI photo coaching for the profile reviews, per mode, at
// users/{uid}.photoAnalysisConsent: { spark, play, acknowledgedAt }. Both
// default off; the reviews only send photos when their mode's flag is true.

export type PhotoConsentMode = 'spark' | 'play'

export interface PhotoConsent {
  spark: boolean
  play: boolean
  // The consent notice has been accepted once; later switches are immediate.
  acknowledged: boolean
}

export function subscribePhotoConsent(
  uid: string,
  onChange: (consent: PhotoConsent) => void,
  onError: () => void,
): Unsubscribe {
  return onSnapshot(
    doc(db, 'users', uid),
    (snap) => {
      const c = snap.data()?.photoAnalysisConsent
      onChange({
        spark: c?.spark === true,
        play: c?.play === true,
        acknowledged: c?.acknowledgedAt != null,
      })
    },
    onError,
  )
}

// The saved choice for one mode: true / false, or null if they've never
// been asked (the review sheet asks before generating).
export async function getPhotoConsentChoice(uid: string, mode: PhotoConsentMode): Promise<boolean | null> {
  const choice: unknown = (await getDoc(doc(db, 'users', uid))).data()?.photoAnalysisConsent?.[mode]
  return typeof choice === 'boolean' ? choice : null
}

// acknowledge: record that the consent notice was accepted (with when).
export async function setPhotoConsent(
  uid: string,
  mode: PhotoConsentMode,
  enabled: boolean,
  { acknowledge = false } = {},
): Promise<void> {
  await updateDoc(doc(db, 'users', uid), {
    [`photoAnalysisConsent.${mode}`]: enabled,
    [`photoAnalysisConsent.${mode}UpdatedAt`]: serverTimestamp(),
    ...(acknowledge && { 'photoAnalysisConsent.acknowledgedAt': serverTimestamp() }),
  })
}
