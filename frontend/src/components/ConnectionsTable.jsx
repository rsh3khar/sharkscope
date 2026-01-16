import React, { useState, useMemo, useEffect, useRef, Fragment } from 'react'
import { List } from 'react-window'
import { Search, ArrowUpDown, ArrowUp, ArrowDown, Globe, Server, Zap, Copy, Check, X, MapPin, ExternalLink, Loader2, ChevronDown, ChevronRight } from 'lucide-react'

// Row height for virtualized list
const ROW_HEIGHT = 52

function formatBytes(bytes) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

function formatTime(timestamp) {
  if (!timestamp) return '-'
  const date = new Date(timestamp * 1000)
  return date.toLocaleTimeString()
}

// Get service hint based on port when app is unknown
function getServiceHint(port, protocol) {
  if (!port) return '-'

  // Well-known ports
  const services = {
    21: 'FTP',
    22: 'SSH',
    23: 'Telnet',
    25: 'SMTP',
    53: 'DNS',
    80: 'HTTP',
    110: 'POP3',
    123: 'NTP',
    143: 'IMAP',
    443: 'HTTPS',
    465: 'SMTPS',
    587: 'SMTP',
    993: 'IMAPS',
    995: 'POP3S',
    3306: 'MySQL',
    3389: 'RDP',
    5432: 'Postgres',
    5900: 'VNC',
    6379: 'Redis',
    8080: 'HTTP',
    8443: 'HTTPS',
    27017: 'MongoDB',
  }

  if (services[port]) {
    return `→ ${services[port]}`
  }

  // WebRTC/STUN ports
  if (port === 3478 || port === 3479) {
    return '→ STUN'
  }

  // High ephemeral ports (likely app traffic)
  if (port >= 49152) {
    return protocol === 'UDP' ? '→ UDP' : '→ TCP'
  }

  // Unknown but show port
  return `→ :${port}`
}

// Generate human-readable description of what's happening
function describeConnection(conn) {
  const app = conn.process || 'Unknown app'
  const dst = conn.dst_geo?.city || conn.dst_ip
  const country = conn.dst_geo?.country || ''
  const org = conn.dst_geo?.org || ''
  const port = conn.dst_port
  const bytes = conn.bytes
  const protocol = conn.protocol

  // Determine service type from port
  let service = ''
  let action = ''

  if (port === 443 || port === 8443) {
    service = 'HTTPS'
    action = 'Encrypted connection'
  } else if (port === 80 || port === 8080) {
    service = 'HTTP'
    action = 'Web request'
  } else if (port === 53) {
    service = 'DNS'
    action = 'Looking up domain'
  } else if (port === 22) {
    service = 'SSH'
    action = 'Secure shell connection'
  } else if (port === 21) {
    service = 'FTP'
    action = 'File transfer'
  } else if (port === 25 || port === 587 || port === 465) {
    service = 'SMTP'
    action = 'Sending email'
  } else if (port === 993 || port === 143) {
    service = 'IMAP'
    action = 'Checking email'
  } else if (port === 3478 || port === 3479 || (port >= 16384 && port <= 32767)) {
    service = 'WebRTC/STUN'
    action = 'Video/voice call'
  } else if (protocol === 'UDP' && port >= 1024) {
    service = 'UDP'
    action = 'Streaming/real-time data'
  } else {
    service = protocol || 'TCP'
    action = 'Network connection'
  }

  // Build description
  const lines = []

  // Main action line
  if (conn.process && conn.process !== '-') {
    if (port === 53) {
      lines.push(`${app} is resolving DNS`)
    } else {
      lines.push(`${app} is making a ${service} connection`)
    }
  } else if (port === 53) {
    lines.push(`DNS query${org ? ` via ${org}` : ''}`)
  } else if (org) {
    lines.push(`${action} to ${org}`)
  } else {
    lines.push(`${action}${dst && dst !== 'Unknown' ? ` to ${dst}` : ''}`)
  }

  // Destination details
  if (country && dst !== country) {
    lines.push(`Server located in ${dst}, ${country}`)
  }

  // Organization info
  if (org && !lines[0].includes(org)) {
    lines.push(`Hosted by ${org}`)
  }

  // Data transferred
  if (bytes > 1024 * 1024) {
    lines.push(`Transferred ${formatBytes(bytes)} of data`)
  } else if (bytes > 10 * 1024) {
    lines.push(`Small data transfer (${formatBytes(bytes)})`)
  }

  // Service-specific hints
  if (port === 443 && org) {
    if (org.toLowerCase().includes('cloudflare')) {
      lines.push('Traffic routed through Cloudflare CDN')
    } else if (org.toLowerCase().includes('amazon') || org.toLowerCase().includes('aws')) {
      lines.push('Connecting to AWS cloud service')
    } else if (org.toLowerCase().includes('google')) {
      lines.push('Google service or GCP-hosted app')
    } else if (org.toLowerCase().includes('microsoft') || org.toLowerCase().includes('azure')) {
      lines.push('Microsoft/Azure cloud service')
    } else if (org.toLowerCase().includes('akamai')) {
      lines.push('Content delivered via Akamai CDN')
    }
  }

  return lines
}

