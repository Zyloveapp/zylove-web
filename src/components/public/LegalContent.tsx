import type { MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import './legal.css'

// Renders legal copy taken verbatim from the zylove-website pages
// (src/pages/public/content/*.html, our own static text). Internal links go
// through the router; in-page anchors and mailto: links work as normal.
export default function LegalContent({ html }: { html: string }) {
  const navigate = useNavigate()

  function onClick(e: MouseEvent<HTMLDivElement>) {
    const a = (e.target as HTMLElement).closest('a')
    const href = a?.getAttribute('href')
    if (!href || !href.startsWith('/') || e.metaKey || e.ctrlKey) return
    e.preventDefault()
    navigate(href)
  }

  return <div className="zy-legal" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
}
