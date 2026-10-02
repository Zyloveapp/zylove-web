import PublicLayout from '../../components/public/PublicLayout'
import LegalContent from '../../components/public/LegalContent'
import communityHtml from './content/community.html?raw'

// Verbatim from zylove-website/community.html (founding links point at /join).
export default function Community() {
  return (
    <PublicLayout>
      <LegalContent html={communityHtml} />
    </PublicLayout>
  )
}
