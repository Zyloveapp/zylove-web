import { useEffect, useState } from 'react'
import PinEntry from './PinEntry'
import PinReset from './PinReset'
import PinSetup from './PinSetup'
import { PinScreen } from './PinPad'
import { hasPin, loadPin } from '../services/playPin'

type Step = 'entry' | 'reset' | 'setup' | 'resetSetup' | 'changeSetup'

interface PlayPinFlowProps {
  uid: string
  // 'unlock': entering Play mode. 'change': Settings → Change Play PIN.
  purpose: 'unlock' | 'change'
  onDone: () => void
  onCancel: () => void
  // Shown under the entry title — the inactivity lock's timeout note.
  entrySubtitle?: string
}

// Entry → (forgot → SMS reset) → setup, as needed. With no PIN yet, starts
// at setup. Changing a PIN means entering the current one first. Whether a
// PIN is set comes from the server; until it answers the screen stays
// covered, and if it can't answer the user can retry or leave — never set a
// new PIN over one they may have (Stage B: fail closed).
export default function PlayPinFlow({ uid, purpose, onDone, onCancel, entrySubtitle }: PlayPinFlowProps) {
  const [step, setStep] = useState<Step | null>(() => (hasPin(uid) ? 'entry' : null))
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [currentPin, setCurrentPin] = useState<string | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    loadPin(uid).then(
      (set) => {
        if (!cancelled) setStep((s) => s ?? (set ? 'entry' : 'setup'))
      },
      () => {
        if (!cancelled) setFailed(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [uid, attempt])

  if (step === null) {
    return (
      <PinScreen
        title={failed ? "Couldn't check your PIN" : '🔥 Play is locked'}
        subtitle={failed ? <span className="text-white/50">Check your connection and try again.</span> : undefined}
      >
        {failed ? (
          <div className="flex flex-col items-center gap-3">
            <button
              type="button"
              onClick={() => {
                setFailed(false)
                setAttempt((n) => n + 1)
              }}
              className="rounded-xl bg-[#E03131] px-6 py-3 font-semibold text-white hover:opacity-90"
            >
              Try again
            </button>
            <button type="button" onClick={onCancel} className="text-sm text-white/40 hover:text-white">
              Cancel
            </button>
          </div>
        ) : (
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
        )}
      </PinScreen>
    )
  }

  if (step === 'reset') return <PinReset uid={uid} onVerified={() => setStep('resetSetup')} onCancel={onCancel} />
  if (step === 'setup') return <PinSetup uid={uid} onDone={onDone} onCancel={onCancel} />
  if (step === 'resetSetup') return <PinSetup uid={uid} reset onDone={onDone} onCancel={onCancel} />
  if (step === 'changeSetup') return <PinSetup uid={uid} currentPin={currentPin} onDone={onDone} onCancel={onCancel} />
  return (
    <PinEntry
      uid={uid}
      title={purpose === 'change' ? 'Enter your current PIN' : '🔥 Enter your PIN'}
      subtitle={entrySubtitle}
      onSuccess={
        purpose === 'change'
          ? (pin) => {
              setCurrentPin(pin)
              setStep('changeSetup')
            }
          : onDone
      }
      onCancel={onCancel}
      onForgot={() => setStep('reset')}
    />
  )
}
