import { useEffect, useState } from 'react'
import { doc, getDoc } from 'firebase/firestore'
import { db } from './firebase'

// Austin-only launch (UPDATE 6): the Founding/Live cities, for the sign-in
// and Join pages. publicStats/openCities is written by the server whenever a
// city's status changes (functions/src/waitlist.ts); until then, Austin.
export interface OpenCity {
  name: string
  state: string
}
const DEFAULT: OpenCity[] = [{ name: 'Austin', state: 'TX' }]

export function useOpenCities(): OpenCity[] {
  const [cities, setCities] = useState<OpenCity[]>(DEFAULT)
  useEffect(() => {
    let cancelled = false
    getDoc(doc(db, 'publicStats/openCities'))
      .then((snap) => {
        const list: unknown = snap.get('cities')
        if (cancelled || !Array.isArray(list)) return
        const ok = list.filter((c): c is OpenCity => typeof c?.name === 'string' && typeof c?.state === 'string')
        if (ok.length) setCities(ok)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
  return cities
}

// "Austin, TX" / "Austin, TX and Dallas, TX" / "Austin, TX, Dallas, TX and Houston, TX".
export function cityList(cities: OpenCity[]): string {
  const names = cities.map((c) => `${c.name}, ${c.state}`)
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
