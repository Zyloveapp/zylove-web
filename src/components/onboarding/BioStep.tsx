import { BIO_MAX_LENGTH } from './types'
import { SkipLink, StepHeader } from './ui'

interface BioStepProps {
  bio: string
  generating: boolean
  usedFallback: boolean
  onChange: (bio: string) => void
  onRegenerate: () => void
  onSkip: () => void
}

export default function BioStep({ bio, generating, usedFallback, onChange, onRegenerate, onSkip }: BioStepProps) {
  return (
    <div>
      <StepHeader title="Your bio is ready." subtitle="Edit it, regenerate it, or keep it as is." />
      {generating ? (
        <div className="flex flex-col items-center gap-3 py-12 text-white/60">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-white/15 border-t-white" />
          Writing your bio…
        </div>
      ) : (
        <>
          {usedFallback && (
            <p className="mb-3 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-200">
              We couldn't write a custom bio right now, so here's a starting point. Edit it or try again.
            </p>
          )}
          <textarea
            rows={9}
            maxLength={BIO_MAX_LENGTH}
            value={bio}
            placeholder="Write your bio here…"
            onChange={(e) => onChange(e.target.value)}
            className="w-full resize-none rounded-xl border border-white/15 p-4 leading-relaxed focus:border-[#1B4FD8] focus:outline-none"
          />
          <p className="mt-1 text-right text-xs text-white/50">
            {bio.length}/{BIO_MAX_LENGTH}
          </p>
          <button
            type="button"
            onClick={onRegenerate}
            className="mt-3 w-full rounded-lg border border-[#1B4FD8] px-4 py-2.5 font-medium"
          >
            ↺ Regenerate
          </button>
        </>
      )}
      <SkipLink label="Skip bio for now" onClick={onSkip} />
    </div>
  )
}
