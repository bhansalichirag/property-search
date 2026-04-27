// Property Lookup — Fully client-side, calls King County ArcGIS APIs directly

const $ = (id) => document.getElementById(id);

// ── King County ArcGIS API endpoints ──
const KC_BASE = "https://gismaps.kingcounty.gov/arcgis/rest/services/Property/KingCo_PropertyInfo/MapServer";
const KC_PARCELS = `${KC_BASE}/2/query`; // Parcels with address, values, lot info
const KC_SALES = `${KC_BASE}/3/query`;   // Sales in the last 3 years

// ── Settings ──
function saveSettings() {
  const rKey = $("realtorApiKey").value.trim();
  const gKey = $("googleMapsKey").value.trim();
  if (rKey) localStorage.setItem("realtor_api_key", rKey);
  else localStorage.removeItem("realtor_api_key");
  if (gKey) localStorage.setItem("google_maps_key", gKey);
  else localStorage.removeItem("google_maps_key");
  $("settingsStatus").textContent = "✅ Keys saved";
}

(function loadSettings() {
  try {
    const rKey = localStorage.getItem("realtor_api_key");
    if (rKey && $("realtorApiKey")) $("realtorApiKey").value = rKey;
    const gKey = localStorage.getItem("google_maps_key");
    if (gKey && $("googleMapsKey")) $("googleMapsKey").value = gKey;
    const mlsState = localStorage.getItem("mls_state");
    if (mlsState && $("mlsState")) $("mlsState").value = mlsState;
  } catch (e) { console.warn("loadSettings error:", e); }
})();

// Persist state selection + auto-search from URL param
let _autoSearchDone = false;
function initPageFromUrl() {
  if (_autoSearchDone) return;

  const sel = $("mlsState");
  if (sel) {
    const saved = localStorage.getItem("mls_state");
    if (saved) sel.value = saved;
    sel.addEventListener("change", () => localStorage.setItem("mls_state", sel.value));
  }

  // Auto-search: check URL param first, then sessionStorage fallback
  const params = new URLSearchParams(window.location.search);
  let searchAddr = params.get("search");
  if (!searchAddr) {
    searchAddr = sessionStorage.getItem("pending_search");
  }

  console.log("[initPageFromUrl] searchAddr:", searchAddr, "addressInput:", !!$("addressInput"));

  if (searchAddr && $("addressInput")) {
    _autoSearchDone = true;
    sessionStorage.removeItem("pending_search"); // clear so it doesn't re-trigger

    // Make sure address tab is visible
    const addrTab = document.querySelector('.search-tabs .tab');
    if (addrTab) switchTab("address", addrTab);

    // Extract unit if embedded in address (e.g., "123 Main St #B-117, City, WA")
    const unitMatch = searchAddr.match(/(?:#|unit\s*|apt\s*|ste\s*)([A-Za-z0-9-]+)/i);
    if (unitMatch && $("unitInput")) {
      $("unitInput").value = unitMatch[1];
      $("addressInput").value = searchAddr.replace(unitMatch[0], "").replace(/\s{2,}/g, " ").trim();
    } else {
      $("addressInput").value = searchAddr;
    }

    console.log("[initPageFromUrl] addressInput value:", $("addressInput").value);
    setTimeout(() => {
      console.log("[initPageFromUrl] Calling doSearch now");
      doSearch();
    }, 500);
  }
}

// Try on multiple events to ensure it runs
initPageFromUrl();
document.addEventListener("DOMContentLoaded", initPageFromUrl);
window.addEventListener("load", initPageFromUrl);

// ── Toast Notifications ──
function showToast(message, type = "info") {
  let container = document.getElementById("toastContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "toastContainer";
    document.body.appendChild(container);
  }
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span>${message}</span><button onclick="this.parentElement.remove()">✕</button>`;
  container.appendChild(toast);
  setTimeout(() => { toast.classList.add("toast-visible"); }, 10);
  setTimeout(() => {
    toast.classList.remove("toast-visible");
    setTimeout(() => toast.remove(), 300);
  }, 6000);
}

// ── Tab Switching ──
function switchTab(tab, btn) {
  document.querySelectorAll(".search-tabs .tab").forEach(t => t.classList.remove("active"));
  btn.classList.add("active");
  $("searchAddress").classList.toggle("hidden", tab !== "address");
  $("searchMls").classList.toggle("hidden", tab !== "mls");
  $("searchHint").textContent = tab === "mls"
    ? "Enter the MLS# from your listing (NWMLS, Zillow, Redfin, etc.). Select your state — MLS numbers are regional and may overlap across states."
    : "Type any address like you would in Google Maps. With a Realtor API key, works for any US property. Without a key, searches King County records only.";
}

// ── Helpers for loading state ──
function beginLoading(btnId) {
  $("loading").classList.remove("hidden");
  $("results").classList.add("hidden");
  $("error").classList.add("hidden");
  $("noResults").classList.add("hidden");
  $(btnId).disabled = true;
}
function endLoading(btnId) {
  $("loading").classList.add("hidden");
  $(btnId).disabled = false;
}
function showError(err) {
  $("error").classList.remove("hidden");
  $("errorMsg").textContent = `Something went wrong: ${err.message}. Please try again.`;
  showToast("Search failed — see error details below.", "error");
}

// ── Search by Address ──
async function doSearch() {
  const raw = $("addressInput").value.trim();
  const unit = $("unitInput").value.trim();
  if (!raw) {
    showToast("Please enter an address to search.", "warn");
    return;
  }

  beginLoading("searchBtn");
  try {
    const realtorKey = localStorage.getItem("realtor_api_key");

    // Step 1: Try King County (free) first
    const report = await buildReport(raw, unit, null);
    const kcFound = report.sources.length > 0 && report.property.pin;

    // Step 2: Only call Realtor API if KC didn't find enough data
    let realtorListing = null;
    const needsRealtor = realtorKey && (
      !kcFound ||                           // No KC data at all
      !report.property.bedrooms ||          // Missing basic property info
      !report.marketValue.assessedTotal     // Missing market value
    );

    if (needsRealtor) {
      showToast("Enriching with Realtor API…", "info");
      realtorListing = await searchRealtorByAddress(raw, unit, realtorKey);
    } else if (kcFound) {
      showToast("Found in King County records (no API call needed) ✅", "info");
    } else if (realtorKey) {
      // KC didn't find it — try Realtor
      showToast("Not found in KC, searching Realtor API…", "info");
      realtorListing = await searchRealtorByAddress(raw, unit, realtorKey);
    }

    // Step 3: Merge Realtor data into report if we got it
    if (realtorListing) {
      await enrichReportWithRealtor(report, realtorListing, unit);
    }

    // Step 4: If still nothing, show no-results
    if (report.sources.length === 0) {
      $("noResults").classList.remove("hidden");
      $("noResultsAddr").textContent = unit ? `${raw}, Unit ${unit}` : raw;
      showToast("No property records found for this address.", "warn");
      return;
    }

    // Set MLS# and Listing ID from Realtor listing
    if (realtorListing?.mlsId) {
      report.mlsNumber = realtorListing.mlsId;
      report.mlsSource = realtorListing.mlsSource;
    }
    if (realtorListing?.listingId) {
      report.listingId = realtorListing.listingId;
    }

    renderReport(report);
  } catch (err) {
    showError(err);
  } finally {
    endLoading("searchBtn");
  }
}

/** Merge Realtor listing data into an existing report */
async function enrichReportWithRealtor(report, listing, unit) {
  if (!report.sources.includes("Realtor API")) report.sources.push("Realtor API");

  // Fill in property basics if KC didn't have them
  if (!report.property.address) report.property.address = listing.address;
  if (!report.property.unit) report.property.unit = listing.unit || unit;
  if (!report.property.city) report.property.city = listing.city;
  if (!report.property.zip) report.property.zip = listing.zip;
  if (!report.property.state) report.property.state = listing.state;
  report.property.bedrooms = report.property.bedrooms || listing.bedrooms;
  report.property.bathrooms = report.property.bathrooms || listing.bathrooms;
  report.property.sqft = report.property.sqft || listing.livingArea;
  report.property.yearBuilt = report.property.yearBuilt || listing.yearBuilt;
  report.property.imageUrl = report.property.imageUrl || listing.imgSrc;
  report.property.homeType = listing.homeType;
  report.property.realtorUrl = listing.detailUrl;
  report.property.photos = listing.photos || [];
  report.property._realtorPropertyId = listing.propertyId;

  // Market values
  report.marketValue.zestimate = listing.estimatedValue;
  report.marketValue.listPrice = listing.price;
  report.marketValue.rentEstimate = listing.rentEstimate;

  // HOA
  if (listing.hoaFee) report.hoa = { monthly: listing.hoaFee, source: "Realtor API" };

  // MLS info
  if (listing.mlsId) { report.mlsNumber = listing.mlsId; report.mlsSource = listing.mlsSource; }
  if (listing.listingId) report.listingId = listing.listingId;

  // Fetch detail for condition/history (1 API call)
  const propId = listing.propertyId;
  if (propId) {
    try {
      const detail = await fetchRealtorDetail(propId);
      if (detail) {
        const d = detail.description || {};
        report.condition = Object.assign(report.condition, {
          stories: d.stories, heating: d.heating, cooling: d.cooling,
          roofing: d.roofing, flooring: d.flooring, garage: d.garage,
          pool: d.pool_yn || (d.pool ? "Yes" : null),
          fireplace: d.fireplace,
        });
        report.property.bedrooms = report.property.bedrooms || d.beds;
        report.property.bathrooms = report.property.bathrooms || d.baths;
        report.property.sqft = report.property.sqft || d.sqft;
        report.property.yearBuilt = report.property.yearBuilt || d.year_built;
        report.property.lotSqft = report.property.lotSqft || d.lot_sqft;

        // Tax & price history from detail
        if (detail.tax_history?.length) {
          const latest = detail.tax_history[0];
          if (latest.assessment?.total && !report.marketValue.assessedTotal) {
            report.marketValue.assessedTotal = latest.assessment.total;
            report.marketValue.assessedLand = latest.assessment.land;
            report.marketValue.assessedImprovement = latest.assessment.building;
          }
          if (latest.tax && !report.mortgage?.propertyTax) {
            report.mortgage.propertyTax = latest.tax;
          }
        }
        if (detail.property_history?.length) {
          report.priceHistory = detail.property_history
            .filter(h => h.price && h.price > 10000)
            .map(h => ({
              date: h.date ? new Date(h.date) : null,
              price: h.price,
              event: h.event_name || "Sale",
              source: "Realtor",
            }));
        }
        if (detail.estimate?.estimate) {
          report.marketValue.zestimate = report.marketValue.zestimate || detail.estimate.estimate;
        }
        if (detail.hoa?.fee && !report.hoa.monthly) {
          report.hoa = { monthly: detail.hoa.fee, source: "Realtor Detail" };
        }
      }
    } catch (e) { console.warn("Realtor detail fetch failed:", e.message); }
  }

  if (!report.property.pin) {
    showToast("No King County parcel found — showing Realtor listing data.", "warn");
  }
}

/** Search Realtor API by natural address (like Google Maps) */
async function searchRealtorByAddress(address, unit, apiKey) {
  const headers = { "x-rapidapi-key": apiKey, "x-rapidapi-host": REALTOR_HOST, "Content-Type": "application/json" };
  const statuses = ["for_sale", "sold", "ready_to_build", "off_market", "other"];

  // Auto-extract unit from address if user typed it inline
  if (!unit) {
    const inlineUnit = address.match(/(?:#|unit\s*|apt\s*|ste\s*|suite\s*)([A-Za-z0-9-]+)/i);
    if (inlineUnit) {
      unit = inlineUnit[1];
      address = address.replace(inlineUnit[0], "").replace(/,\s*,/, ",").trim();
      console.log(`Extracted unit "${unit}" from address, cleaned: "${address}"`);
    }
  }

  // Parse address into components: "9217 122nd Ct NE, Kirkland, WA 98033"
  const parts = address.split(",").map(s => s.trim()).filter(Boolean);
  const street = parts[0] || "";
  const cityPart = parts[1] || "";
  // State and zip may be in parts[2] or embedded in city part
  let state = "", zip = "";
  const stateZipMatch = (parts[2] || cityPart).match(/\b([A-Z]{2})\b\s*(\d{5})?/i);
  if (stateZipMatch) {
    state = stateZipMatch[1].toUpperCase();
    zip = stateZipMatch[2] || "";
  }
  const city = cityPart.replace(/\b[A-Z]{2}\b\s*\d{0,5}\s*$/i, "").trim();

  console.log(`Parsed address: street="${street}", city="${city}", state="${state}", zip="${zip}", unit="${unit || ""}"`);

  // Try multiple search strategies in order of specificity
  const strategies = [];

  // Strategy 1: Structured address fields (most reliable)
  if (street) {
    const structured = { address: unit ? `${street} ${unit}` : street };
    if (city) structured.city = city;
    if (state) structured.state_code = state;
    if (zip) structured.postal_code = zip;
    strategies.push({ label: "structured address", body: structured });
  }

  // Strategy 2: Structured without unit (then filter)
  if (street && unit) {
    const noUnit = { address: street };
    if (city) noUnit.city = city;
    if (state) noUnit.state_code = state;
    if (zip) noUnit.postal_code = zip;
    strategies.push({ label: "structured no-unit", body: noUnit });
  }

  // Strategy 3: Postal code + street (if zip provided)
  if (zip && street) {
    strategies.push({ label: "zip+street", body: { postal_code: zip, address: street } });
  }

  // Strategy 4: free_text fallback with full original input
  strategies.push({ label: "free_text", body: { free_text: unit ? `${address} ${unit}` : address } });

  let allResults = [];
  const seen = new Set();

  for (const { label, body } of strategies) {
    try {
      console.log(`Realtor address search [${label}]:`, JSON.stringify(body));
      const resp = await fetch(
        `https://${REALTOR_HOST}/properties/v3/list`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ limit: 10, offset: 0, ...body, status: statuses })
        }
      );
      if (!resp.ok) { console.warn(`  [${label}] HTTP ${resp.status}`); continue; }
      const data = await resp.json();
      const props = data.data?.home_search?.results || [];
      console.log(`  [${label}] → ${props.length} results`, props.slice(0, 3).map(p => {
        const loc = p.location?.address || {};
        return `${loc.line}, ${loc.city}, ${loc.state_code}`;
      }));

      for (const p of props) {
        const pid = p.property_id || JSON.stringify(p.location?.address);
        if (!seen.has(pid)) { seen.add(pid); allResults.push(p); }
      }

      // If unit specified, check for exact match in this batch
      if (unit && props.length > 0) {
        const unitUpper = unit.toUpperCase().replace(/^#/, "").replace(/-/g, "");
        const unitMatch = props.find(p => {
          const addr = (p.location?.address?.line || "").toUpperCase().replace(/-/g, "");
          return addr.includes(unitUpper) || addr.includes(`#${unitUpper}`) || addr.includes(`UNIT ${unitUpper}`);
        });
        if (unitMatch) {
          console.log(`  ✓ Exact unit match via [${label}]:`, unitMatch.location?.address?.line);
          return normalizeRealtorResult(unitMatch);
        }
      }

      // If only 1 result from a structured search, auto-select
      if (props.length === 1 && label.startsWith("structured")) {
        return normalizeRealtorResult(props[0]);
      }
    } catch (e) { console.warn(`  [${label}] error:`, e.message); }
  }

  if (allResults.length === 0) return null;
  if (allResults.length === 1) return normalizeRealtorResult(allResults[0]);

  // Multiple results — show picker
  return new Promise((resolve) => {
    showMlsPicker(allResults, state || null, (chosen) => {
      resolve(chosen ? normalizeRealtorResult(chosen) : null);
    });
  });
}

