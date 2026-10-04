import { useCallback, useEffect, useRef, useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { FirebaseError } from 'firebase/app'
import { functions } from '../../services/firebase'
import type { OnboardingDraft } from './types'

const ANSWER_MAX = 200

// What generateSparkGoDeeper works from: everything the user has shared so far.
function requestFrom(d: OnboardingDraft) {
  return {
    personality: d.personalityTraits,
    values: d.relationshipValues,
    lifestyle: d.lifestyleTags,
    loveLangGive: d.loveLangGive,
    loveLangReceive: d.loveLangReceive,
    openTo: d.openTo,
    relationshipStatus: d.relationshipStatus,
    promptAnswers: d.selectedPromptIds
      .map((promptId) => ({ promptId, answer: (d.promptAnswers[promptId] ?? '').trim() }))
      .filter((p) => p.answer),
  }
}

// Go Deeper ✦ under the standard prompts: two questions written for this
// person. Optional; answers count toward the step's 3-answer gate. Generated
// once on arrival (kept in the draft), again only on "Regenerate".
export default function SparkGoDeeperSection({
  draft,
  update,
}: {
  draft: OnboardingDraft
  update: (patch: Partial<OnboardingDraft>) => void
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const draftRef = useRef(draft)
  draftRef.current = draft

  const generate = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data } = await httpsCallable<object, { questions: [string, string] }>(functions, 'generateSparkGoDeeper', {
        timeout: 60_000,
      })(requestFrom(draftRef.current))
      update({ sparkGoDeeper: data.questions.map((question) => ({ question, answer: '' })) })
    } catch (err) {
      setError(
        err instanceof FirebaseError && err.code === 'functions/resource-exhausted'
          ? "You've used this week's 3 question sets."
          : "Couldn't write your questions right now.",
      )
    } finally {
      setLoading(false)
    }
  }, [update])

  const started = useRef(false)
  useEffect(() => {
    if (started.current || draftRef.current.sparkGoDeeper.length > 0) return
    started.current = true
    void generate()
  }, [generate])

  function setAnswer(i: number, answer: string) {
    update({
      sparkGoDeeper: draft.sparkGoDeeper.map((g, j) => (j === i ? { ...g, answer: answer.slice(0, ANSWER_MAX) } : g)),
    })
  }

  return (
    <section className="mt-8">
      <h3 className="text-lg font-semibold text-white">Go Deeper ✦</h3>
      <p className="text-sm text-white/50">These questions were written just for you.</p>

      {loading ? (
        <div className="mt-4 flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-white/60">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-[#1B4FD8]" aria-hidden />
          ✦ Generating your questions...
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          {draft.sparkGoDeeper.map((g, i) => (
            <div key={`${i}-${g.question}`} className="rounded-xl border border-white/10 bg-white/5 p-4">
              <p className="font-medium text-white">{g.question}</p>
              <textarea
                value={g.answer}
                onChange={(e) => setAnswer(i, e.target.value)}
                maxLength={ANSWER_MAX}
                rows={3}
                placeholder="Your answer (optional)…"
                className="mt-3 w-full resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-white placeholder:text-white/30 focus:border-[#1B4FD8] focus:outline-none"
              />
              <p className="text-right text-xs text-white/30">
                {g.answer.length}/{ANSWER_MAX}
              </p>
            </div>
          ))}
          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>
      )}

      <button
        type="button"
        onClick={() => void generate()}
        disabled={loading}
        className="mt-3 text-sm text-white/40 hover:text-white disabled:opacity-40"
      >
        ↻ Regenerate questions
      </button>
    </section>
  )
}
