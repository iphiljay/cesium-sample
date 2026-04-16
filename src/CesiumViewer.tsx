import { useEffect, useRef, useState, useCallback, useId } from 'react'
import {
  Viewer,
  Ion,
  Cartesian3,
  Cartesian2,
  Color,
  Math as CesiumMath,
  EllipsoidTerrainProvider,
  CesiumTerrainProvider,
  UrlTemplateImageryProvider,
  ArcGisMapServerImageryProvider,
  ImageryLayer,
  Cesium3DTileset,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  HeightReference,
  LabelStyle,
  Cartographic,
  GeoJsonDataSource,
  KmlDataSource,
  CustomDataSource,
  ColorMaterialProperty,
  ConstantProperty,
  HeadingPitchRange,
  PointPrimitiveCollection,
  SingleTileImageryProvider,
  Rectangle,
} from 'cesium'
import shp from 'shpjs'
import { fromArrayBuffer as tiffFromArrayBuffer } from 'geotiff'
import DxfParser from 'dxf-parser'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import './CesiumViewer.css'

interface Coords {
  lat: number | null
  lon: number | null
  alt: number | null
}

type LayerKind = 'vector' | 'raster' | 'pointcloud'

type LayerRef =
  | { kind: 'vector';     ds: GeoJsonDataSource | KmlDataSource | CustomDataSource }
  | { kind: 'raster';     imageryLayer: ImageryLayer; bounds: [number, number, number, number] }
  | { kind: 'pointcloud'; pts: PointPrimitiveCollection; center: [number, number, number] }

interface SpatialLayer {
  id: string
  name: string
  format: string
  kind: LayerKind
  color: string
  visible: boolean
  info: string
}

interface BasemapDef {
  id: string
  label: string
  url?: string
  arcgisUrl?: string
  overlayArcgisUrl?: string
  credit: string
  maxZoom?: number
}

interface DxfVertex { x: number; y: number }
interface DxfEntity {
  type: string
  vertices?: DxfVertex[]
  shape?: boolean
  closed?: boolean
  position?: DxfVertex
  center?: DxfVertex
  radius?: number
  text?: string
  startPoint?: DxfVertex
}
interface DxfData {
  header?: Record<string, DxfVertex>
  entities?: DxfEntity[]
}

const FLY_LOCATIONS = [
  { name: 'Philippines', lon: 122.0, lat: 12.0, alt: 2_800_000 },
  { name: 'Metro Manila', lon: 121.0, lat: 14.6, alt: 100_000 },
]

const DEFAULT_VIEW = { lon: 122.0, lat: 12.0, alt: 2_800_000 }

