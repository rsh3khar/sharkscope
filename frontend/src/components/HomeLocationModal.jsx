import { useState, useEffect, useRef } from 'react'
import { MapPin, Loader2, Search, X, Globe } from 'lucide-react'

// Fallback major cities (used when search is empty)
const CITIES = [
  { city: 'New York', country: 'United States', lat: 40.7128, lon: -74.0060 },
  { city: 'Los Angeles', country: 'United States', lat: 34.0522, lon: -118.2437 },
  { city: 'San Francisco', country: 'United States', lat: 37.7749, lon: -122.4194 },
  { city: 'Chicago', country: 'United States', lat: 41.8781, lon: -87.6298 },
  { city: 'Seattle', country: 'United States', lat: 47.6062, lon: -122.3321 },
  { city: 'Austin', country: 'United States', lat: 30.2672, lon: -97.7431 },
  { city: 'Miami', country: 'United States', lat: 25.7617, lon: -80.1918 },
  { city: 'Boston', country: 'United States', lat: 42.3601, lon: -71.0589 },
  { city: 'Denver', country: 'United States', lat: 39.7392, lon: -104.9903 },
  { city: 'London', country: 'United Kingdom', lat: 51.5074, lon: -0.1278 },
  { city: 'Manchester', country: 'United Kingdom', lat: 53.4808, lon: -2.2426 },
  { city: 'Paris', country: 'France', lat: 48.8566, lon: 2.3522 },
  { city: 'Berlin', country: 'Germany', lat: 52.5200, lon: 13.4050 },
  { city: 'Munich', country: 'Germany', lat: 48.1351, lon: 11.5820 },
  { city: 'Amsterdam', country: 'Netherlands', lat: 52.3676, lon: 4.9041 },
  { city: 'Dublin', country: 'Ireland', lat: 53.3498, lon: -6.2603 },
  { city: 'Stockholm', country: 'Sweden', lat: 59.3293, lon: 18.0686 },
  { city: 'Oslo', country: 'Norway', lat: 59.9139, lon: 10.7522 },
  { city: 'Copenhagen', country: 'Denmark', lat: 55.6761, lon: 12.5683 },
  { city: 'Helsinki', country: 'Finland', lat: 60.1699, lon: 24.9384 },
  { city: 'Zurich', country: 'Switzerland', lat: 47.3769, lon: 8.5417 },
  { city: 'Vienna', country: 'Austria', lat: 48.2082, lon: 16.3738 },
  { city: 'Madrid', country: 'Spain', lat: 40.4168, lon: -3.7038 },
  { city: 'Barcelona', country: 'Spain', lat: 41.3851, lon: 2.1734 },
  { city: 'Rome', country: 'Italy', lat: 41.9028, lon: 12.4964 },
  { city: 'Milan', country: 'Italy', lat: 45.4642, lon: 9.1900 },
  { city: 'Tokyo', country: 'Japan', lat: 35.6762, lon: 139.6503 },
  { city: 'Osaka', country: 'Japan', lat: 34.6937, lon: 135.5023 },
  { city: 'Seoul', country: 'South Korea', lat: 37.5665, lon: 126.9780 },
  { city: 'Singapore', country: 'Singapore', lat: 1.3521, lon: 103.8198 },
  { city: 'Hong Kong', country: 'Hong Kong', lat: 22.3193, lon: 114.1694 },
  { city: 'Taipei', country: 'Taiwan', lat: 25.0330, lon: 121.5654 },
  { city: 'Shanghai', country: 'China', lat: 31.2304, lon: 121.4737 },
  { city: 'Beijing', country: 'China', lat: 39.9042, lon: 116.4074 },
  { city: 'Shenzhen', country: 'China', lat: 22.5431, lon: 114.0579 },
  { city: 'Mumbai', country: 'India', lat: 19.0760, lon: 72.8777 },
  { city: 'Bangalore', country: 'India', lat: 12.9716, lon: 77.5946 },
  { city: 'Delhi', country: 'India', lat: 28.7041, lon: 77.1025 },
  { city: 'Hyderabad', country: 'India', lat: 17.3850, lon: 78.4867 },
  { city: 'Sydney', country: 'Australia', lat: -33.8688, lon: 151.2093 },
  { city: 'Melbourne', country: 'Australia', lat: -37.8136, lon: 144.9631 },
  { city: 'Auckland', country: 'New Zealand', lat: -36.8509, lon: 174.7645 },
  { city: 'Toronto', country: 'Canada', lat: 43.6532, lon: -79.3832 },
  { city: 'Vancouver', country: 'Canada', lat: 49.2827, lon: -123.1207 },
  { city: 'Montreal', country: 'Canada', lat: 45.5017, lon: -73.5673 },
  { city: 'Mexico City', country: 'Mexico', lat: 19.4326, lon: -99.1332 },
  { city: 'São Paulo', country: 'Brazil', lat: -23.5505, lon: -46.6333 },
  { city: 'Buenos Aires', country: 'Argentina', lat: -34.6037, lon: -58.3816 },
  { city: 'Dubai', country: 'UAE', lat: 25.2048, lon: 55.2708 },
  { city: 'Tel Aviv', country: 'Israel', lat: 32.0853, lon: 34.7818 },
  { city: 'Cairo', country: 'Egypt', lat: 30.0444, lon: 31.2357 },
  { city: 'Cape Town', country: 'South Africa', lat: -33.9249, lon: 18.4241 },
  { city: 'Lagos', country: 'Nigeria', lat: 6.5244, lon: 3.3792 },
  { city: 'Nairobi', country: 'Kenya', lat: -1.2921, lon: 36.8219 },
]