// ── Search by MLS# ──
async function doMlsSearch() {
  const mlsNum = $("mlsInput").value.trim();
  if (!mlsNum) {
    showToast("Please enter an MLS number.", "warn");
    return;
  }

  const realtorKey = localStorage.getItem("realtor_api_key");
  if (!realtorKey) {
    showToast("A Realtor API key (RapidAPI) is required to look up MLS numbers. Add one in ⚙️ Settings.", "error");
    return;
  }

  beginLoading("searchMlsBtn");
  try {
    showToast(`Looking up MLS# ${mlsNum} via Realtor API…`, "info");
    const listing = await resolveMls(mlsNum, realtorKey);

    if (!listing) {
      endLoading("searchMlsBtn");
      $("noResults").classList.remove("hidden");
      $("noResultsAddr").textContent = `MLS# ${mlsNum}`;
      showToast(`MLS# ${mlsNum} not found or cancelled. Try searching by address instead.`, "warn");
      return;
    }

    showToast(`Found: ${listing.address}. Fetching King County records…`, "success");

    const report = await buildReport(listing.streetAddress, listing.unit, null);
    report.mlsNumber = mlsNum;

    // MLS flow always uses Realtor data since user searched by MLS#
    await enrichReportWithRealtor(report, listing, listing.unit);

    if (report.sources.length === 0) {
      $("noResults").classList.remove("hidden");
      $("noResultsAddr").textContent = `MLS# ${mlsNum}`;
      return;
    }

    renderReport(report);
  } catch (err) {
    showError(err);
  } finally {
    endLoading("searchMlsBtn");
  }
}

$("addressInput").addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
$("unitInput").addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
$("mlsInput").addEventListener("keydown", (e) => { if (e.key === "Enter") doMlsSearch(); });

// ── Resolve MLS# via Realtor RapidAPI ──
const REALTOR_HOST = "realty-in-us.p.rapidapi.com";

async function resolveMls(mlsNum, apiKey) {
  const headers = { "x-rapidapi-key": apiKey, "x-rapidapi-host": REALTOR_HOST, "Content-Type": "application/json" };
  const statuses = ["for_sale", "sold", "ready_to_build", "off_market", "other"];
  const stateCode = ($("mlsState")?.value || localStorage.getItem("mls_state") || "WA").toUpperCase();
  localStorage.setItem("mls_state", stateCode);

  // MLS source codes for regional boards (used with source_id + source_listing_id combo)
  const MLS_SOURCES = {
    WA: ["NWMLS", "nwmls", "NW", "WAMLS"],
    CA: ["CRMLS", "SFAR", "BAREIS"],
    TX: ["HAR", "NTREIS", "SABOR"],
    FL: ["MIAMIRE", "STELLAR"],
  };

  const strategies = [
    // 1. Direct source_listing_id (regional MLS#)
    { source_listing_id: mlsNum },
    // 2. source_listing_id + state filter
    { source_listing_id: mlsNum, state_code: stateCode },
    // 3. Try with known MLS source codes for the state
    ...(MLS_SOURCES[stateCode] || []).map(src => ({
      source_listing_id: mlsNum, source_id: src
    })),
    // 4. Prefixed variations (some MLS systems prefix their IDs)
    ...(MLS_SOURCES[stateCode] || []).slice(0, 2).map(src => ({
      source_listing_id: `${src}-${mlsNum}`
    })),
    // 5. listing_id (Realtor.com internal)
    { listing_id: mlsNum },
    // 6. listing_key
    { listing_key: mlsNum },
    // 7. Free-text with MLS board name
    { free_text: `NWMLS ${mlsNum}`, state_code: stateCode },
    { free_text: `MLS# ${mlsNum}`, state_code: stateCode },
    { free_text: mlsNum, state_code: stateCode },
  ];

  // Deduplicate by property_id
  const seen = new Set();
  let allResults = [];
  for (const query of strategies) {
    try {
      const body = { limit: 20, offset: 0, ...query, status: statuses };
      const label = Object.entries(query).map(([k,v]) => `${k}=${v}`).join(", ");
      console.log(`MLS search: ${label}`);
      const resp = await fetch(
        `https://${REALTOR_HOST}/properties/v3/list`,
        { method: "POST", headers, body: JSON.stringify(body) }
      );
      if (resp.ok) {
        const data = await resp.json();
        const props = data.data?.home_search?.results || [];
        if (props.length > 0) {
          console.log(`  → ${props.length} results:`, props.slice(0, 3).map(p => {
            const loc = p.location?.address || {};
            return `${loc.line}, ${loc.city}, ${loc.state_code}`;
          }));
        }
        for (const p of props) {
          const pid = p.property_id || JSON.stringify(p.location?.address);
          if (!seen.has(pid)) { seen.add(pid); allResults.push(p); }
        }
      }
    } catch (e) { console.warn(`  ✗ failed:`, e.message); }
  }
  console.log(`MLS total unique results: ${allResults.length}`);

  // Filter to selected state first
  const stateResults = allResults.filter(p =>
    (p.location?.address?.state_code || "").toUpperCase() === stateCode
  );
  const candidates = stateResults.length > 0 ? stateResults : allResults;

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return normalizeRealtorResult(candidates[0]);

  // Multiple matches — let user pick
  return new Promise((resolve) => {
    showMlsPicker(candidates, stateCode, (chosen) => {
      resolve(chosen ? normalizeRealtorResult(chosen) : null);
    });
  });
}

function showMlsPicker(candidates, stateCode, onSelect) {
  // Remove existing picker
  const existing = document.getElementById("mlsPicker");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "mlsPicker";
  overlay.className = "mls-picker-overlay";

  let html = `<div class="mls-picker-modal">
    <h3>Multiple properties found — select the correct one</h3>
    <p class="mls-picker-hint">Showing ${candidates.length} results${stateCode ? ` (filtered to ${stateCode})` : ""}. Click the correct property or cancel.</p>
    <div class="mls-picker-list">`;

  candidates.forEach((p, i) => {
    const loc = p.location?.address || {};
    const addr = loc.line || "Unknown address";
    const city = loc.city || "";
    const state = loc.state_code || "";
    const zip = loc.postal_code || "";
    const price = p.list_price || p.price;
    const beds = p.description?.beds ?? p.beds ?? "?";
    const baths = p.description?.baths ?? p.baths ?? "?";
    const sqft = p.description?.sqft ?? p.building_size?.size ?? "?";
    const type = p.description?.type ?? p.prop_type ?? "";
    const img = p.primary_photo?.href ? fixRealtorPhotoUrl(p.primary_photo.href) : "";
    const status = p.status || "";

    html += `<button class="mls-picker-item" data-idx="${i}">
      ${img ? `<img src="${img}" alt="Photo" onerror="this.style.display='none'"/>` : `<div class="mls-picker-noimg">🏠</div>`}
      <div class="mls-picker-info">
        <strong>${addr}</strong>
        <span>${city}, ${state} ${zip}</span>
        <span>${beds} bed · ${baths} bath · ${sqft !== "?" ? sqft.toLocaleString() + " sqft" : ""} ${type ? "· " + type : ""}</span>
        <span>${price ? "$" + Number(price).toLocaleString() : "Price N/A"} ${status ? "· " + status.replace(/_/g, " ") : ""}</span>
      </div>
    </button>`;
  });

  html += `</div>
    <div class="mls-picker-actions">
      <button class="mls-picker-cancel">✕ None of these — cancel</button>
    </div>
  </div>`;

  overlay.innerHTML = html;
  document.body.appendChild(overlay);

  // Event handlers
  overlay.querySelectorAll(".mls-picker-item").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx);
      overlay.remove();
      onSelect(candidates[idx]);
    });
  });
  overlay.querySelector(".mls-picker-cancel").addEventListener("click", () => {
    overlay.remove();
    onSelect(null);
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) { overlay.remove(); onSelect(null); }
  });
}