const BASEMAPS: BasemapDef[] = [
  { id: 'osm',          label: 'Standard',   url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',                                           credit: '© OpenStreetMap contributors', maxZoom: 19 },
  { id: 'esri-imagery', label: 'Satellite',  arcgisUrl: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer', overlayArcgisUrl: 'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer', credit: 'Esri, Maxar, GeoEye' },
  { id: 'google-3d',    label: 'Google 3D',  credit: 'Google' },
]

const PALETTE = ['#4d96ff', '#6bcb77', '#ffd93d', '#ff922b', '#cc5de8', '#38d9a9', '#f06595', '#ff6b6b']

export default function CesiumViewer() {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef    = useRef<Viewer | null>(null)
  const handlerRef   = useRef<ScreenSpaceEventHandler | null>(null)
  const buildingsRef    = useRef<Cesium3DTileset | null>(null)
  const googleTilesRef  = useRef<Cesium3DTileset | null>(null)
  const layerRefsRef    = useRef<Map<string, LayerRef>>(new Map())
  const fileInputRef    = useRef<HTMLInputElement>(null)

  const ENV_TOKEN    = import.meta.env.VITE_CESIUM_ION_TOKEN    as string | undefined
  const GOOGLE_KEY   = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined

  const [coords, setCoords]             = useState<Coords>({ lat: null, lon: null, alt: null })
  const [tokenApplied, setTokenApplied] = useState(false)
  const [toast, setToast]               = useState('')
  const [buildingsOn, setBuildingsOn]   = useState(false)
  const [terrainOn, setTerrainOn]       = useState(false)
  const [lightingOn, setLightingOn]     = useState(false)
  const [depthTest, setDepthTest]       = useState(false)
  const [activeBasemap, setActiveBasemap]   = useState('osm')
  const [basemapLoading, setBasemapLoading] = useState(false)
  const [spatialLayers, setSpatialLayers]   = useState<SpatialLayer[]>([])
  const [isDragging, setIsDragging]         = useState(false)

  const dropId = useId()

  const showToast = useCallback((msg: string, duration = 3000) => {
    setToast(msg)
    setTimeout(() => setToast(''), duration)
  }, [])

  useEffect(() => {
    if (ENV_TOKEN && ENV_TOKEN !== 'PASTE_YOUR_NEW_TOKEN_HERE') {
      Ion.defaultAccessToken = ENV_TOKEN
      setTokenApplied(true)
    }
  }, [ENV_TOKEN])

  useEffect(() => {
    if (!containerRef.current || viewerRef.current) return

    const viewer = new Viewer(containerRef.current, {
      baseLayerPicker:       false,
      timeline:              false,
      animation:             false,
      homeButton:            false,
      geocoder:              true,
      sceneModePicker:       true,
      navigationHelpButton:  true,
      fullscreenButton:      false,
      infoBox:               true,
      selectionIndicator:    true,
      terrainProvider:       new EllipsoidTerrainProvider(),
    })

    viewer.imageryLayers.removeAll()
    viewer.imageryLayers.addImageryProvider(
      new UrlTemplateImageryProvider({
        url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        credit: '© OpenStreetMap contributors',
        maximumLevel: 19,
      })
    )

    viewer.scene.globe.enableLighting = false
    viewer.camera.setView({
      destination: Cartesian3.fromDegrees(DEFAULT_VIEW.lon, DEFAULT_VIEW.lat, DEFAULT_VIEW.alt),
    })

    viewerRef.current = viewer

    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas)
    handler.setInputAction((evt: { endPosition: Cartesian2 }) => {
      const cartesian = viewer.camera.pickEllipsoid(evt.endPosition, viewer.scene.globe.ellipsoid)
      if (cartesian) {
        const carto = Cartographic.fromCartesian(cartesian)
        setCoords({
          lat: CesiumMath.toDegrees(carto.latitude),
          lon: CesiumMath.toDegrees(carto.longitude),
          alt: carto.height,
        })
      }
    }, ScreenSpaceEventType.MOUSE_MOVE)
    handlerRef.current = handler

    return () => {
      handler.destroy()
      handlerRef.current = null
      viewer.destroy()
      viewerRef.current = null
    }
  }, [])

  const flyTo = useCallback((loc: typeof FLY_LOCATIONS[0]) => {
    viewerRef.current?.camera.flyTo({
      destination: Cartesian3.fromDegrees(loc.lon, loc.lat, loc.alt),
      duration: 2.5,
    })
    showToast(`Flying to ${loc.name}…`)
  }, [showToast])

  const toggleBuildings = useCallback(async () => {
    const viewer = viewerRef.current
    if (!viewer) return

    if (buildingsOn) {
      if (buildingsRef.current) {
        viewer.scene.primitives.remove(buildingsRef.current)
        buildingsRef.current = null
      }
      viewer.scene.globe.depthTestAgainstTerrain = false
      setBuildingsOn(false)
      showToast('3D Buildings removed.')
      return
    }

    if (!tokenApplied) {
      showToast('⚠ No Cesium Ion token found in .env.local', 4000)
      return
    }

    try {
      if (!terrainOn) {
        showToast('Enabling World Terrain first…', 5000)
        const terrain = await CesiumTerrainProvider.fromIonAssetId(1)
        viewer.terrainProvider = terrain
        setTerrainOn(true)
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      viewer.scene.globe.depthTestAgainstTerrain = true
      setDepthTest(true)
      showToast('Loading 3D Buildings…', 8000)
      const tileset = await Cesium3DTileset.fromIonAssetId(96188)
      viewer.scene.primitives.add(tileset)
      buildingsRef.current = tileset
      setBuildingsOn(true)
      showToast('3D OSM Buildings loaded!')
    } catch {
      showToast('Failed to load 3D Buildings.', 4000)
    }
  }, [buildingsOn, terrainOn, tokenApplied, showToast])

  const toggleTerrain = useCallback(async () => {
    const viewer = viewerRef.current
    if (!viewer) return

    if (terrainOn) {
      if (buildingsRef.current) {
        viewer.scene.primitives.remove(buildingsRef.current)
        buildingsRef.current = null
        setBuildingsOn(false)
      }
      viewer.terrainProvider = new EllipsoidTerrainProvider()
      setTerrainOn(false)
      showToast('Flat terrain restored. 3D Buildings removed.')
      return
    }

    if (!tokenApplied) {
      showToast('⚠ No Cesium Ion token found in .env.local', 4000)
      return
    }

    try {
      showToast('Loading World Terrain…', 6000)
      const terrain = await CesiumTerrainProvider.fromIonAssetId(1)
      viewer.terrainProvider = terrain
      setTerrainOn(true)
      showToast('World Terrain enabled!')
    } catch {
      showToast('Failed to load terrain.', 4000)
    }
  }, [terrainOn, tokenApplied, showToast])

  const toggleLighting = useCallback(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    const next = !lightingOn
    viewer.scene.globe.enableLighting = next
    setLightingOn(next)
    showToast(next ? 'Sun lighting enabled.' : 'Lighting disabled.')
  }, [lightingOn, showToast])

  const toggleDepthTest = useCallback(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    const next = !depthTest
    viewer.scene.globe.depthTestAgainstTerrain = next
    setDepthTest(next)
    showToast(next ? 'Depth test enabled.' : 'Depth test disabled.')
  }, [depthTest, showToast])

  const restoreGlobe = useCallback((viewer: Viewer) => {
    if (googleTilesRef.current) {
      viewer.scene.primitives.remove(googleTilesRef.current)
      googleTilesRef.current = null
    }
    viewer.scene.globe.show = true
    viewer.scene.fog.enabled = false
    if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = true
    viewer.scene.screenSpaceCameraController.minimumZoomDistance = 1
    viewer.scene.screenSpaceCameraController.maximumZoomDistance = Infinity
  }, [])

  const switchBasemap = useCallback(async (def: BasemapDef) => {
    const viewer = viewerRef.current
    if (!viewer || basemapLoading) return

    // Switching away from Google 3D — restore globe first
    if (activeBasemap === 'google-3d' && def.id !== 'google-3d') {
      restoreGlobe(viewer)
    }

    // Google Photorealistic 3D Tiles — uses official Cesium helper (added Cesium 1.111)
    if (def.id === 'google-3d') {
      const key = GOOGLE_KEY?.trim()
      if (!key) { showToast('⚠ Add VITE_GOOGLE_MAPS_API_KEY to .env.local', 4000); return }
      setBasemapLoading(true)
      try {
        showToast('Loading Google Photorealistic 3D Tiles…', 10000)
        // Hide globe so Google tiles render without occlusion
        viewer.scene.globe.show = false
        if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = false
        viewer.scene.fog.enabled = true
        viewer.scene.fog.density = 2e-4
        viewer.scene.fog.minimumBrightness = 0.3

        // Load Google tiles directly — gives full control over tileset options
        const tileset = await Cesium3DTileset.fromUrl(
          `https://tile.googleapis.com/v1/3dtiles/root.json?key=${key}`,
          { showCreditsOnScreen: true, maximumScreenSpaceError: 8, skipLevelOfDetail: false }
        )
        viewer.scene.primitives.add(tileset)
        googleTilesRef.current = tileset

        // Allow full navigation — no zoom cap
        viewer.scene.screenSpaceCameraController.minimumZoomDistance = 50
        viewer.scene.screenSpaceCameraController.maximumZoomDistance = Infinity

        // Street-level view in Shinjuku, Tokyo — dense skyscrapers show 3D clearly
        viewer.camera.flyTo({
          destination: Cartesian3.fromDegrees(139.74505, 35.65887, 150),
          orientation: { heading: CesiumMath.toRadians(30), pitch: CesiumMath.toRadians(-18), roll: 0 },
          duration: 3,
          maximumHeight: 5000,
        })
        setActiveBasemap('google-3d')
        showToast('Google 3D active — Shinjuku, Tokyo. Right-drag to tilt, scroll to zoom.', 6000)
      } catch (e: unknown) {
        console.error('[Google 3D Tiles]', e)
        restoreGlobe(viewer)
        const msg = e instanceof Error ? e.message : String(e)
        const s = msg.match(/\b(4\d\d|5\d\d)\b/)?.[0]
        if (s === '403')      showToast('⚠ Google 403: check API key restrictions in Cloud Console.', 8000)
        else if (s === '400') showToast('⚠ Google 400: add Map Tiles API to key\'s API restrictions.', 8000)
        else                  showToast(`⚠ Google 3D Tiles failed: ${msg.slice(0, 80)}`, 8000)
      } finally {
        setBasemapLoading(false)
      }
      return
    }

    // Standard imagery basemap
    setBasemapLoading(true)
    try {
      viewer.imageryLayers.removeAll()
      let provider
      if (def.arcgisUrl) {
        provider = await ArcGisMapServerImageryProvider.fromUrl(def.arcgisUrl, { enablePickFeatures: false })
      } else if (def.url) {
        provider = new UrlTemplateImageryProvider({ url: def.url, credit: def.credit, maximumLevel: def.maxZoom ?? 19 })
      }
      if (provider) {
        viewer.imageryLayers.addImageryProvider(provider)
        if (def.overlayArcgisUrl) {
          const overlay = await ArcGisMapServerImageryProvider.fromUrl(def.overlayArcgisUrl, { enablePickFeatures: false })
          viewer.imageryLayers.addImageryProvider(overlay)
        }
        setActiveBasemap(def.id)
        showToast(`Basemap: ${def.label}`)
      }
    } catch (err) {
      console.error('[Basemap error]', err)
      showToast(`Failed to load "${def.label}".`, 4000)
    } finally {
      setBasemapLoading(false)
    }
  }, [basemapLoading, activeBasemap, GOOGLE_KEY, restoreGlobe, showToast])

  const nextColor = () => PALETTE[layerRefsRef.current.size % PALETTE.length]

  const applyColorToSource = useCallback(
    (ds: GeoJsonDataSource | KmlDataSource | CustomDataSource, hex: string) => {
      const fill = Color.fromCssColorString(hex)
      const outline = fill.darken(0.3, new Color())
      ds.entities.values.forEach(entity => {
        if (entity.polygon) {
          entity.polygon.material = new ColorMaterialProperty(fill.withAlpha(0.5))
          entity.polygon.outlineColor = new ConstantProperty(outline)
        }
        if (entity.polyline)  entity.polyline.material  = new ColorMaterialProperty(fill)
        if (entity.point) {
          entity.point.color        = new ConstantProperty(fill)
          entity.point.outlineColor = new ConstantProperty(outline)
        }
        if (entity.billboard) entity.billboard.color = new ConstantProperty(fill)
      })
    }, []
  )

  function firstCoord(geojson: { features?: { geometry?: { coordinates?: unknown } }[] }): [number, number] | null {
    const c0 = geojson.features?.[0]?.geometry?.coordinates
    if (!c0) return null
    let c: unknown = c0
    while (Array.isArray(c) && Array.isArray(c[0])) c = c[0]
    if (Array.isArray(c) && typeof c[0] === 'number') return c as [number, number]
    return null
  }

  function isProjected(lon: number, lat: number) {
    return Math.abs(lon) > 180 || Math.abs(lat) > 90
  }

  function fixEntities(ds: GeoJsonDataSource | KmlDataSource | CustomDataSource, cesColor?: Color) {
    ds.entities.values.forEach(e => {
      if (e.polygon) {
        e.polygon.heightReference = new ConstantProperty(HeightReference.CLAMP_TO_GROUND)
        e.polygon.outline          = new ConstantProperty(true)
        e.polygon.outlineWidth     = new ConstantProperty(3)
        if (cesColor) e.polygon.outlineColor = new ConstantProperty(cesColor.darken(0.2, new Color()))
      }
      if (e.polyline) {
        e.polyline.clampToGround = new ConstantProperty(true)
        e.polyline.width         = new ConstantProperty(3)
        if (cesColor) e.polyline.material = new ColorMaterialProperty(cesColor)
      }
      if (e.point) {
        e.point.heightReference          = new ConstantProperty(HeightReference.CLAMP_TO_GROUND)
        e.point.pixelSize                = new ConstantProperty(10)
        e.point.disableDepthTestDistance = new ConstantProperty(Number.POSITIVE_INFINITY)
      }
      if (e.billboard) {
        e.billboard.heightReference          = new ConstantProperty(HeightReference.CLAMP_TO_GROUND)
        e.billboard.disableDepthTestDistance = new ConstantProperty(Number.POSITIVE_INFINITY)
      }
      if (e.label) e.label.disableDepthTestDistance = new ConstantProperty(Number.POSITIVE_INFINITY)
    })
  }

  function registerVector(
    ds: GeoJsonDataSource | KmlDataSource | CustomDataSource,
    name: string, format: string, color: string, info: string
  ) {
    const viewer = viewerRef.current!
    viewer.dataSources.add(ds)
    viewer.flyTo(ds, { duration: 2, offset: new HeadingPitchRange(0, CesiumMath.toRadians(-45), 0) })
    const id = `${Date.now()}-${Math.random()}`
    layerRefsRef.current.set(id, { kind: 'vector', ds })
    setSpatialLayers(prev => [...prev, { id, name, format, kind: 'vector', color, visible: true, info }])
  }

  const loadGeoJson = useCallback(async (file: File) => {
    const viewer = viewerRef.current; if (!viewer) return
    try {
      showToast(`Loading ${file.name}…`, 6000)
      const geojson = JSON.parse(await file.text())
      const fc = firstCoord(geojson)
      if (fc && isProjected(fc[0], fc[1])) { showToast('⚠ Coordinates look projected. Convert to EPSG:4326.', 6000); return }
      const color = nextColor()
      const cesColor = Color.fromCssColorString(color)
      const ds = await GeoJsonDataSource.load(geojson, { stroke: cesColor, fill: cesColor.withAlpha(0.5), strokeWidth: 3, markerColor: cesColor, markerSize: 24 })
      ds.name = file.name
      fixEntities(ds, cesColor)
      registerVector(ds, file.name, 'GeoJSON', color, `${(geojson.features?.length ?? 0).toLocaleString()} features`)
      showToast(`GeoJSON loaded — ${(geojson.features?.length ?? 0).toLocaleString()} features`)
    } catch (e) { console.error(e); showToast('Failed to parse GeoJSON.', 5000) }
  }, [showToast])

  const loadKml = useCallback(async (file: File) => {
    const viewer = viewerRef.current; if (!viewer) return
    try {
      showToast(`Loading ${file.name}…`, 6000)
      const url = URL.createObjectURL(file)
      const ds = await KmlDataSource.load(url, { camera: viewer.camera, canvas: viewer.scene.canvas })
      URL.revokeObjectURL(url)
      ds.name = file.name
      fixEntities(ds)
      const fmt = file.name.toLowerCase().endsWith('.kmz') ? 'KMZ' : 'KML'
      registerVector(ds, file.name, fmt, '#4d96ff', `${ds.entities.values.length.toLocaleString()} features`)
      showToast(`${fmt} loaded — ${ds.entities.values.length.toLocaleString()} features`)
    } catch (e) { console.error(e); showToast('Failed to load KML/KMZ.', 5000) }
  }, [showToast])

  const loadShapefile = useCallback(async (file: File) => {
    const viewer = viewerRef.current; if (!viewer) return
    try {
      showToast(`Parsing ${file.name}…`, 8000)
      const raw = await shp(await file.arrayBuffer())
      const collections = Array.isArray(raw) ? raw : [raw]
      const baseName = file.name.replace(/\.(zip|shp)$/i, '')
      for (let i = 0; i < collections.length; i++) {
        const geojson = collections[i]
        const count = geojson.features?.length ?? 0
        if (count === 0) { showToast(`"${baseName}" has 0 features.`, 5000); continue }
        const fc = firstCoord(geojson)
        if (fc && isProjected(fc[0], fc[1])) { showToast('⚠ Shapefile appears projected. Include .prj or convert to WGS84.', 7000); continue }
        const name = collections.length > 1 ? `${baseName} (${i + 1})` : baseName
        const color = nextColor()
        const cesColor = Color.fromCssColorString(color)
        const ds = await GeoJsonDataSource.load(geojson, { stroke: cesColor, fill: cesColor.withAlpha(0.5), strokeWidth: 3, markerColor: cesColor, markerSize: 24 })
        ds.name = name
        fixEntities(ds, cesColor)
        registerVector(ds, name, 'Shapefile', color, `${count.toLocaleString()} features`)
      }
      showToast('Shapefile loaded.')
    } catch (e) { console.error(e); showToast('Failed to parse shapefile. Check .shp + .dbf are present.', 6000) }
  }, [showToast])

  const loadDxf = useCallback(async (file: File) => {
    const viewer = viewerRef.current; if (!viewer) return
    try {
      showToast(`Parsing DXF ${file.name}…`, 8000)
      const dxf = new DxfParser().parseSync(await file.text())
      if (!dxf) { showToast('Failed to parse DXF — invalid file.', 5000); return }
      const dxfData  = dxf as unknown as DxfData
      const ext    = dxfData.header
      const minPt  = ext?.['$EXTMIN'] ?? { x: 0, y: 0 }
      const maxPt  = ext?.['$EXTMAX'] ?? { x: 0, y: 0 }
      if (isProjected((minPt.x + maxPt.x) / 2, (minPt.y + maxPt.y) / 2)) {
        showToast('⚠ DXF coordinates appear projected. Convert to EPSG:4326 first.', 7000); return
      }
      const color    = nextColor()
      const cesColor = Color.fromCssColorString(color)
      const ds       = new CustomDataSource(file.name)
      let count      = 0
      for (const ent of (dxfData.entities ?? [])) {
        try {
          if (ent.type === 'LINE') {
            const [v0, v1] = ent.vertices ?? []
            ds.entities.add({ polyline: { positions: Cartesian3.fromDegreesArray([v0.x, v0.y, v1.x, v1.y]), width: new ConstantProperty(2), material: new ColorMaterialProperty(cesColor), clampToGround: new ConstantProperty(true) } })
            count++
          } else if (ent.type === 'LWPOLYLINE' || ent.type === 'POLYLINE') {
            const verts = (ent.vertices ?? []).flatMap(v => [v.x, v.y])
            if (ent.shape || ent.closed) {
              ds.entities.add({ polygon: { hierarchy: { positions: Cartesian3.fromDegreesArray(verts), holes: [] }, material: new ColorMaterialProperty(cesColor.withAlpha(0.4)), outline: new ConstantProperty(true), outlineColor: new ConstantProperty(cesColor), heightReference: new ConstantProperty(HeightReference.CLAMP_TO_GROUND) } })
            } else {
              ds.entities.add({ polyline: { positions: Cartesian3.fromDegreesArray(verts), width: new ConstantProperty(2), material: new ColorMaterialProperty(cesColor), clampToGround: new ConstantProperty(true) } })
            }
            count++
          } else if (ent.type === 'POINT') {
            ds.entities.add({ position: Cartesian3.fromDegrees(ent.position?.x ?? 0, ent.position?.y ?? 0, 0), point: { pixelSize: new ConstantProperty(8), color: new ConstantProperty(cesColor), heightReference: new ConstantProperty(HeightReference.CLAMP_TO_GROUND), disableDepthTestDistance: new ConstantProperty(Number.POSITIVE_INFINITY) } })
            count++
          } else if (ent.type === 'CIRCLE') {
            const cx = ent.center?.x ?? 0, cy = ent.center?.y ?? 0, r = ent.radius ?? 0
            const verts: number[] = []
            for (let s = 0; s <= 64; s++) { const a = (s / 64) * 2 * Math.PI; verts.push(cx + r * Math.cos(a), cy + r * Math.sin(a)) }
            ds.entities.add({ polygon: { hierarchy: { positions: Cartesian3.fromDegreesArray(verts), holes: [] }, material: new ColorMaterialProperty(cesColor.withAlpha(0.3)), outline: new ConstantProperty(true), outlineColor: new ConstantProperty(cesColor), heightReference: new ConstantProperty(HeightReference.CLAMP_TO_GROUND) } })
            count++
          } else if (ent.type === 'TEXT' || ent.type === 'MTEXT') {
            ds.entities.add({ position: Cartesian3.fromDegrees(ent.startPoint?.x ?? 0, ent.startPoint?.y ?? 0, 0), label: { text: new ConstantProperty(String(ent.text ?? '')), font: new ConstantProperty('12px sans-serif'), fillColor: new ConstantProperty(Color.WHITE), outlineColor: new ConstantProperty(Color.BLACK), outlineWidth: new ConstantProperty(2), style: new ConstantProperty(LabelStyle.FILL_AND_OUTLINE), heightReference: new ConstantProperty(HeightReference.CLAMP_TO_GROUND), disableDepthTestDistance: new ConstantProperty(Number.POSITIVE_INFINITY) } })
            count++
          }
        } catch { /* skip malformed entity */ }
      }
      if (count === 0) { showToast('DXF parsed but no displayable entities found.', 5000); return }
      registerVector(ds, file.name, 'DXF', color, `${count.toLocaleString()} entities`)
      showToast(`DXF loaded — ${count.toLocaleString()} entities`)
    } catch (e) { console.error(e); showToast('Failed to parse DXF.', 5000) }
  }, [showToast])

  const loadLas = useCallback(async (file: File) => {
    const viewer = viewerRef.current; if (!viewer) return
    try {
      showToast(`Parsing LAS ${file.name}…`, 10000)
      const buffer  = await file.arrayBuffer()
      const view    = new DataView(buffer)
      const sig     = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))
      if (sig !== 'LASF') { showToast('Not a valid LAS file.', 5000); return }
      const pointFmt = view.getUint8(104)
      const recLen   = view.getUint16(105, true)
      const numPts   = view.getUint32(107, true)
      const ptOffset = view.getUint32(96, true)
      const xScale   = view.getFloat64(131, true)
      const yScale   = view.getFloat64(139, true)
      const zScale   = view.getFloat64(147, true)
      const xOff     = view.getFloat64(155, true)
      const yOff     = view.getFloat64(163, true)
      const zOff     = view.getFloat64(171, true)
      const maxX     = view.getFloat64(179, true)
      const minX     = view.getFloat64(187, true)
      const maxY     = view.getFloat64(195, true)
      const minY     = view.getFloat64(203, true)
      const lonC     = (minX + maxX) / 2
      const latC     = (minY + maxY) / 2
      if (isProjected(lonC, latC)) { showToast('⚠ LAS coordinates appear projected. Reproject to WGS84 first.', 7000); return }
      const RGB_OFF: Record<number, number> = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30 }
      const hasRGB   = RGB_OFF[pointFmt] !== undefined
      const rgbOff   = RGB_OFF[pointFmt] ?? 0
      const step     = Math.max(1, Math.ceil(numPts / 1_000_000))
      const loaded   = Math.ceil(numPts / step)
      const pts      = new PointPrimitiveCollection()
      for (let i = 0; i < numPts; i += step) {
        const base = ptOffset + i * recLen
        const x    = view.getInt32(base,     true) * xScale + xOff
        const y    = view.getInt32(base + 4, true) * yScale + yOff
        const z    = view.getInt32(base + 8, true) * zScale + zOff
        let color  = Color.WHITE
        if (hasRGB) {
          color = Color.fromBytes(view.getUint16(base + rgbOff, true) >> 8, view.getUint16(base + rgbOff + 2, true) >> 8, view.getUint16(base + rgbOff + 4, true) >> 8, 255)
        }
        pts.add({ position: Cartesian3.fromDegrees(x, y, z), pixelSize: 2, color })
      }
      viewer.scene.primitives.add(pts)
      const id = `${Date.now()}-${Math.random()}`
      layerRefsRef.current.set(id, { kind: 'pointcloud', pts, center: [lonC, latC, (view.getFloat64(211, true) + view.getFloat64(219, true)) / 2] })
      const sampled = step > 1 ? ` (↓ ${loaded.toLocaleString()} sampled)` : ''
      setSpatialLayers(prev => [...prev, { id, name: file.name, format: 'LAS', kind: 'pointcloud', color: '#ffffff', visible: true, info: `${numPts.toLocaleString()} pts${sampled}` }])
      viewer.camera.flyTo({ destination: Cartesian3.fromDegrees(lonC, latC, 5000), duration: 2 })
      showToast(`LAS loaded — ${loaded.toLocaleString()} points rendered`)
    } catch (e) { console.error(e); showToast('Failed to parse LAS file.', 5000) }
  }, [showToast])

  const loadGeoTiff = useCallback(async (file: File) => {
    const viewer = viewerRef.current; if (!viewer) return
    try {
      showToast(`Reading GeoTIFF ${file.name}…`, 8000)
      const tiff  = await tiffFromArrayBuffer(await file.arrayBuffer())
      const image = await tiff.getImage()
      const [west, south, east, north] = image.getBoundingBox()
      if (isProjected((west + east) / 2, (south + north) / 2)) { showToast('⚠ GeoTIFF appears projected. Re-export in EPSG:4326.', 7000); return }
      const width  = image.getWidth()
      const height = image.getHeight()
      const bands  = image.getSamplesPerPixel()
      const scale  = Math.min(1, 2048 / Math.max(width, height))
      const w      = Math.round(width * scale)
      const h      = Math.round(height * scale)
      const data   = await image.readRasters({ interleave: true, width: w, height: h }) as unknown as number[]
      const canvas = document.createElement('canvas')
      canvas.width = w; canvas.height = h
      const ctx    = canvas.getContext('2d')!
      const imgData = ctx.createImageData(w, h)
      if (bands >= 3) {
        for (let i = 0; i < w * h; i++) {
          imgData.data[i*4]   = data[i*bands]
          imgData.data[i*4+1] = data[i*bands+1]
          imgData.data[i*4+2] = data[i*bands+2]
          imgData.data[i*4+3] = bands >= 4 ? data[i*bands+3] : 255
        }
      } else {
        let mn = Infinity, mx = -Infinity
        for (let i = 0; i < w * h; i++) { if (data[i] < mn) mn = data[i]; if (data[i] > mx) mx = data[i] }
        const range = mx - mn || 1
        for (let i = 0; i < w * h; i++) {
          const v = Math.round(((data[i] - mn) / range) * 255)
          imgData.data[i*4] = v; imgData.data[i*4+1] = v; imgData.data[i*4+2] = v; imgData.data[i*4+3] = 255
        }
      }
      ctx.putImageData(imgData, 0, 0)
      const provider     = await SingleTileImageryProvider.fromUrl(canvas.toDataURL('image/png'), { rectangle: Rectangle.fromDegrees(west, south, east, north), credit: `GeoTIFF: ${file.name}` })
      const imageryLayer = viewer.imageryLayers.addImageryProvider(provider)
      viewer.camera.flyTo({ destination: Rectangle.fromDegrees(west, south, east, north), duration: 2 })
      const id = `${Date.now()}-${Math.random()}`
      layerRefsRef.current.set(id, { kind: 'raster', imageryLayer, bounds: [west, south, east, north] })
      setSpatialLayers(prev => [...prev, { id, name: file.name, format: 'GeoTIFF', kind: 'raster', color: '#888888', visible: true, info: `${w}×${h} px, ${bands} band${bands > 1 ? 's' : ''}` }])
      showToast(`GeoTIFF loaded — ${w}×${h} at ${Math.round(scale * 100)}%`)
    } catch (e) { console.error(e); showToast('Failed to read GeoTIFF.', 5000) }
  }, [showToast])

  const loadSpatialFile = useCallback(async (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    if      (ext === 'geojson' || ext === 'json') await loadGeoJson(file)
    else if (ext === 'kml' || ext === 'kmz')       await loadKml(file)
    else if (ext === 'shp'  || ext === 'zip')      await loadShapefile(file)
    else if (ext === 'dxf')                        await loadDxf(file)
    else if (ext === 'las')                        await loadLas(file)
    else if (ext === 'tif'  || ext === 'tiff')     await loadGeoTiff(file)
    else if (ext === 'laz')  showToast('LAZ: convert to .las using LASzip first.', 6000)
    else if (ext === 'gpkg') showToast('GeoPackage: export to GeoJSON in QGIS first.', 6000)
    else if (ext === 'dwg')  showToast('DWG: export to DXF in AutoCAD/QGIS/FreeCAD first.', 6000)
    else showToast(`Unsupported format: .${ext}`, 4000)
  }, [loadGeoJson, loadKml, loadShapefile, loadDxf, loadLas, loadGeoTiff, showToast])

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) loadSpatialFile(file)
    e.target.value = ''
  }, [loadSpatialFile])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) loadSpatialFile(file)
  }, [loadSpatialFile])

  const toggleLayerVisibility = useCallback((id: string) => {
    const ref = layerRefsRef.current.get(id)
    if (!ref) return
    if (ref.kind === 'vector')     ref.ds.show           = !ref.ds.show
    if (ref.kind === 'raster')     ref.imageryLayer.show = !ref.imageryLayer.show
    if (ref.kind === 'pointcloud') ref.pts.show          = !ref.pts.show
    setSpatialLayers(prev => prev.map(l => l.id === id ? { ...l, visible: !l.visible } : l))
  }, [])

  const changeLayerColor = useCallback((id: string, hex: string) => {
    const ref = layerRefsRef.current.get(id)
    if (!ref || ref.kind !== 'vector') return
    applyColorToSource(ref.ds, hex)
    setSpatialLayers(prev => prev.map(l => l.id === id ? { ...l, color: hex } : l))
  }, [applyColorToSource])

  const removeLayer = useCallback((id: string) => {
    const viewer = viewerRef.current
    const ref    = layerRefsRef.current.get(id)
    if (viewer && ref) {
      if (ref.kind === 'vector')     viewer.dataSources.remove(ref.ds, true)
      if (ref.kind === 'raster')     viewer.imageryLayers.remove(ref.imageryLayer, true)
      if (ref.kind === 'pointcloud') viewer.scene.primitives.remove(ref.pts)
    }
    layerRefsRef.current.delete(id)
    setSpatialLayers(prev => prev.filter(l => l.id !== id))
  }, [])

  const zoomToLayer = useCallback((id: string) => {
    const viewer = viewerRef.current
    const ref    = layerRefsRef.current.get(id)
    if (!viewer || !ref) return
    if (ref.kind === 'vector')     viewer.flyTo(ref.ds, { duration: 1.5, offset: new HeadingPitchRange(0, CesiumMath.toRadians(-45), 0) })
    if (ref.kind === 'raster')     viewer.camera.flyTo({ destination: Rectangle.fromDegrees(...ref.bounds), duration: 1.5 })
    if (ref.kind === 'pointcloud') viewer.camera.flyTo({ destination: Cartesian3.fromDegrees(ref.center[0], ref.center[1], 3000), duration: 1.5 })
  }, [])

  return (
    <div className="cesium-app">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-icon">🌍</span>
          <div>
            <h1>CesiumJS Viewer</h1>
            <p>Philippines GIS Platform</p>
          </div>
        </div>

        <section className="panel">
          <h2>Navigate</h2>
          <div className="btn-grid">
            {FLY_LOCATIONS.map(loc => (
              <button key={loc.name} onClick={() => flyTo(loc)} className="btn btn-sm">
                {loc.name}
              </button>
            ))}
          </div>
        </section>

        <section className="panel">
          <h2>Scene</h2>
          <div className="btn-grid">
            <button onClick={toggleBuildings} className={`btn btn-sm full-width ${buildingsOn ? 'btn-active' : ''}`}>
              🏙 3D Buildings {buildingsOn ? '(ON)' : '(OFF)'}
            </button>
            <button onClick={toggleTerrain} className={`btn btn-sm full-width ${terrainOn ? 'btn-active' : ''}`}>
              ⛰ World Terrain {terrainOn ? '(ON)' : '(OFF)'}
            </button>
            <button onClick={toggleLighting} className={`btn btn-sm full-width ${lightingOn ? 'btn-active' : ''}`}>
              ☀ Sun Lighting {lightingOn ? '(ON)' : '(OFF)'}
            </button>
            <button onClick={toggleDepthTest} className={`btn btn-sm full-width ${depthTest ? 'btn-active' : ''}`}>
              🔬 Depth Test {depthTest ? '(ON)' : '(OFF)'}
            </button>
          </div>
          {tokenApplied && <span className="badge badge-ok" style={{ marginTop: 8, display: 'inline-block' }}>✓ Ion token active</span>}
        </section>

        <section className="panel">
          <h2>Map Layer {basemapLoading && <span className="loading-dot">…</span>}</h2>
          <div className="basemap-grid">
            {BASEMAPS.map(def => {
              const active = activeBasemap === def.id
              return (
                <button
                  key={def.id}
                  className={`basemap-btn ${active ? 'basemap-btn--active' : ''}`}
                  onClick={() => switchBasemap(def)}
                  title={def.label}
                  disabled={basemapLoading}
                >
                  {active && <span className="basemap-check">✓</span>}
                  <span className="basemap-label">{def.label}</span>
                </button>
              )
            })}
          </div>
        </section>

        <section className="panel">
          <h2>Mouse Coordinates</h2>
          <div className="coords">
            <div className="coord-row">
              <span className="coord-label">Lat</span>
              <span className="coord-value">{coords.lat !== null ? `${coords.lat.toFixed(5)}°` : '—'}</span>
            </div>
            <div className="coord-row">
              <span className="coord-label">Lon</span>
              <span className="coord-value">{coords.lon !== null ? `${coords.lon.toFixed(5)}°` : '—'}</span>
            </div>
            <div className="coord-row">
              <span className="coord-label">Alt</span>
              <span className="coord-value">
                {coords.alt !== null ? (coords.alt > 1000 ? `${(coords.alt / 1000).toFixed(1)} km` : `${coords.alt.toFixed(0)} m`) : '—'}
              </span>
            </div>
          </div>
        </section>

        <section className="panel">
          <h2>Spatial Data</h2>
          <div className="format-tags">
            {['GeoJSON','KML','KMZ','SHP','DXF','LAS','TIFF'].map(f => (
              <span key={f} className="format-tag">{f}</span>
            ))}
          </div>
          <div
            className={`drop-zone ${isDragging ? 'drop-zone--over' : ''}`}
            onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            aria-label="Upload spatial data file"
          >
            <span className="drop-icon">📂</span>
            <span>Drop file here or click to browse</span>
            <input
              id={dropId}
              ref={fileInputRef}
              type="file"
              accept=".geojson,.json,.kml,.kmz,.shp,.zip,.dxf,.las,.laz,.tif,.tiff,.gpkg,.dwg"
              style={{ display: 'none' }}
              onChange={handleFileInput}
            />
          </div>
          {spatialLayers.length > 0 && (
            <ul className="layer-list">
              {spatialLayers.map(layer => (
                <li key={layer.id} className="layer-item">
                  <button
                    className="layer-color-btn"
                    title={layer.kind === 'vector' ? 'Change color' : layer.kind}
                    style={{ '--layer-color': layer.color } as React.CSSProperties}
                    onClick={() => layer.kind === 'vector' && document.getElementById(`color-${layer.id}`)?.click()}
                  />
                  {layer.kind === 'vector' && (
                    <input id={`color-${layer.id}`} type="color" value={layer.color} style={{ display: 'none' }} onChange={e => changeLayerColor(layer.id, e.target.value)} />
                  )}
                  <button className="layer-name" title="Zoom to layer" onClick={() => zoomToLayer(layer.id)}>
                    <span className="layer-name-text">{layer.name}</span>
                    <span className="layer-count">
                      <span className="layer-format-badge">{layer.format}</span>
                      {layer.info}
                    </span>
                  </button>
                  <div className="layer-actions">
                    <button className={`layer-btn ${layer.visible ? '' : 'layer-btn--off'}`} title={layer.visible ? 'Hide' : 'Show'} onClick={() => toggleLayerVisibility(layer.id)}>
                      {layer.visible ? '👁' : '🚫'}
                    </button>
                    <button className="layer-btn layer-btn--remove" title="Remove" onClick={() => removeLayer(layer.id)}>✕</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="sidebar-footer">
          Built with <a href="https://cesium.com/" target="_blank" rel="noreferrer">CesiumJS</a> v1.140 + React
        </div>
      </aside>

      <div className="globe-wrapper">
        <div ref={containerRef} className="cesium-container" />
        {toast && <div className="toast">{toast}</div>}
      </div>
    </div>
  )
}
