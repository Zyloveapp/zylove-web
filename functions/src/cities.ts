// Launch cities for founding circles. Mirror of src/config/cities.ts (the
// functions package can't import from the web app); keep the two in sync.

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

export function distanceMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Closest launch city whose radius covers the point, or null.
export function getNearestCity(lat: number, lng: number): ZyloveCity | null {
  let best: { city: ZyloveCity; miles: number } | null = null
  for (const city of ZYLOVE_CITIES) {
    const miles = distanceMiles(lat, lng, city.lat, city.lng)
    if (miles <= city.radiusMiles && (!best || miles < best.miles)) best = { city, miles }
  }
  return best?.city ?? null
}