function fixRealtorPhotoUrl(url) {
  if (!url) return null;
  // Realtor API photo URLs often end with size suffixes like -s, -m, -l, -o
  // or contain {size} placeholder. Replace with large version.
  url = url.replace(/\{size\}/g, "l");
  // Replace small/medium suffix with large: e.g., photo-s.jpg → photo-l.jpg
  url = url.replace(/-s(\.\w+)$/, "-l$1");
  url = url.replace(/-m(\.\w+)$/, "-l$1");
  // Some URLs end with s.jpg without dash
  url = url.replace(/s\.jpg$/, "l.jpg");
  return url;
}

function normalizeRealtorResult(p) {
  console.log("Realtor raw source/mls fields:", { source: p.source, listing_id: p.listing_id, mls_id: p.mls_id, mls: p.mls });
  const loc = p.location?.address || {};
  const addr = loc.line || p.address?.line || "";
  const unitMatch = addr.match(/(?:#|unit\s*|apt\s*|ste\s*)(\w+)\s*$/i);
  const rawImg = p.primary_photo?.href || (p.photos && p.photos[0]?.href);
  const rawPhotos = (p.photos || []).map(ph => ph.href).filter(Boolean);
  return {
    propertyId: p.property_id,
    listingId: p.listing_id || p.source?.listing_id || null,
    mlsId: p.source?.spec_id || p.mls_id || p.source?.listing_id || null,
    mlsSource: p.source?.id || p.source?.name || null,
    mlsSourceType: p.source?.type || null,
    address: addr,
    streetAddress: addr.replace(/\s*(?:#|unit|apt|ste)\s*\w+\s*$/i, "").trim(),
    unit: unitMatch ? unitMatch[1] : null,
    city: loc.city || p.address?.city || "",
    state: loc.state_code || p.address?.state_code || "WA",
    zip: loc.postal_code || p.address?.postal_code || "",
    bedrooms: p.description?.beds ?? p.beds,
    bathrooms: p.description?.baths ?? p.baths,
    livingArea: p.description?.sqft ?? p.building_size?.size,
    yearBuilt: p.description?.year_built ?? p.year_built,
    estimatedValue: p.estimate?.estimate ?? p.price,
    rentEstimate: p.rental_estimate?.estimate,
    price: p.list_price ?? p.price,
    hoaFee: p.hoa?.fee,
    imgSrc: fixRealtorPhotoUrl(rawImg),
    detailUrl: p.href || (p.property_id ? `https://www.realtor.com/realestateandhomes-detail/${p.property_id}` : null),
    homeType: p.description?.type ?? p.prop_type,
    photos: rawPhotos.map(fixRealtorPhotoUrl).filter(Boolean),
  };
}

// ── Fetch Realtor Listing Data (for address-based search enrichment) ──
async function fetchRealtorListing(address, city, state) {
  const apiKey = localStorage.getItem("realtor_api_key");
  if (!apiKey) return null;
  const headers = { "x-rapidapi-key": apiKey, "x-rapidapi-host": REALTOR_HOST };
  const query = `${address}, ${city || ""}, ${state || "WA"}`.replace(/\s+/g, " ").trim();
  try {
    const resp = await fetch(
      `https://${REALTOR_HOST}/properties/v3/list`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 5, offset: 0, query: query, status: ["for_sale", "ready_to_build", "sold"] })
      }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    const props = data.data?.home_search?.results || data.properties || [];
    if (props.length > 0) return normalizeRealtorResult(props[0]);
  } catch (e) { console.warn("Realtor listing fetch failed:", e.message); }
  return null;
}

// ── Fetch Realtor Property Detail (year built, full details, price history) ──
async function fetchRealtorDetail(propertyId) {
  const apiKey = localStorage.getItem("realtor_api_key");
  if (!apiKey || !propertyId) return null;
  const headers = { "x-rapidapi-key": apiKey, "x-rapidapi-host": REALTOR_HOST };

  // Try multiple endpoint paths — API versions change
  const endpoints = [
    `https://${REALTOR_HOST}/properties/v3/detail?property_id=${encodeURIComponent(propertyId)}`,
    `https://${REALTOR_HOST}/properties/detail?property_id=${encodeURIComponent(propertyId)}`,
    `https://${REALTOR_HOST}/properties/v2/detail?property_id=${encodeURIComponent(propertyId)}`,
  ];

  for (const url of endpoints) {
    try {
      console.log(`Trying detail: ${url}`);
      const resp = await fetch(url, { method: "GET", headers });
      if (resp.ok && resp.status !== 204) {
        const data = await resp.json();
        console.log("Realtor detail response:", JSON.stringify(data).slice(0, 1000));
        const home = data.data?.home || data.data?.property_detail || data.data || data;
        if (home && (home.description || home.property_history || home.year_built)) return home;
      } else {
        console.log(`  → ${resp.status}`);
      }
    } catch (e) { console.warn(`  → error:`, e.message); }
  }

  // POST fallback
  try {
    console.log("Trying detail POST fallback");
    const resp = await fetch(
      `https://${REALTOR_HOST}/properties/v3/detail`,
      { method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ property_id: propertyId }) }
    );
    if (resp.ok && resp.status !== 204) {
      const data = await resp.json();
      return data.data?.home || data.data || null;
    }
  } catch (e) { /* ignore */ }

  return null;
}

// ── Fetch Realtor Price History (standalone or from detail) ──
async function fetchRealtorPriceHistory(propertyId) {
  const apiKey = localStorage.getItem("realtor_api_key");
  if (!apiKey || !propertyId) return [];
  const headers = { "x-rapidapi-key": apiKey, "x-rapidapi-host": REALTOR_HOST };

  const endpoints = [
    `https://${REALTOR_HOST}/properties/v3/get-price-history?property_id=${encodeURIComponent(propertyId)}`,
    `https://${REALTOR_HOST}/properties/get-price-history?property_id=${encodeURIComponent(propertyId)}`,
  ];

  for (const url of endpoints) {
    try {
      const resp = await fetch(url, { method: "GET", headers });
      if (resp.ok && resp.status !== 204) {
        const data = await resp.json();
        console.log("Realtor price history response:", JSON.stringify(data).slice(0, 800));
        const history = data.data?.home?.property_history || data.data?.property_history || data.property_history || [];
        const parsed = history.map(h => ({
          date: h.date ? new Date(h.date) : null,
          price: h.price || h.amount || 0,
          event: h.event_name || h.event || h.listing?.status || "—",
          source: "Realtor",
        })).filter(h => h.price > 0);
        if (parsed.length > 0) return parsed;
      }
    } catch (e) { /* try next */ }
  }
  return [];
}

// ── Build Report ──
async function buildReport(address, unit, realtorListing) {
  const report = {
    query: unit ? `${address} #${unit}` : address,
    sources: [],
    property: {},
    marketValue: {},
    sales: [],
    condition: {},
    hoa: { monthly: null, source: null },
    mortgage: { rate: null, rateSource: null, propertyTax: null },
  };

  // 1) King County Parcel Search (unit-aware for condos/apartments)
  const addrParts = address.toUpperCase().replace(/,/g, " ").split(/\s+/).filter(Boolean);
  let likeClause = addrParts.slice(0, 4).map(p => `ADDR_FULL LIKE '%${p}%'`).join(" AND ");
  // For condo units, KC often stores as "123 MAIN ST #301" or includes unit in ADDR_FULL
  if (unit) {
    likeClause += ` AND ADDR_FULL LIKE '%${unit.toUpperCase()}%'`;
  }
  // Fetch more results for condos to find the right unit
  const maxResults = unit ? 20 : 5;

  try {
    const parcelUrl = `${KC_PARCELS}?where=${encodeURIComponent(likeClause)}&outFields=*&f=json&resultRecordCount=${maxResults}`;
    const parcelResp = await fetch(parcelUrl);
    if (!parcelResp.ok) throw new Error(`HTTP ${parcelResp.status}`);
    const parcelData = await parcelResp.json();

    if (parcelData.error) {
      showToast(`King County API error: ${parcelData.error.message || "Unknown error"}`, "error");
    } else if (parcelData.features && parcelData.features.length > 0) {
      report.sources.push("King County Assessor");
      const p = parcelData.features[0].attributes;

      report.property = {
        pin: p.PIN,
        major: p.MAJOR,
        minor: p.MINOR,
        address: p.ADDR_FULL,
        unit: unit || null,
        city: p.CTYNAME || p.POSTALCTYNAME,
        zip: p.ZIP5,
        lotSqft: p.LOTSQFT,
        lotAcres: p.KCA_ACRES ? parseFloat(p.KCA_ACRES).toFixed(2) : null,
        platName: p.PLAT_NAME,
        propType: p.PROPTYPE,
        zoning: p.KCA_ZONING,
        useDescription: p.PREUSE_DESC,
      };

      report.marketValue.assessedLand = p.APPRLNDVAL;
      report.marketValue.assessedImprovement = p.APPR_IMPR;
      report.marketValue.assessedTotal = (p.APPRLNDVAL || 0) + (p.APPR_IMPR || 0);

      // If multiple matches, list them for disambiguation
      if (parcelData.features.length > 1) {
        report.alternatives = parcelData.features.slice(1).map(f => ({
          address: f.attributes.ADDR_FULL,
          city: f.attributes.CTYNAME,
          pin: f.attributes.PIN,
        }));
      }
    } else {
      showToast("No parcel found in King County records for this address.", "warn");
    }
  } catch (e) {
    console.error("KC Parcel search failed:", e);
    showToast("⚠️ King County Assessor lookup failed. The service may be temporarily unavailable.", "error");
    report._kcParcelError = true;
  }

  // 2) Sales History (last 3 years)
  if (report.property.pin) {
    try {
      const salesUrl = `${KC_SALES}?where=${encodeURIComponent(`PIN='${report.property.pin}'`)}&outFields=*&f=json&resultRecordCount=20`;
      const salesResp = await fetch(salesUrl);
      if (!salesResp.ok) throw new Error(`HTTP ${salesResp.status}`);
      const salesData = await salesResp.json();

      if (salesData.error) {
        showToast(`Sales history lookup error: ${salesData.error.message || "Unknown"}`, "warn");
      } else if (salesData.features && salesData.features.length > 0) {
        report.sales = salesData.features.map(f => {
          const s = f.attributes;
          return {
            date: s.SaleDate ? new Date(s.SaleDate) : null,
            price: s.SalePrice,
            buyer: s.buyername,
            seller: s.Sellername,
            exciseNum: s.ExciseTaxNum,
          };
        }).filter(s => s.price > 0).sort((a, b) => (b.date || 0) - (a.date || 0));
      }
      // no toast if simply empty — the UI section already says "no sales"
    } catch (e) {
      console.error("KC Sales fetch failed:", e);
      showToast("⚠️ Sales history lookup failed. The service may be temporarily unavailable.", "warn");
      report._kcSalesError = true;
    }
  }

  // 4) Load local HOA/Special data
  const localHoa = JSON.parse(localStorage.getItem(`hoa_${report.property.pin}`) || "null");
  if (localHoa && !report.hoa.monthly) {
    report.hoa = { monthly: localHoa.monthly, source: "Manual entry", notes: localHoa.notes };
  }

  return report;
}

