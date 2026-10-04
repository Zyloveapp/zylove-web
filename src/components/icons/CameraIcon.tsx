// Camera outline for the chat's photo button. Inherits text color.
export default function CameraIcon({ className = 'h-6 w-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className={className} aria-hidden>
      <path
        d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.6l1.3-2h7.2l1.3 2h1.6A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-9Z"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12.5" r="3.5" />
    </svg>
  )
}
