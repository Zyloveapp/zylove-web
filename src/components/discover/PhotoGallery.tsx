import { useState } from 'react'
import StoredImg from '../StoredImg'

export default function PhotoGallery({ photos, name }: { photos: string[]; name: string }) {
  const [index, setIndex] = useState(0)
  const count = photos.length
  if (count === 0) return null

  return (
    <div>
      <button
        type="button"
        onClick={() => setIndex((i) => (i + 1) % count)}
        disabled={count < 2}
        aria-label={count > 1 ? 'Next photo' : undefined}
        className="relative block aspect-[2/3] w-full overflow-hidden rounded-2xl bg-white/5"
      >
        <StoredImg src={photos[index]} alt={`${name}, photo ${index + 1}`} className="h-full w-full object-cover" />
        {count > 1 && (
          <span className="absolute right-3 top-3 rounded-full bg-black/60 px-2.5 py-1 text-xs font-medium text-white">
            {index + 1} / {count}
          </span>
        )}
      </button>

      {count > 1 && (
        <div className="mt-3 flex justify-center gap-2">
          {photos.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setIndex(i)}
              aria-label={`Photo ${i + 1}`}
              aria-current={i === index}
              className={`h-2 w-2 rounded-full border border-white/60 ${i === index ? 'bg-white' : 'bg-transparent'}`}
            />
          ))}
        </div>
      )}
    </div>
  )
}