// ── Render ──
function fmt(n) {
  if (n == null || isNaN(n)) return "—";
  return "$" + Number(n).toLocaleString();
}
function fmtDate(d) {
  if (!d) return "—";
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

// Full address including unit number
function getFullAddress(p, query) {
  let addr = p.address || query || "";
  const unit = p.unit;
  if (unit && !addr.toLowerCase().includes(unit.toLowerCase())) {
    addr = `${addr} #${unit}`;
  }
  return addr;
}

function renderReport(r) {
  $("results").classList.remove("hidden");

  // Sources
  $("sourcesBanner").textContent = `📡 Data from: ${r.sources.join(" · ") || "No sources returned data"}`;
  if (r.mlsNumber) {
    $("sourcesBanner").textContent += ` | MLS# ${r.mlsNumber}`;
  }
  if (r.alternatives && r.alternatives.length > 0) {
    $("sourcesBanner").textContent += ` | ⚠️ ${r.alternatives.length} other match(es) found — refine address if needed`;
  }

  // Image Gallery
  renderImageGallery(r);

  // Overview
  const p = r.property;
  const overviewItems = [
    det("Address", getFullAddress(p, r.query)),
    det("City / ZIP", [p.city, p.zip].filter(Boolean).join(" ")),
  ];
  if (r.mlsNumber) {
    const mlsLabel = r.mlsSource ? `MLS # (${r.mlsSource})` : "MLS #";
    overviewItems.push(det(mlsLabel, r.mlsNumber));
  }
  if (r.listingId) overviewItems.push(det("Listing ID", r.listingId));
  if (p.homeType) overviewItems.push(det("Home Type", p.homeType));
  overviewItems.push(
    det("Bedrooms", p.bedrooms),
    det("Bathrooms", p.bathrooms),
    det("Sq Ft", p.sqft ? Number(p.sqft).toLocaleString() : null),
    det("Year Built", p.yearBuilt),
  );
  if (p.lotSqft) overviewItems.push(det("Lot Size", `${Number(p.lotSqft).toLocaleString()} sqft (${p.lotAcres || "?"} ac)`));
  if (p.zoning) overviewItems.push(det("Zoning", p.zoning));
  if (p.useDescription) overviewItems.push(det("Use", p.useDescription));
  if (p.platName) overviewItems.push(det("Plat", p.platName));
  if (p.pin) overviewItems.push(det("Parcel (PIN)", p.pin));
  $("overviewDetails").innerHTML = overviewItems.join("");

  // Market Values — only show fields with data
  const mv = r.marketValue;
  const mvItems = [];
  if (mv.assessedTotal) mvItems.push(vbox("Assessed Total", fmt(mv.assessedTotal), mv.taxYear ? `KC ${mv.taxYear}` : "King County"));
  if (mv.assessedLand) mvItems.push(vbox("Land Value", fmt(mv.assessedLand), "Assessment"));
  if (mv.assessedImprovement) mvItems.push(vbox("Improvements", fmt(mv.assessedImprovement), "Assessment"));
  if (mv.zestimate) mvItems.push(vbox("Estimated Value", fmt(mv.zestimate), "Realtor"));
  if (mv.listPrice) mvItems.push(vbox("List Price", fmt(mv.listPrice), "Active listing"));
  if (mvItems.length === 0) mvItems.push(vbox("Market Value", "—", "No data available"));
  $("marketValues").innerHTML = mvItems.join("");

  // Rental estimate
  $("rentalValues").innerHTML = mv.rentZestimate
    ? `<h3 style="font-size:0.95rem;margin:0.8rem 0 0.4rem;color:var(--muted);">🏠 Rental</h3><div class="value-grid">${vbox("Rental Estimate", fmt(mv.rentZestimate) + "/mo", "Realtor")}</div>`
    : "";

  // EMI Calculator — auto-fill inputs from report data
  initEMI(r);

  // Sales & Price History (merged, deduplicated)
  const seenKeys = new Set();
  const allHistory = [];
  // Add actual sales
  for (const s of r.sales) {
    const key = `${s.date?.getTime()}_${s.price}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    allHistory.push({ date: s.date, price: s.price, event: s.buyer && s.buyer !== "—" ? `Sale to ${s.buyer}` : "Sold", source: s.source || "KC Assessor" });
  }
  // Add non-sale price history (listings, tax assessments) that aren't already in sales
  if (r.priceHistory) {
    for (const h of r.priceHistory) {
      if (h.isSale) continue; // already added above
      const key = `${h.date?.getTime()}_${h.price}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      allHistory.push(h);
    }
  }
  allHistory.sort((a, b) => (b.date || 0) - (a.date || 0));

  if (allHistory.length > 0) {
    $("salesEmpty").classList.add("hidden");
    $("salesBody").innerHTML = allHistory.map(s =>
      `<tr><td>${fmtDate(s.date)}</td><td>${fmt(s.price)}</td><td>${s.event || "—"}</td><td>${s.source || "—"}</td></tr>`
    ).join("");
  } else {
    $("salesBody").innerHTML = "";
    $("salesEmpty").classList.remove("hidden");
  }

  // Condition — with helper tooltips
  renderCondition(p, r.condition);

  // Vastu & Buy Analysis — store report globally for direction picker callback
  window._currentReport = r;
  initVastuSection(r);
  renderBuyAnalysis(r);

  // Load saved notes from history
  loadSavedNotes(r);

  // HOA
  const hoa = r.hoa || {};
  $("hoaContent").innerHTML = hoa.monthly
    ? `<div class="hoa-detected">Monthly HOA: ${fmt(hoa.monthly)} <span class="note">(source: ${hoa.source})</span></div>`
    : `<p class="note">No HOA fee found from APIs. Enter manually below if applicable.</p>`;
  if (hoa.monthly) $("hoaManualCost").value = hoa.monthly;
  if (hoa.notes) $("hoaNotes").value = hoa.notes;

  // Special Assessments from localStorage
  const specialData = JSON.parse(localStorage.getItem(`special_${p.pin}`) || "[]");
  renderSpecialList(specialData);

  // Links — More Resources
  const pin = p.pin || "";
  const fullAddr = getFullAddress(p, r.query);
  const city = p.city || "";
  const state = p.state || "WA";
  const zip = p.zip || "";
  const googleAddr = [fullAddr, city, state, zip].filter(Boolean).join(", ");
  const googleEnc = encodeURIComponent(googleAddr);

  const links = [];
  if (pin) {
    links.push(`<a href="https://blue.kingcounty.com/Assessor/eRealProperty/Dashboard.aspx?ParcelNbr=${pin}" target="_blank">🏛️ KC eReal Property</a>`);
    links.push(`<a href="https://gismaps.kingcounty.gov/parcelviewer2/?pin=${pin}" target="_blank">🗺️ Parcel Viewer Map</a>`);
  }
  links.push(
    `<a href="https://www.zillow.com/homes/${googleEnc}_rb/" target="_blank">🏠 Zillow</a>`,
    `<a href="https://www.google.com/maps/search/?api=1&query=${googleEnc}" target="_blank">📍 Google Maps</a>`,
    `<a href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=0,0&pano=&query=${googleEnc}" target="_blank">🛣️ Street View</a>`,
    `<a href="https://earth.google.com/web/search/${googleEnc}" target="_blank">🛰️ Google Earth</a>`,
  );
  $("linksContent").innerHTML = links.join("");

  // Save to search history (slight delay so EMI & buy analysis have finished)
  setTimeout(() => saveToHistory(r), 500);
}

// ── Search History ──
const HISTORY_KEY = "property_search_history";

function getSearchHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); }
  catch { return []; }
}

function saveToHistory(r) {
  const mv = r.marketValue || {};
  const p = r.property || {};

  // Only save if we actually found meaningful data
  if (!p.address && !r.query) return;
  if (!mv.assessedTotal && !mv.zestimate && !mv.listPrice && !p.yearBuilt && !p.bedrooms) return;

  const hoa = r.hoa || {};
  const mort = r.mortgage || {};

  // Read EMI inputs for current values
  const emiRate = parseFloat($("emiRate")?.value) || null;
  const emiTax = parseFloat($("emiTax")?.value) || null;
  const emiInsurance = parseFloat($("emiInsurance")?.value) || null;
  const emiPrice = parseFloat($("emiPrice")?.value) || null;
  const emiDown = parseFloat($("emiDown")?.value) || 20;
  const emiTerm = parseInt($("emiTerm")?.value) || 30;

  // Calculate total monthly from EMI inputs
  let totalMonthly = null;
  if (emiPrice) {
    const loan = emiPrice * (1 - emiDown / 100);
    const mr = (emiRate || 6.13) / 100 / 12;
    const n = emiTerm * 12;
    const pi = mr > 0 ? loan * (mr * Math.pow(1 + mr, n)) / (Math.pow(1 + mr, n) - 1) : loan / n;
    totalMonthly = Math.round(pi + (emiTax || 0) / 12 + (emiInsurance || 0) / 12 + (hoa.monthly || 0) + (emiDown < 20 ? loan * 0.007 / 12 : 0));
  }

  const entry = {
    id: Date.now(),
    date: new Date().toISOString(),
    address: getFullAddress(p, r.query),
    city: p.city || "",
    state: p.state || "WA",
    zip: p.zip || "",
    buyScore: r._buyScore ?? null,
    buyVerdict: r._buyVerdict ?? null,
    vastuDir: r._vastuDir || null,
    vastuRating: r._vastuRating || null,
    hoaMonthly: hoa.monthly || null,
    hoaCovers: getHoaCovers() || null,
    notes: ($("userNotes")?.value || "").trim() || null,
    marketValue: mv.assessedTotal || mv.zestimate || null,
    listPrice: mv.listPrice || null,
    totalMonthly,
    rate: emiRate,
    propertyTax: emiTax,
    insurance: emiInsurance,
    bedrooms: p.bedrooms || null,
    bathrooms: p.bathrooms || null,
    sqft: p.sqft || null,
    yearBuilt: p.yearBuilt || null,
  };

  const history = getSearchHistory();
  // Don't duplicate — if same address exists, update it in place
  const existingIdx = history.findIndex(h => h.address === entry.address);
  if (existingIdx >= 0) {
    entry.id = history[existingIdx].id; // keep original id
    // Preserve notes/hoaCovers if not currently set but existed before
    if (!entry.notes && history[existingIdx].notes) entry.notes = history[existingIdx].notes;
    if (!entry.hoaCovers && history[existingIdx].hoaCovers) entry.hoaCovers = history[existingIdx].hoaCovers;
    history.splice(existingIdx, 1); // remove old
  }
  history.unshift(entry); // add updated entry at top
  // Keep last 50 entries
  if (history.length > 50) history.length = 50;
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  renderSearchHistory();
}

// Recalculate EMI and save updated entry to history
function recalculateEMI() {
  calculateEMI();
  const r = window._currentReport;
  if (r) saveToHistory(r);
}

// Save notes & HOA coverage to history
function saveNotes() {
  const r = window._currentReport;
  if (r) {
    saveToHistory(r);
    showToast("Notes saved to history ✅", "info");
  } else {
    showToast("Search for a property first.", "warn");
  }
}

// Get checked HOA items as comma-separated string
function getHoaCovers() {
  const checked = [];
  document.querySelectorAll("#hoaCheckboxes input[type=checkbox]:checked").forEach(cb => {
    checked.push(cb.value);
  });
  const other = ($("hoaCoversOther")?.value || "").trim();
  if (other) checked.push(...other.split(",").map(s => s.trim()).filter(Boolean));
  return checked.length ? checked.join(", ") : null;
}

