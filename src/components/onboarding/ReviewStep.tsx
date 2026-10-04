import { SPARK_PROMPT_BANK } from '../../types/dualProfile'
import { INTENT_LABELS } from '../../types/profile'
import {
  CONFLICT_STYLE_LABELS,
  STRESS_RESPONSE_LABELS,
  TOGETHERNESS_STYLE_LABELS,
  parseBirthday,
  type OnboardingDraft,
} from './types'

interface ReviewStepProps {
  draft: OnboardingDraft
  saving: boolean
  // What the save is doing right now ("Uploading photos (2 of 4)…").
  progress?: string | null
  // Reimagine my profile (?refresh=true): saving changes, not creating.
  refresh?: boolean
  error: string | null
  onCreate: () => void
}

export default function ReviewStep({ draft, saving, progress, refresh = false, error, onCreate }: ReviewStepProps) {
  // Play path: the same full profile, then straight on to Play setup.
  const playPath = draft.onboardingPath === 'play'
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
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-white/50">Bio</h2>
          <p className="whitespace-pre-line leading-relaxed">{draft.bio.trim()}</p>
        </section>
      )}

      {answers.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-white/50">Prompts</h2>
          {answers.map((a) => (
            <div key={a.id} className="rounded-xl border border-white/10 p-3">
              <p className="text-sm text-white/60">{a.question}</p>
              <p className="mt-1 font-medium">{a.answer}</p>
            </div>
          ))}
        </section>
      )}

      {deeper.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-white/50">Go Deeper</h2>
          {deeper.map((d) => (
            <p key={d.q} className="text-sm">
              <span className="text-white/60">{d.q}</span> <span className="font-medium">{d.a}</span>
            </p>
          ))}
        </section>
      )}

      {playPath && (
        <p className="rounded-lg bg-[#E03131]/10 p-3 text-sm text-red-200">
          🔥 Next up: your Play profile. It's set up right after this.
        </p>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}

      <button
        type="button"
        onClick={onCreate}
        disabled={saving}
        className={`w-full rounded-lg px-4 py-3 font-medium text-white disabled:opacity-50 ${
          playPath ? 'bg-[#E03131]' : 'bg-[#1B4FD8]'
        }`}
      >
        {saving
          ? (progress ?? (refresh ? 'Saving…' : 'Creating your profile…'))
          : refresh
            ? 'Save changes'
            : playPath
              ? 'Enter Play →'
              : 'Create my profile'}
      </button>
      {saving && (
        <p className="text-center text-xs text-white/50">Photo checks can take up to a minute — keep this page open.</p>
      )}
    </div>
  )
}
