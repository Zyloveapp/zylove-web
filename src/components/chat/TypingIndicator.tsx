import { useEffect, useState, type CSSProperties } from 'react'
import type { Mode } from '../../store/modeStore'

const EXIT_MS = 150

// Three pulsing dots in a received-message bubble. Stays mounted briefly after
// `visible` turns off so it can fade out.
export default function TypingIndicator({ visible, mode }: { visible: boolean; mode: Mode }) {
  const [mounted, setMounted] = useState(visible)
  const [lastVisible, setLastVisible] = useState(visible)
  if (visible !== lastVisible) {
    setLastVisible(visible)
    if (visible) setMounted(true)
  }

  useEffect(() => {
    if (visible) return
    const timer = setTimeout(() => setMounted(false), EXIT_MS)
    return () => clearTimeout(timer)
  }, [visible])

  if (!mounted) return null
  const dot = mode === 'play' ? 'bg-[#E03131]' : 'bg-[#1B4FD8]'
  return (
    <div className={`flex items-start ${visible ? 'zy-typing-in' : 'zy-typing-out'}`} aria-live="polite">
      <div className="flex items-center gap-1.5 rounded-2xl rounded-bl-sm bg-white/10 px-4 py-3" aria-label="Typing">
        {[0, 200, 400].map((delay) => (
          <span
            key={delay}
            className={`zy-typing-dot h-2 w-2 rounded-full ${dot}`}
            style={{ '--zy-dot-delay': `${delay}ms` } as CSSProperties}
          />
        ))}
      </div>
    </div>
  )
}