// Row component for virtualized flat list
const ConnectionRow = ({ index, style, connections, selectedConnection, onSelectConnection, rowRefs }) => {
  const conn = connections[index]
  const isSelected = selectedConnection?.id === conn.id

  return (
    <div
      style={style}
      ref={el => { if (el) rowRefs.current[conn.id] = el }}
      onClick={() => onSelectConnection(conn)}
      className={`
        flex items-center border-b border-[#1a1a1a] cursor-pointer transition-colors text-sm
        ${isSelected ? 'bg-blue-500/10' : 'hover:bg-[#141414]'}
      `}
    >
      <div className="flex-1 min-w-0 px-3 py-2">
        <div className="flex items-center gap-2">
          <Server className="w-3.5 h-3.5 text-[#525252] flex-shrink-0" />
          {conn.process ? (
            <span className="text-[#fafafa] mono truncate">{conn.process}</span>
          ) : conn.dst_geo?.org ? (
            <span className="text-[#a1a1a1] text-sm truncate" title={conn.dst_geo.org}>
              → {conn.dst_geo.org}
            </span>
          ) : (
            <span className="text-[#525252] text-xs">
              {getServiceHint(conn.dst_port, conn.protocol)}
            </span>
          )}
        </div>
      </div>
      <div className="flex-1 min-w-0 px-3 py-2">
        <div className="flex flex-col">
          <span className="text-[#fafafa] truncate">{conn.dst_geo?.city || conn.dst_ip}</span>
          {conn.dst_geo?.country && (
            <span className="text-[#525252] text-xs truncate">{conn.dst_geo.country}</span>
          )}
        </div>
      </div>
      <div className="w-20 px-3 py-2 flex-shrink-0">
        <span className="inline-flex px-2 py-0.5 text-xs font-medium rounded bg-[#1a1a1a] text-[#a1a1a1] mono">
          {conn.protocol}
        </span>
      </div>
      <div className="w-20 px-3 py-2 text-right text-[#a1a1a1] mono flex-shrink-0">
        {formatBytes(conn.bytes)}
      </div>
      <div className="w-20 px-3 py-2 text-right text-[#525252] mono flex-shrink-0">
        {formatTime(conn.timestamp)}
      </div>
    </div>
  )
}

// Virtualized flat list of connections
function VirtualizedConnectionList({ connections, selectedConnection, onSelectConnection, rowRefs }) {
  // Row props passed to each row component
  const rowProps = useMemo(() => ({
    connections,
    selectedConnection,
    onSelectConnection,
    rowRefs,
  }), [connections, selectedConnection, onSelectConnection, rowRefs])

  return (
    <List
      rowCount={connections.length}
      rowHeight={ROW_HEIGHT}
      rowComponent={ConnectionRow}
      rowProps={rowProps}
      overscanCount={5}
      style={{ height: '100%', width: '100%' }}
    />
  )
}

