import { useEffect, useRef, useCallback, useState } from 'react'
import { Home, Plus, Minus, Radio, Activity } from 'lucide-react'

export function WorldMap({ connections, arcGroups = [], selectedConnection, selectedArcGroup, onSelectConnection, onSelectArcGroup, packetEvents = [], homeLocation = null }) {
  const canvasRef = useRef(null)
  const mapImageRef = useRef(null)
  const animationRef = useRef(null)
  const timeRef = useRef(0)

  // Store current values in refs for animation loop
  const arcGroupsRef = useRef(arcGroups)
  const selectedConnectionRef = useRef(selectedConnection)
  const selectedArcGroupRef = useRef(selectedArcGroup)
  const zoomRef = useRef(1)
  const panRef = useRef({ x: 0, y: 0 })

  // Packet events ref for real-time visualization
  const packetEventsRef = useRef(packetEvents)

  // Home location ref for private IPs
  const homeLocationRef = useRef(homeLocation)

  // Animation mode: 'live' (real packets) or 'activity' (constant animation)
  const [animMode, setAnimMode] = useState('live')
  const animModeRef = useRef(animMode)

  // Update refs when props/state change
  useEffect(() => { arcGroupsRef.current = arcGroups }, [arcGroups])
  useEffect(() => { selectedConnectionRef.current = selectedConnection }, [selectedConnection])
  useEffect(() => { selectedArcGroupRef.current = selectedArcGroup }, [selectedArcGroup])
  useEffect(() => { packetEventsRef.current = packetEvents }, [packetEvents])
  useEffect(() => { homeLocationRef.current = homeLocation }, [homeLocation])
  useEffect(() => { animModeRef.current = animMode }, [animMode])

  // Zoom and pan state (also mirrored to refs)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  useEffect(() => { zoomRef.current = zoom }, [zoom])
  useEffect(() => { panRef.current = pan }, [pan])

  const isDraggingRef = useRef(false)
  const lastPosRef = useRef({ x: 0, y: 0 })
  const dragDistRef = useRef(0)

  // Hover state - track mouse position and hovered arc group
  const mousePosRef = useRef({ x: -1000, y: -1000 })
  const hoveredArcGroupRef = useRef(null)
  const [hoveredArcGroup, setHoveredArcGroup] = useState(null)
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 })
  const [cursorStyle, setCursorStyle] = useState('grab')

  // Constrain pan to keep map filling viewport
  const constrainPan = useCallback((newPan, z, w, h) => {
    const maxPanX = Math.max(0, (w * z - w) / 2)
    const maxPanY = Math.max(0, (h * z - h) / 2)
    return {
      x: Math.max(-maxPanX, Math.min(maxPanX, newPan.x)),
      y: Math.max(-maxPanY, Math.min(maxPanY, newPan.y)),
    }
  }, [])

  // Go to home location (or reset view if no home set)
  const goHome = useCallback(() => {
    const home = homeLocationRef.current
    if (home && canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect()
      const w = rect.width
      const h = rect.height

      // Set reasonable zoom to see home area
      const newZoom = 3

      // Calculate pan to center on home location
      const baseX = (home.lon + 180) / 360 * w
      const baseY = (90 - home.lat) / 180 * h
      const centerX = w / 2
      const centerY = h / 2

      // Pan needed to center home on screen
      const newPan = {
        x: centerX - (baseX - centerX) * newZoom - centerX,
        y: centerY - (baseY - centerY) * newZoom - centerY,
      }

      setZoom(newZoom)
      setPan(constrainPan(newPan, newZoom, w, h))
    } else {
      // No home location - just reset to default
      setZoom(1)
      setPan({ x: 0, y: 0 })
    }
  }, [constrainPan])

  // Zoom in/out
  const zoomIn = useCallback(() => {
    setZoom(z => Math.min(8, z * 1.5))
  }, [])

  const zoomOut = useCallback(() => {
    setZoom(z => {
      const newZ = Math.max(1, z / 1.5)
      if (canvasRef.current) {
        const rect = canvasRef.current.getBoundingClientRect()
        setPan(p => constrainPan(p, newZ, rect.width, rect.height))
      }
      return newZ
    })
  }, [constrainPan])

  // Load map image and start animation loop (only once on mount)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    // GPU acceleration hints for canvas
    const ctx = canvas.getContext('2d', {
      alpha: false,           // Opaque canvas - skip alpha blending
      desynchronized: true,   // Low-latency rendering, bypasses DOM compositor
      willReadFrequently: false, // We don't read pixels back
    })
    const dpr = window.devicePixelRatio || 1

    // Load map image
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      mapImageRef.current = img
    }
    img.src = 'https://unpkg.com/three-globe@2.31.0/example/img/earth-blue-marble.jpg'

    // Ensure canvas is sized correctly
    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()

    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(canvas)

    // Convert lat/lon to canvas XY
    const toXY = (lat, lon, w, h, z, p) => {
      const baseX = (lon + 180) / 360 * w
      const baseY = (90 - lat) / 180 * h
      const centerX = w / 2
      const centerY = h / 2
      const x = (baseX - centerX) * z + centerX + p.x
      const y = (baseY - centerY) * z + centerY + p.y
      return { x, y }
    }

    // Bezier point helper
    const bezierPoint = (t, p0, p1, p2) => {
      const mt = 1 - t
      return mt * mt * p0 + 2 * mt * t * p1 + t * t * p2
    }

    // Hit test helper - returns arc group if mouse is near it
    const hitTest = (mouseX, mouseY, w, h, currentZoom, currentPan, currentArcGroups) => {
      // Scale hit radius with zoom for easier selection when zoomed in
      const baseHitRadius = 18
      const hitRadius = baseHitRadius * Math.max(1, currentZoom * 0.5)
      const nodeHitRadius = 24 * Math.max(1, currentZoom * 0.5)

      for (const group of currentArcGroups) {
        const srcGeo = group.srcGeo
        const dstGeo = group.dstGeo
        if (!srcGeo || !dstGeo) continue

        const src = toXY(srcGeo.lat, srcGeo.lon, w, h, currentZoom, currentPan)
        const dst = toXY(dstGeo.lat, dstGeo.lon, w, h, currentZoom, currentPan)

        // Check nodes first (larger hit area)
        const distToSrc = Math.sqrt((mouseX - src.x) ** 2 + (mouseY - src.y) ** 2)
        const distToDst = Math.sqrt((mouseX - dst.x) ** 2 + (mouseY - dst.y) ** 2)
        if (distToSrc < nodeHitRadius || distToDst < nodeHitRadius) return group

        // Check arc with adaptive sampling based on screen length
        const midX = (src.x + dst.x) / 2
        const screenDist = Math.sqrt((dst.x - src.x) ** 2 + (dst.y - src.y) ** 2)
        const midY = Math.min(src.y, dst.y) - screenDist * 0.15 - 15

        // More samples for longer arcs (min 20, max 100 samples)
        const numSamples = Math.min(100, Math.max(20, Math.floor(screenDist / 10)))
        const step = 1 / numSamples

        for (let t = 0; t <= 1; t += step) {
          const mt = 1 - t
          const px = mt * mt * src.x + 2 * mt * t * midX + t * t * dst.x
          const py = mt * mt * src.y + 2 * mt * t * midY + t * t * dst.y
          const distToArc = Math.sqrt((mouseX - px) ** 2 + (mouseY - py) ** 2)
          if (distToArc < hitRadius) return group
        }
      }
      return null
    }

    // Throttle hover state updates
    let lastHoverUpdate = 0

    // Animation loop - runs continuously, reads from refs
    const draw = () => {
      animationRef.current = requestAnimationFrame(draw)
      timeRef.current += 0.016

      const rect = canvas.getBoundingClientRect()
      const w = rect.width
      const h = rect.height
      if (w === 0 || h === 0) return

      // Read current values from refs
      const currentZoom = zoomRef.current
      const currentPan = panRef.current
      const currentArcGroups = arcGroupsRef.current
      const currentSelected = selectedConnectionRef.current
      const currentSelectedArcGroup = selectedArcGroupRef.current
      const currentHomeLocation = homeLocationRef.current
      const mousePos = mousePosRef.current

      // Hit test for hover (throttled to every 50ms for performance)
      const now = Date.now()
      if (now - lastHoverUpdate > 50) {
        const hit = hitTest(mousePos.x, mousePos.y, w, h, currentZoom, currentPan, currentArcGroups)
        if (hit?.key !== hoveredArcGroupRef.current?.key) {
          hoveredArcGroupRef.current = hit
          setHoveredArcGroup(hit)
          setCursorStyle(hit ? 'pointer' : 'grab')
          if (hit) {
            setTooltipPos({ x: mousePos.x, y: mousePos.y })
          }
        } else if (hit) {
          // Update tooltip position while hovering
          setTooltipPos({ x: mousePos.x, y: mousePos.y })
        }
        lastHoverUpdate = now
      }

      const currentHoveredArcGroup = hoveredArcGroupRef.current
      const currentPacketEvents = packetEventsRef.current
      const currentAnimMode = animModeRef.current

      // Draw background
      ctx.fillStyle = '#0f1419'
      ctx.fillRect(0, 0, w, h)

      // Draw map if loaded
      if (mapImageRef.current) {
        const mapW = w * currentZoom
        const mapH = h * currentZoom
        const mapX = (w - mapW) / 2 + currentPan.x
        const mapY = (h - mapH) / 2 + currentPan.y
        ctx.drawImage(mapImageRef.current, mapX, mapY, mapW, mapH)
      }

      const hasSelection = currentSelectedArcGroup !== null

      // Helper to draw home marker (green)
      const drawHomeNode = (x, y, selected, hovered) => {
        const size = selected ? 10 : (hovered ? 9 : 7)
        ctx.fillStyle = '#22c55e'
        ctx.globalAlpha = 0.3
        ctx.beginPath()
        ctx.arc(x, y, size + 6, 0, Math.PI * 2)
        ctx.fill()
        ctx.globalAlpha = 1

        ctx.fillStyle = selected ? '#4ade80' : (hovered ? '#86efac' : '#22c55e')
        ctx.beginPath()
        ctx.arc(x, y, size, 0, Math.PI * 2)
        ctx.fill()

        ctx.fillStyle = '#fff'
        ctx.beginPath()
        ctx.arc(x, y, 3, 0, Math.PI * 2)
        ctx.fill()
      }

      // Draw endpoint node helper
      const drawNode = (x, y, isSelectedArc, isHovered, isUnknown) => {
        const size = isSelectedArc ? 8 : (isHovered ? 7 : 5)
        // Red for unknown locations, blue otherwise
        const baseColor = isUnknown ? '#ef4444' : '#3b82f6'
        const brightColor = isUnknown ? '#f87171' : '#60a5fa'
        const hoverColor = isUnknown ? '#fca5a5' : '#22d3ee' // Cyan for hover
        const color = isSelectedArc ? brightColor : (isHovered ? hoverColor : (hasSelection ? '#444' : baseColor))

        // Glow for selected or hovered
        if (isSelectedArc || isHovered) {
          ctx.fillStyle = isSelectedArc ? baseColor : (isUnknown ? '#ef4444' : '#06b6d4')
          ctx.globalAlpha = isSelectedArc ? 0.3 : 0.25
          ctx.beginPath()
          ctx.arc(x, y, isSelectedArc ? 16 : 14, 0, Math.PI * 2)
          ctx.fill()
          ctx.globalAlpha = 1
        }

        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(x, y, size, 0, Math.PI * 2)
        ctx.fill()

        if (isSelectedArc) {
          ctx.fillStyle = '#fff'
          ctx.beginPath()
          ctx.arc(x, y, 3, 0, Math.PI * 2)
          ctx.fill()
        }
      }

      // Draw arc groups (one arc per geographic path)
      currentArcGroups.forEach((group, idx) => {
        const srcGeo = group.srcGeo
        const dstGeo = group.dstGeo
        if (!srcGeo || !dstGeo) return

        // Arc is selected if: arc group is selected OR selected connection is in this group
        const isSelectedByArcGroup = currentSelectedArcGroup?.key === group.key
        const isSelectedByConnection = currentSelected && group.connections?.some(c => c.id === currentSelected.id)
        const isSelected = isSelectedByArcGroup || isSelectedByConnection
        const isHovered = currentHoveredArcGroup?.key === group.key && !isSelected

        const src = toXY(srcGeo.lat, srcGeo.lon, w, h, currentZoom, currentPan)
        const dst = toXY(dstGeo.lat, dstGeo.lon, w, h, currentZoom, currentPan)

        // Calculate curved path
        const midX = (src.x + dst.x) / 2
        const dist = Math.sqrt((dst.x - src.x) ** 2 + (dst.y - src.y) ** 2)
        const midY = Math.min(src.y, dst.y) - dist * 0.15 - 15

        // Uniform arc stroke width
        const strokeWidth = isSelected ? 4 : (isHovered ? 3 : 2)

        const arcOpacity = isSelected ? 1 : (isHovered ? 0.9 : (hasSelection ? 0.15 : 0.7))

        // Draw glow for selected or hovered
        if (isSelected || isHovered) {
          ctx.strokeStyle = isSelected ? '#3b82f6' : '#06b6d4' // Blue for selected, cyan for hover
          ctx.globalAlpha = isSelected ? 0.4 : 0.3
          ctx.lineWidth = strokeWidth + 6
          ctx.beginPath()
          ctx.moveTo(src.x, src.y)
          ctx.quadraticCurveTo(midX, midY, dst.x, dst.y)
          ctx.stroke()
        }

        // Draw arc
        const arcColor = isSelected ? '#60a5fa' : (isHovered ? '#22d3ee' : (hasSelection ? '#444' : '#6b7280'))
        ctx.strokeStyle = arcColor
        ctx.globalAlpha = arcOpacity
        ctx.lineWidth = strokeWidth
        ctx.beginPath()
        ctx.moveTo(src.x, src.y)
        ctx.quadraticCurveTo(midX, midY, dst.x, dst.y)
        ctx.stroke()
        ctx.globalAlpha = 1

        // Animated packet dots
        if (isSelected || isHovered || !hasSelection) {
          if (currentAnimMode === 'activity') {
            // Activity mode: constant bidirectional animation
            const phase = (idx * 0.3) % 1

            // Forward packet
            const t1 = (timeRef.current * 0.3 + phase) % 1
            const px1 = bezierPoint(t1, src.x, midX, dst.x)
            const py1 = bezierPoint(t1, src.y, midY, dst.y)

            // Backward packet
            const t2 = (timeRef.current * 0.3 + phase + 0.5) % 1
            const px2 = bezierPoint(1 - t2, src.x, midX, dst.x)
            const py2 = bezierPoint(1 - t2, src.y, midY, dst.y)

            ctx.fillStyle = isSelected ? '#60a5fa' : (isHovered ? '#22d3ee' : '#9ca3af')
            ctx.globalAlpha = (isSelected || isHovered) ? 1 : 0.7

            ctx.beginPath()
            ctx.arc(px1, py1, (isSelected || isHovered) ? 5 : 3, 0, Math.PI * 2)
            ctx.fill()

            ctx.beginPath()
            ctx.arc(px2, py2, (isSelected || isHovered) ? 5 : 3, 0, Math.PI * 2)
            ctx.fill()

            ctx.globalAlpha = 1
          }
          // Live mode packets are drawn after all arcs (below)
        }

        // Draw source node (check if it's home location)
        const srcIsHome = srcGeo.isHome || (currentHomeLocation &&
          Math.abs(srcGeo.lat - currentHomeLocation.lat) < 0.1 &&
          Math.abs(srcGeo.lon - currentHomeLocation.lon) < 0.1)
        if (srcIsHome) {
          drawHomeNode(src.x, src.y, isSelected, isHovered)
        } else {
          drawNode(src.x, src.y, isSelected, isHovered, srcGeo.unknown)
        }

        // Draw destination node (check if it's home location)
        const dstIsHome = dstGeo.isHome || (currentHomeLocation &&
          Math.abs(dstGeo.lat - currentHomeLocation.lat) < 0.1 &&
          Math.abs(dstGeo.lon - currentHomeLocation.lon) < 0.1)
        if (dstIsHome) {
          drawHomeNode(dst.x, dst.y, isSelected, isHovered)
        } else {
          drawNode(dst.x, dst.y, isSelected, isHovered, dstGeo.unknown)
        }
      })

      // Draw real-time packet events (Live mode)
      if (currentAnimMode === 'live') {
        const now = Date.now()
        const PACKET_DURATION = 800 // 0.8 seconds for snappy packet travel

        currentPacketEvents.forEach(event => {
          // Use home location for private IPs (either source or destination)
          const homeGeo = currentHomeLocation ? {
            lat: currentHomeLocation.lat,
            lon: currentHomeLocation.lon,
          } : null

          // Get geo, but treat pending (null lat/lon) as missing
          const rawSrcGeo = event.src_geo
          const rawDstGeo = event.dst_geo
          const srcGeo = (rawSrcGeo && rawSrcGeo.lat != null && rawSrcGeo.lon != null) ? rawSrcGeo : homeGeo
          const dstGeo = (rawDstGeo && rawDstGeo.lat != null && rawDstGeo.lon != null) ? rawDstGeo : homeGeo

          // Skip if no valid geo data
          if (!srcGeo && !dstGeo) return
          if (!srcGeo || !dstGeo) return // Need both for arc
          // Skip if both are home (local to local)
          if (!event.src_geo && !event.dst_geo) return

          const age = now - event.timestamp
          if (age > PACKET_DURATION) return // Event expired

          const progress = age / PACKET_DURATION // 0 to 1

          const src = toXY(srcGeo.lat, srcGeo.lon, w, h, currentZoom, currentPan)
          const dst = toXY(dstGeo.lat, dstGeo.lon, w, h, currentZoom, currentPan)

          // Calculate arc control point
          const midX = (src.x + dst.x) / 2
          const dist = Math.sqrt((dst.x - src.x) ** 2 + (dst.y - src.y) ** 2)
          const midY = Math.min(src.y, dst.y) - dist * 0.15 - 15

          // Ease-out for smoother animation
          const t = 1 - Math.pow(1 - progress, 2)

          const px = bezierPoint(t, src.x, midX, dst.x)
          const py = bezierPoint(t, src.y, midY, dst.y)

          // Fade out as packet reaches destination
          const opacity = progress < 0.8 ? 1 : 1 - (progress - 0.8) / 0.2

          // Size based on packet size (clamp between 3 and 8)
          const baseSize = Math.min(8, Math.max(3, Math.log2(event.size + 1)))

          // Glow effect
          ctx.fillStyle = '#22d3ee'
          ctx.globalAlpha = opacity * 0.3
          ctx.beginPath()
          ctx.arc(px, py, baseSize + 4, 0, Math.PI * 2)
          ctx.fill()

          // Core dot
          ctx.fillStyle = '#67e8f9'
          ctx.globalAlpha = opacity
          ctx.beginPath()
          ctx.arc(px, py, baseSize, 0, Math.PI * 2)
          ctx.fill()

          // Bright center
          ctx.fillStyle = '#ffffff'
          ctx.globalAlpha = opacity * 0.8
          ctx.beginPath()
          ctx.arc(px, py, baseSize * 0.4, 0, Math.PI * 2)
          ctx.fill()

          ctx.globalAlpha = 1
        })
      }
    }

    draw()

    return () => {
      cancelAnimationFrame(animationRef.current)
      resizeObserver.disconnect()
    }
  }, [])  // Empty deps - only run on mount/unmount

  // Mouse handlers
  const handleMouseDown = (e) => {
    isDraggingRef.current = true
    dragDistRef.current = 0
    lastPosRef.current = { x: e.clientX, y: e.clientY }
    setCursorStyle('grabbing')
  }

  const handleMouseMove = (e) => {
    const canvas = canvasRef.current
    const rect = canvas.getBoundingClientRect()
    const mouseX = e.clientX - rect.left
    const mouseY = e.clientY - rect.top

    // Update mouse position for hit testing in animation loop
    mousePosRef.current = { x: mouseX, y: mouseY }

    if (!isDraggingRef.current) return

    const dx = e.clientX - lastPosRef.current.x
    const dy = e.clientY - lastPosRef.current.y
    dragDistRef.current += Math.abs(dx) + Math.abs(dy)

    setPan(p => constrainPan({ x: p.x + dx, y: p.y + dy }, zoom, rect.width, rect.height))
    lastPosRef.current = { x: e.clientX, y: e.clientY }
  }

  const handleMouseUp = () => {
    isDraggingRef.current = false
    // Restore cursor based on hover state
    setCursorStyle(hoveredArcGroupRef.current ? 'pointer' : 'grab')
  }

  const handleMouseLeave = () => {
    isDraggingRef.current = false
    mousePosRef.current = { x: -1000, y: -1000 }
    hoveredArcGroupRef.current = null
    setHoveredArcGroup(null)
    setCursorStyle('grab')
  }

  const handleWheel = (e) => {
    e.preventDefault()
    const canvas = canvasRef.current
    const rect = canvas.getBoundingClientRect()
    const mouseX = e.clientX - rect.left
    const mouseY = e.clientY - rect.top
    const centerX = rect.width / 2
    const centerY = rect.height / 2

    const delta = e.deltaY > 0 ? 0.85 : 1.15
    const newZoom = Math.max(1, Math.min(8, zoom * delta))

    const zoomRatio = newZoom / zoom
    // Zoom towards mouse position - map is centered so we need to offset from center
    const newPan = {
      x: (mouseX - centerX) * (1 - zoomRatio) + pan.x * zoomRatio,
      y: (mouseY - centerY) * (1 - zoomRatio) + pan.y * zoomRatio,
    }

    setZoom(newZoom)
    setPan(constrainPan(newPan, newZoom, rect.width, rect.height))
  }

  // Click handler - uses refs for current values
  const handleClick = (e) => {
    if (dragDistRef.current > 5) return

    const canvas = canvasRef.current
    const rect = canvas.getBoundingClientRect()
    const clickX = e.clientX - rect.left
    const clickY = e.clientY - rect.top
    const w = rect.width
    const h = rect.height

    const currentZoom = zoomRef.current
    const currentPan = panRef.current
    const currentArcGroups = arcGroupsRef.current

    // Scale hit radius with zoom for easier selection when zoomed in
    const baseHitRadius = 18
    const hitRadius = baseHitRadius * Math.max(1, currentZoom * 0.5)
    const nodeHitRadius = 24 * Math.max(1, currentZoom * 0.5)

    const toXY = (lat, lon) => {
      const baseX = (lon + 180) / 360 * w
      const baseY = (90 - lat) / 180 * h
      const centerX = w / 2
      const centerY = h / 2
      return {
        x: (baseX - centerX) * currentZoom + centerX + currentPan.x,
        y: (baseY - centerY) * currentZoom + centerY + currentPan.y,
      }
    }

    for (const group of currentArcGroups) {
      const srcGeo = group.srcGeo
      const dstGeo = group.dstGeo
      if (!srcGeo || !dstGeo) continue

      const src = toXY(srcGeo.lat, srcGeo.lon)
      const dst = toXY(dstGeo.lat, dstGeo.lon)

      const distToSrc = Math.sqrt((clickX - src.x) ** 2 + (clickY - src.y) ** 2)
      const distToDst = Math.sqrt((clickX - dst.x) ** 2 + (clickY - dst.y) ** 2)

      if (distToSrc < nodeHitRadius || distToDst < nodeHitRadius) {
        onSelectArcGroup(group)
        return
      }

      // Check arc with adaptive sampling based on screen length
      const midX = (src.x + dst.x) / 2
      const screenDist = Math.sqrt((dst.x - src.x) ** 2 + (dst.y - src.y) ** 2)
      const midY = Math.min(src.y, dst.y) - screenDist * 0.15 - 15

      // More samples for longer arcs (min 20, max 100 samples)
      const numSamples = Math.min(100, Math.max(20, Math.floor(screenDist / 10)))
      const step = 1 / numSamples

      for (let t = 0; t <= 1; t += step) {
        const mt = 1 - t
        const px = mt * mt * src.x + 2 * mt * t * midX + t * t * dst.x
        const py = mt * mt * src.y + 2 * mt * t * midY + t * t * dst.y
        const distToArc = Math.sqrt((clickX - px) ** 2 + (clickY - py) ** 2)

        if (distToArc < hitRadius) {
          onSelectArcGroup(group)
          return
        }
      }
    }

    onSelectArcGroup(null)
  }

  // Format bytes for tooltip
  const formatBytes = (bytes) => {
    if (!bytes) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
  }

  return (
    <div className="w-full h-full relative overflow-hidden">
      <canvas
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onWheel={handleWheel}
        onClick={handleClick}
        className="w-full h-full"
        style={{ display: 'block', cursor: cursorStyle }}
      />

      {/* Hover tooltip */}
      {hoveredArcGroup && !isDraggingRef.current && (
        <div
          className="absolute pointer-events-none z-20"
          style={{
            left: Math.min(tooltipPos.x + 16, (canvasRef.current?.getBoundingClientRect().width || 400) - 200),
            top: tooltipPos.y - 10,
            transform: 'translateY(-100%)',
          }}
        >
          <div className="bg-[#1a1a1a]/95 backdrop-blur-sm border border-[#333] rounded-lg px-3 py-2 shadow-xl">
            <div className="text-sm text-[#fafafa] font-medium">
              {hoveredArcGroup.dstGeo?.city || 'Unknown'}
              {hoveredArcGroup.dstGeo?.country && `, ${hoveredArcGroup.dstGeo.country}`}
            </div>
            <div className="text-xs text-[#aaa] mt-1">
              {hoveredArcGroup.connections.length} connection{hoveredArcGroup.connections.length !== 1 ? 's' : ''}
            </div>
            <div className="text-xs text-[#666] mt-1 flex items-center gap-2">
              <span>{formatBytes(hoveredArcGroup.totalBytes)}</span>
              <span className="text-[#444]">|</span>
              <span>{hoveredArcGroup.totalPackets.toLocaleString()} pkts</span>
            </div>
          </div>
        </div>
      )}

      {/* Animation mode toggle */}
      <div className="absolute top-3 right-3 z-10 flex bg-[#141414] border border-[#262626] rounded-md overflow-hidden">
        <button
          onClick={() => setAnimMode('live')}
          className={`px-2.5 py-1.5 text-xs font-medium transition-colors flex items-center gap-1.5 ${
            animMode === 'live'
              ? 'bg-cyan-500/20 text-cyan-400'
              : 'text-[#a1a1a1] hover:text-[#fafafa] hover:bg-[#1a1a1a]'
          }`}
          title="Show real-time packets as they flow"
        >
          <Radio className="w-3 h-3" />
          Live
        </button>
        <button
          onClick={() => setAnimMode('activity')}
          className={`px-2.5 py-1.5 text-xs font-medium transition-colors flex items-center gap-1.5 ${
            animMode === 'activity'
              ? 'bg-cyan-500/20 text-cyan-400'
              : 'text-[#a1a1a1] hover:text-[#fafafa] hover:bg-[#1a1a1a]'
          }`}
          title="Show constant activity animation"
        >
          <Activity className="w-3 h-3" />
          Activity
        </button>
      </div>

      {/* Zoom controls */}
      <div className="absolute bottom-4 right-4 flex flex-col gap-1">
        <button
          onClick={zoomIn}
          className="w-8 h-8 flex items-center justify-center bg-white/90 hover:bg-white rounded shadow text-gray-700 transition-colors"
          title="Zoom in"
        >
          <Plus className="w-4 h-4" />
        </button>
        <button
          onClick={zoomOut}
          disabled={zoom <= 1}
          className="w-8 h-8 flex items-center justify-center bg-white/90 hover:bg-white rounded shadow text-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title="Zoom out"
        >
          <Minus className="w-4 h-4" />
        </button>
        <button
          onClick={goHome}
          className="w-8 h-8 flex items-center justify-center bg-white/90 hover:bg-white rounded shadow text-gray-700 transition-colors"
          title="Go to home location"
        >
          <Home className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
