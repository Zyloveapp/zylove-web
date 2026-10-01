import { useRef, useState, type ChangeEvent } from 'react'
import { MAX_PHOTO_BYTES, MAX_PHOTOS, releasePhotoPreview, type PhotoDraft } from './types'

interface PhotosStepProps {
  photos: PhotoDraft[]
  onChange: (photos: PhotoDraft[]) => void
}

// Photos stay local (object-URL previews) until the final step uploads them,
// so abandoning onboarding never leaves orphaned files in Storage.
export default function PhotosStep({ photos, onChange }: PhotosStepProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)

  function handleFiles(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = '' // allow re-selecting the same file
    setError(null)

    const room = MAX_PHOTOS - photos.length
    const accepted: PhotoDraft[] = []
    const problems: string[] = []

    for (const file of files) {
      if (!file.type.startsWith('image/')) {
        problems.push(`${file.name} isn't an image.`)
      } else if (file.size > MAX_PHOTO_BYTES) {
        problems.push(`${file.name} is over 10 MB.`)
      } else if (accepted.length >= room) {
        problems.push(`Only ${MAX_PHOTOS} photos allowed.`)
        break
      } else {
        accepted.push({ id: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file) })
      }
    }

    if (problems.length) setError(problems.join(' '))
    if (accepted.length) onChange([...photos, ...accepted])
  }

  function remove(id: string) {
    const photo = photos.find((p) => p.id === id)
    if (photo) releasePhotoPreview(photo)
    onChange(photos.filter((p) => p.id !== id))
  }

  function makePrimary(id: string) {
    const photo = photos.find((p) => p.id === id)
    if (!photo) return
    onChange([photo, ...photos.filter((p) => p.id !== id)])
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Add your photos</h1>
      <p className="text-gray-600">
        Add 1–{MAX_PHOTOS} photos. The first one is your main photo — tap another to make it first.
      </p>

      <div className="grid grid-cols-3 gap-2">
        {photos.map((p, i) => (
          <div key={p.id} className="relative aspect-[3/4] overflow-hidden rounded-lg bg-gray-100">
            <button type="button" onClick={() => makePrimary(p.id)} className="h-full w-full">
              <img src={p.previewUrl} alt={`Photo ${i + 1}`} className="h-full w-full object-cover" />
            </button>
            {i === 0 && (
              <span className="absolute left-1 top-1 rounded bg-gray-900/80 px-1.5 py-0.5 text-xs text-white">
                Main
              </span>
            )}
            <button
              type="button"
              onClick={() => remove(p.id)}
              aria-label={`Remove photo ${i + 1}`}
              className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-gray-900/80 text-sm text-white"
            >
              ×
            </button>
          </div>
        ))}
        {photos.length < MAX_PHOTOS && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="flex aspect-[3/4] items-center justify-center rounded-lg border-2 border-dashed border-gray-300 text-3xl text-gray-400 hover:border-gray-500"
            aria-label="Add photos"
          >
            +
          </button>
        )}
      </div>

      <input ref={inputRef} type="file" accept="image/*" multiple onChange={handleFiles} className="hidden" />
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  )
}
