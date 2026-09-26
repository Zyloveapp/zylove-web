import { SPARK_PROMPT_BANK } from '../../types/dualProfile'
import { INTENT_LABELS } from '../../types/profile'
import {
  CONFLICT_STYLE_LABELS,
  STRESS_RESPONSE_LABELS,
  TOGETHERNESS_STYLE_LABELS,
  includesPlay,
  parseBirthday,
  type OnboardingDraft,
} from './types'

interface ReviewStepProps {
  draft: OnboardingDraft
  saving: boolean
  error: string | null
  onCreate: () => void
}

export default function ReviewStep({ draft, saving, error, onCreate }: ReviewStepProps) {
  const age = parseBirthday(draft.birthdayRaw)?.age
  const intent = draft.intent ? INTENT_LABELS[draft.intent] : null
  const answers = draft.selectedPromptIds
    .map((id) => ({
      id,
      question: SPARK_PROMPT_BANK.find((p) => p.id === id)?.text ?? id,
      answer: (draft.promptAnswers[id] ?? '').trim(),
    }))
    .filter((a) => a.answer)
  const deeper = [
    draft.conflictStyle && { q: 'When conflict comes up…', a: CONFLICT_STYLE_LABELS[draft.conflictStyle] },
    draft.togethernessStyle && { q: 'In a relationship, I need…', a: TOGETHERNESS_STYLE_LABELS[draft.togethernessStyle] },
    draft.stressResponse && { q: "When I'm stressed, I…", a: STRESS_RESPONSE_LABELS[draft.stressResponse] },
  ].filter((x): x is { q: string; a: string } => Boolean(x))

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Here's you.</h1>

      <div className="grid grid-cols-3 gap-2">
        {draft.photos.map((p, i) => (
          <img
            key={p.id}
            src={p.previewUrl}
            alt={`Photo ${i + 1}`}
            className="aspect-[3/4] w-full rounded-lg object-cover"
          />
        ))}
      </div>

      <div>
        <p className="text-2xl font-semibold">
          {draft.displayName.trim()}
          {age !== undefined && <span className="font-normal">, {age}</span>}
        </p>
        {intent && (
          <span
            className="mt-2 inline-block rounded-full px-3 py-1 text-sm font-medium text-white"
            style={{ backgroundColor: intent.color }}
          >
            {intent.emoji} {draft.intent === 'open' ? 'Both' : intent.label}
          </span>
        )}
      </div>

      {draft.bio.trim() && (
        <section>
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Bio</h2>
          <p className="whitespace-pre-line leading-relaxed">{draft.bio.trim()}</p>
        </section>
      )}

      {answers.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Prompts</h2>
          {answers.map((a) => (
            <div key={a.id} className="rounded-xl border border-gray-200 p-3">
              <p className="text-sm text-gray-600">{a.question}</p>
              <p className="mt-1 font-medium">{a.answer}</p>
            </div>
          ))}
        </section>
      )}

      {deeper.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Go Deeper</h2>
          {deeper.map((d) => (
            <p key={d.q} className="text-sm">
              <span className="text-gray-600">{d.q}</span> <span className="font-medium">{d.a}</span>
            </p>
          ))}
        </section>
      )}

      {includesPlay(draft.intent) && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          Play profile setup comes after your Spark profile is created.
        </p>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        type="button"
        onClick={onCreate}
        disabled={saving}
        className="w-full rounded-lg bg-gray-900 px-4 py-3 font-medium text-white disabled:opacity-50"
      >
        {saving ? 'Creating your profile…' : 'Create my profile'}
      </button>
    </div>
  )
}
