import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '../services/firebase'
import { useAuthStore } from '../store/authStore'
import { selectPlayPrompts, SPICE_META, PLAY_TAG_LABELS } from '../types/dualProfile'
import { playDescriptorLabels, typePreferenceLabels } from '../types/playDescriptors'
import { MAX_PHOTOS } from '../components/onboarding/types'
import { MODERATION_MESSAGES, uploadModeratedPhoto } from '../services/moderatedPhotos'
import { photoError } from '../services/profile'
import { changeDisplayName, nextNameChange } from '../services/displayNames'
import {
  MIN_PLAY_ANSWERS,
  generatePlayBio,
  loadPlayDraft,
  playAnswerCount,
  tagsIn,
  type PlayDraft,
} from '../services/playOnboarding'
import { hasPlayChanges, playNameChanged, removePlayPhoto, savePlayEdits } from '../services/playProfileEdit'
import {
  AboutYouStep,
  ArrangementStep,
  MyTypeStep,
  NonNegotiablesStep,
  PLAY_BIO_MAX,
  PlayBioStep,
  PlayNameStep,
  PlayPromptsStep,
  SceneStep,
  SpiceStep,
} from '../components/onboarding/PlaySteps'
import StoredImg from '../components/StoredImg'

type SectionId =
  | 'photos'
  | 'name'
  | 'bio'
  | 'spice'
  | 'arrangement'
  | 'scene'
  | 'nonNegotiables'
  | 'aboutYou'
  | 'myType'
  | 'prompts'

interface Loaded {
  uid: string
  original: PlayDraft
  identity: { genderIdentity: unknown; attractedTo: unknown }
  displayName: string
  nameLockedUntil: Date | null
}

// One collapsible section: title and a one-line summary; the editor opens below.
function Section({
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  title: string
  summary: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <section className="rounded-2xl border border-[#E03131]/20 bg-[#E03131]/[0.04]">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
      >
        <span className="min-w-0">
          <span className="block text-xs font-semibold uppercase tracking-widest text-red-400">{title}</span>
          <span className="mt-1 block truncate text-sm text-white/60">{summary || 'Not set'}</span>
        </span>
        <span className="shrink-0 text-sm text-white/40">{open ? '−' : 'Edit'}</span>
      </button>
      {open && <div className="border-t border-[#E03131]/15 px-5 pt-5 pb-6">{children}</div>}
    </section>
  )
}

