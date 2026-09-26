import { SPARK_PROMPT_BANK, type AppPrompt, type PromptAnswer } from '../../types/dualProfile'
import { PROMPT_COUNT, PROMPT_MAX_LENGTH } from './types'

const PROMPTS_BY_ID = new Map<string, AppPrompt>(SPARK_PROMPT_BANK.map((p) => [p.id, p]))

interface PromptsStepProps {
  prompts: PromptAnswer[]
  onChange: (prompts: PromptAnswer[]) => void
}

export default function PromptsStep({ prompts, onChange }: PromptsStepProps) {
  const selectedIds = new Set(prompts.map((p) => p.promptId))
  const full = prompts.length >= PROMPT_COUNT

  function add(promptId: string) {
    if (full || selectedIds.has(promptId)) return
    onChange([...prompts, { promptId, answer: '' }])
  }

  function remove(promptId: string) {
    onChange(prompts.filter((p) => p.promptId !== promptId))
  }

  function setAnswer(promptId: string, answer: string) {
    onChange(prompts.map((p) => (p.promptId === promptId ? { ...p, answer } : p)))
  }

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold">Your prompts</h1>
      <p className="text-gray-600">
        Pick {PROMPT_COUNT} and answer them. ({prompts.length}/{PROMPT_COUNT} chosen)
      </p>

      {prompts.map(({ promptId, answer }) => {
        const prompt = PROMPTS_BY_ID.get(promptId)
        if (!prompt) return null
        return (
          <div key={promptId} className="space-y-2 rounded-xl border border-gray-200 p-4">
            <div className="flex items-start justify-between gap-3">
              <p className="font-medium">{prompt.text}</p>
              <button
                type="button"
                onClick={() => remove(promptId)}
                className="shrink-0 text-sm text-gray-500 underline"
              >
                Change
              </button>
            </div>
            <textarea
              rows={3}
              maxLength={PROMPT_MAX_LENGTH}
              value={answer}
              placeholder={prompt.placeholder}
              onChange={(e) => setAnswer(promptId, e.target.value)}
              className="w-full resize-none rounded-lg border border-gray-300 px-3 py-2 focus:border-gray-800 focus:outline-none"
            />
            <div className="flex justify-between gap-3 text-xs text-gray-500">
              <span>{prompt.inspirations?.length ? `e.g. ${prompt.inspirations[0]}` : ''}</span>
              <span className="shrink-0">
                {answer.length}/{PROMPT_MAX_LENGTH}
              </span>
            </div>
          </div>
        )
      })}

      {!full && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-gray-700">Choose a prompt</p>
          <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200">
            {SPARK_PROMPT_BANK.filter((p) => !selectedIds.has(p.id)).map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => add(p.id)}
                  className="w-full px-4 py-3 text-left text-sm hover:bg-gray-50"
                >
                  {p.text}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
