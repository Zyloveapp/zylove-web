import PDFDocument = require('pdfkit')
import { logger } from 'firebase-functions'
import { getStorage } from 'firebase-admin/storage'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import type { ProfileScorecard } from './profileScorecard'

// Review history: every successful "How's my profile?" review is kept in
// users/{uid}/profileReviews/{mode}/reviews/{reviewId} (owner-read, server-
// write) with a PDF copy at reviews/{uid}/{mode}/{reviewId}.pdf in Storage
// (owner-read). The last 10 per mode are kept.
//
// The PDF path is stored rather than a download URL: a download URL works
// for anyone who has it, while the path is only readable by its owner.

export type ReviewMode = 'spark' | 'play'

const KEEP_PER_MODE = 10

const COLORS = {
  background: '#030712',
  text: '#FFFFFF',
  muted: '#9CA3AF',
  faint: '#4B5563',
  bar: '#1F2937',
  spark: '#1B4FD8',
  play: '#E03131',
  green: '#34D399',
  amber: '#FBBF24',
  red: '#F87171',
}

// DejaVu has ✓ ↑ ✦, which PDF's built-in fonts can't draw.
const FONT = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf')
const FONT_BOLD = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf')

function scoreColor(score: number): string {
  return score >= 80 ? COLORS.green : score >= 60 ? COLORS.amber : COLORS.red
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' })
}

export function renderReviewPdf(mode: ReviewMode, review: ProfileScorecard, date: Date): Promise<Buffer> {
  const accent = mode === 'play' ? COLORS.play : COLORS.spark
  const modeName = mode === 'play' ? 'Play' : 'Spark'
  const doc = new PDFDocument({ size: 'LETTER', margins: { top: 56, bottom: 56, left: 56, right: 56 }, bufferPages: true })
  doc.registerFont('body', FONT)
  doc.registerFont('bold', FONT_BOLD)
  const width = doc.page.width - 112

  const paintBackground = () => doc.rect(0, 0, doc.page.width, doc.page.height).fill(COLORS.background)
  paintBackground()
  doc.on('pageAdded', paintBackground)

  // Header
  doc.font('bold').fontSize(22).fillColor(accent).text('✦ Zylove', 56, 56)
  doc.font('bold').fontSize(14).fillColor(COLORS.text).text(`${modeName} Profile Review`, { continued: false })
  doc.font('body').fontSize(10).fillColor(COLORS.muted).text(formatDate(date))
  doc.moveDown(1.5)

  // Overall score
  // Laid out by hand: mixed sizes on one line otherwise overlap the next.
  const scoreTop = doc.y
  const scoreText = `${review.overallScore}`
  doc.font('bold').fontSize(44)
  const scoreWidth = doc.widthOfString(scoreText)
  doc.fillColor(scoreColor(review.overallScore)).text(scoreText, 56, scoreTop, { lineBreak: false })
  doc.font('body').fontSize(20).fillColor(COLORS.muted).text('/ 100', 56 + scoreWidth + 8, scoreTop + 18, { lineBreak: false })
  doc.font('body').fontSize(11).fillColor(COLORS.muted).text(`Your ${modeName} profile score`, 56, scoreTop + 58)
  doc.moveDown(1.5)

  const section = (name: string, score: number, working: string, improve: string) => {
    if (doc.y > doc.page.height - 170) doc.addPage()
    const top = doc.y
    doc.font('bold').fontSize(12).fillColor(COLORS.text).text(name, 56, top, { continued: true })
    doc.fillColor(COLORS.faint).text('  ·  ', { continued: true })
    doc.fillColor(scoreColor(score)).text(`${score}`)
    // Score bar
    const barY = doc.y + 4
    doc.roundedRect(56, barY, width, 4, 2).fill(COLORS.bar)
    doc.roundedRect(56, barY, Math.max(4, (width * Math.min(100, Math.max(0, score))) / 100), 4, 2).fill(accent)
    doc.y = barY + 12
    doc.font('body').fontSize(10).fillColor(COLORS.green).text('✓ ', 56, doc.y, { continued: true })
    doc.fillColor(COLORS.text).text(working, { width })
    doc.moveDown(0.3)
    doc.fillColor(COLORS.amber).text('↑ ', { continued: true })
    doc.fillColor(COLORS.text).text(improve, { width })
    doc.moveDown(1.2)
  }

  for (const s of review.sections) section(s.name, s.score, s.working, s.improve)
  if (review.photos) {
    section('Photos', review.photos.score, review.photos.working, review.photos.improve)
    for (const tip of review.photos.suggestions) {
      doc.font('body').fontSize(10).fillColor(COLORS.muted).text(`•  ${tip}`, 68, doc.y, { width: width - 12 })
    }
    doc.moveDown(1.2)
  }

  // Top suggestion
  if (doc.y > doc.page.height - 160) doc.addPage()
  const boxTop = doc.y
  doc.font('bold').fontSize(12).fillColor(accent).text('✦ Top Suggestion', 72, boxTop + 14, { width: width - 32 })
  doc.font('body').fontSize(11).fillColor(COLORS.text).text(review.topSuggestion, 72, doc.y + 4, { width: width - 32 })
  const boxBottom = doc.y + 14
  doc.roundedRect(56, boxTop, width, boxBottom - boxTop, 8).lineWidth(1).strokeColor(accent).stroke()

  // Footer on every page, inside the bottom margin (which would otherwise
  // push it onto a new page).
  const range = doc.bufferedPageRange()
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i)
    doc.page.margins.bottom = 0
    const y = doc.page.height - 44
    doc.font('body').fontSize(8).fillColor(COLORS.faint)
    doc.text('Generated by Zylove · zylove.app', 56, y, { width, align: 'center', lineBreak: false })
    doc.text('This review is private and confidential.', 56, y + 11, { width, align: 'center', lineBreak: false })
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
    doc.end()
  })
}