// Row component for grouped app list
const AppGroupRow = ({ index, style, flatItems, expandedApps, selectedConnection, onSelectConnection, toggleAppExpanded, rowRefs }) => {
  const item = flatItems[index]

  if (item.type === 'header') {
    const group = item.group
    const isExpanded = expandedApps.has(group.name)

    return (
      <div
        style={style}
        onClick={() => toggleAppExpanded(group.name)}
        className="flex items-center border-b border-[#262626] bg-[#0f0f0f] cursor-pointer hover:bg-[#141414] transition-colors px-3"
      >
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center gap-2">
            {isExpanded ? (
              <ChevronDown className="w-4 h-4 text-[#525252]" />
            ) : (
              <ChevronRight className="w-4 h-4 text-[#525252]" />
            )}
            <Server className="w-4 h-4 text-blue-400" />
            <span className="font-medium text-[#fafafa]">{group.name}</span>
            <span className="text-xs text-[#525252] ml-2">
              {group.connections.length} connection{group.connections.length !== 1 ? 's' : ''}
            </span>
          </div>
          <span className="text-[#a1a1a1] mono text-sm">{formatBytes(group.totalBytes)}</span>
        </div>
      </div>
    )
  }

  // Connection row under a group
  const conn = item.conn
  const isSelected = selectedConnection?.id === conn.id

  return (
    <div
      style={style}
      ref={el => { if (el) rowRefs.current[conn.id] = el }}
      onClick={(e) => { e.stopPropagation(); onSelectConnection(conn) }}
      className={`
        flex items-center border-b border-[#1a1a1a] cursor-pointer transition-colors text-sm
        ${isSelected ? 'bg-blue-500/10' : 'hover:bg-[#141414]'}
      `}
    >
      <div className="flex-1 min-w-0 px-3 py-2 pl-10">
        <span className="text-[#525252] text-xs">└</span>
      </div>
      <div className="flex-1 min-w-0 px-3 py-2">
        <div className="flex flex-col">
          <span className="text-[#fafafa] truncate">{conn.dst_geo?.city || conn.dst_ip}</span>
          {conn.dst_geo?.country && (
            <span className="text-[#525252] text-xs truncate">{conn.dst_geo.country}</span>
          )}
        </div>
      </div>
      <div className="w-20 px-3 py-2 flex-shrink-0">
        <span className="inline-flex px-2 py-0.5 text-xs font-medium rounded bg-[#1a1a1a] text-[#a1a1a1] mono">
          {conn.protocol}
        </span>
      </div>
      <div className="w-20 px-3 py-2 text-right text-[#a1a1a1] mono flex-shrink-0">
        {formatBytes(conn.bytes)}
      </div>
      <div className="w-20 px-3 py-2 text-right text-[#525252] mono flex-shrink-0">
        {formatTime(conn.timestamp)}
      </div>
    </div>
  )
}

// Virtualized grouped app list - flattens groups into a single list
function VirtualizedAppGroupList({ appGroups, expandedApps, selectedConnection, onSelectConnection, toggleAppExpanded, rowRefs }) {
  // Flatten groups into a list of items (headers + connections)
  const flatItems = useMemo(() => {
    const items = []
    appGroups.forEach(group => {
      items.push({ type: 'header', group })
      if (expandedApps.has(group.name)) {
        group.connections.forEach(conn => {
          items.push({ type: 'connection', conn, groupName: group.name })
        })
      }
    })
    return items
  }, [appGroups, expandedApps])

  // Row props passed to each row component
  const rowProps = useMemo(() => ({
    flatItems,
    expandedApps,
    selectedConnection,
    onSelectConnection,
    toggleAppExpanded,
    rowRefs,
  }), [flatItems, expandedApps, selectedConnection, onSelectConnection, toggleAppExpanded, rowRefs])

  return (
    <List
      rowCount={flatItems.length}
      rowHeight={ROW_HEIGHT}
      rowComponent={AppGroupRow}
      rowProps={rowProps}
      overscanCount={5}
      style={{ height: '100%', width: '100%' }}
    />
  )
}

