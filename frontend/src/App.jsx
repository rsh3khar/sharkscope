import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { Globe } from './components/Globe'
import { WorldMap } from './components/WorldMap'
import { ConnectionsTable } from './components/ConnectionsTable'
import { Header } from './components/Header'
import { StatsBar } from './components/StatsBar'
import { HomeLocationModal } from './components/HomeLocationModal'

// Performance constants
const MAX_CONNECTIONS = 1000
const MAX_PACKET_EVENTS = 300 // More events for accurate burst visualization
const BATCH_INTERVAL_MS = 50 // Flush every 50ms for snappier real-time feel
const PACKET_EVENT_TTL_MS = 2000 // 2s TTL - tighter cleanup

function App() {
  const [connections, setConnections] = useState([])
  const [selectedConnectionId, setSelectedConnectionId] = useState(null)
  const [capturing, setCapturing] = useState(false)
  const [interface_, setInterface] = useState('')
  const [availableInterfaces, setAvailableInterfaces] = useState([])
  const [stats, setStats] = useState({ packets: 0, flows: 0, bytes: 0 })
  const [viewMode, setViewMode] = useState(() => {
    const saved = localStorage.getItem('sharkscope-view-mode')
    return saved === '2d' ? '2d' : '3d' // Default to 3d
  })
  const [groupMode, setGroupMode] = useState(() => {
    const saved = localStorage.getItem('sharkscope-group-mode')
    return saved === 'app' ? 'app' : 'location' // Default to location
  })
  const [panelWidth, setPanelWidth] = useState(() => {
    const saved = localStorage.getItem('sharkscope-panel-width')
    return saved ? parseInt(saved, 10) : 75 // Default: 75% map, 25% panel
  })
  const [packetEvents, setPacketEvents] = useState([]) // Real-time packet events for animation
  const [homeLocation, setHomeLocation] = useState(null) // User's home location for private IPs
  const [showHomeModal, setShowHomeModal] = useState(false)
  const [isRecording, setIsRecording] = useState(false) // Recording to pcap
  const [lastRecording, setLastRecording] = useState(null) // Last completed recording info
  const [isDemo, setIsDemo] = useState(false) // Demo mode (no tshark)
  const wsRef = useRef(null)
  const isDraggingRef = useRef(false)

  // Batching refs for performance - accumulate updates, flush periodically
  const pendingPacketEventsRef = useRef([])
  const pendingNewConnectionsRef = useRef([])
  const pendingConnectionUpdatesRef = useRef(new Map()) // key -> update data
  const pendingStatsRef = useRef({ packets: 0, flows: 0, bytes: 0 })

  // Derive selected connection from connections array (so it updates with new packets)
  const selectedConnection = useMemo(() => {
    if (!selectedConnectionId) return null
    return connections.find(c => c.id === selectedConnectionId) || null
  }, [connections, selectedConnectionId])

  // State for arc group selection (clicking an arc filters to those connections)
  const [selectedArcGroupKey, setSelectedArcGroupKey] = useState(null)

  // Derive grouped arcs from connections (one arc per geographic path)
  const arcGroups = useMemo(() => {
    const groups = new Map() // key: "srcLat,srcLon-dstLat,dstLon"

    connections.forEach(conn => {
      const srcGeo = conn.src_geo || homeLocation
      const dstGeo = conn.dst_geo || homeLocation
      // Skip if no geo, or if geo is pending (no lat/lon yet)
      if (!srcGeo || !dstGeo) return
      if (srcGeo.pending || dstGeo.pending) return
      if (srcGeo.lat == null || dstGeo.lat == null) return

      // Round to 1 decimal for grouping (same city)
      const srcKey = `${srcGeo.lat.toFixed(1)},${srcGeo.lon.toFixed(1)}`
      const dstKey = `${dstGeo.lat.toFixed(1)},${dstGeo.lon.toFixed(1)}`
      // Normalize key so A→B and B→A are same arc
      const key = [srcKey, dstKey].sort().join('-')

      if (!groups.has(key)) {
        groups.set(key, {
          key,
          srcGeo,
          dstGeo,
          connections: [],
          totalBytes: 0,
          totalPackets: 0,
        })
      }

      const group = groups.get(key)
      group.connections.push(conn)
      group.totalBytes += conn.bytes
      group.totalPackets += conn.packets
    })

    return Array.from(groups.values())
  }, [connections, homeLocation])

  // Derive app-based arc groups (one arc per process to each location)
  const appGroups = useMemo(() => {
    const groups = new Map() // key: "processName-dstLat,dstLon"

    connections.forEach(conn => {
      const srcGeo = conn.src_geo || homeLocation
      const dstGeo = conn.dst_geo || homeLocation
      // Skip if no geo, or if geo is pending (no lat/lon yet)
      if (!srcGeo || !dstGeo) return
      if (srcGeo.pending || dstGeo.pending) return
      if (srcGeo.lat == null || dstGeo.lat == null) return

      // Use process name or "Unknown" for grouping
      const processName = conn.process || 'Unknown'

      // Round to 1 decimal for location grouping
      const dstKey = `${dstGeo.lat.toFixed(1)},${dstGeo.lon.toFixed(1)}`
      const key = `${processName}-${dstKey}`

      if (!groups.has(key)) {
        groups.set(key, {
          key,
          srcGeo,  // Home location for app groups
          dstGeo,
          process: processName,
          connections: [],
          totalBytes: 0,
          totalPackets: 0,
        })
      }

      const group = groups.get(key)
      group.connections.push(conn)
      group.totalBytes += conn.bytes
      group.totalPackets += conn.packets
    })

    return Array.from(groups.values())
  }, [connections, homeLocation])

  // Use the appropriate groups based on grouping mode
  const activeArcGroups = groupMode === 'location' ? arcGroups : appGroups

  // Get selected arc group object from key
  const selectedArcGroup = useMemo(() => {
    if (!selectedArcGroupKey) return null
    return activeArcGroups.find(g => g.key === selectedArcGroupKey) || null
  }, [activeArcGroups, selectedArcGroupKey])

  // Filter connections when arc is selected
  const filteredConnections = useMemo(() => {
    if (!selectedArcGroup) return connections
    return selectedArcGroup.connections
  }, [connections, selectedArcGroup])

  // Handler to select a connection (stores ID, not object)
  const handleSelectConnection = useCallback((conn) => {
    setSelectedConnectionId(conn?.id || null)
  }, [])

  // Handler to select an arc group (filters table to connections on that path)
  const handleSelectArcGroup = useCallback((group) => {
    setSelectedArcGroupKey(group?.key || null)
    setSelectedConnectionId(null) // Clear specific connection selection
  }, [])

  // Handler to clear arc filter
  const clearArcFilter = useCallback(() => {
    setSelectedArcGroupKey(null)
  }, [])

  // Handler for online IP lookup (for unknown addresses)
  const lookupIP = useCallback(async (ip) => {
    try {
      const res = await fetch(`/api/lookup/${ip}`)
      const data = await res.json()

      if (data.lat && data.lon && !data.error) {
        // Update all connections with this IP
        setConnections(prev => prev.map(conn => {
          if (conn.dst_ip === ip && conn.dst_geo?.unknown) {
            return { ...conn, dst_geo: data }
          }
          if (conn.src_ip === ip && conn.src_geo?.unknown) {
            return { ...conn, src_geo: data }
          }
          return conn
        }))
        return data
      }
      return null
    } catch (err) {
      console.error('IP lookup failed:', err)
      return null
    }
  }, [])

  // Load home location from localStorage on mount, show modal if not set
  useEffect(() => {
    const saved = localStorage.getItem('sharkscope-home-location')
    if (saved) {
      try {
        setHomeLocation(JSON.parse(saved))
      } catch (e) {
        // Invalid JSON, show modal
        if (!sessionStorage.getItem('sharkscope-home-skipped')) {
          setShowHomeModal(true)
        }
      }
    } else {
      // No saved location, show modal (unless skipped this session)
      if (!sessionStorage.getItem('sharkscope-home-skipped')) {
        setShowHomeModal(true)
      }
    }
  }, [])

  // Auto-detect available network interfaces on mount
  useEffect(() => {
    const detectInterfaces = async () => {
      try {
        const res = await fetch('/api/interfaces')
        const data = await res.json()

        if (data.interfaces && data.interfaces.length > 0) {
          setAvailableInterfaces(data.interfaces)
          setIsDemo(data.demo === true)

          // Auto-select: prefer en0 (WiFi) only - most reliable
          const names = data.interfaces.map(i => i.name)

          if (names.includes('en0')) {
            setInterface('en0')
          } else if (names.length > 0) {
            setInterface(names[0])
          }
        }
      } catch (err) {
        console.error('Failed to detect interfaces:', err)
        // Fallback to en0
        setInterface('en0')
      }
    }

    detectInterfaces()
  }, [])

  // Save view preferences to localStorage
  useEffect(() => {
    localStorage.setItem('sharkscope-view-mode', viewMode)
  }, [viewMode])

  useEffect(() => {
    localStorage.setItem('sharkscope-group-mode', groupMode)
  }, [groupMode])

  // Batched update flush - processes accumulated updates every BATCH_INTERVAL_MS
  // This reduces React re-renders from per-packet to batched (10x improvement at 100pps)
  useEffect(() => {
    const flushBatchedUpdates = () => {
      const now = Date.now()
      const cutoff = now - PACKET_EVENT_TTL_MS

      // Capture and clear refs BEFORE setState to avoid race conditions
      const newPacketEvents = pendingPacketEventsRef.current
      const newConnections = pendingNewConnectionsRef.current
      const connectionUpdates = pendingConnectionUpdatesRef.current
      const statsUpdate = { ...pendingStatsRef.current }

      // Clear refs immediately
      if (newPacketEvents.length > 0) pendingPacketEventsRef.current = []
      if (newConnections.length > 0) pendingNewConnectionsRef.current = []
      if (connectionUpdates.size > 0) pendingConnectionUpdatesRef.current = new Map()
      if (statsUpdate.packets > 0 || statsUpdate.flows > 0 || statsUpdate.bytes > 0) {
        pendingStatsRef.current = { packets: 0, flows: 0, bytes: 0 }
      }

      // Flush pending packet events
      if (newPacketEvents.length > 0) {
        setPacketEvents(prev => {
          const filtered = prev.filter(e => e.timestamp > cutoff)
          const combined = [...filtered, ...newPacketEvents]
          return combined.slice(-MAX_PACKET_EVENTS)
        })
      } else {
        // Still clean up old events even if no new ones
        setPacketEvents(prev => {
          const filtered = prev.filter(e => e.timestamp > cutoff)
          return filtered.length !== prev.length ? filtered : prev
        })
      }

      // Flush pending new connections
      if (newConnections.length > 0) {
        setConnections(prev => [...newConnections, ...prev].slice(0, MAX_CONNECTIONS))
      }

      // Flush pending connection updates (bytes/packets updates for existing connections)
      if (connectionUpdates.size > 0) {
        setConnections(prev => {
          const updated = prev.map(conn => {
            const key = [conn.src_ip, conn.dst_ip].sort().join('-')
            const update = connectionUpdates.get(key)
            if (update) {
              return {
                ...conn,
                bytes: conn.bytes + update.bytes,
                packets: conn.packets + update.packets,
                lastActive: update.lastActive,
              }
            }
            return conn
          })
          return updated.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0))
        })
      }

      // Flush pending stats
      if (statsUpdate.packets > 0 || statsUpdate.flows > 0 || statsUpdate.bytes > 0) {
        setStats(prev => ({
          packets: prev.packets + statsUpdate.packets,
          flows: prev.flows + statsUpdate.flows,
          bytes: prev.bytes + statsUpdate.bytes,
        }))
      }
    }

    const interval = setInterval(flushBatchedUpdates, BATCH_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [])

  const startCapture = useCallback(() => {
    if (!interface_) {
      console.warn('No interface selected')
      return
    }

    if (wsRef.current) {
      wsRef.current.close()
    }

    // Clear state for fresh capture
    setConnections([])
    setPacketEvents([])
    setStats({ packets: 0, flows: 0, bytes: 0 })
    setSelectedConnectionId(null)
    setSelectedArcGroupKey(null)

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/capture/${encodeURIComponent(interface_)}`)
    wsRef.current = ws

    ws.onopen = () => setCapturing(true)

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data)

      if (data.type === 'error') {
        console.error('Capture error:', data.error)
        setCapturing(false)
        return
      }

      if (data.type === 'session') {
        console.log('Session started:', data.session_id)
        return
      }

      if (data.type === 'recording_status') {
        if (data.status === 'recording') {
          setIsRecording(true)
          console.log('Recording started:', data.filename)
        } else if (data.status === 'stopped') {
          setIsRecording(false)
          setLastRecording({
            filename: data.filename,
            file_size: data.file_size,
            duration: data.duration,
            download_url: data.download_url,
          })
          console.log('Recording stopped:', data.filename, `(${(data.file_size / 1024).toFixed(1)} KB)`)
        } else if (data.error) {
          console.error('Recording error:', data.error)
          setIsRecording(false)
        }
        return
      }

      // Handle geo_update from background IP lookup
      if (data.type === 'geo_update') {
        const { ip, geo } = data
        console.log('Geo update:', ip, '→', geo.city, geo.country)
        setConnections(prev => prev.map(conn => {
          let updated = conn
          if (conn.dst_ip === ip && conn.dst_geo?.unknown) {
            updated = { ...updated, dst_geo: geo }
          }
          if (conn.src_ip === ip && conn.src_geo?.unknown) {
            updated = { ...updated, src_geo: geo }
          }
          return updated
        }))
        return
      }

      // Handle process_update from background process lookup
      if (data.type === 'process_update') {
        const { src_ip, dst_ip, process, pid } = data
        console.log('Process update:', src_ip, '↔', dst_ip, '→', process)
        setConnections(prev => prev.map(conn => {
          // Match by IP pair (connections are bidirectional)
          if ((conn.src_ip === src_ip && conn.dst_ip === dst_ip) ||
              (conn.src_ip === dst_ip && conn.dst_ip === src_ip)) {
            if (!conn.process) {  // Only update if no process yet
              return { ...conn, process, pid }
            }
          }
          return conn
        }))
        return
      }

      if (data.type === 'packet') {
        // Batch stats update (accumulate, flush periodically)
        pendingStatsRef.current.packets += 1
        pendingStatsRef.current.flows += data.new_flow ? 1 : 0
        pendingStatsRef.current.bytes += data.length || 0

        // Batch packet event for real-time visualization (only if has geo data)
        if (data.src_geo || data.dst_geo) {
          const connKey = [data.src_ip, data.dst_ip].sort().join('-')
          pendingPacketEventsRef.current.push({
            id: `${connKey}-${Date.now()}-${Math.random()}`,
            connKey,
            src_ip: data.src_ip,
            dst_ip: data.dst_ip,
            src_geo: data.src_geo,
            dst_geo: data.dst_geo,
            timestamp: Date.now(),
            size: data.length || 0,
          })
        }

        if (data.new_flow && (data.src_geo || data.dst_geo)) {
          // Batch new connection
          pendingNewConnectionsRef.current.push({
            id: `${data.src_ip}-${data.dst_ip}-${Date.now()}`,
            src_ip: data.src_ip,
            dst_ip: data.dst_ip,
            src_port: data.src_port,
            dst_port: data.dst_port,
            src_geo: data.src_geo,
            dst_geo: data.dst_geo,
            protocol: data.protocol,
            process: data.process,
            pid: data.pid,
            bytes: data.length || 0,
            packets: 1,
            timestamp: data.timestamp,
            lastActive: Date.now(),
          })
        } else if (data.src_geo || data.dst_geo) {
          // Batch connection update (accumulate bytes/packets for existing connection)
          const key = [data.src_ip, data.dst_ip].sort().join('-')
          const existing = pendingConnectionUpdatesRef.current.get(key)
          if (existing) {
            existing.bytes += data.length || 0
            existing.packets += 1
            existing.lastActive = Date.now()
          } else {
            pendingConnectionUpdatesRef.current.set(key, {
              bytes: data.length || 0,
              packets: 1,
              lastActive: Date.now(),
            })
          }
        }
      }
    }

    ws.onclose = () => setCapturing(false)
    ws.onerror = () => setCapturing(false)
  }, [interface_])

  const stopCapture = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    setCapturing(false)
    setIsRecording(false)
  }, [])

  const toggleRecording = useCallback(() => {
    if (!wsRef.current) return

    if (isRecording) {
      wsRef.current.send(JSON.stringify({ type: 'stop_recording' }))
    } else {
      wsRef.current.send(JSON.stringify({ type: 'start_recording' }))
    }
  }, [isRecording])

  const downloadRecording = useCallback(async () => {
    if (lastRecording?.download_url) {
      window.open(lastRecording.download_url, '_blank')
    } else {
      // Fetch latest recording from API
      try {
        const res = await fetch('/api/recordings')
        const data = await res.json()
        if (data.recordings && data.recordings.length > 0) {
          const latest = data.recordings[0] // Already sorted by most recent
          window.open(latest.download_url, '_blank')
        }
      } catch (err) {
        console.error('Failed to fetch recordings:', err)
      }
    }
  }, [lastRecording])

  const clearConnections = useCallback(() => {
    setConnections([])
    setStats({ packets: 0, flows: 0, bytes: 0 })
    setSelectedConnectionId(null)
    setSelectedArcGroupKey(null)
    setLastRecording(null)
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close()
      }
    }
  }, [])

  return (
    <div className="h-screen w-screen flex flex-col bg-[#0a0a0a]">
      <Header
        capturing={capturing}
        interface_={interface_}
        setInterface={setInterface}
        availableInterfaces={availableInterfaces}
        onStart={startCapture}
        onStop={stopCapture}
        onClear={clearConnections}
        homeLocation={homeLocation}
        onOpenHomeModal={() => setShowHomeModal(true)}
        isRecording={isRecording}
        onToggleRecording={toggleRecording}
        lastRecording={lastRecording}
        onDownloadRecording={downloadRecording}
        isDemo={isDemo}
      />

      <div
        className="flex-1 flex min-h-0"
        onMouseMove={(e) => {
          if (!isDraggingRef.current) return
          const container = e.currentTarget
          const rect = container.getBoundingClientRect()
          const x = e.clientX - rect.left
          const pct = Math.max(20, Math.min(80, (x / rect.width) * 100))
          setPanelWidth(pct)
        }}
        onMouseUp={() => {
          if (isDraggingRef.current) {
            localStorage.setItem('sharkscope-panel-width', String(panelWidth))
          }
          isDraggingRef.current = false
        }}
        onMouseLeave={() => {
          if (isDraggingRef.current) {
            localStorage.setItem('sharkscope-panel-width', String(panelWidth))
          }
          isDraggingRef.current = false
        }}
      >
        {/* Map View - Left side */}
        <div
          className="relative"
          style={{ width: `${panelWidth}%` }}
        >
          {/* View toggle */}
          <div className="absolute top-3 left-3 z-10 flex bg-[#141414] border border-[#262626] rounded-md overflow-hidden">
            <button
              onClick={() => setViewMode('3d')}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                viewMode === '3d'
                  ? 'bg-blue-500/20 text-blue-400'
                  : 'text-[#a1a1a1] hover:text-[#fafafa] hover:bg-[#1a1a1a]'
              }`}
            >
              3D
            </button>
            <button
              onClick={() => setViewMode('2d')}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                viewMode === '2d'
                  ? 'bg-blue-500/20 text-blue-400'
                  : 'text-[#a1a1a1] hover:text-[#fafafa] hover:bg-[#1a1a1a]'
              }`}
            >
              2D
            </button>
          </div>

          {viewMode === '3d' ? (
            <Globe
              connections={connections}
              arcGroups={activeArcGroups}
              selectedConnection={selectedConnection}
              selectedArcGroup={selectedArcGroup}
              onSelectConnection={handleSelectConnection}
              onSelectArcGroup={handleSelectArcGroup}
              packetEvents={packetEvents}
              homeLocation={homeLocation}
              groupMode={groupMode}
            />
          ) : (
            <WorldMap
              connections={connections}
              arcGroups={activeArcGroups}
              selectedConnection={selectedConnection}
              selectedArcGroup={selectedArcGroup}
              onSelectConnection={handleSelectConnection}
              onSelectArcGroup={handleSelectArcGroup}
              packetEvents={packetEvents}
              homeLocation={homeLocation}
              groupMode={groupMode}
            />
          )}
        </div>

        {/* Resizable divider */}
        <div
          className="w-1 bg-[#262626] hover:bg-blue-500/50 cursor-col-resize transition-colors flex-shrink-0"
          onMouseDown={() => { isDraggingRef.current = true }}
        />

        {/* Connections Table - Right side */}
        <div
          className="flex flex-col"
          style={{ width: `${100 - panelWidth}%` }}
        >
          <ConnectionsTable
            connections={filteredConnections}
            selectedConnection={selectedConnection}
            selectedArcGroup={selectedArcGroup}
            onSelectConnection={handleSelectConnection}
            onClearArcFilter={clearArcFilter}
            onLookupIP={lookupIP}
            groupMode={groupMode}
            onSetGroupMode={(mode) => { setGroupMode(mode); setSelectedArcGroupKey(null) }}
          />
        </div>
      </div>

      <StatsBar stats={stats} capturing={capturing} />

      {/* Home location modal - shown on first load */}
      <HomeLocationModal
        isOpen={showHomeModal}
        onClose={() => setShowHomeModal(false)}
        onSetLocation={setHomeLocation}
      />
    </div>
  )
}

export default App
