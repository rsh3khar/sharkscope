import { Play, Square, Trash2, Wifi, MapPin, Circle, Download } from 'lucide-react'
import { useMemo, useEffect } from 'react'

// Build smart interface options from detected interfaces
function buildInterfaceOptions(interfaces) {
  if (!interfaces || interfaces.length === 0) {
    return [{ name: 'en0', label: 'Wi-Fi (en0)' }]
  }

  // Filter out tshark extcap plugins and virtual interfaces we don't care about
  const EXCLUDE_INTERFACES = [
    'sshdump', 'ciscodump', 'udpdump', 'wifidump', 'randpkt',  // extcap plugins
    'ap1', 'awdl0', 'llw0', 'gif0', 'stf0',  // virtual/unused
    'anpi0', 'anpi1', 'anpi2',  // Apple network processor
  ]

  const realInterfaces = interfaces.filter(i =>
    !EXCLUDE_INTERFACES.includes(i.name) &&
    !i.name.startsWith('anpi')  // Filter all anpi interfaces
  )

  const names = realInterfaces.map(i => i.name)
  const options = []

  // Find WiFi interface (en0)
  const wifi = names.find(n => n === 'en0')
  // Find VPN tunnels
  const vpns = names.filter(n => n.startsWith('utun'))

  // WiFi first (most reliable)
  if (wifi) {
    options.push({ name: wifi, label: 'Wi-Fi (en0)' })
  }

  // WiFi + VPN combo second
  if (wifi && vpns.length > 0) {
    options.push({
      name: [wifi, ...vpns].join(','),
      label: `Wi-Fi + VPN tunnels (${vpns.length})`,
    })
  }

  // Individual VPN tunnels
  vpns.slice(0, 3).forEach(vpn => {
    options.push({ name: vpn, label: `VPN tunnel (${vpn})` })
  })

  // Loopback (useful for debugging local traffic)
  if (names.includes('lo0')) {
    options.push({ name: 'lo0', label: 'Loopback (localhost)' })
  }

  // Fallback: if no options built, show all remaining interfaces
  if (options.length === 0) {
    realInterfaces.forEach(iface => {
      options.push({ name: iface.name, label: iface.description || iface.name })
    })
  }

  return options
}

export function Header({
  capturing,
  interface_,
  setInterface,
  availableInterfaces,
  onStart,
  onStop,
  onClear,
  homeLocation,
  onOpenHomeModal,
  isRecording,
  onToggleRecording,
  lastRecording,
  onDownloadRecording,
  isDemo,
}) {
  // Build interface options from detected interfaces
  const interfaceOptions = useMemo(
    () => buildInterfaceOptions(availableInterfaces),
    [availableInterfaces]
  )

  // Auto-select first option if current interface doesn't match any option
  useEffect(() => {
    if (interfaceOptions.length > 0) {
      const currentValid = interfaceOptions.some(opt => opt.name === interface_)
      if (!currentValid) {
        setInterface(interfaceOptions[0].name)
      }
    }
  }, [interfaceOptions, interface_, setInterface])

  return (
    <header className="h-14 px-4 flex items-center justify-between border-b border-[#262626] bg-[#0a0a0a]">
      {/* Logo */}
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
          <Wifi className="w-4 h-4 text-blue-500" />
        </div>
        <span className="text-sm font-medium text-[#fafafa]">SharkScope</span>
        {isDemo && (
          <span className="px-2 py-0.5 text-xs font-medium bg-amber-500/20 text-amber-400 border border-amber-500/30 rounded">
            DEMO
          </span>
        )}
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3">
        {/* Interface selector */}
        <select
          value={interface_}
          onChange={(e) => setInterface(e.target.value)}
          disabled={capturing}
          className="h-8 px-3 text-sm bg-[#141414] border border-[#262626] rounded-md text-[#fafafa] focus:outline-none focus:border-[#404040] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {interfaceOptions.map(iface => (
            <option key={iface.name} value={iface.name}>
              {iface.label}
            </option>
          ))}
        </select>

        {/* Start/Stop button */}
        {capturing ? (
          <button
            onClick={onStop}
            className="h-8 px-4 flex items-center gap-2 text-sm font-medium bg-red-500/10 text-red-400 border border-red-500/20 rounded-md hover:bg-red-500/20 transition-colors"
          >
            <Square className="w-3.5 h-3.5" />
            Stop
          </button>
        ) : (
          <button
            onClick={onStart}
            className="h-8 px-4 flex items-center gap-2 text-sm font-medium bg-green-500/10 text-green-400 border border-green-500/20 rounded-md hover:bg-green-500/20 transition-colors"
          >
            <Play className="w-3.5 h-3.5" />
            Start
          </button>
        )}

        {/* Record toggle button - only show when capturing */}
        {capturing && (
          <button
            onClick={onToggleRecording}
            className={`h-8 px-3 flex items-center gap-2 text-sm font-medium border rounded-md transition-colors ${
              isRecording
                ? 'bg-red-500/20 text-red-400 border-red-500/30 hover:bg-red-500/30'
                : 'text-[#a1a1a1] border-[#262626] hover:bg-[#141414] hover:text-[#fafafa]'
            }`}
            title={isRecording ? 'Stop recording to pcap' : 'Start recording to pcap'}
          >
            <Circle className={`w-3.5 h-3.5 ${isRecording ? 'fill-red-500 animate-pulse' : ''}`} />
            {isRecording ? 'Recording' : 'Record'}
          </button>
        )}

        {/* Download last recording - show when not capturing and there's a recording */}
        {!capturing && lastRecording && (
          <button
            onClick={onDownloadRecording}
            className="h-8 px-3 flex items-center gap-2 text-sm font-medium text-blue-400 border border-blue-500/30 bg-blue-500/10 rounded-md hover:bg-blue-500/20 transition-colors"
            title={`Download ${lastRecording.filename}`}
          >
            <Download className="w-3.5 h-3.5" />
            Download pcap
          </button>
        )}

        {/* Clear button */}
        <button
          onClick={onClear}
          className="h-8 px-3 flex items-center gap-2 text-sm text-[#a1a1a1] border border-[#262626] rounded-md hover:bg-[#141414] hover:text-[#fafafa] transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" />
          Clear
        </button>

        {/* Home location button */}
        <button
          onClick={onOpenHomeModal}
          className={`h-8 px-3 flex items-center gap-2 text-sm border rounded-md transition-colors ${
            homeLocation
              ? 'text-green-400 border-green-500/30 bg-green-500/10 hover:bg-green-500/20'
              : 'text-[#a1a1a1] border-[#262626] hover:bg-[#141414] hover:text-[#fafafa]'
          }`}
          title={homeLocation ? `Home: ${homeLocation.city}, ${homeLocation.country}` : 'Set home location'}
        >
          <MapPin className="w-3.5 h-3.5" />
          {homeLocation ? homeLocation.city : 'Set Home'}
        </button>
      </div>
    </header>
  )
}
