import { useEffect } from 'react'

// Sets the tab title while a page is mounted, back to "Zylove" on leave.
// Crawlers only read index.html, so this is for people (tabs, history,
// bookmarks); the site-wide meta tags live there.
export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = title
    return () => {
      document.title = 'Zylove'
    }
  }, [title])
}
