import type { ReactNode } from 'react'
import { toggleIn, type HeightFtIn, type Option } from './types'

export function StepHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-5 space-y-1">
      <h1 className="text-2xl font-semibold leading-tight">{title}</h1>
      {subtitle && <p className="text-gray-600">{subtitle}</p>}
    </div>
  )
}

export function FieldLabel({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="mb-2 mt-5 first:mt-0">
      <p className="text-sm font-medium text-gray-800">{children}</p>
      {hint && <p className="text-xs text-gray-500">{hint}</p>}
    </div>
  )
}

function chipClass(selected: boolean): string {
  return `rounded-full border px-3 py-1.5 text-sm transition-colors disabled:opacity-40 ${
    selected ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-300 bg-white text-gray-700 hover:border-gray-500'
  }`
}

export function ChipSelect<T extends string>({
  options,
  value,
  onChange,
  allowDeselect = false,
}: {
  options: Option<T>[]
  value: T | null
  onChange: (value: T | null) => void
  allowDeselect?: boolean
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(allowDeselect && value === o.value ? null : o.value)}
          className={chipClass(value === o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function ChipMultiSelect<T extends string>({
  options,
  value,
  onChange,
  max,
  exclusive,
}: {
  options: Option<T>[]
  value: T[]
  onChange: (value: T[]) => void
  max?: number
  // An option that can't be combined with the others (e.g. "Everyone").
  exclusive?: T
}) {
  const full = max !== undefined && value.length >= max

  function toggle(v: T) {
    if (exclusive !== undefined) {
      if (v === exclusive) return onChange(value.includes(v) ? [] : [v])
      return onChange(toggleIn(value.filter((x) => x !== exclusive), v, max))
    }
    onChange(toggleIn(value, v, max))
  }

  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => {
        const selected = value.includes(o.value)
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={selected}
            disabled={full && !selected}
            onClick={() => toggle(o.value)}
            className={chipClass(selected)}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function cardClass(selected: boolean): string {
  return `w-full rounded-xl border-2 p-3.5 text-left transition-colors disabled:opacity-40 ${
    selected ? 'border-gray-900 bg-gray-50' : 'border-gray-200 hover:border-gray-400'
  }`
}

export function CardSelect<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Option<T>[]
  value: T | null
  onChange: (value: T) => void
}) {
  return (
    <div className="space-y-2">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cardClass(value === o.value)}
        >
          <div className="font-medium">{o.label}</div>
          {o.description && <div className="mt-0.5 text-sm text-gray-600">{o.description}</div>}
        </button>
      ))}
    </div>
  )
}

export function CardMultiSelect<T extends string>({
  options,
  value,
  onChange,
  max,
}: {
  options: Option<T>[]
  value: T[]
  onChange: (value: T[]) => void
  max?: number
}) {
  const full = max !== undefined && value.length >= max
  return (
    <div className="space-y-2">
      {options.map((o) => {
        const selected = value.includes(o.value)
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={selected}
            disabled={full && !selected}
            onClick={() => onChange(toggleIn(value, o.value, max))}
            className={cardClass(selected)}
          >
            <div className="flex items-center justify-between gap-3 font-medium">
              <span>{o.label}</span>
              {selected && <span aria-hidden>✓</span>}
            </div>
            {o.description && <div className="mt-0.5 text-sm text-gray-600">{o.description}</div>}
          </button>
        )
      })}
    </div>
  )
}

const selectClass =
  'rounded-lg border border-gray-300 bg-white px-3 py-2 focus:border-gray-800 focus:outline-none'

export function HeightPicker({
  value,
  onChange,
  label,
}: {
  value: HeightFtIn
  onChange: (value: HeightFtIn) => void
  label: string
}) {
  return (
    <div className="flex items-center gap-2">
      <select
        aria-label={`${label} feet`}
        value={value.feet}
        onChange={(e) => onChange({ ...value, feet: Number(e.target.value) })}
        className={selectClass}
      >
        {[4, 5, 6, 7].map((f) => (
          <option key={f} value={f}>
            {f} ft
          </option>
        ))}
      </select>
      <select
        aria-label={`${label} inches`}
        value={value.inches}
        onChange={(e) => onChange({ ...value, inches: Number(e.target.value) })}
        className={selectClass}
      >
        {Array.from({ length: 12 }, (_, i) => (
          <option key={i} value={i}>
            {i} in
          </option>
        ))}
      </select>
    </div>
  )
}

export function NumberSelect({
  value,
  options,
  onChange,
  label,
}: {
  value: number
  options: number[]
  onChange: (value: number) => void
  label: string
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className={selectClass}
    >
      {options.map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </select>
  )
}

export function SkipLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="mt-6 w-full text-center text-sm text-gray-500 underline">
      {label}
    </button>
  )
}

const styledSelectClass =
  'w-full rounded-xl border border-gray-200 bg-white px-4 py-3 pr-10 text-base appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500'

export function StyledSelect({
  value,
  onChange,
  options,
  placeholder,
  ariaLabel,
  className = '',
}: {
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
  ariaLabel: string
  className?: string
}) {
  return (
    <div className={`relative ${className}`}>
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${styledSelectClass} ${value === '' ? 'text-gray-400' : 'text-gray-900'}`}
      >
        {placeholder !== undefined && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((o) => (
          <option key={o.value} value={o.value} className="text-gray-900">
            {o.label}
          </option>
        ))}
      </select>
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        fill="currentColor"
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500"
      >
        <path
          fillRule="evenodd"
          d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
          clipRule="evenodd"
        />
      </svg>
    </div>
  )
}
