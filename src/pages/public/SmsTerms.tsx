import PublicLayout from '../../components/public/PublicLayout'
import LegalContent from '../../components/public/LegalContent'
import smsTermsHtml from './content/sms-terms.html?raw'

// SMS program terms (carrier A2P requirements). Keep in step with Terms §3.4
// and Privacy → Text messages.
export default function SmsTerms() {
  return (
    <PublicLayout title="SMS Terms · Zylove">
      <LegalContent html={smsTermsHtml} />
    </PublicLayout>
  )
}
