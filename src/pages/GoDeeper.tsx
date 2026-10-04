import { useEffect, useState } from 'react'
import { useBackLinkClass } from '../store/modeStore'
import { Link, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { loadOwnProfile, saveGoDeeper } from '../services/profile'
import { GO_DEEPER_QUESTIONS, goDeeperAnswers, type GoDeeperAnswers, type GoDeeperKey } from '../components/profile/goDeeper'

type Loaded = { uid: string; answers: GoDeeperAnswers } | 'error'

// The three Go Deeper questions from onboarding, answerable from the profile.
export default function GoDeeper() {
  const backLinkClass = useBackLinkClass()
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const navigate = useNavigate()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [answers, setAnswers] = useState<GoDeeperAnswers>({})
  const [saving, setSaving] = useState(false)
  const [saveState, setSaveState] = useState<'saved' | 'error' | null>(null)

  useEffect(() => {
    if (!uid) return
    let cancelled = false
    loadOwnProfile(uid)
      .then((own) => {
        if (cancelled) return
        if (!own) return setLoaded('error')
        const current = goDeeperAnswers(own.profile)
        setAnswers(current)
        setLoaded({ uid, answers: current })
      })
      .catch(() => !cancelled && setLoaded('error'))
    return () => {
      cancelled = true
    }
  }, [uid])

  const { conflictStyle, togethernessStyle, stressResponse } = answers
  const complete = Boolean(conflictStyle && togethernessStyle && stressResponse)

  async function save() {
    if (!conflictStyle || !togethernessStyle || !stressResponse || saving) return
    setSaving(true)
    setSaveState(null)
    try {
      await saveGoDeeper(uid, { conflictStyle, togethernessStyle, stressResponse })
      setSaveState('saved')
      setTimeout(() => navigate('/profile'), 1200)
    } catch {
      setSaveState('error')
    } finally {
      setSaving(false)
    }
  }

  const page = 'min-h-[calc(100dvh-7rem)] lg:min-h-[calc(100dvh-7.5rem)] bg-gray-950 text-white'

  if (loaded === 'error') {
    return (
      <div className={`flex flex-col items-center justify-center gap-3 px-4 ${page}`}>
        <p className="text-white/60">Couldn't load your profile.</p>
        <Link to="/profile" className="text-sm text-white/40 underline hover:text-white/60">
          Back to Profile
        </Link>
      </div>
    )
  }
  if (loaded?.uid !== uid) {
    return (
      <div className={`flex items-center justify-center ${page}`}>
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
      </div>
    )
  }

  return (
    <div className={page}>
      <header className="mx-auto flex max-w-xl items-center justify-between px-4 pt-5">
        <Link to="/profile" className={`text-sm font-medium ${backLinkClass} hover:text-white`}>
          ← Back
        </Link>
        <h1 className="font-semibold">✦ How I operate</h1>
        <span className="w-12" aria-hidden />
      </header>

      <div className="mx-auto max-w-xl space-y-10 px-4 pt-6 pb-8">
        <p className="text-sm text-white/60">
          Three quick questions about how you actually operate in a relationship. Pick the one that sounds most like
          you.
        </p>

        {GO_DEEPER_QUESTIONS.map((q) => (
          <fieldset key={q.key}>
            <legend className="mb-3 text-lg font-semibold">{q.question}</legend>
            <div className="space-y-2">
              {Object.entries(q.labels).map(([value, label]) => {
                const selected = answers[q.key] === value
                return (
                  <label
                    key={value}
                    className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 transition-colors ${
                      selected
                        ? 'border-[#1B4FD8] bg-[#1B4FD8]/15 text-white'
                        : 'border-white/10 bg-white/5 text-white/80 hover:border-white/25'
                    }`}
                  >
                    <input
                      type="radio"
                      name={q.key}
                      value={value}
                      checked={selected}
                      onChange={() => setAnswers((a) => ({ ...a, [q.key as GoDeeperKey]: value }))}
                      className="accent-[#1B4FD8]"
                    />
                    {label}
                  </label>
                )
              })}
            </div>
          </fieldset>
        ))}
      </div>

      {/* Sits above the mobile bottom nav (h-16); flush on desktop. */}
      <div className="sticky bottom-16 border-t border-white/10 bg-gray-950 px-4 py-3">
        <div className="mx-auto max-w-xl">
          {saveState === 'saved' && (
            <p className="mb-2 text-center text-sm text-emerald-400">✦ Saved. Your matches will see this on your profile.</p>
          )}
          {saveState === 'error' && <p className="mb-2 text-center text-sm text-red-400">Couldn't save. Try again.</p>}
          <button
            type="button"
            onClick={save}
            disabled={!complete || saving || saveState === 'saved'}
            className="w-full rounded-xl bg-[#1B4FD8] py-3 font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {saving ? 'Saving…' : complete ? 'Save' : 'Answer all 3 to save'}
          </button>
        </div>
      </div>
    </div>
  )
}
