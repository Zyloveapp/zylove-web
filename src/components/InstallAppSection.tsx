import { useState } from 'react'
import InstallGuide from './InstallGuide'

// Already launched from the home screen? display-mode covers Android and
// current iOS; navigator.standalone covers older iOS Safari.
function runningAsApp(): boolean {
  if (typeof window === 'undefined') return false
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
  return iosStandalone || window.matchMedia('(display-mode: standalone)').matches
}

// Settings → Install app: how to add Zylove to the home screen, or a note
// that this already is the installed app.
export default function InstallAppSection() {
  const [installed] = useState(runningAsApp)
  const [open, setOpen] = useState(false)

  if (installed) return <p className="text-sm text-white/50">✦ You're using the Zylove app</p>

  return (
    <section className="rounded-2xl border border-white/10 bg-white/5">
      <h2 className="px-5 pt-4 text-xs font-semibold uppercase tracking-widest text-white/40">Install app</h2>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left hover:bg-white/[0.03]"
      >
        <span>
          <span className="block font-medium">Add Zylove to your home screen</span>
          <span className="block text-sm text-white/50">
            Get the full app experience — launches fullscreen, works like a native app.
          </span>
        </span>
        <span className="shrink-0 text-sm font-semibold text-[#7C9BFF]">How to install →</span>
      </button>
      {open && <InstallGuide onClose={() => setOpen(false)} />}
    </section>
  )
}
