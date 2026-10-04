// Where to go after signing in, for links that must survive the login page
// (a /claim-founder text tapped while signed out). Session-only. Read
// without clearing (render may run twice); the destination page clears it.
const KEY = 'zylove_after_login'

export function rememberAfterLogin(path: string): void {
  try {
    sessionStorage.setItem(KEY, path)
  } catch {
    // Storage unavailable: they land on Explore instead.
  }
}

export function afterLoginPath(fallback: string): string {
  try {
    const path = sessionStorage.getItem(KEY)
    return path?.startsWith('/') ? path : fallback
  } catch {
    return fallback
  }
}

export function clearAfterLogin(): void {
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    // Nothing to clear.
  }
}
