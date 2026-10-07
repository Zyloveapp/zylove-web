import { getDistanceMiles } from '../services/location'

// Launch cities. Each one runs its own founding circle (50 women + 50 men)
// and keeps bots on until it fills. Mirrored in functions/src/founders.ts.
//
// Firestore: config/city_{id} (counters, server-only writes) and
// publicStats/city_{id} (public member count). Flat ids because config and
// publicStats are one-level collections in the rules.

export interface ZyloveCity {
  id: string
  name: string
  state: string
  lat: number
  lng: number
  radiusMiles: number
  // Shorter name for the badge ("NYC Founder"); defaults to name.
  badgeName?: string
}

export const FOUNDER_CAPACITY = 100

export const ZYLOVE_CITIES: ZyloveCity[] = [
  // Texas
  { id: 'austin', name: 'Austin', state: 'TX', lat: 30.2672, lng: -97.7431, radiusMiles: 50 },
  { id: 'dallas', name: 'Dallas', state: 'TX', lat: 32.7767, lng: -96.797, radiusMiles: 50 },
  { id: 'houston', name: 'Houston', state: 'TX', lat: 29.7604, lng: -95.3698, radiusMiles: 50 },
  { id: 'san_antonio', name: 'San Antonio', state: 'TX', lat: 29.4241, lng: -98.4936, radiusMiles: 50 },
  // South/Southeast
  { id: 'miami', name: 'Miami', state: 'FL', lat: 25.7617, lng: -80.1918, radiusMiles: 50 },
  { id: 'atlanta', name: 'Atlanta', state: 'GA', lat: 33.749, lng: -84.388, radiusMiles: 50 },
  { id: 'nashville', name: 'Nashville', state: 'TN', lat: 36.1627, lng: -86.7816, radiusMiles: 50 },
  { id: 'charlotte', name: 'Charlotte', state: 'NC', lat: 35.2271, lng: -80.8431, radiusMiles: 50 },
  { id: 'tampa', name: 'Tampa', state: 'FL', lat: 27.9506, lng: -82.4572, radiusMiles: 50 },
  { id: 'new_orleans', name: 'New Orleans', state: 'LA', lat: 29.9511, lng: -90.0715, radiusMiles: 50 },
  // Northeast
  { id: 'nyc', name: 'New York City', state: 'NY', lat: 40.7128, lng: -74.006, radiusMiles: 50, badgeName: 'NYC' },
  { id: 'boston', name: 'Boston', state: 'MA', lat: 42.3601, lng: -71.0589, radiusMiles: 50 },
  { id: 'philadelphia', name: 'Philadelphia', state: 'PA', lat: 39.9526, lng: -75.1652, radiusMiles: 50 },
  { id: 'washington_dc', name: 'Washington DC', state: 'DC', lat: 38.9072, lng: -77.0369, radiusMiles: 50, badgeName: 'DC' },
  // Midwest
  { id: 'chicago', name: 'Chicago', state: 'IL', lat: 41.8781, lng: -87.6298, radiusMiles: 50 },
  { id: 'minneapolis', name: 'Minneapolis', state: 'MN', lat: 44.9778, lng: -93.265, radiusMiles: 50 },
  // West
  { id: 'los_angeles', name: 'Los Angeles', state: 'CA', lat: 34.0522, lng: -118.2437, radiusMiles: 50 },
  { id: 'san_francisco', name: 'San Francisco', state: 'CA', lat: 37.7749, lng: -122.4194, radiusMiles: 50 },
  { id: 'seattle', name: 'Seattle', state: 'WA', lat: 47.6062, lng: -122.3321, radiusMiles: 50 },
  { id: 'denver', name: 'Denver', state: 'CO', lat: 39.7392, lng: -104.9903, radiusMiles: 50 },
  { id: 'phoenix', name: 'Phoenix', state: 'AZ', lat: 33.4484, lng: -112.074, radiusMiles: 50 },
  { id: 'las_vegas', name: 'Las Vegas', state: 'NV', lat: 36.1699, lng: -115.1398, radiusMiles: 50 },
  { id: 'portland', name: 'Portland', state: 'OR', lat: 45.5051, lng: -122.675, radiusMiles: 50 },
  { id: 'san_diego', name: 'San Diego', state: 'CA', lat: 32.7157, lng: -117.1611, radiusMiles: 50 },
]

const AUSTIN = ZYLOVE_CITIES[0]

// Closest launch city whose radius covers the point, or null. withinMiles
// widens every city's radius (display only, e.g. "Austin needs 97 more").
export function getNearestCity(lat: number, lng: number, withinMiles?: number): ZyloveCity | null {
  let best: { city: ZyloveCity; miles: number } | null = null
  for (const city of ZYLOVE_CITIES) {
    const miles = getDistanceMiles(lat, lng, city.lat, city.lng)
    if (miles <= (withinMiles ?? city.radiusMiles) && (!best || miles < best.miles)) best = { city, miles }
  }
  return best?.city ?? null
}

export function isAustinArea(lat: number, lng: number): boolean {
  return getDistanceMiles(lat, lng, AUSTIN.lat, AUSTIN.lng) <= AUSTIN.radiusMiles
}

