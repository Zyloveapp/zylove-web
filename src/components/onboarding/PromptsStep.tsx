import { useState } from 'react'
import { SPARK_PROMPT_BANK, type AppPrompt } from '../../types/dualProfile'
import { MIN_PROMPT_ANSWERS, PROMPT_COUNT, PROMPT_MAX_LENGTH, answeredPromptCount, type StepProps } from './types'
import { StepHeader } from './ui'

const PROMPTS_BY_ID = new Map<string, AppPrompt>(SPARK_PROMPT_BANK.map((p) => [p.id, p]))

export default function PromptsStep({ draft, update }: StepProps) {
  const [swapping, setSwapping] = useState<string | null>(null)
  const [inspiring, setInspiring] = useState<string | null>(null)

  const selected = draft.selectedPromptIds
  const available = SPARK_PROMPT_BANK.filter((p) => !selected.includes(p.id))

  function add(id: string) {
    if (selected.length >= PROMPT_COUNT) return
    update({ selectedPromptIds: [...selected, id] })
  }

  function swap(oldId: string, newId: string) {
    const answers = { ...draft.promptAnswers }
    delete answers[oldId]
    update({ selectedPromptIds: selected.map((id) => (id === oldId ? newId : id)), promptAnswers: answers })
    setSwapping(null)
  }

  function setAnswer(id: string, answer: string) {
    update({ promptAnswers: { ...draft.promptAnswers, [id]: answer } })
  }

  return (
    <div>
      <StepHeader
        title="Your prompts"
        subtitle={`Pick ${PROMPT_COUNT} and answer at least ${MIN_PROMPT_ANSWERS}. These shape your bio.`}
      />
      <p className="mb-4 text-sm text-white/50">
        {selected.length}/{PROMPT_COUNT} chosen · {answeredPromptCount(draft)} answered
      </p>

      <div className="space-y-3">
        {selected.map((id) => {
          const prompt = PROMPTS_BY_ID.get(id)
          if (!prompt) return null
          const answer = draft.promptAnswers[id] ?? ''
          return (
            <div key={id} className="rounded-xl border border-white/10 p-4">
              <p className="mb-2 font-medium">{prompt.text}</p>
              <textarea
                rows={3}
                maxLength={PROMPT_MAX_LENGTH}
                value={answer}
                placeholder={prompt.placeholder}
                onChange={(e) => setAnswer(id, e.target.value)}
                className="w-full resize-none rounded-lg border border-white/15 px-3 py-2 focus:border-[#1B4FD8] focus:outline-none"
              />
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                {prompt.inspirations && prompt.inspirations.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setInspiring(inspiring === id ? null : id)}
                    className="rounded-full border border-white/15 px-3 py-1 text-white/60"
                  >
                    ✦ Need a spark?
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setSwapping(swapping === id ? null : id)}
                  className="rounded-full border border-white/15 px-3 py-1 text-white/60"
                >
                  ↻ Different question
                </button>
                <span className="ml-auto text-white/50">
                  {answer.length}/{PROMPT_MAX_LENGTH}
                </span>
              </div>

              {inspiring === id && prompt.inspirations && (
                <div className="mt-3 space-y-1.5">
                  {prompt.inspirations.map((ins) => (
                    <button
                      key={ins}
                      type="button"
                      onClick={() => {
                        setAnswer(id, ins)
                        setInspiring(null)
                      }}
                      className="block w-full rounded-lg bg-white/5 px-3 py-2 text-left text-sm text-white/80 hover:bg-white/10"
                    >
                      "{ins}"
                    </button>
                  ))}
                </div>
              )}

              {swapping === id && (
                <div className="mt-3 border-t border-white/5 pt-3">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-white/50">Choose a different question</p>
                  <PromptList prompts={available} onPick={(newId) => swap(id, newId)} />
                </div>
              )}
            </div>
          )
        })}
      </div>

      {selected.length < PROMPT_COUNT && (
        <div className="mt-5">
          <p className="mb-2 text-sm font-medium text-white/90">Choose a prompt</p>
          <PromptList prompts={available} onPick={add} />
        </div>
      )}
    </div>
  )
}

function PromptList({ prompts, onPick }: { prompts: AppPrompt[]; onPick: (id: string) => void }) {
  return (
    <ul className="divide-y divide-white/5 rounded-xl border border-white/10">
      {prompts.map((p) => (
        <li key={p.id}>
          <button type="button" onClick={() => onPick(p.id)} className="w-full px-4 py-3 text-left text-sm hover:bg-white/10">
            {p.text}
          </button>
        </li>
      ))}
    </ul>
  )
}
