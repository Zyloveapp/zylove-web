// The photo-analysis consent text, per mode — shared by Settings → Privacy
// and the review sheet's "Include photo analysis?" step.
export default function PhotoConsentCopy({ mode, className = '' }: { mode: 'spark' | 'play'; className?: string }) {
  const policy = (
    <a href="/privacy" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-white">
      Privacy Policy
    </a>
  )
  return mode === 'play' ? (
    <p className={className}>
      Your Play photos will be analyzed for coaching feedback and not used for any other purpose. Only enable this if
      you're comfortable with your photos being processed externally. See our {policy} for details.
    </p>
  ) : (
    <p className={className}>
      Your Spark profile photos will be analyzed for coaching feedback and not used for any other purpose. See our{' '}
      {policy} for details.
    </p>
  )
}
