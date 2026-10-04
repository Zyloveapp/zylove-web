import { collection, getDocs, limit, orderBy, query } from 'firebase/firestore'
import { getDownloadURL, ref } from 'firebase/storage'
import { db, storage } from './firebase'
import type { Mode } from '../store/modeStore'

// Saved "How's my profile?" reviews (written server-side by
// reviewProfile / reviewPlayProfile), owner-read only.
export interface SavedReview {
  reviewId: string
  mode: Mode
  createdAt: number
  overallScore: number
  sections: { name: string; score: number; working: string; improve: string }[]
  topSuggestion: string
  photosScore: number | null
  photos: { score: number; working: string; improve: string; suggestions: string[] } | null
  pdfPath: string | null
}

const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const str = (v: unknown) => (typeof v === 'string' ? v : '')

export async function loadReviews(uid: string, mode: Mode): Promise<SavedReview[]> {
  const snap = await getDocs(
    query(collection(db, `users/${uid}/profileReviews/${mode}/reviews`), orderBy('createdAtMs', 'desc'), limit(10)),
  )
  return snap.docs.map((d) => {
    const r = d.data()
    const sections = Array.isArray(r.sections) ? r.sections : []
    const photos = typeof r.photos === 'object' && r.photos !== null ? r.photos : null
    return {
      reviewId: d.id,
      mode,
      createdAt: num(r.createdAtMs),
      overallScore: num(r.overallScore),
      sections: sections.map((s: Record<string, unknown>) => ({
        name: str(s.name),
        score: num(s.score),
        working: str(s.working),
        improve: str(s.improve),
      })),
      topSuggestion: str(r.topSuggestion),
      photosScore: typeof r.photosScore === 'number' ? r.photosScore : null,
      photos: photos
        ? {
            score: num(photos.score),
            working: str(photos.working),
            improve: str(photos.improve),
            suggestions: Array.isArray(photos.suggestions) ? photos.suggestions.filter((x: unknown) => typeof x === 'string') : [],
          }
        : null,
      pdfPath: typeof r.pdfPath === 'string' ? r.pdfPath : null,
    }
  })
}

// Owner-only rules are checked when the tokenized URL is issued. Opened as a
// link (no bucket CORS needed); the browser's PDF viewer handles saving.
export async function downloadReviewPdf(pdfPath: string): Promise<void> {
  // Open tab immediately during user gesture — Safari requires this
  const newTab = window.open('', '_blank')
  if (!newTab) {
    // Popup blocked — fallback: try direct link
    const url = await getDownloadURL(ref(storage, pdfPath))
    window.location.href = url
    return
  }
  try {
    const url = await getDownloadURL(ref(storage, pdfPath))
    newTab.location.href = url
  } catch (err) {
    console.error('PDF download failed:', err)
    newTab.close()
    throw err
  }
}
