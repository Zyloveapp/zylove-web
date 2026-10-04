import PublicLayout from '../../components/public/PublicLayout'
import LegalContent from '../../components/public/LegalContent'
import termsHtml from './content/terms.html?raw'

// Verbatim from zylove-website/terms.html (founding links point at /join).
export default function Terms() {
  return (
    <PublicLayout title="Terms of Service · Zylove">
      <LegalContent html={termsHtml} />
    </PublicLayout>
  )
}