// Set HOA checkboxes from a comma-separated string
function setHoaCovers(str) {
  // Uncheck all first
  document.querySelectorAll("#hoaCheckboxes input[type=checkbox]").forEach(cb => { cb.checked = false; });
  if ($("hoaCoversOther")) $("hoaCoversOther").value = "";
  if (!str) return;

  const items = str.split(",").map(s => s.trim()).filter(Boolean);
  const checkboxValues = new Set();
  document.querySelectorAll("#hoaCheckboxes input[type=checkbox]").forEach(cb => {
    checkboxValues.add(cb.value);
  });

  const otherItems = [];
  items.forEach(item => {
    const cb = document.querySelector(`#hoaCheckboxes input[value="${item}"]`);
    if (cb) {
      cb.checked = true;
    } else if (!checkboxValues.has(item)) {
      otherItems.push(item);
    }
  });
  if (otherItems.length && $("hoaCoversOther")) {
    $("hoaCoversOther").value = otherItems.join(", ");
  }
}

// Load saved notes/hoaCovers from history when displaying a property
function loadSavedNotes(report) {
  const addr = getFullAddress(report.property || {}, report.query);
  const history = getSearchHistory();
  const existing = history.find(h => h.address === addr);
  if (existing) {
    if ($("userNotes")) $("userNotes").value = existing.notes || "";
    setHoaCovers(existing.hoaCovers || "");
  } else {
    if ($("userNotes")) $("userNotes").value = "";
    setHoaCovers("");
  }
}

function renderSearchHistory() {
  const history = getSearchHistory();
  const el = $("historyCount");
  if (el) el.textContent = history.length;
}

// Load history count on page load
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => renderSearchHistory());
} else {
  renderSearchHistory();
}

// ── Monthly Cost / EMI Calculator ──
const EMI_COLORS = {
  pi: "#4f46e5",     // Principal & Interest — indigo
  tax: "#f59e0b",    // Property Tax — amber
  ins: "#10b981",    // Insurance — green
  hoa: "#ef4444",    // HOA — red
  pmi: "#8b5cf6",    // PMI — purple
};

async function fetchCurrentMortgageRate() {
  // Try Zillow-style average; fall back to a sensible default
  try {
    const resp = await fetch("https://api.api-ninjas.com/v1/interestrate?country=United States", {
      headers: { "X-Api-Key": "FREE_TIER" },
    });
    if (resp.ok) {
      const data = await resp.json();
      const fed = data.central_bank_rates?.[0]?.rate_pct;
      if (fed) return { rate: (fed + 2.5).toFixed(2), source: "Est. from Fed rate" };
    }
  } catch (e) { /* ignore */ }
  return { rate: "6.13", source: "Avg 30yr fixed (Apr 2026)" };
}

async function initEMI(r) {
  const mv = r.marketValue;
  const homePrice = mv.listPrice || mv.zestimate || mv.assessedTotal || 0;
  const hoa = r.hoa?.monthly || 0;
  const mort = r.mortgage || {};

  // Set home price
  $("emiPrice").value = homePrice || "";

  // Interest rate: from Realtor detail → or fetch current rate
  let rate = mort.rate;
  let rateSource = "Realtor mortgage data";
  if (!rate) {
    const fetched = await fetchCurrentMortgageRate();
    rate = parseFloat(fetched.rate);
    rateSource = fetched.source;
  }
  $("emiRate").value = rate || "6.13";
  $("emiRateSource").textContent = `📊 Rate source: ${rateSource}`;

  // Property tax
  const annualTax = mort.propertyTax || (mv.assessedTotal ? Math.round(mv.assessedTotal * 0.01) : 0);
  $("emiTax").value = annualTax || "";

  // HOA
  $("emiHoa").value = hoa || "";

  // Insurance estimate: ~0.35% of home value per year for WA
  const annualInsurance = mort.insurance || (homePrice ? Math.round(homePrice * 0.0035) : 1500);
  $("emiInsurance").value = annualInsurance || "";

  // Down payment default 20%
  $("emiDown").value = 10;

  // Calculate
  calculateEMI();
}

function calculateEMI() {
  const price = parseFloat($("emiPrice").value) || 0;
  const downPct = parseFloat($("emiDown").value) || 20;
  const rate = parseFloat($("emiRate").value) || 6.13;
  const termYears = parseInt($("emiTerm").value) || 30;
  const annualTax = parseFloat($("emiTax").value) || 0;
  const monthlyHoa = parseFloat($("emiHoa").value) || 0;
  const annualInsurance = parseFloat($("emiInsurance").value) || 0;

  if (price <= 0) {
    $("emiBreakdown").innerHTML = `<p class="note" style="grid-column:1/-1">Enter a home price to see the monthly breakdown.</p>`;
    return;
  }

  const downPayment = price * (downPct / 100);
  const loanAmount = price - downPayment;
  const monthlyRate = rate / 100 / 12;
  const numPayments = termYears * 12;

  // P&I calculation
  let monthlyPI = 0;
  if (monthlyRate > 0 && numPayments > 0) {
    monthlyPI = loanAmount * (monthlyRate * Math.pow(1 + monthlyRate, numPayments)) / (Math.pow(1 + monthlyRate, numPayments) - 1);
  } else {
    monthlyPI = loanAmount / numPayments;
  }

  const monthlyTax = annualTax / 12;
  const monthlyInsurance = annualInsurance / 12;

  // PMI: required if down < 20%, typically 0.5-1% of loan/year
  const monthlyPMI = downPct < 20 ? (loanAmount * 0.007) / 12 : 0;

  const totalMonthly = monthlyPI + monthlyTax + monthlyInsurance + monthlyHoa + monthlyPMI;

  // Build breakdown
  const items = [
    { label: "Principal & Interest", value: monthlyPI, color: EMI_COLORS.pi },
    { label: "Property Tax", value: monthlyTax, color: EMI_COLORS.tax },
    { label: "Insurance", value: monthlyInsurance, color: EMI_COLORS.ins },
  ];
  if (monthlyHoa > 0) items.push({ label: "HOA", value: monthlyHoa, color: EMI_COLORS.hoa });
  if (monthlyPMI > 0) items.push({ label: "PMI", value: monthlyPMI, color: EMI_COLORS.pmi });

  let html = "";

  // Total bar first
  html += `<div class="emi-item emi-total"><span class="emi-label">Total Monthly Payment</span><span class="emi-value">${fmtEMI(totalMonthly)}/mo</span></div>`;

  // Stacked color bar
  html += `<div class="emi-bar-container"><div class="emi-bar">`;
  for (const it of items) {
    const pct = totalMonthly > 0 ? (it.value / totalMonthly * 100) : 0;
    html += `<div style="width:${pct.toFixed(1)}%;background:${it.color}" title="${it.label}: ${fmtEMI(it.value)}"></div>`;
  }
  html += `</div><div class="emi-legend">`;
  for (const it of items) {
    html += `<span style="--dot-color:${it.color}"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${it.color};margin-right:4px;vertical-align:middle;"></span>${it.label}</span>`;
  }
  html += `</div></div>`;

  // Individual items
  for (const it of items) {
    html += `<div class="emi-item"><span class="emi-label">${it.label}</span><span class="emi-value">${fmtEMI(it.value)}</span></div>`;
  }

  // Loan summary line
  html += `<div class="emi-item" style="grid-column:1/-1;background:none;border-top:1px solid var(--border);padding-top:0.8rem;">
    <span class="emi-label">Loan: ${fmtEMI(loanAmount)} @ ${rate}% for ${termYears}yr · Down: ${fmtEMI(downPayment)} (${downPct}%)</span>
    <span class="emi-value" style="font-size:0.85rem">Total paid: ${fmtEMI(totalMonthly * numPayments)}</span>
  </div>`;

  $("emiBreakdown").innerHTML = html;
}

function fmtEMI(n) {
  if (n == null || isNaN(n)) return "$0";
  return "$" + Math.round(n).toLocaleString();
}

