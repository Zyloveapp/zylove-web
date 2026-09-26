import { ONBOARDING_COPY } from '../../brand/zylove'
import { GENDER_LABELS, ATTRACTED_TO_LABELS } from '../../types/profile'
import { includesPlay, type OnboardingDraft } from './types'

interface DoneStepProps {
  draft: OnboardingDraft
  saving: boolean
  saved: boolean
  error: string | null
  onSave: () => void
  onContinue: () => void
}

export default function DoneStep({ draft, saving, saved, error, onSave, onContinue }: DoneStepProps) {
  const playNext = includesPlay(draft.intent)

  if (saved) {
    return (
      <div className="space-y-4 text-center">
        <div className="text-5xl">✦</div>
        <h1 className="text-2xl font-semibold">{ONBOARDING_COPY.done.title}</h1>
        <p className="text-gray-600">Your Spark profile is live.</p>
        {playNext && (
          <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
            Next up: your Play profile. You'll set it up separately now that Spark is complete.
          </p>
        )}
        <button
          type="button"
          onClick={onContinue}
          className="w-full rounded-lg bg-gray-900 px-4 py-3 font-medium text-white"
        >
          Start discovering
        </button>
      </div>
    )
  }

  const gender =
    draft.genderIdentity === 'self_describe'
      ? draft.genderSelfDescribe.trim()
      : draft.genderIdentity && GENDER_LABELS[draft.genderIdentity]

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold">Review your profile</h1>

      <div className="flex items-center gap-4">
        {draft.photos[0] && (
          <img src={draft.photos[0].previewUrl} alt="Main" className="h-20 w-16 rounded-lg object-cover" />
        )}
        <div>
          <p className="text-lg font-semibold">
            {draft.displayName.trim()}, {draft.age}
          </p>
          <p className="text-sm text-gray-600">
            {gender} · into {draft.attractedTo.map((a) => ATTRACTED_TO_LABELS[a]).join(', ')}
          </p>
          <p className="text-sm text-gray-600">
            {draft.photos.length} photo{draft.photos.length === 1 ? '' : 's'} · {draft.prompts.length} prompts
          </p>
        </div>
      </div>

      {playNext && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          Play profile setup comes after Spark is complete.
        </p>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        type="button"
        onClick={onSave}
        disabled={saving}
        className="w-full rounded-lg bg-gray-900 px-4 py-3 font-medium text-white disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Create my profile'}
      </button>
    </div>
  )
}
