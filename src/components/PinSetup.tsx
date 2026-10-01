import { useState } from 'react'
import PinPad, { PinScreen } from './PinPad'
import { PIN_LENGTH, savePin } from '../services/playPin'

interface PinSetupProps {
  uid: string
  onDone: () => void
  onCancel: () => void
}

// Create, then confirm. A mismatch starts over.
export default function PinSetup({ uid, onDone, onCancel }: PinSetupProps) {
  const [first, setFirst] = useState<string | null>(null)
  const [value, setValue] = useState('')
  const [mismatch, setMismatch] = useState(false)
  const [shake, setShake] = useState(false)
  const [saving, setSaving] = useState(false)

  async function change(next: string) {
    setValue(next)
    if (next.length > 0) setMismatch(false)
    if (next.length < PIN_LENGTH) return
    if (first === null) {
      setFirst(next)
      setValue('')
      return
    }
    if (next !== first) {
      setFirst(null)
      setValue('')
      setMismatch(true)
      setShake(true)
      setTimeout(() => setShake(false), 450)
      return
    }
    setSaving(true)
    await savePin(uid, next)
    onDone()
  }

  const confirming = first !== null

  return (
    <PinScreen
      title={confirming ? 'Confirm your PIN' : 'Create your Play PIN'}
      subtitle={confirming ? 'Enter the same 4 digits again.' : 'Your PIN keeps Play mode private on shared devices.'}
    >
      <PinPad key={confirming ? 'confirm' : 'create'} value={value} onChange={change} disabled={saving} shake={shake} />
      <p className="mt-6 h-5 text-sm text-red-400" role="alert">
        {mismatch ? "PINs don't match. Try again." : ''}
      </p>
      <button type="button" onClick={onCancel} className="mt-4 text-sm text-white/50 hover:text-white">
        Cancel
      </button>
    </PinScreen>
  )
}
