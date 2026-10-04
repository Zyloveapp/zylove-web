// Play inactivity lock. Last activity in Play lives in sessionStorage; after
// 2 minutes without any (or with no record, e.g. a new tab), Play asks for
// the PIN again. Checked on load, whenever the tab comes back into view, and
// every 30 seconds while it's visible — so an idle open screen locks within
// 2:30 at most.

export const INACTIVITY_TIMEOUT = 2 * 60 * 1000 // 2 minutes
const KEY = 'zylove_play_last_active'
// Activity is frequent (every scroll); one write per second is plenty.
const WRITE_EVERY_MS = 1000
const IDLE_CHECK_MS = 30 * 1000

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

// Listens for activity while in Play (and unlocked); onCheck runs when the
// tab is shown again and every 30 seconds while it's visible. The caller
// starts this on entering Play and the cleanup stops it all on leaving.
export function trackPlayActivity(onCheck: () => void): () => void {
  const onVisibility = () => {
    if (document.visibilityState === 'visible') onCheck()
  }
  const idleCheck = setInterval(() => {
    if (document.visibilityState === 'visible') onCheck()
  }, IDLE_CHECK_MS)
  document.addEventListener('click', updateActivity)
  document.addEventListener('scroll', updateActivity, true)
  document.addEventListener('keydown', updateActivity)
  document.addEventListener('touchstart', updateActivity)
  document.addEventListener('visibilitychange', onVisibility)
  return () => {
    clearInterval(idleCheck)
    document.removeEventListener('click', updateActivity)
    document.removeEventListener('scroll', updateActivity, true)
    document.removeEventListener('keydown', updateActivity)
    document.removeEventListener('touchstart', updateActivity)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}
