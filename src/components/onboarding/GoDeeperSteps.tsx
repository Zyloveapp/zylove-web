import { toOptions, type Option } from './types'
import { CardSelect, SkipLink, StepHeader } from './ui'

export function GoDeeperIntro({ onStart, onSkip }: { onStart: () => void; onSkip: () => void }) {
  return (
    <div className="pt-6 text-center">
      <div className="mb-4 text-5xl">✦</div>
      <h1 className="mb-3 text-2xl font-semibold">Want sharper matches?</h1>
      <p className="mb-8 text-white/60">
        Three quick questions help us understand how you actually operate in a relationship — not just what you say
        you want.
      </p>
      <button
        type="button"
        onClick={onStart}
        className="w-full rounded-lg bg-[#1B4FD8] px-4 py-3 font-medium text-white"
      >
        Let's go →
      </button>
      <SkipLink label="Skip for now" onClick={onSkip} />
    </div>
  )
}

export function GoDeeperQuestion<T extends string>({
  title,
  labels,
  value,
  onChange,
  onSkip,
}: {
  title: string
  labels: Record<T, string>
  value: T | null
  onChange: (value: T) => void
  onSkip: () => void
}) {
  const options: Option<T>[] = toOptions(labels, (l) => l)
  return (
    <div>
      <StepHeader title={title} subtitle="Pick the one that sounds most like you." />
      <CardSelect options={options} value={value} onChange={onChange} />
      <SkipLink label="Skip this question" onClick={onSkip} />
    </div>
  )
}
