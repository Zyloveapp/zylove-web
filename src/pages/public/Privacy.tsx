import PublicLayout from '../../components/public/PublicLayout'
import LegalContent from '../../components/public/LegalContent'
import privacyHtml from './content/privacy.html?raw'

// Verbatim from zylove-website/privacy.html (founding links point at /join).
export default function Privacy() {
  return (
    <PublicLayout title="Privacy Policy · Zylove">
      <LegalContent html={privacyHtml} />
    </PublicLayout>
  )
}
