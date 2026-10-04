import { Link } from 'react-router-dom'
import { goDeeperAnswerRows, goDeeperComplete, type GoDeeperAnswers } from './goDeeper'

// Go Deeper section. On your own profile, while any answer is missing it
// shows the prompt card; answered questions are listed either way. On
// someone else's only their answers show (nothing when there are none).
export default function HowIOperate({ answers, own }: { answers: GoDeeperAnswers; own: boolean }) {
  const rows = goDeeperAnswerRows(answers)
  const complete = !own || goDeeperComplete(answers)
  if (!own && rows.length === 0) return null
  return (
    <section>
      <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-white/50">How I operate</h3>
      {rows.length > 0 && (
        <dl className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-5">
          {rows.map((r) => (
            <div key={r.label}>
              <dt className="text-xs text-white/40">{r.label}</dt>
              <dd className="mt-0.5 text-white">{r.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {!complete && (
        <div className={`rounded-2xl border border-[#1B4FD8]/40 bg-[#1B4FD8]/10 p-5 ${rows.length > 0 ? 'mt-3' : ''}`}>
          <p className="font-semibold text-white">✦ How do you operate in a relationship?</p>
          <p className="mt-1 text-sm text-white/60">
            Answer 3 quick questions to show matches how you really work. It sharpens your compatibility score.
          </p>
          <Link
            to="/profile/go-deeper"
            className="mt-4 inline-block rounded-xl bg-[#1B4FD8] px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
          >
            Answer now →
          </Link>
        </div>
      )}
    </section>
  )
}