export function ConnectionsTable({ connections, selectedConnection, selectedArcGroup, onSelectConnection, onClearArcFilter, onLookupIP, groupMode = 'location', onSetGroupMode }) {
  const [search, setSearch] = useState('')
  const [sortField, setSortField] = useState('timestamp')
  const [sortDirection, setSortDirection] = useState('desc')
  const [protocolFilter, setProtocolFilter] = useState('all')
  const [appFilter, setAppFilter] = useState('all')
  const [copied, setCopied] = useState(false)
  const [copiedField, setCopiedField] = useState(null) // Track which field was copied
  const [lookupLoading, setLookupLoading] = useState(null) // IP being looked up
  const [expandedApps, setExpandedApps] = useState(new Set()) // Expanded app groups
  const rowRefs = useRef({})
  const tableContainerRef = useRef(null)

  // Toggle app group expansion
  const toggleAppExpanded = (appName) => {
    setExpandedApps(prev => {
      const next = new Set(prev)
      if (next.has(appName)) {
        next.delete(appName)
      } else {
        next.add(appName)
      }
      return next
    })
  }

  // Handle IP lookup - falls back to external page if API fails
  const handleLookup = async (ip) => {
    if (!onLookupIP) return
    setLookupLoading(ip)
    try {
      const result = await onLookupIP(ip)
      if (!result) {
        // API lookup failed, open external lookup page
        window.open(`https://ipinfo.io/${ip}`, '_blank')
      }
    } finally {
      setLookupLoading(null)
    }
  }

  // Copy a single field to clipboard
  const copyToClipboard = (text, field) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedField(field)
      setTimeout(() => setCopiedField(null), 1500)
    })
  }

  // Copy connection details to clipboard
  const copyConnectionDetails = () => {
    if (!selectedConnection) return

    const lines = [
      `=== Connection Details ===`,
      ``,
      `Source: ${selectedConnection.src_ip}${selectedConnection.src_port ? `:${selectedConnection.src_port}` : ''}`,
      selectedConnection.src_geo ? `  Location: ${selectedConnection.src_geo.city}, ${selectedConnection.src_geo.country}` : null,
      ``,
      `Destination: ${selectedConnection.dst_ip}${selectedConnection.dst_port ? `:${selectedConnection.dst_port}` : ''}`,
      selectedConnection.dst_geo ? `  Location: ${selectedConnection.dst_geo.city}, ${selectedConnection.dst_geo.country}` : null,
      selectedConnection.dst_geo?.org ? `  Organization: ${selectedConnection.dst_geo.org}` : null,
      ``,
      `Protocol: ${selectedConnection.protocol}`,
      `Bytes: ${formatBytes(selectedConnection.bytes)} (${selectedConnection.bytes} bytes)`,
      `Packets: ${selectedConnection.packets}`,
      selectedConnection.process ? `Application: ${selectedConnection.process}${selectedConnection.pid ? ` (PID ${selectedConnection.pid})` : ''}` : null,
      ``,
      `Time: ${formatTime(selectedConnection.timestamp)}`,
    ].filter(Boolean).join('\n')

    navigator.clipboard.writeText(lines).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  // Scroll to selected row when selection changes (e.g., from map click)
  useEffect(() => {
    if (selectedConnection && rowRefs.current[selectedConnection.id]) {
      rowRefs.current[selectedConnection.id].scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      })
    }
  }, [selectedConnection?.id])

  // Get unique protocols for filter
  const protocols = useMemo(() => {
    const set = new Set(connections.map(c => c.protocol).filter(Boolean))
    return ['all', ...Array.from(set).sort()]
  }, [connections])

  // Get unique apps for filter
  const apps = useMemo(() => {
    const set = new Set(connections.map(c => c.process).filter(p => p && p !== '-'))
    return ['all', ...Array.from(set).sort()]
  }, [connections])

  // Filter and sort connections
  const filteredConnections = useMemo(() => {
    let result = [...connections]

    // Search filter
    if (search) {
      const searchLower = search.toLowerCase()
      result = result.filter(conn =>
        conn.src_ip?.toLowerCase().includes(searchLower) ||
        conn.dst_ip?.toLowerCase().includes(searchLower) ||
        conn.process?.toLowerCase().includes(searchLower) ||
        conn.src_geo?.city?.toLowerCase().includes(searchLower) ||
        conn.dst_geo?.city?.toLowerCase().includes(searchLower) ||
        conn.src_geo?.country?.toLowerCase().includes(searchLower) ||
        conn.dst_geo?.country?.toLowerCase().includes(searchLower)
      )
    }

    // Protocol filter
    if (protocolFilter !== 'all') {
      result = result.filter(conn => conn.protocol === protocolFilter)
    }

    // App filter
    if (appFilter !== 'all') {
      result = result.filter(conn => conn.process === appFilter)
    }

    // Sort
    result.sort((a, b) => {
      let aVal, bVal

      switch (sortField) {
        case 'timestamp':
          aVal = a.timestamp || 0
          bVal = b.timestamp || 0
          break
        case 'bytes':
          aVal = a.bytes || 0
          bVal = b.bytes || 0
          break
        case 'packets':
          aVal = a.packets || 0
          bVal = b.packets || 0
          break
        case 'protocol':
          aVal = a.protocol || ''
          bVal = b.protocol || ''
          break
        case 'process':
          aVal = a.process || ''
          bVal = b.process || ''
          break
        case 'destination':
          aVal = a.dst_geo?.city || a.dst_ip || ''
          bVal = b.dst_geo?.city || b.dst_ip || ''
          break
        default:
          return 0
      }

      if (typeof aVal === 'string') {
        return sortDirection === 'asc'
          ? aVal.localeCompare(bVal)
          : bVal.localeCompare(aVal)
      }

      return sortDirection === 'asc' ? aVal - bVal : bVal - aVal
    })

    return result
  }, [connections, search, protocolFilter, appFilter, sortField, sortDirection])

  // Group connections by app when in app mode
  const appGroups = useMemo(() => {
    if (groupMode !== 'app') return []

    const groups = new Map()

    filteredConnections.forEach(conn => {
      const appName = conn.process || 'Unknown'

      if (!groups.has(appName)) {
        groups.set(appName, {
          name: appName,
          connections: [],
          totalBytes: 0,
          totalPackets: 0,
        })
      }

      const group = groups.get(appName)
      group.connections.push(conn)
      group.totalBytes += conn.bytes || 0
      group.totalPackets += conn.packets || 0
    })

    // Sort groups by total bytes (most traffic first)
    return Array.from(groups.values()).sort((a, b) => b.totalBytes - a.totalBytes)
  }, [filteredConnections, groupMode])

  const handleSort = (field) => {
    if (sortField === field) {
      setSortDirection(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDirection('desc')
    }
  }

  const SortIcon = ({ field }) => {
    if (sortField !== field) return <ArrowUpDown className="w-3.5 h-3.5 text-[#525252]" />
    return sortDirection === 'asc'
      ? <ArrowUp className="w-3.5 h-3.5 text-blue-500" />
      : <ArrowDown className="w-3.5 h-3.5 text-blue-500" />
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="p-3 border-b border-[#262626] flex items-center gap-3">
        {/* Search */}
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#525252]" />
          <input
            type="text"
            placeholder="Search connections..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full h-8 pl-9 pr-3 text-sm bg-[#141414] border border-[#262626] rounded-md text-[#fafafa] placeholder:text-[#525252] focus:outline-none focus:border-[#404040]"
          />
        </div>

        {/* Protocol filter */}
        <select
          value={protocolFilter}
          onChange={(e) => setProtocolFilter(e.target.value)}
          className="h-8 px-3 text-sm bg-[#141414] border border-[#262626] rounded-md text-[#fafafa] focus:outline-none focus:border-[#404040]"
        >
          {protocols.map(p => (
            <option key={p} value={p}>
              {p === 'all' ? 'All protocols' : p}
            </option>
          ))}
        </select>

        {/* App filter */}
        <select
          value={appFilter}
          onChange={(e) => setAppFilter(e.target.value)}
          className="h-8 px-3 text-sm bg-[#141414] border border-[#262626] rounded-md text-[#fafafa] focus:outline-none focus:border-[#404040]"
        >
          {apps.map(app => (
            <option key={app} value={app}>
              {app === 'all' ? 'All apps' : app}
            </option>
          ))}
        </select>

        {/* Group mode toggle */}
        {onSetGroupMode && (
          <div className="flex bg-[#141414] border border-[#262626] rounded-md overflow-hidden">
            <button
              onClick={() => onSetGroupMode('location')}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                groupMode === 'location'
                  ? 'bg-blue-500/20 text-blue-400'
                  : 'text-[#a1a1a1] hover:text-[#fafafa] hover:bg-[#1a1a1a]'
              }`}
              title="Show all connections"
            >
              All
            </button>
            <button
              onClick={() => onSetGroupMode('app')}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                groupMode === 'app'
                  ? 'bg-blue-500/20 text-blue-400'
                  : 'text-[#a1a1a1] hover:text-[#fafafa] hover:bg-[#1a1a1a]'
              }`}
              title="Group by app"
            >
              By App
            </button>
          </div>
        )}
      </div>

      {/* Arc filter header - shows when arc group is selected */}
      {selectedArcGroup && (
        <div className="px-3 py-2 border-b flex items-center justify-between bg-blue-500/10 border-blue-500/20">
          <div className="flex items-center gap-2 text-sm">
            {groupMode === 'app' ? (
              <Server className="w-4 h-4 text-blue-400" />
            ) : (
              <MapPin className="w-4 h-4 text-blue-400" />
            )}
            <span className="text-[#fafafa]">
              Showing {selectedArcGroup.connections.length} connection{selectedArcGroup.connections.length !== 1 ? 's' : ''}{' '}
              {groupMode === 'app' ? (
                <>
                  from <span className="font-medium">{selectedArcGroup.process || 'Unknown'}</span>
                  {selectedArcGroup.dstGeo?.city && (
                    <> to {selectedArcGroup.dstGeo.city}</>
                  )}
                </>
              ) : (
                <>
                  to{' '}
                  <span className="font-medium">
                    {selectedArcGroup.dstGeo?.city || 'Unknown'}
                    {selectedArcGroup.dstGeo?.country && `, ${selectedArcGroup.dstGeo.country}`}
                  </span>
                </>
              )}
            </span>
            <span className="text-[#a1a1a1]">
              ({formatBytes(selectedArcGroup.totalBytes)} total)
            </span>
          </div>
          <button
            onClick={onClearArcFilter}
            className="flex items-center gap-1.5 px-2 py-1 text-xs text-[#a1a1a1] hover:text-[#fafafa] hover:bg-[#141414] rounded transition-colors"
          >
            <X className="w-3.5 h-3.5" />
            Clear filter
          </button>
        </div>
      )}

      {/* Virtualized Table */}
      <div className="flex-1 flex flex-col overflow-hidden" ref={tableContainerRef}>
        {/* Header */}
        <div className="flex items-center border-b border-[#262626] bg-[#0a0a0a] text-sm flex-shrink-0">
          <div className="flex-1 min-w-0 px-3 py-2">
            <button
              onClick={() => handleSort('process')}
              className="flex items-center gap-1.5 font-medium text-[#a1a1a1] hover:text-[#fafafa]"
            >
              App
              <SortIcon field="process" />
            </button>
          </div>
          <div className="flex-1 min-w-0 px-3 py-2">
            <button
              onClick={() => handleSort('destination')}
              className="flex items-center gap-1.5 font-medium text-[#a1a1a1] hover:text-[#fafafa]"
            >
              Destination
              <SortIcon field="destination" />
            </button>
          </div>
          <div className="w-20 px-3 py-2 flex-shrink-0">
            <button
              onClick={() => handleSort('protocol')}
              className="flex items-center gap-1.5 font-medium text-[#a1a1a1] hover:text-[#fafafa]"
            >
              Protocol
              <SortIcon field="protocol" />
            </button>
          </div>
          <div className="w-20 px-3 py-2 text-right flex-shrink-0">
            <button
              onClick={() => handleSort('bytes')}
              className="flex items-center gap-1.5 font-medium text-[#a1a1a1] hover:text-[#fafafa] ml-auto"
            >
              Data
              <SortIcon field="bytes" />
            </button>
          </div>
          <div className="w-20 px-3 py-2 text-right flex-shrink-0">
            <button
              onClick={() => handleSort('timestamp')}
              className="flex items-center gap-1.5 font-medium text-[#a1a1a1] hover:text-[#fafafa] ml-auto"
            >
              Time
              <SortIcon field="timestamp" />
            </button>
          </div>
        </div>

        {/* Virtualized List */}
        <div className="flex-1 min-h-0">
          {filteredConnections.length === 0 ? (
            <div className="flex items-center justify-center h-full text-[#525252] text-sm">
              {connections.length === 0
                ? 'No connections captured yet. Click Start to begin.'
                : 'No connections match your search.'}
            </div>
          ) : groupMode === 'app' ? (
            /* Grouped by App view - flatten groups into rows for virtualization */
            <VirtualizedAppGroupList
              appGroups={appGroups}
              expandedApps={expandedApps}
              selectedConnection={selectedConnection}
              onSelectConnection={onSelectConnection}
              toggleAppExpanded={toggleAppExpanded}
              rowRefs={rowRefs}
            />
          ) : (
            /* Flat list view (location mode) - virtualized */
            <VirtualizedConnectionList
              connections={filteredConnections}
              selectedConnection={selectedConnection}
              onSelectConnection={onSelectConnection}
              rowRefs={rowRefs}
            />
          )}
        </div>
      </div>

      {/* Connection Detail Panel */}
      {selectedConnection && (
        <div className="border-t border-[#262626] p-4 bg-[#0a0a0a]">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-[#fafafa]">Connection Details</h3>
            <div className="flex items-center gap-2">
              <button
                onClick={copyConnectionDetails}
                className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded transition-colors ${
                  copied
                    ? 'text-green-400 bg-green-500/10'
                    : 'text-[#525252] hover:text-[#a1a1a1] hover:bg-[#141414]'
                }`}
                title="Copy connection details"
              >
                {copied ? (
                  <>
                    <Check className="w-3 h-3" />
                    Copied!
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3" />
                    Copy
                  </>
                )}
              </button>
              <button
                onClick={() => onSelectConnection(null)}
                className="text-xs text-[#525252] hover:text-[#a1a1a1]"
              >
                Close
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 text-sm">
            {/* Source */}
            <div className="space-y-1 min-w-0">
              <div className="text-[#525252] text-xs uppercase tracking-wider">Source</div>
              <div className="flex items-start gap-1.5 group">
                <span className="mono text-[#fafafa] text-xs break-all">{selectedConnection.src_ip}</span>
                <button
                  onClick={() => copyToClipboard(selectedConnection.src_ip, 'src_ip')}
                  className="flex-shrink-0 p-0.5 text-[#525252] hover:text-[#a1a1a1] opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Copy IP"
                >
                  {copiedField === 'src_ip' ? (
                    <Check className="w-3 h-3 text-green-400" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                </button>
              </div>
              {selectedConnection.src_geo && (
                <div className="text-[#a1a1a1]">
                  {selectedConnection.src_geo.city}, {selectedConnection.src_geo.country}
                </div>
              )}
              {selectedConnection.src_port && (
                <div className="text-[#525252] mono">Port {selectedConnection.src_port}</div>
              )}
            </div>

            {/* Destination */}
            <div className="space-y-1 min-w-0">
              <div className="text-[#525252] text-xs uppercase tracking-wider">Destination</div>
              <div className="flex items-start gap-1.5 group">
                <span className="mono text-[#fafafa] text-xs break-all">{selectedConnection.dst_ip}</span>
                <button
                  onClick={() => copyToClipboard(selectedConnection.dst_ip, 'dst_ip')}
                  className="flex-shrink-0 p-0.5 text-[#525252] hover:text-[#a1a1a1] opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Copy IP"
                >
                  {copiedField === 'dst_ip' ? (
                    <Check className="w-3 h-3 text-green-400" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                </button>
              </div>
              {selectedConnection.dst_geo && (
                <div className="flex items-center gap-2">
                  <span className={selectedConnection.dst_geo.unknown ? 'text-red-400' : 'text-[#a1a1a1]'}>
                    {selectedConnection.dst_geo.city}, {selectedConnection.dst_geo.country}
                  </span>
                  {selectedConnection.dst_geo.unknown && onLookupIP && (
                    <button
                      onClick={() => handleLookup(selectedConnection.dst_ip)}
                      disabled={lookupLoading === selectedConnection.dst_ip}
                      className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-blue-400 hover:text-blue-300 bg-blue-500/10 hover:bg-blue-500/20 rounded transition-colors disabled:opacity-50"
                      title="Lookup location online"
                    >
                      {lookupLoading === selectedConnection.dst_ip ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <ExternalLink className="w-3 h-3" />
                      )}
                      Lookup
                    </button>
                  )}
                </div>
              )}
              {selectedConnection.dst_port && (
                <div className="text-[#525252] mono">Port {selectedConnection.dst_port}</div>
              )}
            </div>

            {/* Stats */}
            <div className="space-y-1">
              <div className="text-[#525252] text-xs uppercase tracking-wider">Traffic</div>
              <div className="text-[#fafafa]">
                {formatBytes(selectedConnection.bytes)} / {selectedConnection.packets} packets
              </div>
            </div>

            {/* Process */}
            {selectedConnection.process && (
              <div className="space-y-1">
                <div className="text-[#525252] text-xs uppercase tracking-wider">Application</div>
                <div className="text-[#fafafa]">
                  {selectedConnection.process}
                  {selectedConnection.pid && (
                    <span className="text-[#525252] ml-2">PID {selectedConnection.pid}</span>
                  )}
                </div>
              </div>
            )}

            {/* What's Happening - Human readable description */}
            <div className="space-y-2 pt-3 border-t border-[#262626]">
              <div className="flex items-center gap-2 text-[#525252] text-xs uppercase tracking-wider">
                <Zap className="w-3 h-3" />
                What's Happening
              </div>
              <div className="space-y-1.5">
                {describeConnection(selectedConnection).map((line, i) => (
                  <div
                    key={i}
                    className={i === 0 ? "text-[#fafafa]" : "text-[#a1a1a1] text-sm"}
                  >
                    {i === 0 ? line : `• ${line}`}
                  </div>
                ))}
              </div>
            </div>

            {/* Protocol & Port Info */}
            <div className="space-y-1 pt-3 border-t border-[#262626]">
              <div className="text-[#525252] text-xs uppercase tracking-wider">Technical Details</div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <span className="text-[#525252]">Protocol:</span>{' '}
                  <span className="text-[#a1a1a1] mono">{selectedConnection.protocol}</span>
                </div>
                <div>
                  <span className="text-[#525252]">Dst Port:</span>{' '}
                  <span className="text-[#a1a1a1] mono">{selectedConnection.dst_port}</span>
                </div>
                <div>
                  <span className="text-[#525252]">Packets:</span>{' '}
                  <span className="text-[#a1a1a1] mono">{selectedConnection.packets}</span>
                </div>
                <div>
                  <span className="text-[#525252]">Bytes:</span>{' '}
                  <span className="text-[#a1a1a1] mono">{formatBytes(selectedConnection.bytes)}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
