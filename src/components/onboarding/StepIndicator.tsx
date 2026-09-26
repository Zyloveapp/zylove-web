interface StepIndicatorProps {
  steps: readonly string[]
  current: number
}

export default function StepIndicator({ steps, current }: StepIndicatorProps) {
  return (
    <div>
      <div className="flex gap-1.5">
        {steps.map((label, i) => (
          <div
            key={label}
            className={`h-1.5 flex-1 rounded-full ${i <= current ? 'bg-gray-900' : 'bg-gray-200'}`}
          />
        ))}
      </div>
      <p className="mt-2 text-xs font-medium uppercase tracking-wide text-gray-500">
        Step {current + 1} of {steps.length} · {steps[current]}
      </p>
    </div>
  )
}
