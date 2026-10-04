import { useEffect, useState } from 'react'
import PinPad, { PinScreen } from './PinPad'
import { PIN_LENGTH, checkPin, lockedUntil } from '../services/playPin'

interface PinEntryProps {
  uid: string
  title?: string
  // e.g. the inactivity lock's "Your session timed out for privacy."
  subtitle?: string
  onSuccess: () => void
  onCancel: () => void
  onForgot: () => void
}

// Auto-submits on the fourth digit. Three misses lock entry for 30 seconds.
export default function PinEntry({
  uid,
  title = '🔥 Enter your PIN',
  subtitle,
  onSuccess,
  onCancel,
  onForgot,
}: PinEntryProps) {
  const [value, setValue] = useState('')
  const [checking, setChecking] = useState(false)
  const [wrong, setWrong] = useState(false)
  const [shake, setShake] = useState(false)
  const [lockEnd, setLockEnd] = useState(() => lockedUntil(uid))
  const [now, setNow] = useState(() => Date.now())

  const locked = lockEnd > now
  useEffect(() => {
    if (!locked) return
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [locked])

  async function change(next: string) {
    setValue(next)
    if (next.length > 0) setWrong(false)
    if (next.length < PIN_LENGTH) return
    setChecking(true)
    const result = await checkPin(uid, next)
    setChecking(false)
    if (result === 'ok') return onSuccess()
    setValue('')
    setShake(true)
    setTimeout(() => setShake(false), 450)
    if (result === 'locked') {
      setLockEnd(lockedUntil(uid))
      setNow(Date.now())
      setWrong(false)
    } else {
      setWrong(true)
    }
  }

  const secondsLeft = Math.ceil((lockEnd - now) / 1000)

  return (
    <PinScreen title={title} subtitle={subtitle && <span className="text-white/40">{subtitle}</span>}>
      <PinPad value={value} onChange={change} disabled={checking || locked} shake={shake} />
      <p className="mt-6 h-5 text-sm text-red-400" role="alert">
        {locked ? `Too many attempts. Try again in ${secondsLeft} seconds.` : wrong ? 'Incorrect PIN' : ''}
      </p>
      <div className="mt-4 flex flex-col items-center gap-3">
        <button type="button" onClick={onForgot} className="text-sm text-[#E03131]/70 hover:text-[#E03131]">
          Forgot your PIN?
        </button>
        <button type="button" onClick={onCancel} className="text-sm text-white/40 hover:text-white">
          Cancel
        </button>
      </div>
    </PinScreen>
  )
}
