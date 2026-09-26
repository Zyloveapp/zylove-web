import { MODE_LABELS, ONBOARDING_COPY } from '../../brand/zylove'
import { includesPlay, type IntentChoice } from './types'

const OPTIONS: { value: IntentChoice; emoji: string; name: string; tagline: string; description: string }[] = [
  { value: 'spark', ...MODE_LABELS.spark },
  { value: 'play', ...MODE_LABELS.play },
  {
    value: 'both',
    emoji: '✦',
    name: 'Both',
    tagline: 'Open to either.',
    description: 'Set up Spark now and add a Play profile after.',
  },
]

interface IntentStepProps {
  intent: IntentChoice | null
  onChange: (intent: IntentChoice) => void
}

export default function IntentStep({ intent, onChange }: IntentStepProps) {
  const copy = ONBOARDING_COPY.intent
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{copy.title}</h1>
      <p className="text-gray-600">{copy.preamble}</p>
      <div className="space-y-3">
        {OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={intent === o.value}
            className={`w-full rounded-xl border-2 p-4 text-left transition-colors ${
              intent === o.value ? 'border-gray-900 bg-gray-50' : 'border-gray-200 hover:border-gray-400'
            }`}
          >
            <div className="font-semibold">
              {o.emoji} {o.name} <span className="font-normal text-gray-500">— {o.tagline}</span>
            </div>
            <div className="mt-1 text-sm text-gray-600">{o.description}</div>
          </button>
        ))}
      </div>
      {includesPlay(intent) && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          You'll set up your Spark profile first. Play profile setup comes after Spark is complete.
        </p>
      )}
      <p className="text-xs text-gray-500">{copy.privacy}</p>
    </div>
  )
}
