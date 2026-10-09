import { useEffect, useState } from 'react'
import { MAX_PROMPTS, PROMPT_ANSWER_LIMIT, DYNAMIC_PROMPT_ID, fetchProfileQuestion, saveDynamicPrompt } from '../../services/profile'
import type { PromptAnswer } from '../../types/dualProfile'
import { friendlyError } from '../../services/errors'

interface JustForYouCardProps {
  uid: string
  prompts: PromptAnswer[]
  // The question behind the profile's current 'dynamic' prompt, if any.
  dynamicPrompt: string | null
  onSaved: (prompts: PromptAnswer[], question: string) => void
}

// "✦ Just for you" — an AI-written prompt question based on the user's own
// profile, answerable in place. Generated once per browser session.
export default function JustForYouCard({ uid, prompts, dynamicPrompt, onSaved }: JustForYouCardProps) {
  const [question, setQuestion] = useState<string | null | 'error'>(null)
  const [answer, setAnswer] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchProfileQuestion(uid)
      .then((q) => !cancelled && setQuestion(q))
      .catch(() => !cancelled && setQuestion('error'))
    return () => {
      cancelled = true
    }
  }, [uid])

  if (question === 'error') return null

  const hasDynamic = prompts.some((p) => p.promptId === DYNAMIC_PROMPT_ID)
  // Answering this exact question already (e.g. after a reload this session).
  if (!saved && hasDynamic && question !== null && question === dynamicPrompt) return null
  const atLimit = prompts.length >= MAX_PROMPTS && !hasDynamic

  async function save() {
    if (typeof question !== 'string' || !answer.trim() || saving) return
    setSaving(true)
    setError(null)
    try {
      const next = await saveDynamicPrompt(uid, prompts, question, answer)
      setSaved(true)
      onSaved(next, question)
    } catch (err) {
      setError(friendlyError(err, "Couldn't save. Try again."))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded-2xl border border-[#1B4FD8]/40 bg-[#1B4FD8]/10 p-5">
      <p className="text-xs font-semibold uppercase tracking-widest text-[#7C9BFF]">✦ Just for you</p>
      {question === null ? (
        <div className="mt-3 space-y-2" aria-label="Writing a question for you">
          <div className="h-4 w-4/5 animate-pulse rounded bg-white/10" />
          <div className="h-4 w-2/5 animate-pulse rounded bg-white/10" />
        </div>
      ) : saved ? (
        <p className="mt-2 text-sm text-emerald-300">Added to your profile ✦</p>
      ) : (
        <>
          <p className="mt-2 text-lg text-white">{question}</p>
          {atLimit ? (
            <p className="mt-3 text-sm text-white/50">You've reached your prompt limit. Edit a prompt to use this one.</p>
          ) : (
            <>
              <textarea
                value={answer}
                onChange={(e) => setAnswer(e.target.value.slice(0, PROMPT_ANSWER_LIMIT))}
                maxLength={PROMPT_ANSWER_LIMIT}
                rows={3}
                placeholder="Your answer…"
                className="mt-3 w-full resize-none rounded-xl border border-white/10 bg-gray-950/60 px-4 py-2.5 text-white placeholder:text-white/30 focus:border-white/30 focus:outline-none"
              />
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="text-xs text-white/30">
                  {answer.length}/{PROMPT_ANSWER_LIMIT}
                  {hasDynamic && ' · replaces your current "just for you" answer'}
                </span>
                <button
                  type="button"
                  onClick={save}
                  disabled={!answer.trim() || saving}
                  className="shrink-0 rounded-xl bg-[#1B4FD8] px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                  {saving ? 'Saving…' : 'Add to my profile ✦'}
                </button>
              </div>
              {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
            </>
          )}
        </>
      )}
    </div>
  )
}
