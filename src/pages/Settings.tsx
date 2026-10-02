import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { hasPin } from '../services/playPin'
import PlayPinFlow from '../components/PlayPinFlow'

// Stub settings page. For now: the Play PIN.
export default function Settings() {
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const navigate = useNavigate()
  const [flow, setFlow] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  // Re-read on every render: the flow can set or clear the PIN.
  const pinSet = uid ? hasPin(uid) : false

  return (
    <div className="min-h-[calc(100dvh-7rem)] bg-gray-950 px-4 py-6 text-white">
      <div className="mx-auto max-w-xl space-y-6">
        <h1 className="text-2xl font-bold">Settings</h1>

        <section className="rounded-2xl border border-white/10 bg-white/5">
          <h2 className="px-5 pt-4 text-xs font-semibold uppercase tracking-widest text-white/40">Privacy</h2>
          <button
            type="button"
            onClick={() => {
              setNotice(null)
              setFlow(true)
            }}
            className="flex w-full items-center justify-between px-5 py-4 text-left hover:bg-white/[0.03]"
          >
            <span>
              <span className="block font-medium">{pinSet ? 'Change Play PIN' : 'Set a Play PIN'}</span>
              <span className="block text-sm text-white/50">Keeps Play mode private on shared devices.</span>
            </span>
            <span className="text-white/30" aria-hidden>
              ›
            </span>
          </button>
          {notice && <p className="px-5 pb-4 text-sm text-emerald-300">{notice}</p>}
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/5">
          <h2 className="px-5 pt-4 text-xs font-semibold uppercase tracking-widest text-white/40">Safety</h2>
          <button
            type="button"
            onClick={() => navigate('/settings/report')}
            className="flex w-full items-center justify-between px-5 py-4 text-left hover:bg-white/[0.03]"
          >
            <span>
              <span className="block font-medium">Report a past connection</span>
              <span className="block text-sm text-white/50">Anyone you matched with in the last 90 days.</span>
            </span>
            <span className="text-white/30" aria-hidden>
              ›
            </span>
          </button>
        </section>
      </div>

      {flow && (
        <PlayPinFlow
          uid={uid}
          purpose="change"
          onDone={() => {
            setFlow(false)
            setNotice('Play PIN updated ✦')
          }}
          onCancel={() => setFlow(false)}
        />
      )}
    </div>
  )
}
