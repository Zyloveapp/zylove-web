import type { MatchEntry } from '../../services/matches'

// Stand-in until the real chat is built.
export default function ChatPlaceholder({ match, onBack }: { match: MatchEntry; onBack: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-white/10 px-6 py-4">
        <button type="button" onClick={onBack} className="text-white/60 hover:text-white lg:hidden" aria-label="Back to matches">
          ←
        </button>
        {match.photoURL && <img src={match.photoURL} alt="" className="h-9 w-9 rounded-full object-cover" />}
        <h2 className="font-semibold text-white">
          {match.name}
          {match.age !== null && <span className="font-normal text-white/50">, {match.age}</span>}
        </h2>
      </header>
      <div className="flex flex-1 items-center justify-center text-white/40">Chat coming soon</div>
    </div>
  )
}
