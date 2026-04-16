# CesiumJS GIS Viewer

A Philippines-focused GIS web app built with **React + TypeScript + Vite + CesiumJS 1.140**.

## Features

- Standard (OpenStreetMap) and Satellite (ESRI) basemaps with street labels
- Google Photorealistic 3D Tiles (street-level 3D buildings)
- OSM 3D Buildings via Cesium Ion
- World Terrain elevation
- Sun lighting and depth test toggles
- Load spatial data: GeoJSON, KML/KMZ, Shapefile (.zip), DXF, LAS, GeoTIFF
- Mouse coordinate display (Lat / Lon / Alt)

---

## Getting Started

### 1. Clone the repo

```bash
git clone https://github.com/iphiljay/cesium-sample.git
cd cesium-sample
```

### 2. Install dependencies

```bash
npm install
```

### 3. Set up API keys

Create a `.env.local` file in the project root (this file is gitignored and will never be committed):

```
VITE_CESIUM_ION_TOKEN=your_cesium_ion_token_here
VITE_GOOGLE_MAPS_API_KEY=your_google_maps_api_key_here
```

#### Getting your Cesium Ion token

1. Sign up or log in at [ion.cesium.com](https://ion.cesium.com)
2. Go to **Access Tokens** → click **Create token**
3. Copy the token and paste it as `VITE_CESIUM_ION_TOKEN`

> Required for: OSM 3D Buildings and World Terrain features.

#### Getting your Google Maps API key

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or select an existing one)
3. Go to **APIs & Services** → **Library** and enable:
   - **Map Tiles API**
4. Go to **APIs & Services** → **Credentials** → **Create Credentials** → **API key**
5. Click **Edit API key** → under **API restrictions**, select **Restrict key** and add **Map Tiles API** to the allowed list
6. Enable **Billing** on your project (required by Google — you get $200 free credit/month)
7. Copy the key and paste it as `VITE_GOOGLE_MAPS_API_KEY`

> Required for: Google Photorealistic 3D Tiles feature.
> Note: Google 3D Tiles shows full 3D building mesh in major cities (Tokyo, New York, London, etc.). Coverage varies by region.

### 4. Run the dev server

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

---

## Build for production

```bash
npm run build
```

---

## Tech Stack

| Package | Version |
|---|---|
| React | 19 |
| TypeScript | 5 |
| Vite | 6 |
| CesiumJS | 1.140 |
| vite-plugin-cesium | latest |
| shpjs | latest |
| geotiff | latest |
| dxf-parser | latest |
