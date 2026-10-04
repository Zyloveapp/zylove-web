// Play inactivity lock. Last activity in Play lives in sessionStorage; after
// 2 minutes without any (or with no record, e.g. a new tab), Play asks for
// the PIN again. Checked on load and whenever the tab comes back into view.

export const INACTIVITY_TIMEOUT = 2 * 60 * 1000 // 2 minutes
const KEY = 'zylove_play_last_active'
// Activity is frequent (every scroll); one write per second is plenty.
const WRITE_EVERY_MS = 1000

let lastWrite = 0

export function markPlayActive(now = Date.now()): void {
  lastWrite = now
  try {
    sessionStorage.setItem(KEY, String(now))
  } catch {
    // Storage unavailable — every check will ask for the PIN.
  }
}

export function updateActivity(): void {
  const now = Date.now()
  if (now - lastWrite >= WRITE_EVERY_MS) markPlayActive(now)
}

export function playSessionExpired(now = Date.now()): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY))
    return !Number.isFinite(last) || last <= 0 || now - last > INACTIVITY_TIMEOUT
  } catch {
    return true
  }
}

export function clearPlaySession(): void {
  lastWrite = 0
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    // ignore
  }
}

// Listens for activity while in Play; onReturn runs when the tab is shown
// again. Returns the cleanup.
export function trackPlayActivity(onReturn: () => void): () => void {
  const onVisibility = () => {
    if (document.visibilityState === 'visible') onReturn()
  }
  document.addEventListener('click', updateActivity)
  document.addEventListener('scroll', updateActivity, true)
  document.addEventListener('keydown', updateActivity)
  document.addEventListener('touchstart', updateActivity)
  document.addEventListener('visibilitychange', onVisibility)
  return () => {
    document.removeEventListener('click', updateActivity)
    document.removeEventListener('scroll', updateActivity, true)
    document.removeEventListener('keydown', updateActivity)
    document.removeEventListener('touchstart', updateActivity)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}
