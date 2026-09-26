interface ChipProps {
  label: string
  selected: boolean
  onClick: () => void
  disabled?: boolean
}

export default function Chip({ label, selected, onClick, disabled = false }: ChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled && !selected}
      aria-pressed={selected}
      className={`rounded-full border px-3 py-1.5 text-sm transition-colors disabled:opacity-40 ${
        selected
          ? 'border-gray-900 bg-gray-900 text-white'
          : 'border-gray-300 bg-white text-gray-700 hover:border-gray-500'
      }`}
    >
      {label}
    </button>
  )
}