export function HomeLocationModal({ isOpen, onClose, onSetLocation }) {
  const [detecting, setDetecting] = useState(false)
  const [search, setSearch] = useState('')
  const [mode, setMode] = useState('choose') // 'choose' or 'search'
  const [searchResults, setSearchResults] = useState([])
  const [searching, setSearching] = useState(false)
  const searchTimeoutRef = useRef(null)

  // Debounced search using Nominatim (OpenStreetMap)
  useEffect(() => {
    if (!search || search.length < 2) {
      setSearchResults([])
      return
    }

    // Clear previous timeout
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current)
    }

    // Debounce search by 300ms
    searchTimeoutRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(search)}&format=json&limit=10&addressdetails=1&featuretype=city`,
          { headers: { 'Accept-Language': 'en' } }
        )
        const data = await res.json()

        const results = data
          .filter(r => r.lat && r.lon)
          .map(r => ({
            city: r.address?.city || r.address?.town || r.address?.village || r.name,
            country: r.address?.country || '',
            state: r.address?.state || '',
            lat: parseFloat(r.lat),
            lon: parseFloat(r.lon),
            displayName: r.display_name,
          }))

        setSearchResults(results)
      } catch (err) {
        console.error('Search failed:', err)
        setSearchResults([])
      } finally {
        setSearching(false)
      }
    }, 300)

    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current)
      }
    }
  }, [search])

  if (!isOpen) return null

  // Use search results if searching, otherwise filter preset cities
  const displayCities = search.length >= 2
    ? searchResults
    : CITIES.filter(c =>
        !search || c.city.toLowerCase().includes(search.toLowerCase()) ||
        c.country.toLowerCase().includes(search.toLowerCase())
      )

  const detectLocation = async () => {
    setDetecting(true)
    try {
      // Add 5 second timeout
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 5000)

      const res = await fetch('/api/my-location', { signal: controller.signal })
      clearTimeout(timeoutId)

      const data = await res.json()
      if (data.lat && data.lon) {
        const location = {
          city: data.city,
          country: data.country,
          lat: data.lat,
          lon: data.lon,
          ip: data.ip,
        }
        onSetLocation(location)
        localStorage.setItem('sharkscope-home-location', JSON.stringify(location))
        onClose()
      } else {
        alert('Could not detect location: ' + (data.error || 'Unknown error'))
        setMode('search') // Switch to manual selection
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        alert('Location detection timed out. Please select your city manually.')
      } else {
        alert('Failed to detect location: ' + err.message)
      }
      setMode('search') // Switch to manual selection
    } finally {
      setDetecting(false)
    }
  }

  const selectCity = (city) => {
    const location = {
      city: city.city,
      country: city.country,
      state: city.state || '',
      lat: city.lat,
      lon: city.lon,
      ip: 'manual',
    }
    onSetLocation(location)
    localStorage.setItem('sharkscope-home-location', JSON.stringify(location))
    onClose()
  }

  const skipForNow = () => {
    // Set a flag so we don't show again this session
    sessionStorage.setItem('sharkscope-home-skipped', 'true')
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-md bg-[#141414] border border-[#262626] rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="p-5 border-b border-[#262626]">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-full bg-green-500/10 flex items-center justify-center">
              <Globe className="w-5 h-5 text-green-500" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-[#fafafa]">Set Your Location</h2>
              <p className="text-sm text-[#a1a1a1]">Show connection arcs from your device</p>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="p-5">
          {mode === 'choose' ? (
            <div className="space-y-3">
              {/* Auto-detect button */}
              <button
                onClick={detectLocation}
                disabled={detecting}
                className="w-full h-12 flex items-center justify-center gap-3 text-sm font-medium bg-blue-500/10 border border-blue-500/30 rounded-lg text-blue-400 hover:bg-blue-500/20 transition-colors disabled:opacity-50"
              >
                {detecting ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Detecting...
                  </>
                ) : (
                  <>
                    <MapPin className="w-5 h-5" />
                    Auto-detect from IP
                  </>
                )}
              </button>

              <div className="flex items-center gap-3 py-2">
                <div className="flex-1 h-px bg-[#262626]" />
                <span className="text-xs text-[#525252]">or</span>
                <div className="flex-1 h-px bg-[#262626]" />
              </div>

              {/* Select city button */}
              <button
                onClick={() => setMode('search')}
                className="w-full h-12 flex items-center justify-center gap-3 text-sm font-medium bg-[#1a1a1a] border border-[#262626] rounded-lg text-[#a1a1a1] hover:text-[#fafafa] hover:bg-[#262626] transition-colors"
              >
                <Search className="w-5 h-5" />
                Select a city manually
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Back button and search */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { setMode('choose'); setSearch('') }}
                  className="w-8 h-8 flex items-center justify-center text-[#525252] hover:text-[#a1a1a1] transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#525252]" />
                  <input
                    type="text"
                    placeholder="Search cities..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    autoFocus
                    className="w-full h-10 pl-9 pr-3 text-sm bg-[#0a0a0a] border border-[#262626] rounded-lg text-[#fafafa] placeholder:text-[#525252] focus:outline-none focus:border-[#404040]"
                  />
                </div>
              </div>

              {/* City list */}
              <div className="max-h-64 overflow-y-auto -mx-2 px-2">
                {searching ? (
                  <div className="py-8 flex items-center justify-center gap-2 text-[#525252] text-sm">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Searching...
                  </div>
                ) : displayCities.length === 0 ? (
                  <div className="py-8 text-center text-[#525252] text-sm">
                    {search.length >= 2 ? 'No cities found' : 'Type to search any city worldwide'}
                  </div>
                ) : (
                  <div className="space-y-1">
                    {displayCities.slice(0, 15).map((city, idx) => (
                      <button
                        key={`${city.city}-${city.country}-${idx}`}
                        onClick={() => selectCity(city)}
                        className="w-full px-3 py-2.5 flex items-center justify-between text-left rounded-lg hover:bg-[#1a1a1a] transition-colors group"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-sm text-[#fafafa] group-hover:text-white">
                            {city.city}
                          </div>
                          <div className="text-xs text-[#525252] truncate">
                            {city.state ? `${city.state}, ` : ''}{city.country}
                          </div>
                        </div>
                        <MapPin className="w-4 h-4 text-[#525252] group-hover:text-green-500 transition-colors flex-shrink-0 ml-2" />
                      </button>
                    ))}
                    {!search && (
                      <div className="py-2 text-center text-[#525252] text-xs">
                        Or search for any city worldwide...
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-[#262626] bg-[#0a0a0a]">
          <button
            onClick={skipForNow}
            className="w-full text-center text-sm text-[#525252] hover:text-[#a1a1a1] transition-colors"
          >
            Skip for now
          </button>
        </div>
      </div>
    </div>
  )
}
