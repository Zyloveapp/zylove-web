import { MAX_RANGE_AGE, MIN_AGE, parseBirthday } from './types'
import { StepHeader, StyledSelect } from './ui'

interface NameStepProps {
  legalName: string
  displayName: string
  birthdayRaw: string
  // Profile refresh after identity lock: shown, not editable. The private
  // first name locks with it.
  birthdayLocked?: boolean
  onChange: (patch: { legalName?: string; displayName?: string; birthdayRaw?: string }) => void
}

const inputClass = 'w-full rounded-lg border border-white/15 px-3 py-2 focus:border-[#1B4FD8] focus:outline-none'

const MONTH_OPTIONS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
].map((label, i) => ({ value: String(i + 1).padStart(2, '0'), label }))

const DAY_OPTIONS = Array.from({ length: 31 }, (_, i) => {
  const d = i + 1
  return { value: String(d).padStart(2, '0'), label: String(d) }
})

const CURRENT_YEAR = new Date().getFullYear()
const YEAR_OPTIONS = Array.from({ length: MAX_RANGE_AGE - MIN_AGE + 1 }, (_, i) => {
  const y = String(CURRENT_YEAR - MIN_AGE - i)
  return { value: y, label: y }
})

// birthdayRaw stays in MM/DD/YYYY form; unselected parts are left empty (e.g. "03//").
function splitBirthday(raw: string): [string, string, string] {
  const parts = raw.split('/')
  if (parts.length !== 3) return ['', '', '']
  const [m, d, y] = parts
  return [m.length === 2 ? m : '', d.length === 2 ? d : '', y.length === 4 ? y : '']
}

export default function NameStep({ legalName, displayName, birthdayRaw, birthdayLocked = false, onChange }: NameStepProps) {
  const [month, day, year] = splitBirthday(birthdayRaw)
  const setPart = (patch: { month?: string; day?: string; year?: string }) =>
    onChange({ birthdayRaw: `${patch.month ?? month}/${patch.day ?? day}/${patch.year ?? year}` })

  const complete = birthdayRaw.length === 10
  const parsed = complete ? parseBirthday(birthdayRaw) : null
  const error = birthdayLocked || !complete
    ? null
    : !parsed
      ? 'Please enter a valid date.'
      : parsed.age < MIN_AGE
        ? `You must be ${MIN_AGE} or older to use Zylove.`
        : null

  return (
    <div>
      <StepHeader title="Your name" />
      {/* Locked accounts set before legal names existed simply skip it. */}
      {!(birthdayLocked && !legalName) && (
        <label className="mb-5 block space-y-1">
          <span className="text-sm font-medium text-white/90">{birthdayLocked ? '🔒 ' : ''}Your first name</span>
          <input
            type="text"
            autoComplete="given-name"
            maxLength={50}
            value={legalName}
            readOnly={birthdayLocked}
            onChange={(e) => onChange({ legalName: e.target.value })}
            className={`${inputClass} read-only:opacity-60`}
          />
          <span className="block text-xs text-white/50">
            Your real name is private and used only for account security. It's never shown to other users.
          </span>
        </label>
      )}
      <label className="block space-y-1">
        <span className="text-sm font-medium text-white/90">What should we call you?</span>
        <input
          type="text"
          autoComplete="nickname"
          maxLength={30}
          value={displayName}
          onChange={(e) => onChange({ displayName: e.target.value })}
          className={inputClass}
        />
        <span className="block text-xs text-white/50">This is what others will see on your profile.</span>
      </label>
      {birthdayLocked && (
        <div className="mt-5 space-y-1">
          <span className="block text-sm font-medium text-white/90">🔒 Birthday</span>
          <p className="text-sm text-white/50">Locked after account setup.</p>
        </div>
      )}
      <div className={`mt-5 space-y-1 ${birthdayLocked ? 'hidden' : ''}`}>
        <span className="block text-sm font-medium text-white/90">Birthday</span>
        <div className="flex gap-2">
          <StyledSelect
            ariaLabel="Birth month"
            placeholder="Month"
            value={month}
            options={MONTH_OPTIONS}
            onChange={(v) => setPart({ month: v })}
            className="flex-[2]"
          />
          <StyledSelect
            ariaLabel="Birth day"
            placeholder="Day"
            value={day}
            options={DAY_OPTIONS}
            onChange={(v) => setPart({ day: v })}
            className="flex-1"
          />
          <StyledSelect
            ariaLabel="Birth year"
            placeholder="Year"
            value={year}
            options={YEAR_OPTIONS}
            onChange={(v) => setPart({ year: v })}
            className="flex-[1.5]"
          />
        </div>
      </div>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      {parsed && !error && (
        <p className="mt-2 text-sm text-emerald-300">
          🎂{' '}
          {new Date(`${parsed.iso}T00:00:00`).toLocaleDateString('en-US', {
            month: 'long',
            day: 'numeric',
            year: 'numeric',
          })}
        </p>
      )}
    </div>
  )
}
