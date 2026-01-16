import { useEffect, useRef, useCallback, useState } from 'react'
import * as THREE from 'three'
import { Home, Radio, Activity } from 'lucide-react'

// Convert lat/lon to 3D coordinates
function latLonToVector3(lat, lon, radius = 1) {
  const phi = (90 - lat) * (Math.PI / 180)
  const theta = (lon + 180) * (Math.PI / 180)
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta)
  )
}

// Create arc curve between two points using spherical interpolation
function createArcCurve(startLat, startLon, endLat, endLon) {
  const start = latLonToVector3(startLat, startLon, 1).normalize()
  const end = latLonToVector3(endLat, endLon, 1).normalize()

  const angle = start.angleTo(end)
  const arcHeight = 0.1 + (angle / Math.PI) * 0.3

  // Handle very close or antipodal points
  if (angle < 0.01) {
    return new THREE.QuadraticBezierCurve3(
      start.clone().multiplyScalar(1.01),
      start.clone().multiplyScalar(1.01 + arcHeight),
      end.clone().multiplyScalar(1.01)
    )
  }

  // Sample points along great circle with height
  const points = []
  const segments = 32

  for (let i = 0; i <= segments; i++) {
    const t = i / segments
    const sinAngle = Math.sin(angle)

    // Spherical interpolation
    const a = Math.sin((1 - t) * angle) / sinAngle
    const b = Math.sin(t * angle) / sinAngle
    const point = new THREE.Vector3(
      a * start.x + b * end.x,
      a * start.y + b * end.y,
      a * start.z + b * end.z
    )

    // Lift with parabolic profile
    const lift = 4 * t * (1 - t) * arcHeight
    point.normalize().multiplyScalar(1.01 + lift)
    points.push(point)
  }

  return new THREE.CatmullRomCurve3(points)
}

