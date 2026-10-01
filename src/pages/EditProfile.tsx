import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import {
  BIO_LIMIT,
  MAX_PROFILE_PHOTOS,
  MAX_PROMPTS,
  PROMPT_ANSWER_LIMIT,
  loadOwnProfile,
  photoError,
  regenerateBio,
  removeProfilePhoto,
  saveSparkEdits,
  uploadProfilePhoto,
} from '../services/profile'
import type { DiscoverProfile } from '../services/discover'
import { SPARK_PROMPT_BANK, type PromptAnswer } from '../types/dualProfile'
import { profileGenderLabel, promptQuestion } from '../components/discover/labels'

const inputClass =
  'w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-white placeholder:text-white/30 focus:border-white/30 focus:outline-none'

function Section({ emoji, title, sub, children }: { emoji: string; title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">
          <span aria-hidden>{emoji}</span> {title}
        </h2>
        {sub && <p className="text-sm text-white/40">{sub}</p>}
      </div>
      {children}
    </section>
  )
}

function LockedField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="mb-1 text-sm text-white/60">🔒 {label}</p>
      <p className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-white/70">{value}</p>
    </div>
  )
}

// Prompt picker: Spark prompts not already in use. Bottom sheet on mobile.
function PromptPicker({ used, onPick, onClose }: { used: string[]; onPick: (id: string) => void; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-sm lg:items-center lg:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="prompt-picker-title"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="flex max-h-[80dvh] w-full flex-col rounded-t-2xl bg-gray-900 text-white lg:max-w-md lg:rounded-2xl">
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
          <h2 id="prompt-picker-title" className="font-semibold">
            Choose a prompt
          </h2>
          <button type="button" onClick={onClose} className="text-sm text-white/50 hover:text-white">
            Cancel
          </button>
        </div>
        <ul className="overflow-y-auto px-3 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))]">
          {SPARK_PROMPT_BANK.filter((p) => !used.includes(p.id)).map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onPick(p.id)}
                className="w-full rounded-xl px-3 py-3 text-left text-sm text-white/90 hover:bg-white/10"
              >
                {p.text}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

type Picker = { swapIndex: number | null } // null = adding a new prompt

export default function EditProfile() {
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const navigate = useNavigate()
  const [profile, setProfile] = useState<DiscoverProfile | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [displayName, setDisplayName] = useState('')
  const [pronouns, setPronouns] = useState('')
  const [bio, setBio] = useState('')
  const [prompts, setPrompts] = useState<PromptAnswer[]>([])
  const [photos, setPhotos] = useState<string[]>([])
  const [photoBusy, setPhotoBusy] = useState(false)
  const [photoMessage, setPhotoMessage] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [bioError, setBioError] = useState(false)
  const [picker, setPicker] = useState<Picker | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveState, setSaveState] = useState<'saved' | 'error' | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!uid) return
    let cancelled = false
    loadOwnProfile(uid)
      .then((own) => {
        if (cancelled) return
        if (!own) return setLoadError(true)
        setProfile(own.profile)
        setDisplayName(own.profile.displayName ?? '')
        setPronouns(own.profile.pronouns ?? '')
        setBio(own.bio.slice(0, BIO_LIMIT))
        setPrompts(own.prompts.slice(0, MAX_PROMPTS))
        setPhotos(Array.isArray(own.profile.photoURLs) ? own.profile.photoURLs : [])
      })
      .catch(() => !cancelled && setLoadError(true))
    return () => {
      cancelled = true
    }
  }, [uid])

  async function addPhoto(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const problem = photoError(file)
    if (problem) return setPhotoMessage(problem)
    setPhotoBusy(true)
    setPhotoMessage(null)
    try {
      const url = await uploadProfilePhoto(uid, file)
      setPhotos((p) => [...p, url])
    } catch {
      setPhotoMessage("Couldn't upload that photo. Try again.")
    } finally {
      setPhotoBusy(false)
    }
  }

  async function deletePhoto(url: string) {
    setPhotoBusy(true)
    setPhotoMessage(null)
    try {
      await removeProfilePhoto(uid, url)
      setPhotos((p) => p.filter((u) => u !== url))
    } catch {
      setPhotoMessage("Couldn't remove that photo. Try again.")
    } finally {
      setPhotoBusy(false)
    }
  }

  async function handleRegenerate() {
    if (!profile) return
    setGenerating(true)
    setBioError(false)
    const next = await regenerateBio(profile, displayName, prompts)
    if (next) setBio(next)
    else setBioError(true)
    setGenerating(false)
  }

  function pickPrompt(id: string) {
    if (!picker) return
    const { swapIndex } = picker
    // Swapping starts the answer fresh, like mobile.
    setPrompts((ps) =>
      swapIndex === null ? [...ps, { promptId: id, answer: '' }] : ps.map((p, i) => (i === swapIndex ? { promptId: id, answer: '' } : p)),
    )
    setPicker(null)
  }

  async function save() {
    if (!displayName.trim() || saving) return
    setSaving(true)
    setSaveState(null)
    try {
      await saveSparkEdits(uid, { displayName, pronouns, bio, prompts })
      setSaveState('saved')
      setTimeout(() => navigate('/profile'), 1200)
    } catch {
      setSaveState('error')
    } finally {
      setSaving(false)
    }
  }

  const page = 'min-h-[calc(100dvh-4rem)] bg-gray-950 text-white lg:min-h-[calc(100dvh-3.5rem)]'

  if (loadError) {
    return (
      <div className={`flex flex-col items-center justify-center gap-3 px-4 ${page}`}>
        <p className="text-white/60">Couldn't load your profile.</p>
        <Link to="/profile" className="text-sm text-white/40 underline hover:text-white/60">
          Back to Profile
        </Link>
      </div>
    )
  }
  if (!profile) {
    return (
      <div className={`flex items-center justify-center ${page}`}>
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
      </div>
    )
  }

  const gender = profileGenderLabel(profile)

  return (
    <div className={page}>
      <header className="mx-auto flex max-w-xl items-center justify-between px-4 pt-5">
        <Link to="/profile" className="text-sm font-medium text-[#7C9BFF] hover:text-white">
          ← Back
        </Link>
        <h1 className="font-semibold">✦ Spark Profile</h1>
        <span className="w-12" aria-hidden />
      </header>

      <div className="mx-auto max-w-xl space-y-10 px-4 pt-6 pb-8">
        <Section emoji="🪪" title="Identity" sub="How you show up across Zylove">
          <label className="block">
            <span className="mb-1 block text-sm text-white/60">Display name</span>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={40} className={inputClass} />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm text-white/60">Pronouns (optional)</span>
            <input
              value={pronouns}
              onChange={(e) => setPronouns(e.target.value)}
              placeholder="e.g. she/her, they/them"
              maxLength={40}
              className={inputClass}
            />
          </label>
          {profile.birthday && <LockedField label="Birthday" value={profile.birthday} />}
          {gender && <LockedField label="Gender" value={gender} />}
          {(profile.birthday || gender) && (
            <p className="text-xs text-white/30">Locked after account setup for account security</p>
          )}
        </Section>

        <Section emoji="📸" title="Photos" sub={`Up to ${MAX_PROFILE_PHOTOS} photos · not shared with Play`}>
          <div className="grid grid-cols-3 gap-2">
            {photos.map((url, i) => (
              <div key={url} className="relative aspect-[3/4] overflow-hidden rounded-xl bg-white/5">
                <img src={url} alt={`Photo ${i + 1}`} className="h-full w-full object-cover" />
                {/* Keep at least one photo — Discover hides profiles without one. */}
                {photos.length > 1 && (
                  <button
                    type="button"
                    onClick={() => deletePhoto(url)}
                    disabled={photoBusy}
                    aria-label={`Delete photo ${i + 1}`}
                    className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-black/70 text-xs font-bold text-white hover:bg-black disabled:opacity-50"
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
            {photos.length < MAX_PROFILE_PHOTOS && (
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                disabled={photoBusy}
                className="flex aspect-[3/4] flex-col items-center justify-center rounded-xl border border-dashed border-[#1B4FD8]/60 bg-[#1B4FD8]/10 text-[#7C9BFF] hover:bg-[#1B4FD8]/20 disabled:opacity-50"
              >
                {photoBusy ? (
                  <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white" />
                ) : (
                  <>
                    <span className="text-3xl leading-none">+</span>
                    <span className="mt-1 text-xs font-semibold">Add photo</span>
                  </>
                )}
              </button>
            )}
          </div>
          <input ref={fileInput} type="file" accept="image/*" onChange={addPhoto} className="hidden" />
          <p className="text-xs text-white/30">Photo changes save right away.</p>
          {photoMessage && <p className="text-sm text-red-400">{photoMessage}</p>}
        </Section>

        <Section emoji="✍️" title="Your bio" sub={`Genuine, story-style. ${BIO_LIMIT} chars.`}>
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value.slice(0, BIO_LIMIT))}
            maxLength={BIO_LIMIT}
            rows={5}
            placeholder="Tell your story — what makes you you? What are you actually looking for?"
            className={`${inputClass} resize-none`}
          />
          <div className="flex items-center justify-between text-sm">
            <button
              type="button"
              onClick={handleRegenerate}
              disabled={generating}
              className="font-semibold text-[#7C9BFF] hover:text-white disabled:opacity-50"
            >
              {generating ? 'Generating…' : '↺ Regenerate bio'}
            </button>
            <span className="text-white/30">
              {bio.length}/{BIO_LIMIT}
            </span>
          </div>
          {bioError && <p className="text-sm text-red-400">Couldn't generate a bio right now. Try again.</p>}
        </Section>

        <Section emoji="💬" title="Prompts" sub={`Answer at least 2 (max ${MAX_PROMPTS})`}>
          {prompts.map((p, i) => (
            <div key={p.promptId} className="rounded-xl border border-white/10 border-l-[#1B4FD8] border-l-2 bg-white/5 p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm text-white/60">{promptQuestion(p.promptId)}</p>
                <button
                  type="button"
                  onClick={() => setPicker({ swapIndex: i })}
                  className="shrink-0 text-sm text-[#7C9BFF] hover:text-white"
                >
                  ↻ Swap prompt
                </button>
              </div>
              <textarea
                value={p.answer}
                onChange={(e) =>
                  setPrompts((ps) =>
                    ps.map((q, j) => (j === i ? { ...q, answer: e.target.value.slice(0, PROMPT_ANSWER_LIMIT) } : q)),
                  )
                }
                maxLength={PROMPT_ANSWER_LIMIT}
                rows={3}
                placeholder="Your answer…"
                className="mt-2 w-full resize-none bg-transparent text-white placeholder:text-white/30 focus:outline-none"
              />
              <p className="text-right text-xs text-white/30">
                {p.answer.length}/{PROMPT_ANSWER_LIMIT}
              </p>
            </div>
          ))}
          {prompts.length < MAX_PROMPTS && (
            <button
              type="button"
              onClick={() => setPicker({ swapIndex: null })}
              className="w-full rounded-xl border border-dashed border-white/20 py-3 text-sm font-semibold text-[#7C9BFF] hover:bg-white/5"
            >
              ＋ Add a prompt
            </button>
          )}
        </Section>
      </div>

      {/* Sits above the mobile bottom nav (h-16); flush on desktop. */}
      <div className="sticky bottom-16 border-t border-white/10 bg-gray-950 px-4 py-3 lg:bottom-0">
        <div className="mx-auto max-w-xl">
          {saveState === 'saved' && (
            <p className="mb-2 text-center text-sm text-emerald-400">Saved ✦ — Your Spark profile has been updated.</p>
          )}
          {saveState === 'error' && <p className="mb-2 text-center text-sm text-red-400">Couldn't save. Try again.</p>}
          <button
            type="button"
            onClick={save}
            disabled={saving || !displayName.trim() || saveState === 'saved'}
            className="w-full rounded-xl bg-[#1B4FD8] py-3 font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Save Spark profile'}
          </button>
        </div>
      </div>

      {picker && (
        <PromptPicker
          used={prompts.map((p) => p.promptId)}
          onPick={pickPrompt}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  )
}
