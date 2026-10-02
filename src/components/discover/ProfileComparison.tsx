import type { ReactNode } from 'react'
import type { DiscoverProfile } from '../../services/discover'
import { lifestyleLabel, loveLanguageLabel, personalityLabel, valueLabel } from './labels'
import { compareProfiles, joinNames } from './compare'
import { playCommons, playConversations, type PlayFacts } from './playCompare'

// Side-by-side Spark insights from both profiles (mirrors mobile's
// MatchScorecard): Things in Common, Worth a Conversation, Love Languages.

const MAX_DIFFERENCES = 2

function Section({ icon, title, iconClass, children }: { icon: string; title: string; iconClass: string; children: ReactNode }) {
  return (
    <div className="mt-6">
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-white">
        <span className={`mr-1.5 ${iconClass}`}>{icon}</span>
        {title}
      </p>
      {children}
    </div>
  )
}

function Row({ label, detail, accent }: { label: string; detail: string; accent: string }) {
  return (
    <div className={`mb-2 border-l-2 pl-3 ${accent}`}>
      <p className="text-sm font-medium text-white/80">{label}</p>
      <p className="text-sm text-white/55">{detail}</p>
    </div>
  )
}

function LoveLangCell({ title, items, matched }: { title: string; items: string[]; matched: Set<string> }) {
  return (
    <div>
      <p className="mb-1.5 text-xs text-white/40">{title}</p>
      {items.length === 0 ? (
        <p className="text-sm text-white/25">—</p>
      ) : (
        <ul className="space-y-1">
          {items.map((l) => (
            <li key={l} className={`text-sm ${matched.has(l) ? 'text-white' : 'text-white/55'}`}>
              {loveLanguageLabel(l)}
              {matched.has(l) && <span className="ml-1.5 font-semibold text-[#1B4FD8]">✓</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default function ProfileComparison({ me, them }: { me: DiscoverProfile; them: DiscoverProfile }) {
  const facts = compareProfiles(me, them)
  const { sharedValues, sharedTraits, sharedLife, onlyMine, onlyTheirs, myGive, myNeed, theirGive, theirNeed } = facts

  const commons: { label: string; detail: string }[] = []
  if (sharedValues.length > 0) {
    commons.push({ label: 'Shared values', detail: `You both prioritize ${joinNames(sharedValues.map(valueLabel))}.` })
  }
  if (sharedTraits.length > 0) {
    commons.push({ label: 'Personality match', detail: `You're both ${joinNames(sharedTraits.map(personalityLabel))}.` })
  }
  if (sharedLife.length > 0) {
    commons.push({ label: 'Lifestyle in common', detail: sharedLife.map(lifestyleLabel).join(' · ') })
  }

  // Pair one of yours with one of theirs where both sides differ (as mobile
  // does); otherwise list the side that has tags the other doesn't.
  const differences: { label: string; detail: string }[] = []
  const pairs = Math.min(onlyMine.length, onlyTheirs.length, MAX_DIFFERENCES)
  for (let i = 0; i < pairs; i++) {
    differences.push({
      label: 'Different lifestyles',
      detail: `You: ${lifestyleLabel(onlyMine[i])} · They: ${lifestyleLabel(onlyTheirs[i])}`,
    })
  }
  if (pairs === 0) {
    for (const t of onlyMine.slice(0, MAX_DIFFERENCES)) differences.push({ label: 'Just you', detail: lifestyleLabel(t) })
    for (const t of onlyTheirs.slice(0, MAX_DIFFERENCES - differences.length)) {
      differences.push({ label: 'Just them', detail: lifestyleLabel(t) })
    }
  }

  // Your give meets their need; their give meets your need.
  const iGiveTheyNeed = new Set(facts.iGiveTheyNeed)
  const theyGiveINeed = new Set(facts.theyGiveINeed)
  const hasLoveLangs = myGive.length + myNeed.length + theirGive.length + theirNeed.length > 0

  return (
    <>
      {commons.length > 0 && (
        <Section icon="✦" title="Things in common" iconClass="text-green-400">
          {commons.map((c) => (
            <Row key={c.label} label={c.label} detail={c.detail} accent="border-green-400/60" />
          ))}
        </Section>
      )}

      {differences.length > 0 && (
        <Section icon="◎" title="Worth a conversation" iconClass="text-amber-400">
          {differences.map((d, i) => (
            <Row key={i} label={d.label} detail={d.detail} accent="border-amber-400/60" />
          ))}
        </Section>
      )}

      {hasLoveLangs && (
        <Section icon="♡" title="Love languages" iconClass="text-[#1B4FD8]">
          <div className="grid max-w-md grid-cols-2 gap-x-6 gap-y-4 rounded-xl border border-white/[0.08] bg-white/5 p-4">
            <LoveLangCell title="You give" items={myGive} matched={iGiveTheyNeed} />
            <LoveLangCell title="You receive" items={myNeed} matched={theyGiveINeed} />
            <LoveLangCell title="They give" items={theirGive} matched={theyGiveINeed} />
            <LoveLangCell title="They need" items={theirNeed} matched={iGiveTheyNeed} />
          </div>
        </Section>
      )}
    </>
  )
}

// Play version: Things in common and Worth a conversation from both Play
// profiles. No love-languages grid — Play doesn't use them.
export function PlayComparison({ facts }: { facts: PlayFacts }) {
  const commons = playCommons(facts)
  const conversations = playConversations(facts)
  return (
    <>
      {commons.length > 0 && (
        <Section icon="🔥" title="Things in common" iconClass="text-[#E03131]">
          {commons.map((c) => (
            <Row key={c.label} label={c.label} detail={c.detail} accent="border-[#E03131]/60" />
          ))}
        </Section>
      )}

      {conversations.length > 0 && (
        <Section icon="◎" title="Worth a conversation" iconClass="text-amber-400">
          {conversations.map((c) => (
            <Row key={c.label} label={c.label} detail={c.detail} accent="border-amber-400/60" />
          ))}
        </Section>
      )}
    </>
  )
}