// ── Vastu Shastra Analysis ──
const VASTU_DATA = {
  N:  { score: 85, rating: "Very Good", emoji: "🟢",
        summary: "North-facing entrance is excellent for wealth and career growth.",
        details: `<strong>Ruling deity:</strong> Kubera (god of wealth &amp; treasure).<br>
<strong>Element:</strong> Water.<br>
<strong>Planets:</strong> Mercury &amp; Jupiter.<br><br>
A north-facing door invites the magnetic energy of the Earth, which flows from the North Pole. Kubera's blessings make this ideal for professionals, business owners, and anyone seeking financial prosperity. The north is associated with career advancement, networking, and steady income flow.<br><br>
<strong>Best for:</strong> Finance professionals, entrepreneurs, IT workers, consultants.<br>
<strong>Interior tips:</strong> Keep the north side of the home open and clutter-free. A small water fountain or fish aquarium in the north living area amplifies wealth energy. Use light blues and greens near the entrance.`,
        remedies: "No major remedies needed. Maintain a clean, clutter-free entrance. Enhance with a <strong>small water feature</strong> (fountain or aquarium) in the north area. Use light blue/green door or mat. Keep shoes organized and away from the main door. A <strong>Kubera Yantra</strong> behind the door is considered beneficial." },

  NE: { score: 95, rating: "Excellent", emoji: "🟢",
        summary: "Northeast is the most auspicious direction in Vastu — the 'Ishaan' corner.",
        details: `<strong>Ruling deity:</strong> Lord Shiva (Ishaan — the supreme lord).<br>
<strong>Element:</strong> Water + Ether (space).<br>
<strong>Planets:</strong> Jupiter (Guru).<br><br>
The northeast corner is called "Ishaan Kon" — the most sacred and powerful direction in Vastu Shastra. The first rays of the rising sun enter through the northeast, bringing divine energy, wisdom, and spiritual growth. This is considered the direction from which all positive cosmic energy flows into a home.<br><br>
<strong>Best for:</strong> Everyone — especially families seeking harmony, students, spiritual practitioners, and those wanting all-around prosperity.<br>
<strong>Interior tips:</strong> Keep the NE area at a lower level than the rest of the house. A prayer room or meditation space here is ideal. Never place a toilet or heavy storage in the NE corner. Water elements (fountain, aquarium) in the NE are extremely auspicious.`,
        remedies: "No remedies needed — this is the best possible entrance direction! To maximize its benefit: keep the entrance spotlessly clean, ensure it opens inward, install bright warm lighting, and place fresh flowers or a Tulsi plant near the door. A <strong>Swastik</strong> or <strong>Om symbol</strong> on the door enhances positive energy." },

  E:  { score: 90, rating: "Excellent", emoji: "🟢",
        summary: "East-facing entrance brings health, positivity, and social reputation.",
        details: `<strong>Ruling deity:</strong> Indra (king of gods) &amp; Surya (Sun god).<br>
<strong>Element:</strong> Fire (Agni) — solar energy.<br>
<strong>Planets:</strong> Sun.<br><br>
The east represents the rising sun — the most powerful source of positive energy. An east-facing entrance floods the home with morning sunlight, providing natural Vitamin D, killing bacteria, and uplifting the mood of residents. Indra blesses the household with fame, leadership, and social standing.<br><br>
<strong>Best for:</strong> Families with children, government employees, leaders, teachers, and anyone seeking health and recognition.<br>
<strong>Interior tips:</strong> Keep the east side open with large windows. Never block the east with tall structures or heavy curtains. A living room or study in the east section is ideal. Use warm golden or orange tones for the entrance.`,
        remedies: "No major remedies needed. To enhance: use a <strong>bright yellow or golden door</strong>. Hang a <strong>Sun symbol</strong> (Surya Yantra) near the entrance. Ensure morning light can enter — avoid heavy curtains on east-facing windows. Place a <strong>Tulsi plant</strong> or flowering plants near the entrance." },

  SE: { score: 55, rating: "Average", emoji: "🟡",
        summary: "Southeast is the fire corner — can bring aggression and health issues if not balanced.",
        details: `<strong>Ruling deity:</strong> Agni (god of fire).<br>
<strong>Element:</strong> Fire.<br>
<strong>Planets:</strong> Venus (Shukra).<br><br>
The southeast is dominated by Agni (fire element). While fire is essential for cooking and transformation, an entrance here can amplify aggressive energy, leading to arguments among family members, legal disputes, and health problems (especially digestive and inflammation-related). Women in the household may face particular stress.<br><br>
However, a kitchen placed in the SE corner is considered excellent — the fire element is in its natural position there.<br><br>
<strong>Impact areas:</strong> Relationships (conflicts), health (acidity, blood pressure, inflammation), legal matters, financial disputes.<br>
<strong>Who should be cautious:</strong> Families with young children, couples, and people prone to anger.`,
        remedies: `<strong>Essential remedies for SE entrance:</strong><br>
• Place a <strong>water fountain or small aquarium</strong> just inside the entrance to counter fire energy<br>
• Use <strong>green and blue colors</strong> for the door and entrance mat — these cool down fire<br>
• Add <strong>live green plants</strong> on both sides of the main door<br>
• Install <strong>bright white (not yellow) lighting</strong> at the entrance<br>
• <strong>Avoid red, orange, or maroon</strong> colors anywhere near the entrance<br>
• Place a <strong>Ganesha idol</strong> at the entrance facing outward<br>
• Keep a <strong>bowl of sea salt</strong> near the entrance (replace monthly) to absorb negative energy<br>
• A <strong>brass or copper threshold strip</strong> at the base of the door reduces negative effects` },

  S:  { score: 45, rating: "Below Average", emoji: "🟠",
        summary: "South-facing entrance is generally not recommended — associated with Yama (god of death).",
        details: `<strong>Ruling deity:</strong> Yama (god of death &amp; dharma).<br>
<strong>Element:</strong> Earth.<br>
<strong>Planets:</strong> Mars (Mangal).<br><br>
The south direction is ruled by Yama, which in Vastu creates an association with obstacles, endings, and heavy energy. A south entrance can bring health challenges (chronic fatigue, depression), financial stress, career stagnation, and general feeling of heaviness in the household.<br><br>
<strong>Important nuance — Padas (segments):</strong> The south wall is divided into 9 padas. Not all are equally negative:<br>
• <strong>S3 (center-south):</strong> Most acceptable — associated with Gruhakshata, reasonably positive<br>
• <strong>S4 (slightly toward SW):</strong> Worst segment — direct Yama influence<br>
• <strong>S1-S2 (toward SE):</strong> Moderate — fire element helps somewhat<br><br>
<strong>Impact areas:</strong> Health (fatigue, depression), finances (unexpected expenses), career (slow progress), family harmony.<br>
<strong>Who is most affected:</strong> People with weak Mars in their horoscope, elderly residents.`,
        remedies: `<strong>Essential remedies for South entrance:</strong><br>
• Install a <strong>heavy brass or copper threshold strip</strong> at the door base — this is the single most important remedy<br>
• Place a <strong>Vastu pyramid</strong> or <strong>Vastu Dosh Nivaran Yantra</strong> above the door frame<br>
• Use <strong>bright lighting</strong> at the entrance — NEVER keep a south entrance dark<br>
• Paint the door <strong>green or blue</strong> — absolutely avoid black, dark brown, or red<br>
• Place a small <strong>Ganesha idol</strong> (facing outward) at the entrance<br>
• Keep a <strong>red colored mat</strong> outside and a <strong>green mat</strong> inside the door<br>
• Hang a <strong>wind chime with 5 rods</strong> (Panch Dhatu) near the entrance<br>
• Place <strong>9 green plants</strong> along the south wall outside if possible<br>
• A <strong>Hanuman idol or picture</strong> near the entrance provides protection<br>
• <strong>Never leave the south door open</strong> unnecessarily — keep it closed when not in use` },

  SW: { score: 30, rating: "Poor", emoji: "🔴",
        summary: "Southwest entrance is the most inauspicious in Vastu — ruled by Nirrti (demon of dissolution).",
        details: `<strong>Ruling deity:</strong> Nirrti (demon of dissolution &amp; decay).<br>
<strong>Element:</strong> Earth (heavy, stagnant).<br>
<strong>Planets:</strong> Rahu (shadow planet of confusion).<br><br>
The southwest is considered the most negative direction for an entrance in Vastu Shastra. Nirrti represents destruction, dissolution, and decay. Rahu's influence adds confusion, deception, and unexpected setbacks. This direction carries the heaviest and most stagnant energy.<br><br>
<strong>Potential effects:</strong><br>
• <strong>Health:</strong> Chronic illnesses, unexplained fatigue, joint pain, depression, anxiety<br>
• <strong>Finance:</strong> Consistent financial losses, bad investments, unexpected legal expenses<br>
• <strong>Relationships:</strong> Marital discord, trust issues, family conflicts, isolation<br>
• <strong>Career:</strong> Sudden job loss, backstabbing by colleagues, stalled promotions<br>
• <strong>General:</strong> A persistent feeling of "nothing goes right" despite best efforts<br><br>
<strong>Severity:</strong> This is a <strong>major Vastu dosha</strong> (defect). If you are considering purchasing this property, factor this heavily into your decision. Professional Vastu consultation is strongly recommended.`,
        remedies: `<strong>Critical remedies for SW entrance (professional consultation recommended):</strong><br>
• <strong>Heavy brass/copper threshold strip</strong> — use the thickest available<br>
• <strong>Vastu pyramid</strong> above the door frame AND a <strong>lead metal strip</strong> embedded under the threshold<br>
• Place a <strong>Swastik symbol</strong> in copper/brass on the door<br>
• <strong>Heavy stone or metal guardian statues</strong> (lions, elephants) flanking the entrance<br>
• Keep the entrance <strong>extremely well-lit 24/7</strong> — use warm bright lights<br>
• Place a <strong>large Ganesha idol</strong> facing outward near the entrance<br>
• Paint the door <strong>yellow or cream</strong> — never dark colors<br>
• Keep a <strong>pair of elephant figurines</strong> (trunks raised) on both sides<br>
• Place <strong>sea salt in all four corners</strong> of the entrance area (replace weekly)<br>
• A <strong>Vastu Dosh Nivaran Yantra</strong> energized by a priest is highly recommended<br>
• Consider using an <strong>alternate entrance</strong> if the property has a side or back door in a better direction<br>
• <strong>Never store valuables, cash, or important documents</strong> near the SW entrance` },

  W:  { score: 65, rating: "Good", emoji: "🟢",
        summary: "West-facing entrance is acceptable and can bring prosperity through sustained effort.",
        details: `<strong>Ruling deity:</strong> Varuna (god of water, rain, and the cosmic order).<br>
<strong>Element:</strong> Water.<br>
<strong>Planets:</strong> Saturn (Shani).<br><br>
The west direction is ruled by Varuna and influenced by Saturn. This brings a methodical, disciplined energy — prosperity comes through hard work and patience rather than sudden windfalls. The evening sun brings warmth and golden light into a west-facing home.<br><br>
<strong>Best for:</strong> People in entertainment, media, politics, public relations, and creative fields. Also good for people who work late hours (the afternoon/evening sun energizes).<br><br>
<strong>Interior tips:</strong> The master bedroom in the SW corner of a west-facing home is ideal. Keep the west entrance well-lit. A metal or iron nameplate is beneficial.<br>
<strong>Note:</strong> Saturn's influence means results come slowly but are long-lasting. Patience is key with a west-facing home.`,
        remedies: "Mild remedies to enhance positive energy: use a <strong>blue or grey door</strong> (Saturn's colors). Install a <strong>metal nameplate</strong> on the door. Place a <strong>pair of elephants</strong> near the entrance. Use <strong>white or cream door mat</strong>. Keep the entrance well-lit in the evening hours. A <strong>small Ganesha idol</strong> on the door is always beneficial." },

  NW: { score: 60, rating: "Moderate", emoji: "🟡",
        summary: "Northwest entrance brings mobility and change — beneficial for some, destabilizing for others.",
        details: `<strong>Ruling deity:</strong> Vayu (god of wind &amp; air).<br>
<strong>Element:</strong> Air.<br>
<strong>Planets:</strong> Moon (Chandra).<br><br>
The northwest is governed by Vayu (wind), which brings constant movement and change. The Moon's influence adds emotional fluctuation. This direction can be beneficial for people who thrive on change — but unsettling for those seeking stability.<br><br>
<strong>Positive effects:</strong> Good social connections, travel opportunities, networking success, quick sales (good for property investors who want to sell), helpful for careers in banking, travel, logistics, and trading.<br><br>
<strong>Negative effects:</strong> Frequent relocations, inability to settle down, restlessness, emotional instability, guests overstaying welcome, money flowing out quickly.<br><br>
<strong>Best for:</strong> Young professionals, business travelers, property investors, people in logistics/travel.<br>
<strong>Not ideal for:</strong> Retirees, families with young children, people seeking long-term stability.`,
        remedies: `<strong>Remedies to add stability to NW entrance:</strong><br>
• Use <strong>earthy tones</strong> (brown, beige, terracotta, yellow) for the door and mat<br>
• Place <strong>heavy furniture</strong> or a solid console table near the entrance — weight counters wind<br>
• <strong>Avoid wind chimes</strong> at this door — they amplify Vayu's restless energy<br>
• Add a <strong>pair of heavy elephant figurines</strong> (trunks down for grounding) near the entrance<br>
• Use <strong>square or rectangular shapes</strong> in entrance decor (earth shapes ground air energy)<br>
• A <strong>yellow or golden door mat</strong> activates earth element<br>
• Keep <strong>heavy stone planters</strong> with stable plants (no hanging or swaying plants) near the entrance` },
};

