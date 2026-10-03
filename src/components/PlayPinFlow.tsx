import { useEffect, useState } from 'react'
import PinEntry from './PinEntry'
import PinReset from './PinReset'
import PinSetup from './PinSetup'
import { hasPin, loadPin } from '../services/playPin'

type Step = 'entry' | 'reset' | 'setup'

interface PlayPinFlowProps {
  uid: string
  // 'unlock': entering Play mode. 'change': Settings → Change Play PIN.
  purpose: 'unlock' | 'change'
  onDone: () => void
  onCancel: () => void
}

// Entry → (forgot → SMS reset) → setup, as needed. With no PIN yet, starts
// at setup. Changing a PIN means entering the current one first. The saved
// PIN is checked in Firestore first, so a browser that lost its copy asks
// for the existing PIN instead of making the user set a new one.
export default function PlayPinFlow({ uid, purpose, onDone, onCancel }: PlayPinFlowProps) {
  const [step, setStep] = useState<Step | null>(() => (hasPin(uid) ? 'entry' : null))

  useEffect(() => {
    let cancelled = false
    loadPin(uid).then((set) => {
      if (!cancelled) setStep((s) => s ?? (set ? 'entry' : 'setup'))
    })
    return () => {
      cancelled = true
    }
  }, [uid])

  if (step === null) return null

  if (step === 'reset') return <PinReset uid={uid} onVerified={() => setStep('setup')} onCancel={onCancel} />
  if (step === 'setup') return <PinSetup uid={uid} onDone={onDone} onCancel={onCancel} />
  return (
    <PinEntry
      uid={uid}
      title={purpose === 'change' ? 'Enter your current PIN' : 'Enter your Play PIN'}
      onSuccess={purpose === 'change' ? () => setStep('setup') : onDone}
      onCancel={onCancel}
      onForgot={() => setStep('reset')}
    />
  )
}