// Saves a review and its PDF, then trims the mode's history to the newest 10.
// Never throws: a failure here must not lose the review the user is shown.
export async function saveReviewHistory(uid: string, mode: ReviewMode, review: ProfileScorecard): Promise<void> {
  try {
    const db = getFirestore()
    const reviews = db.collection(`users/${uid}/profileReviews/${mode}/reviews`)
    const ref = reviews.doc()
    const now = new Date()
    await ref.set({
      reviewId: ref.id,
      mode,
      createdAt: FieldValue.serverTimestamp(),
      createdAtMs: now.getTime(),
      overallScore: review.overallScore,
      sections: review.sections,
      topSuggestion: review.topSuggestion,
      photosIncluded: Boolean(review.photos),
      photosScore: review.photos?.score ?? null,
      ...(review.photos && { photos: review.photos }),
    })

    try {
      const pdfPath = `reviews/${uid}/${mode}/${ref.id}.pdf`
      const pdf = await renderReviewPdf(mode, review, now)
      await getStorage().bucket().file(pdfPath).save(pdf, { contentType: 'application/pdf', resumable: false })
      await ref.update({ pdfPath })
    } catch (err) {
      logger.error('saveReviewHistory: PDF failed', { mode, message: err instanceof Error ? err.message : String(err) })
    }

    const old = await reviews.orderBy('createdAtMs', 'desc').offset(KEEP_PER_MODE).get()
    await Promise.all(
      old.docs.map(async (d) => {
        const path: unknown = d.data().pdfPath
        if (typeof path === 'string') await getStorage().bucket().file(path).delete({ ignoreNotFound: true }).catch(() => {})
        await d.ref.delete()
      }),
    )
  } catch (err) {
    logger.error('saveReviewHistory failed', { mode, message: err instanceof Error ? err.message : String(err) })
  }
}
