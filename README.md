# Property Lookup

A fully client-side web app for looking up property details, market value, monthly costs, and more. Works for any US property with a Realtor API key, and has enhanced data for King County, WA (Bellevue, Redmond, Kirkland, Sammamish, etc.).

**No server or backend required** — runs entirely in the browser. Host it anywhere that serves static files.

---

## 🚀 Quick Start

### Option 1: Open directly (simplest)

Just double-click `public/index.html` in your file browser. Everything works with the `file://` protocol.

### Option 2: Local server (recommended)

Using Node.js (npx):
```bash
npx serve public
# Open http://localhost:3000
```

Using Python:
```bash
cd public
python -m http.server 8080
# Open http://localhost:8080
```

Using VS Code: Install the **Live Server** extension, right-click `public/index.html` → "Open with Live Server".

### Option 3: GitHub Pages (access from any device)

1. Push this repo to GitHub
2. Go to **Settings → Pages → Source → Deploy from branch → `main` → `/public`**
3. Your app will be live at `https://<username>.github.io/<repo-name>/`

---

## ⚙️ Setup — API Keys

The app works without any API keys (King County data only). For full functionality, add a **Realtor API key**:

### Realtor API Key (recommended — free tier available)

1. Go to [RapidAPI — Realtor](https://rapidapi.com/apidojo/api/realty-in-us)
2. Sign up for a free account
3. Subscribe to the **Realty in US** API (free tier = 500 requests/month)
4. Copy your `X-RapidAPI-Key` from the API dashboard
5. In the app, click **⚙️ Settings** and paste the key into **Realtor API Key**
6. Click **Save**

> 💡 The app minimizes API usage — it tries free King County data first, and only calls Realtor API when needed (missing bedrooms, value, or non-KC properties).

### Google Maps API Key (optional)

For Street View photos in the image gallery:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Enable the **Street View Static API**
3. Create an API key and paste it into **⚙️ Settings → Google Maps Key**

---

## ✨ Features

### Property Search
- 📍 **Search by address** — type any US address like you would in Google Maps
- 🏷️ **Search by MLS #** — look up by MLS number with state filtering
- 🏢 **Unit/apartment support** — separate unit field for condos and apartments

### Property Details
- 🏠 Address, beds, baths, sqft, year built, lot size, home type
- 🔨 Condition details (heating, cooling, roofing, flooring, garage, pool)
- 📸 Property photos from Realtor API + satellite map view

### Market Value
- 💰 King County assessed value (land + improvement breakdown)
- 📊 Estimated market value and list price from Realtor
- 🏘️ Rental estimate (shown separately)

### Monthly Cost Calculator (EMI)
- 💳 Full breakdown: Principal & Interest, Property Tax, Insurance, HOA, PMI
- 📝 All fields editable — auto-fills from API data
- 🎨 Color-coded stacked bar visualization
- 🔄 Recalculate button updates the breakdown and saves to history

### Additional Analysis
- 🧭 **Vastu Shastra Analysis** — compass direction picker with auto-detection from address, detailed analysis, remedies, and scoring
- ✅ **"Should You Buy?" Score** — weighted scoring across value, condition, HOA, neighborhood factors
- 🏷️ Sales & price history table

### Notes & HOA Tracking
- 📝 Personal notes per property (persisted in history)
- ☑️ HOA coverage checklist (Water, Sewer, Garbage, Roof, Pool, Gym, etc.)

### Search History
- 📋 Full history with all fields — opens in a dedicated page
- 🔍 Filter and sort by date, score, price, monthly cost
- 📥 Export to CSV
- 🗑️ Delete individual entries
- 🔄 Click any entry to re-search that address

### External Links
- 🏛️ KC eReal Property & Parcel Viewer (when parcel PIN available)
- 🏠 Zillow
- 📍 Google Maps, Street View, Google Earth

---

## 📁 Project Structure

```
property-lookup/
├── public/
│   ├── index.html       — Main dashboard UI
│   ├── app.js           — All logic: API calls, rendering, EMI, Vastu, history
│   ├── style.css        — Styles, responsive design, animations
│   └── history.html     — Standalone search history page
└── README.md
```

---

## 🔒 Privacy & Data

- **No backend** — all API calls go directly from your browser
- **API keys** stored in your browser's `localStorage` only — never sent anywhere except the API endpoints
- **Search history** stored in `localStorage` — stays on your device
- **No cookies, no tracking, no analytics**

---

## 📱 Browser Support

Works in all modern browsers (Chrome, Edge, Firefox, Safari). Responsive design works on desktop, tablet, and mobile.

---

## 🗺️ Data Sources

| Source | Data | Access |
|---|---|---|
| **King County Assessor (ArcGIS)** | Address, lot, assessed values, zoning, sales (3yr) | ✅ Free / public |
| **Realtor API (RapidAPI)** | Beds/baths, photos, estimate, HOA, price history, MLS | Free tier (500/mo) |
| **Google Maps API** | Street View photos | Optional (free tier) |
| **Manual entry** | Notes, HOA coverage, special assessments | Saved in localStorage |