function estimateDirection(address) {
  if (!address) return null;
  const addr = address.toUpperCase();

  const isAve = /\bAVE\b|\bAVENUE\b/.test(addr);
  const isWay = /\bWAY\b/.test(addr);
  const isDr = /\bDR\b|\bDRIVE\b/.test(addr);
  const isBlvd = /\bBLVD\b|\bBOULEVARD\b/.test(addr);
  const isSt = /\bST\b|\bSTREET\b/.test(addr);
  const isPl = /\bPL\b|\bPLACE\b/.test(addr);
  const isCt = /\bCT\b|\bCOURT\b/.test(addr);
  const isLn = /\bLN\b|\bLANE\b/.test(addr);
  const isNS = isAve || isWay || isDr || isBlvd;
  const isEW = isSt || isPl || isCt || isLn;

  const hasNE = /\bNE\b/.test(addr);
  const hasNW = /\bNW\b/.test(addr);
  const hasSE = /\bSE\b/.test(addr);
  const hasSW = /\bSW\b/.test(addr);

  const roadType = isAve ? "Avenue" : isWay ? "Way" : isDr ? "Drive" : isBlvd ? "Boulevard"
    : isSt ? "Street" : isPl ? "Place" : isCt ? "Court" : isLn ? "Lane" : null;
  const quadrant = hasNE ? "NE" : hasNW ? "NW" : hasSE ? "SE" : hasSW ? "SW" : null;

  let dir = null;
  let reasoning = [];

  if (isNS) {
    reasoning.push(`"${roadType}" roads in King County typically run <strong>North–South</strong>.`);
    reasoning.push("Houses on N–S roads face either <strong>East</strong> or <strong>West</strong>.");
    if (hasNE || hasSE) {
      dir = "W";
      reasoning.push(`The address is in the <strong>${quadrant} quadrant</strong>. On the east side of a N–S road, the front door typically faces <strong>West</strong> (toward the road).`);
    } else if (hasNW || hasSW) {
      dir = "E";
      reasoning.push(`The address is in the <strong>${quadrant} quadrant</strong>. On the west side of a N–S road, the front door typically faces <strong>East</strong> (toward the road).`);
    } else {
      dir = "E";
      reasoning.push("No quadrant suffix found — defaulting to <strong>East</strong>-facing (most common for avenues).");
    }
  } else if (isEW) {
    reasoning.push(`"${roadType}" roads in King County typically run <strong>East–West</strong>.`);
    reasoning.push("Houses on E–W roads face either <strong>North</strong> or <strong>South</strong>.");
    if (hasNE || hasNW) {
      dir = "S";
      reasoning.push(`The address is in the <strong>${quadrant} quadrant</strong>. On the north side of an E–W road, the front door typically faces <strong>South</strong> (toward the road).`);
    } else if (hasSE || hasSW) {
      dir = "N";
      reasoning.push(`The address is in the <strong>${quadrant} quadrant</strong>. On the south side of an E–W road, the front door typically faces <strong>North</strong> (toward the road).`);
    } else {
      dir = "N";
      reasoning.push("No quadrant suffix found — defaulting to <strong>North</strong>-facing (most common for streets).");
    }
  }

  if (!dir) {
    reasoning.push("Could not determine road orientation from the address. No AVE/ST/DR/WAY/PL/CT/LN found.");
  } else {
    reasoning.push(`<br><strong>⚠️ This is an estimate</strong> based on King County street naming conventions. Actual door direction can differ due to corner lots, cul-de-sacs, angled roads, or apartment building layouts. <strong>Verify with Google Street View</strong> or an in-person visit, then click the correct direction on the compass above.`);
  }

  return { dir, reasoning };
}

function initVastuSection(report) {
  const addr = report.property.address || report.query;
  const estimation = estimateDirection(addr);
  const estimatedDir = estimation?.dir || null;
  const pin = report.property.pin;
  const saved = pin ? localStorage.getItem(`vastu_dir_${pin}`) : null;
  const dir = saved || estimatedDir;

  // Store on report for history
  report._vastuDir = dir;
  if (dir && VASTU_DATA[dir]) {
    report._vastuRating = VASTU_DATA[dir].rating;
  }

  // Highlight the estimated/saved direction button
  document.querySelectorAll(".dir-btn").forEach(b => b.classList.remove("active", "estimated"));
  if (dir) {
    const btn = document.querySelector(`.dir-btn[data-dir="${dir}"]`);
    if (btn) {
      btn.classList.add(saved ? "active" : "estimated");
      renderVastu(dir);
    }
  }

  // Show how direction was detected
  let noteHtml = "";
  if (saved) {
    noteHtml = `✅ <strong>${saved}-facing</strong> — you manually selected this direction for this property. Click a different direction to change.`;
  } else if (estimatedDir && estimation.reasoning) {
    noteHtml = `<details class="detection-details"><summary>🤖 Auto-estimated: <strong>${estimatedDir}</strong>-facing — click to see how</summary>
      <div class="detection-reasoning">
        <p><strong>Address analyzed:</strong> ${addr}</p>
        <ol>${estimation.reasoning.map(r => `<li>${r}</li>`).join("")}</ol>
      </div>
    </details>`;
  } else {
    noteHtml = `⚠️ Could not auto-detect direction from the address "<em>${addr}</em>". Please select manually using the compass above, or check <a href="https://www.google.com/maps/search/${encodeURIComponent(addr)}" target="_blank">Google Street View</a>.`;
  }
  $("directionAutoNote").innerHTML = noteHtml;
}

function setDirection(dir, btn) {
  document.querySelectorAll(".dir-btn").forEach(b => b.classList.remove("active", "estimated"));
  btn.classList.add("active");
  renderVastu(dir);

  // Save to localStorage
  const pin = window._currentReport?.property?.pin;
  if (pin) localStorage.setItem(`vastu_dir_${pin}`, dir);

  // Update report and save to history
  if (window._currentReport) {
    window._currentReport._vastuDir = dir;
    window._currentReport._vastuRating = VASTU_DATA[dir]?.rating || null;
    saveToHistory(window._currentReport);
  }

  // Re-run buy analysis with new Vastu score
  if (window._currentReport) renderBuyAnalysis(window._currentReport, dir);
}

function renderVastu(dir) {
  const v = VASTU_DATA[dir];
  if (!v) return;

  const barColor = v.score >= 70 ? "var(--green)" : v.score >= 50 ? "#f59e0b" : "var(--red)";
  const remedyTitle = v.score >= 70 ? "✨ Enhancement Tips" : v.score >= 50 ? "🔧 Vastu Remedies" : "🚨 Important Vastu Remedies";

  $("vastuResult").innerHTML = `
    <div class="vastu-score-row">
      <div class="vastu-score-circle" style="border-color: ${barColor}">
        <span class="vastu-score-num">${v.score}</span>
        <span class="vastu-score-label">/ 100</span>
      </div>
      <div class="vastu-score-info">
        <div class="vastu-rating">${v.emoji} ${v.rating} — ${dir}-Facing Entrance</div>
        <div class="vastu-summary">${v.summary}</div>
      </div>
    </div>
    <div class="vastu-details">
      <h3>📖 Detailed Vastu Analysis</h3>
      <div class="vastu-details-body">${v.details}</div>
    </div>
    <div class="vastu-remedies">
      <h3>${remedyTitle}</h3>
      <div class="vastu-remedies-body">${v.remedies}</div>
    </div>
  `;
}

// ── Good Buy Analysis ──
function renderBuyAnalysis(r, overrideDir) {
  const factors = [];
  let totalScore = 0;
  let maxScore = 0;

  // 1. Price vs Assessed Value
  const listPrice = r.marketValue.listPrice || r.marketValue.zestimate;
  const assessed = r.marketValue.assessedTotal;
  if (listPrice && assessed && assessed > 0) {
    const ratio = listPrice / assessed;
    let pts, verdict;
    if (ratio <= 1.0) { pts = 10; verdict = "Priced at or below assessed value — great deal"; }
    else if (ratio <= 1.15) { pts = 8; verdict = "Priced within 15% of assessed value — fair"; }
    else if (ratio <= 1.3) { pts = 5; verdict = "Priced 15-30% above assessed value — slightly high"; }
    else { pts = 2; verdict = "Priced significantly above assessed value — may be overpriced"; }
    factors.push({ name: "Price vs Assessed Value", score: pts, max: 10, icon: "💲", detail: `List/Estimated: ${fmt(listPrice)} vs Assessed: ${fmt(assessed)} (${Math.round(ratio * 100)}%). ${verdict}.` });
    totalScore += pts; maxScore += 10;
  }

  // 3. Property Age & Condition
  const yearBuilt = r.property.yearBuilt;
  if (yearBuilt) {
    const age = new Date().getFullYear() - yearBuilt;
    let pts, verdict;
    if (age <= 5) { pts = 10; verdict = "New construction — minimal maintenance expected"; }
    else if (age <= 15) { pts = 8; verdict = "Modern build — likely in good condition"; }
    else if (age <= 30) { pts = 6; verdict = "May need updates to kitchen/bath/roof soon"; }
    else if (age <= 50) { pts = 4; verdict = "Expect significant maintenance — check roof, HVAC, plumbing"; }
    else { pts = 2; verdict = "Older home — budget for major system replacements"; }
    factors.push({ name: "Property Age", score: pts, max: 10, icon: "🏗️", detail: `Built ${yearBuilt} (${age} years old). ${verdict}.` });
    totalScore += pts; maxScore += 10;
  }

  // 4. Lot Size
  const lotSqft = r.property.lotSqft;
  if (lotSqft) {
    const lot = Number(lotSqft);
    let pts, verdict;
    if (lot >= 10000) { pts = 10; verdict = "Large lot — room for additions, ADU potential, great outdoor space"; }
    else if (lot >= 7000) { pts = 7; verdict = "Average Eastside lot — decent yard space"; }
    else if (lot >= 4000) { pts = 5; verdict = "Smaller lot — typical for newer developments or condos"; }
    else { pts = 3; verdict = "Very small lot or condo — limited outdoor space"; }
    factors.push({ name: "Lot Size", score: pts, max: 10, icon: "📐", detail: `${lot.toLocaleString()} sqft. ${verdict}.` });
    totalScore += pts; maxScore += 10;
  }

  // 5. HOA Cost
  const hoaMonthly = r.hoa?.monthly;
  if (hoaMonthly !== null && hoaMonthly !== undefined) {
    const hoa = Number(hoaMonthly);
    let pts, verdict;
    if (hoa === 0) { pts = 10; verdict = "No HOA — full control over your property"; }
    else if (hoa <= 200) { pts = 8; verdict = "Low HOA — reasonable for common area maintenance"; }
    else if (hoa <= 500) { pts = 5; verdict = "Moderate HOA — check what's included (pool, gym, etc.)"; }
    else if (hoa <= 800) { pts = 3; verdict = "High HOA — factor this into monthly cost carefully"; }
    else { pts = 1; verdict = "Very high HOA — significant ongoing cost, verify what it covers"; }
    factors.push({ name: "HOA Cost", score: pts, max: 10, icon: "🏘️", detail: `$${hoa}/month. ${verdict}.` });
    totalScore += pts; maxScore += 10;
  }

  // 6. Vastu Score
  const pin = r.property.pin;
  const vastuDir = overrideDir || (pin ? localStorage.getItem(`vastu_dir_${pin}`) : null) || estimateDirection(r.property.address || r.query);
  if (vastuDir && VASTU_DATA[vastuDir]) {
    const v = VASTU_DATA[vastuDir];
    const pts = Math.round(v.score / 10); // normalize to 0-10
    factors.push({ name: "Vastu Score", score: pts, max: 10, icon: "🧭", detail: `${vastuDir}-facing entrance: ${v.rating} (${v.score}/100). ${v.summary}` });
    totalScore += pts; maxScore += 10;
  }

  // 7. Zoning Flexibility
  const zoning = r.property.zoning;
  if (zoning) {
    let pts = 5, verdict = "Standard residential zoning";
    const z = zoning.toUpperCase();
    if (z.includes("R-") && parseInt(z.replace(/\D/g, "")) >= 8) { pts = 8; verdict = "Higher density zoning — ADU/DADU potential, future upzoning possible"; }
    else if (z.includes("RSX")) { pts = 6; verdict = "Suburban residential — single family, possible ADU"; }
    else if (z.includes("RM") || z.includes("MULTI")) { pts = 9; verdict = "Multi-family zoning — strong investment potential"; }
    factors.push({ name: "Zoning", score: pts, max: 10, icon: "🏛️", detail: `Zoned ${zoning}. ${verdict}.` });
    totalScore += pts; maxScore += 10;
  }

  // Render
  const overallPct = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;
  let overallVerdict, overallColor, overallEmoji;
  if (overallPct >= 75) { overallVerdict = "Strong Buy"; overallColor = "var(--green)"; overallEmoji = "✅"; }
  else if (overallPct >= 55) { overallVerdict = "Decent Buy"; overallColor = "#f59e0b"; overallEmoji = "👍"; }
  else if (overallPct >= 40) { overallVerdict = "Proceed with Caution"; overallColor = "#f59e0b"; overallEmoji = "⚠️"; }
  else { overallVerdict = "Not Recommended"; overallColor = "var(--red)"; overallEmoji = "🚫"; }

  // Store on report for history
  r._buyScore = overallPct;
  r._buyVerdict = overallVerdict;

  $("buyScoreHeader").innerHTML = `
    <div class="buy-overall">
      <div class="buy-overall-score" style="border-color:${overallColor}">
        <span class="big-num">${overallPct}</span><span class="big-label">/ 100</span>
      </div>
      <div>
        <div class="buy-overall-verdict" style="color:${overallColor}">${overallEmoji} ${overallVerdict}</div>
        <div class="note">Based on ${factors.length} factors analyzed</div>
      </div>
    </div>`;

  $("buyFactors").innerHTML = factors.map(f => {
    const pct = Math.round((f.score / f.max) * 100);
    const color = pct >= 70 ? "var(--green)" : pct >= 50 ? "#f59e0b" : "var(--red)";
    return `<div class="buy-factor">
      <div class="buy-factor-header">
        <span>${f.icon} ${f.name}</span>
        <span class="buy-factor-score" style="color:${color}">${f.score}/${f.max}</span>
      </div>
      <div class="buy-factor-bar"><div class="buy-factor-fill" style="width:${pct}%;background:${color}"></div></div>
      <div class="buy-factor-detail">${f.detail}</div>
    </div>`;
  }).join("");

  // Summary
  const pros = factors.filter(f => f.score / f.max >= 0.7).map(f => `${f.icon} ${f.name}`);
  const cons = factors.filter(f => f.score / f.max < 0.5).map(f => `${f.icon} ${f.name}`);
  $("buySummary").innerHTML = `
    <div class="buy-pros-cons">
      ${pros.length > 0 ? `<div class="buy-pros"><h3>✅ Strengths</h3><ul>${pros.map(p => `<li>${p}</li>`).join("")}</ul></div>` : ""}
      ${cons.length > 0 ? `<div class="buy-cons"><h3>⚠️ Watch Out</h3><ul>${cons.map(c => `<li>${c}</li>`).join("")}</ul></div>` : ""}
    </div>
    <p class="note" style="margin-top:0.8rem">⚖️ This analysis is for informational purposes only. Always consult a licensed real estate agent and do your own due diligence before purchasing.</p>`;
}