// Edit the saved Play profile section by section ("Reset the vibe" is the
// full onboarding redo). Photos save as they change; everything else waits
// for "Save changes", which writes only what changed.
export default function EditPlayProfile() {
  const navigate = useNavigate()
  const uid = useAuthStore((s) => s.user?.uid) ?? ''
  const [loaded, setLoaded] = useState<Loaded | 'none' | 'error' | null>(null)
  const [draft, setDraft] = useState<PlayDraft | null>(null)
  const [open, setOpen] = useState<SectionId | null>(null)
  const [photoBusy, setPhotoBusy] = useState(false)
  const [photoMessage, setPhotoMessage] = useState<string | null>(null)
  const [bioBusy, setBioBusy] = useState(false)
  const [bioMessage, setBioMessage] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!uid) return
    let cancelled = false
    Promise.all([loadPlayDraft(uid, selectPlayPrompts(uid).map((p) => p.id)), getDoc(doc(db, 'users', uid))])
      .then(([saved, root]) => {
        if (cancelled) return
        if (!saved) return setLoaded('none')
        const data = root.data()
        // The root doc's Play name is the real one (the profile copy is a mirror).
        const rootName: unknown = data?.playDisplayName
        const current = typeof rootName === 'string' && rootName ? { ...saved, playDisplayName: rootName } : saved
        setDraft(current)
        setLoaded({
          uid,
          original: current,
          identity: { genderIdentity: data?.genderIdentity, attractedTo: data?.attractedTo },
          displayName: typeof data?.displayName === 'string' ? data.displayName : '',
          nameLockedUntil: nextNameChange(data?.playDisplayNameUpdatedAt),
        })
      })
      .catch(() => !cancelled && setLoaded('error'))
    return () => {
      cancelled = true
    }
  }, [uid])

  if (loaded === 'none') return <Navigate to="/play-onboarding" replace />
  if (loaded === 'error') {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 bg-gray-950 px-4 text-center text-white">
        <p className="text-white/70">We couldn't load your Play profile.</p>
        <Link to="/profile" className="text-sm text-red-400 underline">
          Back to profile
        </Link>
      </div>
    )
  }
  if (!loaded || loaded.uid !== uid || !draft) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center bg-gray-950">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-[#E03131]" />
      </div>
    )
  }

  const info = loaded
  const update = (patch: Partial<PlayDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d))
  const toggle = (id: SectionId) => setOpen((o) => (o === id ? null : id))
  const props = { play: draft, update }
  const photos = draft.photos.map((p) => p.previewUrl)

  // Same minimums as Play onboarding.
  const problems = [
    !draft.playDisplayName.trim() && 'add a Play name',
    draft.spiceLevel === null && 'pick a spice level',
    tagsIn(draft.tags, 'arrangement').length === 0 && 'pick what you’re looking for',
    playAnswerCount(draft) < MIN_PLAY_ANSWERS && `answer ${MIN_PLAY_ANSWERS} prompts`,
    !draft.bio.trim() && 'write a bio',
  ].filter((p): p is string => Boolean(p))
  const changed = hasPlayChanges(info.original, draft)

  async function addPhoto(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const problem = photoError(file)
    if (problem) return setPhotoMessage(problem)
    setPhotoBusy(true)
    setPhotoMessage(null)
    // Waits for moderation (up to 30s); only a passed photo joins the grid.
    const { outcome, url } = await uploadModeratedPhoto(uid, 'play', file)
    if (outcome === 'approved' && url) {
      setDraft((d) =>
        d && !d.photos.some((p) => p.previewUrl === url)
          ? { ...d, photos: [...d.photos, { id: url, file: null, previewUrl: url }] }
          : d,
      )
    } else if (outcome !== 'approved') {
      setPhotoMessage(MODERATION_MESSAGES[outcome])
    }
    setPhotoBusy(false)
  }

  async function deletePhoto(url: string) {
    if (photos.length <= 1) return setPhotoMessage('Keep at least one Play photo.')
    setPhotoBusy(true)
    setPhotoMessage(null)
    try {
      await removePlayPhoto(uid, url)
      setDraft((d) => (d ? { ...d, photos: d.photos.filter((p) => p.previewUrl !== url) } : d))
    } catch {
      setPhotoMessage("Couldn't remove that photo. Try again.")
    } finally {
      setPhotoBusy(false)
    }
  }

  async function regenerateBio() {
    if (!draft) return
    setBioBusy(true)
    setBioMessage(null)
    const result = await generatePlayBio(draft, info.identity)
    if ('bio' in result) update({ bio: result.bio.slice(0, PLAY_BIO_MAX) })
    else
      setBioMessage(
        result.error === 'limit'
          ? "You've used this week's 3 bio generations — write it yourself for now."
          : "Couldn't generate a bio right now. Try again or write it yourself.",
      )
    setBioBusy(false)
  }

  async function save() {
    if (!draft || saving || problems.length > 0) return
    setSaving(true)
    setSaveError(null)
    try {
      // A new Play name goes through updateDisplayName (30-day limit,
      // enforced server-side); nothing else is saved if it's refused.
      if (playNameChanged(info.original, draft)) {
        const refused = await changeDisplayName('play', draft.playDisplayName)
        if (refused) {
          setSaveError(refused)
          setSaving(false)
          return
        }
      }
      await savePlayEdits(uid, info.original, draft)
      navigate('/profile', { replace: true, state: { flash: '✦ Play profile updated.' } })
    } catch {
      setSaveError("Couldn't save your changes. Try again.")
      setSaving(false)
    }
  }

  const spice = draft.spiceLevel ? SPICE_META[draft.spiceLevel] : null
  const tagSummary = (category: Parameters<typeof tagsIn>[1]) =>
    tagsIn(draft.tags, category)
      .map((t) => PLAY_TAG_LABELS[t].label)
      .join(', ')
  const scene = (['acts', 'dynamic', 'vibe', 'place'] as const).flatMap((c) => tagsIn(draft.tags, c))

  return (
    <div className="min-h-[calc(100dvh-7rem)] bg-gray-950 text-white">
      <div className="mx-auto max-w-xl space-y-4 px-4 pt-6 pb-36">
        <div className="mb-2 flex items-center gap-3">
          <Link to="/profile" className="text-sm font-medium text-red-400 hover:text-white">
            ← Back
          </Link>
          <h1 className="text-2xl font-bold">Edit Play profile</h1>
        </div>

        <Section title="Photos" summary={`${photos.length} photo${photos.length === 1 ? '' : 's'}`} open={open === 'photos'} onToggle={() => toggle('photos')}>
          <div className="grid grid-cols-3 gap-2">
            {photos.map((url) => (
              <div key={url} className="relative aspect-[3/4] overflow-hidden rounded-xl">
                <StoredImg src={url} alt="" className="h-full w-full object-cover" />
                <button
                  type="button"
                  onClick={() => void deletePhoto(url)}
                  disabled={photoBusy}
                  aria-label="Remove photo"
                  className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-full bg-black/70 text-sm text-white disabled:opacity-40"
                >
                  ✕
                </button>
              </div>
            ))}
            {photos.length < MAX_PHOTOS && (
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                disabled={photoBusy}
                className="flex aspect-[3/4] items-center justify-center rounded-xl border border-dashed border-[#E03131]/40 text-2xl text-red-400 disabled:opacity-40"
              >
                {photoBusy ? '…' : '+'}
              </button>
            )}
          </div>
          <input ref={fileInput} type="file" accept="image/*" className="hidden" onChange={(e) => void addPhoto(e)} />
          {photoMessage && <p className="mt-3 text-sm text-amber-300">{photoMessage}</p>}
          <p className="mt-3 text-xs text-white/40">Photo changes save right away. New photos are checked before they appear.</p>
        </Section>

        <Section title="Play name" summary={draft.playDisplayName || info.displayName} open={open === 'name'} onToggle={() => toggle('name')}>
          <PlayNameStep {...props} lockedUntil={info.nameLockedUntil} placeholder={info.displayName || undefined} />
        </Section>

        <Section title="Bio" summary={draft.bio} open={open === 'bio'} onToggle={() => toggle('bio')}>
          <PlayBioStep
            bio={draft.bio}
            editing
            busy={bioBusy}
            message={bioMessage}
            onChange={(bio) => update({ bio })}
            onGenerate={() => void regenerateBio()}
            onWrite={() => {}}
          />
        </Section>

        <Section title="Spice level" summary={spice ? `${spice.emoji} ${spice.label}` : ''} open={open === 'spice'} onToggle={() => toggle('spice')}>
          <SpiceStep {...props} />
        </Section>

        <Section title="Looking for" summary={tagSummary('arrangement')} open={open === 'arrangement'} onToggle={() => toggle('arrangement')}>
          <ArrangementStep {...props} />
        </Section>

        <Section title="Scene" summary={scene.length ? `${scene.length} selected` : ''} open={open === 'scene'} onToggle={() => toggle('scene')}>
          <SceneStep {...props} />
        </Section>

        <Section title="Non-negotiables" summary={`${draft.nonNegotiables.length || 'None'} selected`} open={open === 'nonNegotiables'} onToggle={() => toggle('nonNegotiables')}>
          <NonNegotiablesStep {...props} />
        </Section>

        <Section
          title="About you"
          summary={playDescriptorLabels({
            playHeight: draft.heightCm,
            playBodyType: draft.bodyType,
            playBodyHair: draft.bodyHair,
            playGrooming: draft.grooming,
            playEnergy: draft.energy,
          }).join(' · ')}
          open={open === 'aboutYou'}
          onToggle={() => toggle('aboutYou')}
        >
          <AboutYouStep {...props} />
        </Section>

        <Section title="My type" summary={typePreferenceLabels(draft.typePreferences).join(' · ')} open={open === 'myType'} onToggle={() => toggle('myType')}>
          <MyTypeStep {...props} />
        </Section>

        <Section
          title="Prompts + Go Deeper"
          summary={`${playAnswerCount(draft)} answered`}
          open={open === 'prompts'}
          onToggle={() => toggle('prompts')}
        >
          <PlayPromptsStep {...props} inspirationStyle="pills" />
        </Section>
      </div>

      {/* Sits above the mobile bottom nav (h-16). */}
      <div className="sticky bottom-16 border-t border-[#E03131]/20 bg-gray-950 px-4 py-3">
        <div className="mx-auto max-w-xl">
          {(saveError || (changed && problems.length > 0)) && (
            <p className="mb-2 text-center text-sm text-red-300">{saveError ?? `To save, ${problems.join(', ')}.`}</p>
          )}
          <button
            type="button"
            onClick={() => void save()}
            disabled={!changed || problems.length > 0 || saving}
            className="w-full rounded-xl bg-[#E03131] py-3 font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {saving ? 'Saving…' : changed ? 'Save changes' : 'No changes yet'}
          </button>
        </div>
      </div>
    </div>
  )
}