export function cityById(id: unknown): ZyloveCity | null {
  return ZYLOVE_CITIES.find((c) => c.id === id) ?? null
}

export const cityConfigPath = (id: string) => `config/city_${id}`
export const cityStatsPath = (id: string) => `publicStats/city_${id}`

// Stage C: the major cities people outside every launch radius are linked to
// (mirror of functions/src/cities.ts MAJOR_CITIES).
export const MAJOR_CITIES: ZyloveCity[] = [
  { id: 'salt_lake_city', name: 'Salt Lake City', state: 'UT', lat: 40.7608, lng: -111.891, radiusMiles: 50 },
  { id: 'sacramento', name: 'Sacramento', state: 'CA', lat: 38.5816, lng: -121.4944, radiusMiles: 50 },
  { id: 'albuquerque', name: 'Albuquerque', state: 'NM', lat: 35.0844, lng: -106.6504, radiusMiles: 50 },
  { id: 'tucson', name: 'Tucson', state: 'AZ', lat: 32.2226, lng: -110.9747, radiusMiles: 50 },
  { id: 'el_paso', name: 'El Paso', state: 'TX', lat: 31.7619, lng: -106.485, radiusMiles: 50 },
  { id: 'boise', name: 'Boise', state: 'ID', lat: 43.615, lng: -116.2023, radiusMiles: 50 },
  { id: 'spokane', name: 'Spokane', state: 'WA', lat: 47.6588, lng: -117.426, radiusMiles: 50 },
  { id: 'oklahoma_city', name: 'Oklahoma City', state: 'OK', lat: 35.4676, lng: -97.5164, radiusMiles: 50 },
  { id: 'kansas_city', name: 'Kansas City', state: 'MO', lat: 39.0997, lng: -94.5786, radiusMiles: 50 },
  { id: 'st_louis', name: 'St. Louis', state: 'MO', lat: 38.627, lng: -90.1994, radiusMiles: 50 },
  { id: 'omaha', name: 'Omaha', state: 'NE', lat: 41.2565, lng: -95.9345, radiusMiles: 50 },
  { id: 'milwaukee', name: 'Milwaukee', state: 'WI', lat: 43.0389, lng: -87.9065, radiusMiles: 50 },
  { id: 'detroit', name: 'Detroit', state: 'MI', lat: 42.3314, lng: -83.0458, radiusMiles: 50 },
  { id: 'indianapolis', name: 'Indianapolis', state: 'IN', lat: 39.7684, lng: -86.1581, radiusMiles: 50 },
  { id: 'columbus', name: 'Columbus', state: 'OH', lat: 39.9612, lng: -82.9988, radiusMiles: 50 },
  { id: 'cleveland', name: 'Cleveland', state: 'OH', lat: 41.4993, lng: -81.6944, radiusMiles: 50 },
  { id: 'cincinnati', name: 'Cincinnati', state: 'OH', lat: 39.1031, lng: -84.512, radiusMiles: 50 },
  { id: 'pittsburgh', name: 'Pittsburgh', state: 'PA', lat: 40.4406, lng: -79.9959, radiusMiles: 50 },
  { id: 'buffalo', name: 'Buffalo', state: 'NY', lat: 42.8864, lng: -78.8784, radiusMiles: 50 },
  { id: 'baltimore', name: 'Baltimore', state: 'MD', lat: 39.2904, lng: -76.6122, radiusMiles: 50 },
  { id: 'richmond', name: 'Richmond', state: 'VA', lat: 37.5407, lng: -77.436, radiusMiles: 50 },
  { id: 'raleigh', name: 'Raleigh', state: 'NC', lat: 35.7796, lng: -78.6382, radiusMiles: 50 },
  { id: 'orlando', name: 'Orlando', state: 'FL', lat: 28.5383, lng: -81.3792, radiusMiles: 50 },
  { id: 'jacksonville', name: 'Jacksonville', state: 'FL', lat: 30.3322, lng: -81.6557, radiusMiles: 50 },
  { id: 'birmingham', name: 'Birmingham', state: 'AL', lat: 33.5186, lng: -86.8104, radiusMiles: 50 },
  { id: 'memphis', name: 'Memphis', state: 'TN', lat: 35.1495, lng: -90.049, radiusMiles: 50 },
  { id: 'louisville', name: 'Louisville', state: 'KY', lat: 38.2527, lng: -85.7585, radiusMiles: 50 },
  { id: 'hartford', name: 'Hartford', state: 'CT', lat: 41.7658, lng: -72.6734, radiusMiles: 50 },
  { id: 'providence', name: 'Providence', state: 'RI', lat: 41.824, lng: -71.4128, radiusMiles: 50 },
  { id: 'honolulu', name: 'Honolulu', state: 'HI', lat: 21.3069, lng: -157.8583, radiusMiles: 50 },
  { id: 'anchorage', name: 'Anchorage', state: 'AK', lat: 61.2181, lng: -149.9003, radiusMiles: 50 },
]

// A launch or major city by id (the city someone's Free period waits for).
export function anyCityById(id: unknown): ZyloveCity | null {
  return cityById(id) ?? MAJOR_CITIES.find((c) => c.id === id) ?? null
}