// ── Image Gallery ──
function renderImageGallery(r) {
  const p = r.property;
  const addr = getFullAddress(p, r.query);
  const addrEnc = encodeURIComponent(addr + (p.city ? `, ${p.city}, WA` : ", WA"));
  const gmapsKey = localStorage.getItem("google_maps_key");

  let cards = "";

  // 1) Realtor photo (from API)
  if (p.imageUrl) {
    console.log("Gallery image URL:", p.imageUrl);
    cards += `<div class="gallery-card">
      <img src="${p.imageUrl}" alt="Property photo" onerror="console.warn('Image failed to load:', this.src); this.parentElement.style.display='none'" />
      <span class="gallery-label">Realtor</span>
    </div>`;
  }

  // 1b) Additional photos from Realtor
  if (p.photos && p.photos.length > 1) {
    for (let i = 1; i < Math.min(p.photos.length, 5); i++) {
      cards += `<div class="gallery-card">
        <img src="${p.photos[i]}" alt="Property photo ${i+1}" onerror="this.parentElement.style.display='none'" />
        <span class="gallery-label">Photo ${i+1}</span>
      </div>`;
    }
  }

  // 2) Google Street View (needs API key)
  if (gmapsKey) {
    const svUrl = `https://maps.googleapis.com/maps/api/streetview?size=600x400&location=${addrEnc}&key=${gmapsKey}`;
    cards += `<div class="gallery-card">
      <img src="${svUrl}" alt="Google Street View" onerror="this.parentElement.innerHTML='<div class=\\'gallery-placeholder\\'>No Street View available</div>'" />
      <span class="gallery-label">Street View</span>
    </div>`;
  }

  // 3) Google Maps satellite embed (no key needed)
  cards += `<div class="gallery-card gallery-map">
    <iframe src="https://maps.google.com/maps?q=${addrEnc}&t=k&z=18&output=embed"
      frameborder="0" allowfullscreen loading="lazy" title="Satellite map"></iframe>
    <span class="gallery-label">Satellite Map</span>
  </div>`;

  // Fallback if no photos at all
  if (!p.imageUrl && !gmapsKey) {
    cards = `<div class="gallery-card">
      <div class="gallery-placeholder">🏡<br>No property photos available.<br>
        <small>Add a Realtor API or Google Maps API key in ⚙️ Settings for photos.</small>
      </div>
    </div>` + cards;
  }

  $("imageGallery").innerHTML = cards;

  // Photo links — only Zillow
  const zillowAddr = [addr, p.city, p.state || "WA", p.zip].filter(Boolean).join(", ");
  $("photoLinks").innerHTML = `<a href="https://www.zillow.com/homes/${encodeURIComponent(zillowAddr)}_rb/" target="_blank">📸 Zillow Photos</a>`;
}

// ── Condition & Details with Tooltips ──
const CONDITION_HELP = {
  "Year Built": "The year the main structure was originally constructed. Older homes may have charm but could need more maintenance on plumbing, electrical, and insulation.",
  "Property Type": "The broad classification: Residential (R) means it's zoned and used for housing. Commercial (C) means business use. Mixed means both.",
  "Use Type": "How the county classifies the property's current use. 'Single Family (Res Use/Zone)' is a standard house on residentially zoned land.",
  "Home Type": "The style of housing: single_family, condo, townhome, apartment, multi_family, etc.",
  "Lot Size": "Total land area in square feet and acres. Larger lots give more yard space but may cost more in landscaping and taxes. Average Eastside lot is ~7,000–10,000 sqft.",
  "Zoning": "The county zoning code controls what can be built. 'RSX 7.2' means Residential Suburban with ~7,200 sqft minimum lot size. 'R-4' means 4 units per acre. Check zoning before any additions or ADUs.",
  "Plat": "The name of the original subdivision or neighborhood development the lot belongs to. Useful for finding CC&Rs (deed restrictions) and HOA info.",
  "Assessed Land": "The county's appraised value of just the land, used for property tax calculations. This is NOT the market price — it's typically lower.",
  "Assessed Improvement": "The county's appraised value of the structure (house, garage, etc.) on the land. 'Improvement' = anything built on the lot.",
  "Assessed Total": "Land + Improvement values combined. Your property tax is a percentage of this. King County reassesses annually.",
  "Stories": "Number of levels/floors in the building. Important for accessibility and stairs.",
  "Heating": "Type of heating system: forced air (common, uses ducts), radiant (floor/baseboard), heat pump (efficient), etc.",
  "Cooling": "Type of cooling/AC system. Central air uses ducts; mini-split is ductless. No cooling means you may need to add it.",
  "Roofing": "Roof material. Composition/asphalt shingles last ~20-30 years. Metal lasts 40-70 years. Tile can last 50+ years.",
  "Flooring": "Types of flooring throughout the home: hardwood, carpet, tile, laminate, vinyl, etc.",
  "Garage": "Garage capacity and type. Attached garages share a wall with the house. Detached garages are separate structures.",
  "Parking": "Available parking spaces/types. Can include garage, driveway, carport, or street parking.",
  "Pool": "Whether the property has a pool. Pools add value but also maintenance costs (~$1,200-3,000/year).",
  "Construction": "The primary building material: frame (wood), brick, stucco, concrete, etc.",
  "Exterior": "Exterior finish material: vinyl siding, wood, brick, stucco, fiber cement (HardiPlank), etc.",
};

function renderCondition(p, condition) {
  condition = condition || {};
  const items = [
    { label: "Year Built", value: p.yearBuilt },
    { label: "Home Type", value: p.homeType },
    { label: "Property Type", value: p.propType === "R" ? "Residential" : p.propType || null },
    { label: "Use Type", value: p.useDescription },
    { label: "Stories", value: condition.stories || p.stories },
    { label: "Lot Size", value: p.lotSqft ? `${Number(p.lotSqft).toLocaleString()} sqft (${p.lotAcres || "?"} ac)` : null },
    { label: "Zoning", value: p.zoning },
    { label: "Plat", value: p.platName },
    { label: "Heating", value: condition.heating },
    { label: "Cooling", value: condition.cooling },
    { label: "Roofing", value: condition.roofing },
    { label: "Flooring", value: condition.flooring },
    { label: "Construction", value: condition.construction },
    { label: "Exterior", value: condition.exterior },
    { label: "Garage", value: condition.garage },
    { label: "Parking", value: condition.parking },
    { label: "Pool", value: condition.pool },
  ].filter(item => item.value); // Only show fields that have data

  if (items.length === 0) {
    $("conditionGrid").innerHTML = `<p style="color: var(--muted); grid-column: 1/-1;">No property condition data available from King County or Realtor API.</p>`;
    return;
  }

  $("conditionGrid").innerHTML = items.map(({ label, value }) => {
    const help = CONDITION_HELP[label];
    return `<div class="cond-item">
      <div class="label">
        ${label}
        ${help ? `<button class="help-btn" onclick="showHelp(this)" data-help="${escAttr(help)}" title="What does this mean?">ℹ️</button>` : ""}
      </div>
      <div class="value">${value ?? "—"}</div>
    </div>`;
  }).join("");
}

function escAttr(str) {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;");
}

function showHelp(btn) {
  // Remove any existing popover
  document.querySelectorAll(".help-popover").forEach(el => el.remove());

  const text = btn.getAttribute("data-help");
  const pop = document.createElement("div");
  pop.className = "help-popover";
  pop.innerHTML = `<p>${text}</p><button onclick="this.parentElement.remove()">Got it</button>`;
  btn.closest(".cond-item").appendChild(pop);

  // Auto-dismiss after 12 seconds
  setTimeout(() => { if (pop.parentElement) pop.remove(); }, 12000);
}

// ── Helpers ──
function det(label, value) {
  return `<div class="detail-item"><div class="detail-label">${label}</div><div class="detail-value">${value ?? "—"}</div></div>`;
}
function vbox(label, amount, sub) {
  return `<div class="value-box"><div class="label">${label}</div><div class="amount">${amount}</div><div class="sub">${sub || ""}</div></div>`;
}
function cond(label, value) {
  return `<div class="cond-item"><div class="label">${label}</div><div class="value">${value ?? "—"}</div></div>`;
}

// ── HOA & Special Assessment persistence ──
function saveHoaManual() {
  const pin = getCurrentPin();
  if (!pin) { alert("Search for a property first."); return; }
  const data = { monthly: $("hoaManualCost").value, notes: $("hoaNotes").value };
  localStorage.setItem(`hoa_${pin}`, JSON.stringify(data));
  alert("HOA info saved locally for this property.");
}

function addSpecialAssessment() {
  const pin = getCurrentPin();
  if (!pin) { alert("Search for a property first."); return; }
  const desc = $("specialDesc").value.trim();
  const amt = $("specialAmount").value;
  if (!desc) return;
  const key = `special_${pin}`;
  const list = JSON.parse(localStorage.getItem(key) || "[]");
  list.push({ desc, amount: amt });
  localStorage.setItem(key, JSON.stringify(list));
  $("specialDesc").value = "";
  $("specialAmount").value = "";
  renderSpecialList(list);
}

function renderSpecialList(list) {
  $("specialList").innerHTML = list.map((s, i) =>
    `<li><span>${s.desc}</span><span>${fmt(s.amount)}</span></li>`
  ).join("");
}

function getCurrentPin() {
  const el = document.querySelector("#overviewDetails .detail-value:last-child");
  // Fallback: look for PIN in the rendered overview
  const pinEl = [...document.querySelectorAll(".detail-label")].find(e => e.textContent.includes("PIN"));
  return pinEl ? pinEl.nextElementSibling?.textContent : null;
}