export function Globe({ connections, arcGroups = [], selectedConnection, selectedArcGroup, onSelectConnection, onSelectArcGroup, packetEvents = [], homeLocation = null }) {
  const containerRef = useRef(null)
  const sceneRef = useRef(null)
  const cameraRef = useRef(null)
  const rendererRef = useRef(null)
  const globeRef = useRef(null)
  const arcsGroupRef = useRef(null)
  const nodesGroupRef = useRef(null)
  const packetsGroupRef = useRef(null)
  const curvesMapRef = useRef(new Map())  // Map connection key -> curve for packet animation
  const frameRef = useRef(null)
  const controlsRef = useRef(null)
  const timeRef = useRef(0)
  const raycasterRef = useRef(new THREE.Raycaster())
  const arcGroupMapRef = useRef(new Map())  // Maps mesh uuid -> arc group for click detection

  // Animation mode: 'live' (real packets) or 'activity' (constant animation)
  const [animMode, setAnimMode] = useState('live')
  const animModeRef = useRef(animMode)
  useEffect(() => { animModeRef.current = animMode }, [animMode])

  // Hover state for tooltip and highlight
  const [hoveredArcGroup, setHoveredArcGroup] = useState(null)
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 })
  const hoveredArcGroupRef = useRef(null)

  // Refs for animation loop access
  const connectionsRef = useRef(connections)
  const arcGroupsRef = useRef(arcGroups)
  const selectedArcGroupRef = useRef(selectedArcGroup)
  const selectedConnectionRef = useRef(selectedConnection)
  const packetEventsRef = useRef(packetEvents)
  const homeLocationRef = useRef(homeLocation)
  // Ref to access onSelectArcGroup in event handlers
  const onSelectArcGroupRef = useRef(onSelectArcGroup)
  useEffect(() => { onSelectArcGroupRef.current = onSelectArcGroup }, [onSelectArcGroup])

  useEffect(() => { connectionsRef.current = connections }, [connections])
  useEffect(() => { arcGroupsRef.current = arcGroups }, [arcGroups])
  useEffect(() => { selectedArcGroupRef.current = selectedArcGroup }, [selectedArcGroup])
  useEffect(() => { selectedConnectionRef.current = selectedConnection }, [selectedConnection])
  useEffect(() => { packetEventsRef.current = packetEvents }, [packetEvents])
  useEffect(() => { homeLocationRef.current = homeLocation }, [homeLocation])

  // Go to home location (or reset view if no home set)
  const goHome = useCallback(() => {
    if (controlsRef.current) {
      const home = homeLocationRef.current
      if (home) {
        // Rotate globe to center on home location
        // Longitude maps to Y rotation (horizontal spin)
        // Latitude maps to X rotation (tilt) - but we keep tilt minimal for usability
        const lonRad = (home.lon * Math.PI) / 180
        controlsRef.current.targetRotationY = -lonRad
        controlsRef.current.targetRotationX = 0  // Keep level for better UX
        controlsRef.current.targetZoom = 2.2  // Zoom in a bit
      } else {
        // No home location - reset to default
        controlsRef.current.targetRotationX = 0
        controlsRef.current.targetRotationY = 0
        controlsRef.current.targetZoom = 2.8
      }
    }
  }, [])

  // Initialize scene
  useEffect(() => {
    if (!containerRef.current) return

    const container = containerRef.current
    const w = container.clientWidth
    const h = container.clientHeight

    // Scene
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x0a0a0a)
    sceneRef.current = scene

    // Camera
    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100)
    camera.position.z = 2.8
    cameraRef.current = camera

    // Renderer
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance', // Request dedicated GPU
      stencil: false,  // We don't use stencil buffer
    })
    renderer.setSize(w, h)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    container.appendChild(renderer.domElement)
    rendererRef.current = renderer

    // Lighting - brighter for better visibility
    const ambient = new THREE.AmbientLight(0xffffff, 1.2)
    scene.add(ambient)

    const directional = new THREE.DirectionalLight(0xffffff, 0.6)
    directional.position.set(5, 3, 5)
    scene.add(directional)

    const directional2 = new THREE.DirectionalLight(0xffffff, 0.4)
    directional2.position.set(-5, -2, -5)
    scene.add(directional2)

    // Globe - use BasicMaterial for consistent brightness like 2D map
    const textureLoader = new THREE.TextureLoader()
    const earthTexture = textureLoader.load(
      'https://unpkg.com/three-globe@2.31.0/example/img/earth-blue-marble.jpg'
    )
    earthTexture.colorSpace = THREE.SRGBColorSpace

    const globeGeometry = new THREE.SphereGeometry(1, 64, 64)
    const globeMaterial = new THREE.MeshBasicMaterial({
      map: earthTexture,
    })
    const globe = new THREE.Mesh(globeGeometry, globeMaterial)
    scene.add(globe)
    globeRef.current = globe

    // Atmosphere (subtle)
    const atmosphereGeometry = new THREE.SphereGeometry(1.02, 64, 64)
    const atmosphereMaterial = new THREE.MeshBasicMaterial({
      color: 0x3b82f6,
      transparent: true,
      opacity: 0.05,
      side: THREE.BackSide,
    })
    scene.add(new THREE.Mesh(atmosphereGeometry, atmosphereMaterial))

    // Groups for dynamic content
    const arcsGroup = new THREE.Group()
    const nodesGroup = new THREE.Group()
    const packetsGroup = new THREE.Group()
    scene.add(arcsGroup)
    scene.add(nodesGroup)
    scene.add(packetsGroup)
    arcsGroupRef.current = arcsGroup
    nodesGroupRef.current = nodesGroup
    packetsGroupRef.current = packetsGroup

    // Controls - store in ref for external access
    const controls = {
      isDragging: false,
      previousX: 0,
      previousY: 0,
      rotationY: 0,
      rotationX: 0,
      targetRotationY: 0,
      targetRotationX: 0,
      zoom: 2.8,
      targetZoom: 2.8,
      dragDist: 0,  // Track drag distance to distinguish click vs drag
    }
    controlsRef.current = controls

    const onMouseDown = (e) => {
      controls.isDragging = true
      controls.dragDist = 0
      controls.previousX = e.clientX
      controls.previousY = e.clientY
    }

    const onMouseUp = (e) => {
      const wasDragging = controls.isDragging
      controls.isDragging = false

      // If barely moved, treat as click
      if (wasDragging && controls.dragDist < 5) {
        handleClick(e)
      }
    }

    const onMouseMove = (e) => {
      if (!controls.isDragging) return
      const deltaX = e.clientX - controls.previousX
      const deltaY = e.clientY - controls.previousY
      controls.dragDist += Math.abs(deltaX) + Math.abs(deltaY)
      controls.targetRotationY += deltaX * 0.005
      controls.targetRotationX += deltaY * 0.005
      controls.previousX = e.clientX
      controls.previousY = e.clientY
    }

    const onWheel = (e) => {
      e.preventDefault()
      controls.targetZoom = Math.max(1.5, Math.min(6, controls.targetZoom + e.deltaY * 0.002))
    }

    // Click handler with raycasting for arc selection
    const handleClick = (e) => {
      const rect = container.getBoundingClientRect()
      const mouse = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      )

      const raycaster = raycasterRef.current
      raycaster.setFromCamera(mouse, camera)

      // Check intersections with arcs and nodes
      const arcsGroup = arcsGroupRef.current
      const nodesGroup = nodesGroupRef.current
      const arcGroupMap = arcGroupMapRef.current

      if (arcsGroup && nodesGroup) {
        // Check nodes first (easier to click)
        const nodeIntersects = raycaster.intersectObjects(nodesGroup.children, false)
        if (nodeIntersects.length > 0) {
          const hit = nodeIntersects[0].object
          const group = arcGroupMap.get(hit.uuid)
          if (group && onSelectArcGroupRef.current) {
            onSelectArcGroupRef.current(group)
            return
          }
        }

        // Check arcs
        const arcIntersects = raycaster.intersectObjects(arcsGroup.children, false)
        if (arcIntersects.length > 0) {
          const hit = arcIntersects[0].object
          const group = arcGroupMap.get(hit.uuid)
          if (group && onSelectArcGroupRef.current) {
            onSelectArcGroupRef.current(group)
            return
          }
        }
      }

      // Clicked on empty space - deselect
      if (onSelectArcGroupRef.current) {
        onSelectArcGroupRef.current(null)
      }
    }

    // Hover handler for cursor feedback and tooltip (throttled)
    let lastHoverCheck = 0
    const onMouseMoveHover = (e) => {
      // Throttle to every 50ms
      const now = Date.now()
      if (now - lastHoverCheck < 50) return
      lastHoverCheck = now

      // Skip during drag
      if (controls.isDragging) {
        container.style.cursor = 'grabbing'
        return
      }

      const rect = container.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top
      const mouse = new THREE.Vector2(
        (mouseX / rect.width) * 2 - 1,
        -(mouseY / rect.height) * 2 + 1
      )

      const raycaster = raycasterRef.current
      raycaster.setFromCamera(mouse, camera)

      const arcsGroup = arcsGroupRef.current
      const nodesGroup = nodesGroupRef.current
      const arcGroupMap = arcGroupMapRef.current

      let hitGroup = null

      if (arcsGroup && nodesGroup) {
        // Check nodes first
        const nodeIntersects = raycaster.intersectObjects(nodesGroup.children, false)
        if (nodeIntersects.length > 0) {
          const hit = nodeIntersects[0].object
          hitGroup = arcGroupMap.get(hit.uuid)
        }

        // Check arcs if no node hit
        if (!hitGroup) {
          const arcIntersects = raycaster.intersectObjects(arcsGroup.children, false)
          if (arcIntersects.length > 0) {
            const hit = arcIntersects[0].object
            hitGroup = arcGroupMap.get(hit.uuid)
          }
        }
      }

      // Update hover state
      if (hitGroup?.key !== hoveredArcGroupRef.current?.key) {
        hoveredArcGroupRef.current = hitGroup
        setHoveredArcGroup(hitGroup)
      }

      // Update tooltip position
      if (hitGroup) {
        setTooltipPos({ x: mouseX, y: mouseY })
        container.style.cursor = 'pointer'
      } else {
        container.style.cursor = 'grab'
      }
    }

    // Named handlers for proper cleanup
    const onMouseLeave = () => {
      controls.isDragging = false
      container.style.cursor = 'grab'
      hoveredArcGroupRef.current = null
      setHoveredArcGroup(null)
    }

    const onMouseMoveAll = (e) => {
      onMouseMove(e)
      onMouseMoveHover(e)
    }

    container.addEventListener('mousedown', onMouseDown)
    container.addEventListener('mouseup', onMouseUp)
    container.addEventListener('mouseleave', onMouseLeave)
    container.addEventListener('mousemove', onMouseMoveAll)
    container.addEventListener('wheel', onWheel, { passive: false })

    // Shared geometry for packet spheres
    const packetGeometry = new THREE.SphereGeometry(0.015, 8, 8)
    const packetMaterial = new THREE.MeshBasicMaterial({ color: 0x22d3ee })

    // Animation loop
    const animate = () => {
      frameRef.current = requestAnimationFrame(animate)
      timeRef.current = Date.now()

      // Smooth rotation
      controls.rotationY += (controls.targetRotationY - controls.rotationY) * 0.1
      controls.rotationX += (controls.targetRotationX - controls.rotationX) * 0.1

      globe.rotation.y = controls.rotationY
      globe.rotation.x = controls.rotationX
      arcsGroup.rotation.y = controls.rotationY
      arcsGroup.rotation.x = controls.rotationX
      nodesGroup.rotation.y = controls.rotationY
      nodesGroup.rotation.x = controls.rotationX
      packetsGroup.rotation.y = controls.rotationY
      packetsGroup.rotation.x = controls.rotationX

      // Smooth zoom
      controls.zoom += (controls.targetZoom - controls.zoom) * 0.1
      camera.position.z = controls.zoom

      // Animate packets
      const now = timeRef.current
      const realNow = Date.now()
      const PACKET_DURATION = 800 // 0.8 seconds for snappy packet travel
      const currentAnimMode = animModeRef.current
      const currentPacketEvents = packetEventsRef.current
      const currentHomeLocation = homeLocationRef.current
      const curvesMap = curvesMapRef.current

      // Clear old packets
      while (packetsGroup.children.length > 0) {
        packetsGroup.remove(packetsGroup.children[0])
      }

      if (currentAnimMode === 'live') {
        // Live mode: animate packets from real events
        currentPacketEvents.forEach(event => {
          const homeGeo = currentHomeLocation ? { lat: currentHomeLocation.lat, lon: currentHomeLocation.lon } : null
          // Get geo, but treat pending (null lat/lon) as missing
          const rawSrcGeo = event.src_geo
          const rawDstGeo = event.dst_geo
          const srcGeo = (rawSrcGeo && rawSrcGeo.lat != null && rawSrcGeo.lon != null) ? rawSrcGeo : homeGeo
          const dstGeo = (rawDstGeo && rawDstGeo.lat != null && rawDstGeo.lon != null) ? rawDstGeo : homeGeo

          if (!srcGeo || !dstGeo) return
          if (!event.src_geo && !event.dst_geo) return

          const age = realNow - event.timestamp
          if (age > PACKET_DURATION || age < 0) return

          const curveKey = `${srcGeo.lat.toFixed(2)},${srcGeo.lon.toFixed(2)}-${dstGeo.lat.toFixed(2)},${dstGeo.lon.toFixed(2)}`
          let curve = curvesMap.get(curveKey)
          if (!curve) {
            curve = createArcCurve(srcGeo.lat, srcGeo.lon, dstGeo.lat, dstGeo.lon)
            curvesMap.set(curveKey, curve)
          }

          const progress = age / PACKET_DURATION
          const t = 1 - Math.pow(1 - progress, 2)
          const point = curve.getPointAt(Math.min(1, Math.max(0, t)))

          const packet = new THREE.Mesh(packetGeometry, packetMaterial.clone())
          packet.position.copy(point)
          packet.material.transparent = true
          packet.material.opacity = progress < 0.8 ? 1 : 1 - (progress - 0.8) / 0.2
          packetsGroup.add(packet)
        })
      } else {
        // Activity mode: constant bidirectional animation on all arc groups
        const cycleTime = 2500
        const currentArcGroups = arcGroupsRef.current

        // Materials for outgoing (cyan) and incoming (orange) packets
        const outgoingMaterial = new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true })
        const incomingMaterial = new THREE.MeshBasicMaterial({ color: 0xfb923c, transparent: true })

        currentArcGroups.forEach((group, idx) => {
          const srcGeo = group.srcGeo
          const dstGeo = group.dstGeo

          if (!srcGeo || !dstGeo) return

          const curveKey = `${srcGeo.lat.toFixed(2)},${srcGeo.lon.toFixed(2)}-${dstGeo.lat.toFixed(2)},${dstGeo.lon.toFixed(2)}`
          let curve = curvesMap.get(curveKey)
          if (!curve) {
            curve = createArcCurve(srcGeo.lat, srcGeo.lon, dstGeo.lat, dstGeo.lon)
            curvesMap.set(curveKey, curve)
          }

          // Stagger animation by arc group index
          const offset = (idx * 0.17) % 1

          // Calculate fade based on position (fade at endpoints)
          const calcOpacity = (t) => {
            if (t < 0.1) return t / 0.1  // Fade in at start
            if (t > 0.9) return (1 - t) / 0.1  // Fade out at end
            return 1
          }

          // Outgoing packet (src → dst)
          const t1 = ((now / cycleTime + offset) % 1)
          const point1 = curve.getPointAt(t1)
          const packet1 = new THREE.Mesh(packetGeometry, outgoingMaterial.clone())
          packet1.position.copy(point1)
          packet1.material.opacity = calcOpacity(t1)
          packetsGroup.add(packet1)

          // Incoming packet (dst → src) - offset by 0.5 cycle, different color
          const t2 = ((now / cycleTime + offset + 0.5) % 1)
          const point2 = curve.getPointAt(1 - t2)
          const packet2 = new THREE.Mesh(packetGeometry, incomingMaterial.clone())
          packet2.position.copy(point2)
          packet2.material.opacity = calcOpacity(t2)
          packetsGroup.add(packet2)
        })
      }

      renderer.render(scene, camera)
    }
    animate()

    // Resize handler
    const handleResize = () => {
      const w = container.clientWidth
      const h = container.clientHeight
      if (w === 0 || h === 0) return
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
    }

    const resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(container)

    // Cleanup
    return () => {
      cancelAnimationFrame(frameRef.current)
      resizeObserver.disconnect()
      container.removeEventListener('mousedown', onMouseDown)
      container.removeEventListener('mouseup', onMouseUp)
      container.removeEventListener('mouseleave', onMouseLeave)
      container.removeEventListener('mousemove', onMouseMoveAll)
      container.removeEventListener('wheel', onWheel)
      // Clear curve cache to prevent memory leak
      curvesMapRef.current.clear()
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement)
      }
      renderer.dispose()
    }
  }, [])

  // Update arcs and nodes when arc groups or hover changes
  useEffect(() => {
    const arcsGroup = arcsGroupRef.current
    const nodesGroup = nodesGroupRef.current
    const arcGroupMap = arcGroupMapRef.current
    if (!arcsGroup || !nodesGroup) return

    // Clear existing
    while (arcsGroup.children.length) {
      arcsGroup.remove(arcsGroup.children[0])
    }
    while (nodesGroup.children.length) {
      nodesGroup.remove(nodesGroup.children[0])
    }
    arcGroupMap.clear()

    const addedNodes = new Set()
    const hasSelection = selectedArcGroup !== null || selectedConnection !== null

    arcGroups.forEach((group) => {
      const srcGeo = group.srcGeo
      const dstGeo = group.dstGeo
      if (!srcGeo || !dstGeo) return

      // Arc is selected if: arc group is selected OR selected connection is in this group
      const isSelectedByArcGroup = selectedArcGroup?.key === group.key
      const isSelectedByConnection = selectedConnection && group.connections?.some(c => c.id === selectedConnection.id)
      const isSelected = isSelectedByArcGroup || isSelectedByConnection
      const isHovered = hoveredArcGroup?.key === group.key && !isSelected

      // Colors: selected = blue, hovered = cyan, default = gray
      let arcColor, arcOpacity
      if (isSelected) {
        arcColor = 0x3b82f6  // Blue
        arcOpacity = 1
      } else if (isHovered) {
        arcColor = 0x22d3ee  // Cyan
        arcOpacity = 0.9
      } else if (hasSelection) {
        arcColor = 0x333333  // Dimmed
        arcOpacity = 0.2
      } else {
        arcColor = 0x525252  // Default gray
        arcOpacity = 0.7
      }

      // Create arc curve
      const curve = createArcCurve(srcGeo.lat, srcGeo.lon, dstGeo.lat, dstGeo.lon)

      // Thicker tubes for easier click detection
      const tubeRadius = isSelected ? 0.008 : (isHovered ? 0.007 : 0.006)

      // Selected or hovered arc gets a glow effect
      if (isSelected || isHovered) {
        const glowColor = isSelected ? 0x3b82f6 : 0x06b6d4
        const innerColor = isSelected ? 0x60a5fa : 0x22d3ee

        const glowGeometry = new THREE.TubeGeometry(curve, 32, tubeRadius * 2.5, 8, false)
        const glowMaterial = new THREE.MeshBasicMaterial({
          color: glowColor,
          transparent: true,
          opacity: isSelected ? 0.3 : 0.25,
        })
        const glowMesh = new THREE.Mesh(glowGeometry, glowMaterial)
        arcsGroup.add(glowMesh)
        arcGroupMap.set(glowMesh.uuid, group)

        const innerGeometry = new THREE.TubeGeometry(curve, 32, tubeRadius, 8, false)
        const innerMaterial = new THREE.MeshBasicMaterial({
          color: innerColor,
          transparent: true,
          opacity: 1,
        })
        const innerMesh = new THREE.Mesh(innerGeometry, innerMaterial)
        arcsGroup.add(innerMesh)
        arcGroupMap.set(innerMesh.uuid, group)
      } else {
        const tubeGeometry = new THREE.TubeGeometry(curve, 32, tubeRadius, 8, false)
        const material = new THREE.MeshBasicMaterial({
          color: arcColor,
          transparent: true,
          opacity: arcOpacity,
        })
        const mesh = new THREE.Mesh(tubeGeometry, material)
        arcsGroup.add(mesh)
        arcGroupMap.set(mesh.uuid, group)
      }

      // Add nodes - make them bigger for easier clicking
      const addNode = (geo, key, isEndpoint) => {
        if (!geo || addedNodes.has(key)) return
        addedNodes.add(key)

        const pos = latLonToVector3(geo.lat, geo.lon, 1.01)
        const isHome = geo.isHome || (homeLocation &&
          Math.abs(geo.lat - homeLocation.lat) < 0.1 &&
          Math.abs(geo.lon - homeLocation.lon) < 0.1)
        // Bigger nodes for easier clicking, even bigger when hovered
        const size = isEndpoint && isSelected ? 0.035 : (isEndpoint && isHovered ? 0.032 : (isHome ? 0.03 : 0.025))

        let nodeColor
        if (isHome) {
          nodeColor = isEndpoint && isSelected ? 0x4ade80 : 0x22c55e
        } else if (geo.unknown) {
          nodeColor = isEndpoint && isSelected ? 0xf87171 : 0xef4444
        } else if (isEndpoint && isHovered) {
          nodeColor = 0x22d3ee  // Cyan for hovered
        } else {
          nodeColor = isEndpoint && isSelected ? 0x60a5fa : (hasSelection && !isSelected ? 0x333333 : 0x3b82f6)
        }

        const nodeGeometry = new THREE.SphereGeometry(size, 16, 16)
        const nodeMaterial = new THREE.MeshBasicMaterial({ color: nodeColor })
        const node = new THREE.Mesh(nodeGeometry, nodeMaterial)
        node.position.copy(pos)
        nodesGroup.add(node)
        arcGroupMap.set(node.uuid, group)

        // Add glow ring for selected/hovered endpoints or home
        if ((isEndpoint && (isSelected || isHovered)) || isHome) {
          const ringSize = isHome ? 0.045 : 0.04
          let ringColor
          if (isHome) {
            ringColor = 0x22c55e
          } else if (isHovered) {
            ringColor = 0x06b6d4  // Cyan for hover
          } else if (geo.unknown) {
            ringColor = 0xef4444
          } else {
            ringColor = 0x3b82f6
          }

          const ringGeo = new THREE.RingGeometry(ringSize, ringSize + 0.01, 32)
          const ringMat = new THREE.MeshBasicMaterial({
            color: ringColor,
            transparent: true,
            opacity: 0.5,
            side: THREE.DoubleSide,
          })
          const ring = new THREE.Mesh(ringGeo, ringMat)
          ring.position.copy(pos)
          ring.lookAt(0, 0, 0)
          nodesGroup.add(ring)
          arcGroupMap.set(ring.uuid, group)
        }
      }

      const isEndpointOfSelectedOrHovered = isSelected || isHovered
      addNode(srcGeo, `${srcGeo.lat}-${srcGeo.lon}`, isEndpointOfSelectedOrHovered)
      addNode(dstGeo, `${dstGeo.lat}-${dstGeo.lon}`, isEndpointOfSelectedOrHovered)
    })
  }, [arcGroups, selectedArcGroup, selectedConnection, homeLocation, hoveredArcGroup])

  return (
    <div className="w-full h-full relative">
      <div
        ref={containerRef}
        className="w-full h-full"
        style={{ cursor: 'grab' }}
      />

      {/* Animation mode toggle */}
      <div className="absolute top-3 right-3 flex bg-[#141414] border border-[#262626] rounded-md overflow-hidden">
        <button
          onClick={() => setAnimMode('live')}
          className={`px-2.5 py-1.5 flex items-center gap-1.5 text-xs font-medium transition-colors ${
            animMode === 'live'
              ? 'bg-cyan-500/20 text-cyan-400'
              : 'text-[#a1a1a1] hover:text-[#fafafa] hover:bg-[#1a1a1a]'
          }`}
          title="Live mode - show packets as they arrive"
        >
          <Radio className="w-3.5 h-3.5" />
          Live
        </button>
        <button
          onClick={() => setAnimMode('activity')}
          className={`px-2.5 py-1.5 flex items-center gap-1.5 text-xs font-medium transition-colors ${
            animMode === 'activity'
              ? 'bg-cyan-500/20 text-cyan-400'
              : 'text-[#a1a1a1] hover:text-[#fafafa] hover:bg-[#1a1a1a]'
          }`}
          title="Activity mode - constant animation on all connections"
        >
          <Activity className="w-3.5 h-3.5" />
          Activity
        </button>
      </div>

      {/* Home button */}
      <button
        onClick={goHome}
        className="absolute bottom-3 right-3 p-2 bg-[#141414] border border-[#262626] rounded-md text-[#a1a1a1] hover:text-[#fafafa] hover:bg-[#1a1a1a] transition-colors"
        title="Go to home location"
      >
        <Home className="w-4 h-4" />
      </button>

      {/* Hover tooltip */}
      {hoveredArcGroup && (
        <div
          className="absolute pointer-events-none z-20"
          style={{
            left: Math.min(tooltipPos.x + 16, (containerRef.current?.clientWidth || 400) - 200),
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
    </div>
  )
}

// Helper to format bytes
function formatBytes(bytes) {
  if (!bytes) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}
