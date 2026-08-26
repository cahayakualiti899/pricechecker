
const CONFIG = {
    // Will be filled from ip.json
    API_BASE_URL: null,

    SLIDESHOW_INTERVAL: 5000,
    AUTO_RESET_DELAY: 30000,

    // PROMO LOCATION SCOPING
    // true  = a promotion is only displayed when it belongs to the location this
    //         kiosk actually asked about. Blocks HQ-fallback pricing and any
    //         promo tagged to a different branch from advertising here.
    // false = display whatever promotion the API returns, unfiltered.
    PROMO_REQUIRES_MATCHING_LOCATION: true,

    // MEMBER PRICE VISIBILITY
    // true  = the MEMBER EXCLUSIVE box only appears while a promotion is
    //         actually running (IsPromoValid AND inside its date window).
    //         Use this when MemberPrice1 is populated as part of a promotion
    //         and goes stale once that promotion ends.
    // false = the box appears whenever MemberPrice1 > 0, treating it as a
    //         standing member rate that is always available.
    MEMBER_PRICE_REQUIRES_ACTIVE_PROMO: true,

    // ── Slider images ────────────────────────────────────────
    // Central distribution repo (public, holds ONLY html/js/css/jpg - never
    // credentials). Slides are LOCATION-PREFIXED so one repo drives every
    // outlet: HQ_Slide1.jpg, TUARAN3_Slide1.jpg, TUARAN3_Slide2.jpg, ...
    // The kiosk asks its own API (/info) which outlet it is, then loads only
    // that location's slides. Loading order per outlet:
    //   1. {LOCATION}_Slide{n}.jpg from the repo  (outlet-specific)
    //   2. slide{n}.jpg from the repo             (chain-wide default)
    //   3. images/slider/slide{n}.jpg locally     (offline fallback)
    SLIDES_REMOTE: 'https://raw.githubusercontent.com/cahayakualiti899/pricechecker/main/',
    SLIDES_LOCAL: 'images/slider/',
    SLIDE_PREFIX: 'slide',
    SLIDE_EXT: '.jpg',
    MAX_SLIDES: 20,

    GITHUB_BASE: 'https://raw.githubusercontent.com/jayasuperstore/image/main/',
    PRODUCT_IMAGE_BASE: 'https://raw.githubusercontent.com/jayasuperstore/image/main/products/',
    DEFAULT_IMAGE: 'https://raw.githubusercontent.com/jayasuperstore/image/main/products/none.png',

    // File updates are pulled to DISK by the KioskUpdateService inside
    // JayaWebApi on this host (the old in-page auto-update could never write
    // to the IIS folder, so it never actually persisted anything). The page
    // only polls its OWN local version.json and reloads once when the host's
    // files have moved ahead of the running page.
    VERSION_CHECK_INTERVAL: 300000,      // poll local version.json every 5 min
    SLIDESHOW_REFRESH_INTERVAL: 1800000, // re-detect slides every 30 min

    IP_CONFIG_FILE: 'ip.json' // ⬅ new
};

// Load API URL from ip.json (per-device configuration)
async function loadIpConfig() {
    try {
        const response = await fetch(CONFIG.IP_CONFIG_FILE + '?t=' + Date.now(), {
            cache: 'no-cache'
        });

        if (!response.ok) {
            throw new Error('ip.json not found or not accessible');
        }

        const cfg = await response.json();

        if (!cfg.apiBaseUrl || typeof cfg.apiBaseUrl !== 'string') {
            throw new Error('apiBaseUrl missing or invalid in ip.json');
        }

        CONFIG.API_BASE_URL = cfg.apiBaseUrl.trim();
        console.log('API_BASE_URL from ip.json:', CONFIG.API_BASE_URL);
    } catch (err) {
        console.error('Failed to load ip.json:', err);
        alert('Configuration error: cannot load API URL from ip.json');

        // Safety: avoid calling "null/..." – keep it empty if not set
        if (!CONFIG.API_BASE_URL) {
            CONFIG.API_BASE_URL = '';
        }
    }
}



// State Management
const state = {
    currentSlide: 0,
    slideInterval: null,
    resetTimeout: null,
    barcodeBuffer: '',
    barcodeTimeout: null,
    updateCheckInterval: null,
    currentVersion: '1.8.6', // Increment this with each update
    lastUpdateCheck: null,
    kioskLocation: null      // outlet code from /api/pricechecker/info (e.g. TUARAN3)
};

// Initialize on page load
document.addEventListener('DOMContentLoaded', async function() {
    console.log(`Price Checker v${state.currentVersion} - updates pulled by host service`);

    // 1) Load per-device API config from ip.json
    await loadIpConfig();
    
    // Watch this host's local version.json (KioskUpdateService writes it)
    initVersionWatch();

    await buildSlideshow(); // Build slideshow dynamically with auto-detection
    initSlideshowRefresh(); // pick up newly uploaded slides without a manual reload
    initializeBarcodeScanner();
    setupEventListeners();
    setupManualInput();
    
    // Auto-request fullscreen on page load
    setTimeout(() => {
        requestFullscreen();
    }, 500); // Small delay to ensure page is fully loaded
});

// ============================================
// VERSION WATCH
// ============================================
// File updates are pulled to DISK by the KioskUpdateService that runs inside
// JayaWebApi on this host - it polls the distribution repo and writes
// js/css/html into this site's folder, version.json last as a commit marker.
// The page's only job is to notice its host's files moved ahead and reload
// ONCE. A reload loop is impossible: after reloading, the running version
// equals the disk version.
//
// (The previous in-page auto-updater is gone. A browser page cannot write to
// the IIS folder it was served from, so it never persisted anything; its
// script hot-swap also died redeclaring `const CONFIG`. See KioskUpdateService.)

// Compare two dotted version strings.
// Returns 1 if a > b, -1 if a < b, 0 if equal. Missing segments count as 0.
function compareVersions(a, b) {
    const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const va = pa[i] || 0;
        const vb = pb[i] || 0;
        if (va > vb) return 1;
        if (va < vb) return -1;
    }
    return 0;
}

async function checkLocalVersion() {
    try {
        const res = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
        if (!res.ok) return;

        const v = await res.json();
        state.lastUpdateCheck = new Date();
        updateLastCheckTime();

        if (!v.version || compareVersions(v.version, state.currentVersion) <= 0) return;

        // LOOP GUARD. The no-loop promise holds only while version.json and
        // pricechecker.js on disk carry the SAME version. A release that bumps
        // version.json but not the JS (easy to do by hand) breaks that: the page
        // reloads, still reads the old version out of the JS, and reloads again
        // forever. Remember what we already reloaded for - sessionStorage
        // survives the reload but not a new tab.
        let already = null;
        try { already = sessionStorage.getItem('reloadedForVersion'); } catch (e) { }

        if (already === v.version) {
            console.error(
                `\u26a0 Version mismatch on this host: version.json says ${v.version} but ` +
                `pricechecker.js reports ${state.currentVersion}. Already reloaded once - ` +
                `refusing to loop. Re-publish so BOTH files carry the same version ` +
                `(use release.ps1).`);
            return;
        }

        try { sessionStorage.setItem('reloadedForVersion', v.version); } catch (e) { }
        console.log(`Host updated to v${v.version} (running v${state.currentVersion}) - reloading to pick it up.`);
        window.location.reload();
    } catch (e) {
        // version.json unreachable - try again next cycle
    }
}

function initVersionWatch() {
    checkLocalVersion();
    state.updateCheckInterval = setInterval(checkLocalVersion, CONFIG.VERSION_CHECK_INTERVAL);
}

// Re-detect slides periodically (only while the slideshow is on screen) so a
// newly uploaded {LOCATION}_SlideN.jpg reaches long-running kiosks without a
// manual refresh.
function initSlideshowRefresh() {
    setInterval(async () => {
        const priceDisplay = document.getElementById('priceDisplay');
        if (priceDisplay && priceDisplay.style.display === 'block') return; // mid-scan
        console.log('Periodic slide re-detection...');
        await buildSlideshow();
    }, CONFIG.SLIDESHOW_REFRESH_INTERVAL);
}

// Small bottom-left indicator showing the running version and last file check.
function updateLastCheckTime() {
    let indicator = document.getElementById('update-indicator');
    if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = 'update-indicator';
        indicator.style.cssText = 'position: fixed; bottom: 10px; left: 10px; font-size: 10px; color: #999; z-index: 100; font-family: monospace;';
        document.body.appendChild(indicator);
    }
    const time = state.lastUpdateCheck ? state.lastUpdateCheck.toLocaleTimeString() : 'never';
    indicator.textContent = `v${state.currentVersion} \u00b7 files checked: ${time}`;
}

// ============================================
// ORIGINAL PRICE CHECKER FUNCTIONALITY
// ============================================

// ── Kiosk location (for location-prefixed slides) ──────────────
// Asks this kiosk's own API which outlet it serves. Cached in memory and in
// localStorage so slides still resolve to the right outlet if the API is
// briefly down at page load. Returns null when the location cannot be learned.
async function getKioskLocation() {
    if (state.kioskLocation) return state.kioskLocation;

    try {
        const res = await fetch(`${CONFIG.API_BASE_URL}/info`);
        if (res.ok) {
            const info = await res.json();
            const loc = String(info.location || info.Location || '').trim().toUpperCase();
            if (loc) {
                state.kioskLocation = loc;
                try { localStorage.setItem('kiosk_location', loc); } catch (e) { }
                console.log(`Kiosk location from API: ${loc}`);
                return loc;
            }
        }
    } catch (e) {
        console.warn('Could not get kiosk location from API:', e.message);
    }

    // API unreachable: fall back to the last known location
    try {
        const cached = localStorage.getItem('kiosk_location');
        if (cached) {
            state.kioskLocation = cached;
            console.log(`Kiosk location from cache: ${cached}`);
            return cached;
        }
    } catch (e) { }

    return null;
}

// Probe one slide slot under a base URL. `prefixes` lets outlet slides match
// whatever casing was used when the file was uploaded (GitHub raw URLs are
// case-sensitive): TUARAN3_Slide1.jpg, TUARAN3_SLIDE1.jpg, TUARAN3_slide1.jpg.
async function findSlideAt(base, prefixes, i) {
    for (const p of prefixes) {
        const url = `${base}${p}${i}${CONFIG.SLIDE_EXT}`;
        if (await checkImageExists(url)) return url;
    }
    return null;
}

// Collect sequential slides (1, 2, 3, ... stop at first gap) for one tier.
async function collectSlides(base, prefixes) {
    const found = [];
    for (let i = 1; i <= CONFIG.MAX_SLIDES; i++) {
        const url = await findSlideAt(base, prefixes, i);
        if (!url) break;
        found.push(url);
    }
    return found;
}

// Auto-detect available slides and build slideshow
async function buildSlideshow() {
    const slideshowContainer = document.getElementById('slideshowContainer');
    let availableSlides = [];

    // Tier 1: outlet-specific slides from the distribution repo
    const loc = await getKioskLocation();
    if (loc) {
        console.log(`Looking for ${loc}_Slide1${CONFIG.SLIDE_EXT} ... in distribution repo`);
        availableSlides = await collectSlides(CONFIG.SLIDES_REMOTE,
            // include lowercase-location casings too (ranau_slide1.jpg was a real upload)
            [`${loc}_Slide`, `${loc}_SLIDE`, `${loc}_slide`,
             `${loc.toLowerCase()}_slide`, `${loc.toLowerCase()}_Slide`]);
        if (availableSlides.length) console.log(`Using ${availableSlides.length} slide(s) for outlet ${loc}`);
    }

    // Tier 2: chain-wide default slides from the repo (unprefixed slide1.jpg...)
    if (availableSlides.length === 0) {
        availableSlides = await collectSlides(CONFIG.SLIDES_REMOTE, [CONFIG.SLIDE_PREFIX]);
        if (availableSlides.length) console.log(`Using ${availableSlides.length} chain-wide slide(s) from repo`);
    }

    // Tier 3: local offline fallback (images/slider/slide1.jpg ...)
    if (availableSlides.length === 0) {
        availableSlides = await collectSlides(CONFIG.SLIDES_LOCAL, [CONFIG.SLIDE_PREFIX]);
        if (availableSlides.length) console.log(`Offline: using ${availableSlides.length} local slide(s)`);
    }

    // Nothing anywhere: point at local slide1 so the layout stays intact
    if (availableSlides.length === 0) {
        console.warn('No slides found remotely or locally - showing placeholder slot.');
        availableSlides.push(`${CONFIG.SLIDES_LOCAL}${CONFIG.SLIDE_PREFIX}1${CONFIG.SLIDE_EXT}`);
    }
    
    console.log(`Total slides detected: ${availableSlides.length}`);
    
    // Clear existing slides
    slideshowContainer.innerHTML = '';
    
    // Create slides
    availableSlides.forEach((imageUrl, index) => {
        const slideDiv = document.createElement('div');
        slideDiv.className = `slide fade ${index === 0 ? 'active' : ''}`;
        
        const img = document.createElement('img');
        img.src = imageUrl;
        img.alt = `Promotion ${index + 1}`;
        // Add inline styles for proper image display
        img.style.cssText = `
            width: 100%;
            height: 100%;
            object-fit: contain;
            object-position: center;
            background: #f5f5f5;
        `;
        
        slideDiv.appendChild(img);
        slideshowContainer.appendChild(slideDiv);
    });
    
    // Create indicators container
    const indicatorsDiv = document.createElement('div');
    indicatorsDiv.className = 'slide-indicators';
    
    // Create dots
    for (let i = 0; i < availableSlides.length; i++) {
        const dot = document.createElement('span');
        dot.className = `dot ${i === 0 ? 'active' : ''}`;
        dot.onclick = () => goToSlide(i);
        indicatorsDiv.appendChild(dot);
    }
    
    slideshowContainer.appendChild(indicatorsDiv);
    
    // Start slideshow if more than one slide
    if (availableSlides.length > 1) {
        startSlideshow();
    }
}

// Check if an image exists at the given URL.
// Uses an Image probe rather than fetch(HEAD): it works regardless of how IIS
// handles the HEAD verb, needs no CORS handling, and behaves the same for local
// paths as for remote URLs.
function checkImageExists(url) {
    return new Promise((resolve) => {
        const img = new Image();
        let settled = false;

        const done = (result) => {
            if (settled) return;
            settled = true;
            img.onload = img.onerror = null;
            resolve(result);
        };

        img.onload = () => done(true);
        img.onerror = () => done(false);
        img.src = url;

        // Safety net so a hung request cannot stall slideshow build-up
        setTimeout(() => done(false), 3000);
    });
}

// Slideshow Functions
function startSlideshow() {
    if (state.slideInterval) {
        clearInterval(state.slideInterval);
    }
    
    const slides = document.getElementsByClassName('slide');
    if (slides.length <= 1) return; // Don't start slideshow if only one slide
    
    showSlide(0);
    state.slideInterval = setInterval(() => {
        nextSlide();
    }, CONFIG.SLIDESHOW_INTERVAL);
}

function stopSlideshow() {
    if (state.slideInterval) {
        clearInterval(state.slideInterval);
        state.slideInterval = null;
    }
}

function showSlide(index) {
    const slides = document.querySelectorAll('.slide');
    const dots = document.querySelectorAll('.dot');
    
    if (slides.length === 0) return;
    
    if (index >= slides.length) {
        state.currentSlide = 0;
    } else if (index < 0) {
        state.currentSlide = slides.length - 1;
    } else {
        state.currentSlide = index;
    }
    
    slides.forEach((slide, i) => {
        slide.classList.toggle('active', i === state.currentSlide);
    });
    
    dots.forEach((dot, i) => {
        dot.classList.toggle('active', i === state.currentSlide);
    });
}

function nextSlide() {
    showSlide(state.currentSlide + 1);
}

function goToSlide(index) {
    showSlide(index);
    // Restart slideshow timer
    startSlideshow();
}

// Barcode Scanner Setup
function initializeBarcodeScanner() {
    const barcodeInput = document.getElementById('barcodeInput');
    
    // Keep input focused for barcode scanner
    barcodeInput.focus();
    
    setInterval(() => {
        if (document.activeElement !== barcodeInput && 
            document.activeElement.id !== 'manualInput') {
            barcodeInput.focus();
        }
    }, 100);
    
    // Listen for document keypress events (barcode scanner input)
    document.addEventListener('keydown', handleBarcodeInput);
}

function handleBarcodeInput(event) {
    // CRITICAL: Ignore if user is typing in manual input
    const activeElement = document.activeElement;
    if (activeElement && activeElement.id === 'manualInput') {
        return; // Don't capture keystrokes when manual input is focused
    }
    
    // Clear previous timeout
    if (state.barcodeTimeout) {
        clearTimeout(state.barcodeTimeout);
    }
    
    // Handle Enter key - barcode complete
    if (event.key === 'Enter') {
        if (state.barcodeBuffer.trim()) {
            searchProduct(state.barcodeBuffer.trim());
            state.barcodeBuffer = '';
        }
        return;
    }
    
    // Ignore special keys (except alphanumeric and common barcode characters)
    if (event.key.length > 1 && event.key !== 'Shift') {
        return;
    }
    
    // Add character to buffer (ignore Shift)
    if (event.key !== 'Shift') {
        state.barcodeBuffer += event.key;
    }
    
    // Reset buffer after 100ms of inactivity (barcode scanners are fast)
    state.barcodeTimeout = setTimeout(() => {
        state.barcodeBuffer = '';
    }, 100);
}

// Manual Input Setup
function setupManualInput() {
    const manualInput = document.getElementById('manualInput');
    
    if (manualInput) {
        // Handle Enter key in manual input
        manualInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                searchManual();
            }
        });
        
        // When manual input is focused, pause barcode scanning
        manualInput.addEventListener('focus', () => {
            console.log('Manual input focused - pausing barcode scanner');
            document.removeEventListener('keydown', handleBarcodeInput);
        });
        
        // When manual input loses focus, resume barcode scanning
        manualInput.addEventListener('blur', () => {
            console.log('Manual input blurred - resuming barcode scanner');
            document.addEventListener('keydown', handleBarcodeInput);
            
            // Refocus hidden input for barcode scanner
            setTimeout(() => {
                document.getElementById('barcodeInput').focus();
            }, 100);
        });
    }
}

function searchManual() {
    const manualInput = document.getElementById('manualInput');
    const searchValue = manualInput.value.trim();
    
    if (searchValue) {
        console.log('Manual search:', searchValue);
        searchProduct(searchValue);
        manualInput.value = ''; // Clear input after search
        manualInput.blur(); // Remove focus
        
        // Hide header after search
        const header = document.getElementById('header');
        if (header) {
            header.style.display = 'none';
        }
        const toggleBtn = document.getElementById('toggleHeaderBtn');
        if (toggleBtn) {
            toggleBtn.innerHTML = '<i class="fas fa-search"></i> Search';
            toggleBtn.style.background = '#2563eb';
        }
    } else {
        alert('Please enter an item code, barcode, or subcode');
    }
}

// Product Search Function
async function searchProduct(searchValue) {
    if (!searchValue) return;
    
    // Sanitize search value
    searchValue = searchValue.trim();
    
    // Hide header when searching
    const header = document.getElementById('header');
    if (header) {
        header.style.display = 'none';
    }
    
    showLoading();
    hideError();
    stopSlideshow();
    
    try {
        console.log(`Fetching product: ${searchValue}`);
        
        // Use the correct API endpoint format from original code
        const response = await fetch(`${CONFIG.API_BASE_URL}/${encodeURIComponent(searchValue)}`);
        
        console.log('Response status:', response.status);
        
        if (!response.ok) {
            if (response.status === 404) {
                throw new Error('Product not found');
            }
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const rawData = await response.json();
        const data = normalizeKeys(rawData);
        console.log('Product data:', data);
        
        if (data) {
            displayProduct(data);
            scheduleAutoReset();
        } else {
            showError('Product not found');
        }
    } catch (error) {
        console.error('Error fetching product:', error);
        showError(error.message || 'Failed to load product information. Please try again.');
    } finally {
        hideLoading();
    }
}

// Display Product Function
function displayProduct(product) {
    hideLoading();
    
    // Hide slideshow, show price display
    document.getElementById('slideshowContainer').style.display = 'none';
    document.getElementById('priceDisplay').style.display = 'block';
    
    // Basic Information
    document.getElementById('itemCode').textContent = product.ItemCode || '-';
    document.getElementById('barcodeDisplay').textContent = product.Barcode || product.ItemCode || '-';
    document.getElementById('productName').textContent = product.ItemDescription || 'Unknown Product';
    document.getElementById('articleCode').textContent = product.ItemBrand || '-';
    
    // Location Display with Fallback indicator
    const locationText = product.Location || '-';
    const locationDisplay = document.getElementById('locationDisplay');
    if (product.IsFallbackFromHQ) {
        locationDisplay.textContent = `${locationText} (From HQ Stock)`;
        locationDisplay.style.color = '#ff9800'; // Orange color for fallback
    } else {
        locationDisplay.textContent = locationText;
        locationDisplay.style.color = ''; // Reset to default
    }
    
    // Product Image - ONLY GitHub
    const imageElement = document.getElementById('productImage');
    if (product.ItemImage) {
        // If API provides base64 image, use it
        imageElement.src = `data:image/jpeg;base64,${product.ItemImage}`;
        imageElement.onerror = () => {
            imageElement.src = CONFIG.DEFAULT_IMAGE;
        };
    } else {
        // Try GitHub image by item code
        imageElement.src = `${CONFIG.PRODUCT_IMAGE_BASE}${product.ItemCode}.png`;
        imageElement.onerror = () => {
            // Fallback to default GitHub image only
            imageElement.src = CONFIG.DEFAULT_IMAGE;
        };
    }
    
    // Stock Information
    displayStock(product.BalQty, getUOM(product));
    
    // Price Information
    displayPricing(product);
    
    // Reset to slideshow after delay
    resetToSlideshow();
}

// Display Stock
function displayStock(balQty, uom) {
    const stockBadge = document.getElementById('stockBadge');
    const stockQty = document.getElementById('stockQty');
    const stockUOM = document.getElementById('stockUOM');
    
    const qty = parseFloat(balQty) || 0;
    
    stockQty.textContent = qty.toFixed(0);
    stockUOM.textContent = uom || 'Unit';
    
    // Update badge color based on stock level
    stockBadge.classList.remove('low-stock', 'out-of-stock');
    if (qty === 0) {
        stockBadge.classList.add('out-of-stock');
    } else if (qty <= 10) {
        stockBadge.classList.add('low-stock');
    }
}

// ============================================
// PROMOTION EXPIRY GUARD
// ============================================
// The API's IsPromoValid flag is not trusted on its own: an expired promotion
// can still come back flagged valid, which left ended promos on the shelf
// display. Today must also fall inside the promotion's own date window.
// NOTE: the authoritative check belongs server-side; this is a safety net.

// Parse a promo date into a LOCAL day boundary.
// FromDate counts from 00:00:00.000 and ToDate through 23:59:59.999, so a promo
// ending "today" stays valid all day and there is no midnight off-by-one.
function parsePromoBoundary(dateString, endOfDay) {
    if (!dateString) return null;

    const d = new Date(dateString);
    if (isNaN(d.getTime())) return null; // unparseable - treat as "no boundary"

    return endOfDay
        ? new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999)
        : new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

// True when the promotion is currently inside its date window. With no
// Promotion object / no dates there is nothing to disprove, so defer to the flag.
function isPromoWindowOpen(promotion) {
    if (!promotion) return true;

    const now = new Date();
    const start = parsePromoBoundary(promotion.FromDate, false);
    const end = parsePromoBoundary(promotion.ToDate, true);

    if (start && now < start) return false; // not started yet
    if (end && now > end) return false;     // expired

    return true;
}

// ============================================
// PROMOTION LOCATION GUARD
// ============================================
// Promotions in AutoCount are per-location, but nothing in this front end ever
// checked that: Location was only used to paint the badge, and SearchedLocation
// was never read at all. A promo returned by the API was displayed regardless of
// which branch it belonged to.
//
// NOTE: the API is the only place that can filter promotions correctly at the
// source (the promo lookup needs a WHERE on the location). This is a guard, not
// a substitute - it can only reject what the payload gives it enough to reject.

function normaliseLoc(value) {
    return value == null ? '' : String(value).trim().toUpperCase();
}

// Pull a location off the promotion object. The field name varies by API
// revision, so check the plausible ones and return whichever is present.
function getPromoLocation(promotion) {
    if (!promotion) return null;
    return promotion.Location
        || promotion.LocationCode
        || promotion.BranchCode
        || promotion.Branch
        || null;
}

// True when the promotion belongs to the location this kiosk asked about.
function isPromoForThisLocation(product) {
    if (!CONFIG.PROMO_REQUIRES_MATCHING_LOCATION) return true;

    const here = normaliseLoc(product.SearchedLocation || product.Location);

    // The branch had no record for this item so the API fell back to HQ. Any
    // pricing/promo attached to that row is HQ's, not this store's.
    if (product.IsFallbackFromHQ) {
        console.warn('📍 Promo suppressed: data is an HQ fallback, not this location.');
        return false;
    }

    // The row returned is for a different location than the one requested.
    const rowLoc = normaliseLoc(product.Location);
    if (here && rowLoc && rowLoc !== here) {
        console.warn(`📍 Promo suppressed: row location "${rowLoc}" != searched location "${here}".`);
        return false;
    }

    // If the promotion itself carries a location, it must match.
    const promoLoc = normaliseLoc(getPromoLocation(product.Promotion));
    if (!promoLoc) {
        if (product.Promotion) {
            console.warn('📍 Promotion has NO location field - cannot verify branch scope on the client. The API must filter promos by location.');
        }
        return true; // nothing to disprove - defer to the API
    }

    if (here && promoLoc !== here) {
        console.warn(`📍 Promo suppressed: promotion belongs to "${promoLoc}", kiosk is "${here}".`);
        return false;
    }

    return true;
}

// Resolve the unit of measure from the API payload.
//
// BUG FIX: normalizeKeys() only uppercases the FIRST letter of each key, so the
// API's "uom" arrives as "Uom" - never "UOM". Every `product.UOM` read was
// therefore undefined and silently fell back to 'Unit', which is why the shelf
// display showed "33 Unit" / "RM 2.00 / Unit" for an item the API reports as PCS.
// Checked in order so it keeps working whichever casing the API sends.
function getUOM(product, fallback) {
    return product.UOM || product.Uom || product.uom || fallback || 'Unit';
}

// "Min. Buy: 3 (Max: 6) Unit(s)"
function buildQtyText(minQty, maxQty, uom) {
    let text = `Min. Buy: ${minQty}`;
    if (maxQty && maxQty > 0 && maxQty !== minQty) {
        text += ` (Max: ${maxQty})`;
    }
    return `${text} ${uom || 'unit'}(s)`;
}

// ── Price pending review (outlet has no price for this item) ───
// RANAU/RANAU2 price only from ItemUOM.Price2. When that is empty the API
// sends priceUnavailable=true and NO figures at all - we must show nothing
// rather than the other outlets' price, which the till here would not charge.
function showPricePendingReview(product) {
    ['normalPriceBox', 'promoPriceBox', 'memberPriceBox', 'promoQuantity',
     'memberQuantity', 'promoValidity'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });

    const section = document.querySelector('.price-section');
    if (!section) return;

    let box = document.getElementById('pricePendingBox');
    if (!box) {
        box = document.createElement('div');
        box.id = 'pricePendingBox';
        box.className = 'price-box';
        box.style.cssText =
            'display:block;background:#fff8e1;border-left:6px solid #f59e0b;' +
            'border-radius:8px;padding:18px 20px;text-align:center;';
        box.innerHTML =
            '<div style="font-size:1.35rem;font-weight:700;color:#92400e;margin-bottom:6px;">' +
            '<i class="fas fa-hourglass-half" style="margin-right:8px;"></i>Harga belum tersedia</div>' +
            '<div style="font-size:1rem;color:#92400e;">Sila tanya staf / Please ask our staff</div>';
        section.appendChild(box);
    }
    box.style.display = 'block';

    console.warn(`\u23f3 No price for ${product.ItemCode} at this outlet ` +
        `(${product.PriceColumn || 'Price2 empty'}) - showing pending review.`);
}

function hidePricePendingReview() {
    const box = document.getElementById('pricePendingBox');
    if (box) box.style.display = 'none';
    const normalBox = document.getElementById('normalPriceBox');
    if (normalBox) normalBox.style.display = '';
}

// Display Pricing - FIXED to show promo even when price equals normal but has minQty
function displayPricing(product) {
    console.log('=== displayPricing called ===');

    // Outlet has no price for this item - show the pending-review panel only.
    if (product.PriceUnavailable === true || product.PriceUnavailable === 'True') {
        showPricePendingReview(product);
        console.log('=== displayPricing complete (pending review) ===');
        return;
    }
    hidePricePendingReview();

    const normalPrice = parseFloat(product.NormalPrice) || 0;
    const promoPrice = parseFloat(product.PromoPrice) || 0;
    const memberPrice = parseFloat(product.MemberPrice1) || 0;

    const isPromoFlag = product.IsPromoValid === true || product.IsPromoValid === 'T';
    const promoWindowOpen = isPromoWindowOpen(product.Promotion);
    const promoLocationOk = isPromoForThisLocation(product);
    const isPromoValid = isPromoFlag && promoWindowOpen && promoLocationOk;

    if (isPromoFlag && !promoWindowOpen) {
        console.warn('⏰ Promo flagged valid by API but its date window is closed - suppressing.', product.Promotion);
    }

    const minQty = parseFloat(product.Promotion?.MinQty);
    const maxQty = parseFloat(product.Promotion?.MaxQty);

    // A quantity tier may only be advertised while the promotion is running.
    const hasValidQtyTier = isPromoValid && minQty && !isNaN(minQty) && minQty > 1;

    console.log('Price values:', { normalPrice, promoPrice, isPromoFlag, promoWindowOpen, promoLocationOk, isPromoValid, minQty, maxQty });
    
    // Normal Price Box
    const normalPriceBox = document.getElementById('normalPriceBox');
    const normalPriceValue = document.getElementById('normalPrice');
    const normalUOM = document.getElementById('normalUOM');
    
    normalPriceValue.textContent = formatPrice(normalPrice);
    normalUOM.textContent = getUOM(product);
    
    // Normal price always shown without strike-through
    normalPriceBox.querySelector('.price-value').classList.remove('crossed');
    
    // Promo Price Box
    const promoPriceBox = document.getElementById('promoPriceBox');
    const hasPromo = isPromoValid && promoPrice > 0 && promoPrice < normalPrice;
    
    console.log('hasPromo calculation:', hasPromo);
    
    if (hasPromo) {
        console.log('✅ SHOWING PROMO BOX');
        promoPriceBox.style.display = 'block';
        document.getElementById('promoPrice').textContent = formatPrice(promoPrice);
        document.getElementById('promoUOM').textContent = getUOM(product);
        
        // Calculate savings
        const savings = normalPrice - promoPrice;
        document.getElementById('savingsAmount').textContent = formatPrice(savings);
        
        // Show quantity requirement ONLY if MinQty is greater than 1
        const promoQtyBox = document.getElementById('promoQuantity');
        const promoQtyText = document.getElementById('promoQtyText');
        
        if (hasValidQtyTier) {
            console.log('✅ SHOWING QUANTITY BOX (active promo, MinQty > 1)');
            promoQtyText.textContent = buildQtyText(minQty, maxQty, getUOM(product));
            promoQtyBox.style.display = 'block';
        } else {
            promoQtyBox.style.display = 'none';
        }
        
        // Display promo validity
        displayPromoValidity(product);
    } else {
        console.log('❌ NOT SHOWING PROMO BOX');
        promoPriceBox.style.display = 'none';

        const promoQtyBox = document.getElementById('promoQuantity');
        if (promoQtyBox) {
            promoQtyBox.style.display = 'none';
        }

        // Hide the "Valid from / Valid until" row too. It was previously left
        // untouched here, so once any promo item had been scanned the validity
        // dates stayed on screen for every following item - including expired
        // ones - because displayPromoValidity() is only ever called in the
        // promo branch.
        const promoValidity = document.getElementById('promoValidity');
        if (promoValidity) {
            promoValidity.style.display = 'none';
        }
    }
    
    // Member Price Box (only if no promo or member price is better)
    //
    // MemberPrice1 is a separate field from the promotion: the API returns it
    // populated even when IsPromoValid is false and Promotion is null, so the
    // box used to appear on items that have no live offer at all. When
    // MEMBER_PRICE_REQUIRES_ACTIVE_PROMO is on, the box is tied to a currently
    // running promotion and a stale member rate can no longer advertise itself
    // as an exclusive deal.
    const memberPriceBox = document.getElementById('memberPriceBox');
    const memberGateOpen = !CONFIG.MEMBER_PRICE_REQUIRES_ACTIVE_PROMO || isPromoValid;

    if (!memberGateOpen && memberPrice > 0) {
        console.log(`ℹ️ Member price RM ${formatPrice(memberPrice)} hidden - no promotion currently running (MEMBER_PRICE_REQUIRES_ACTIVE_PROMO).`);
    }

    // A member price must actually BE a saving. A stale promo row can carry a
    // MemberPrice1 above the item's current normal price (promo entered when
    // the normal price was higher, then the price dropped) - showing that as
    // "MEMBER EXCLUSIVE ... Save RM -0.50" advertises paying MORE for being a
    // member. Suppress it and flag the data problem in the console.
    const memberIsARealDeal = memberPrice > 0 && memberPrice < normalPrice;

    if (memberGateOpen && memberPrice > 0 && !memberIsARealDeal) {
        console.warn(`🛑 Member price RM ${formatPrice(memberPrice)} is NOT below normal RM ${formatPrice(normalPrice)} - box suppressed. Check the promotion row for this item (stale member price?).`);
    }

    if (memberGateOpen && memberIsARealDeal && (!isPromoValid || !promoPrice || memberPrice < promoPrice)) {
        memberPriceBox.style.display = 'block';
        
        // Set member unit price
        document.getElementById('memberPrice').textContent = formatPrice(memberPrice);
        document.getElementById('memberUOM').textContent = getUOM(product);
        
        // The bulk "RM x.xx for N Units" row.
        //
        // BUG FIX: this was selected with '.price-value:nth-of-type(2)', which
        // ALWAYS returned null. Every child of #memberPriceBox is a <div>, so
        // :nth-of-type(2) resolves to the 2nd div - that is div.price-label,
        // which does not carry the .price-value class, so nothing matched.
        // Both show/hide branches below were therefore dead code and the bulk
        // row stayed permanently visible with whatever values were last written
        // (or the markup default, "RM 0.00 for 3 Units").
        // Index-based lookup targets the correct element: [0] = unit price,
        // [1] = the bulk total row.
        const memberTotalPriceSection = memberPriceBox.querySelectorAll('.price-value')[1] || null;

        const memberQtyBox = document.getElementById('memberQuantity');
        const memberQtyText = document.getElementById('memberQtyText');
        const memberSavingsElement = document.getElementById('memberSavingsAmount');

        if (hasValidQtyTier) {
            // Bulk tier comes from a promotion that is genuinely running today.
            const memberTotalQty = minQty;
            const memberTotalPrice = memberPrice * memberTotalQty;

            updateElement('memberTotalQty', memberTotalQty);
            updateElement('memberTotalPrice', formatPrice(memberTotalPrice));
            updateElement('memberTotalUOM', getUOM(product));

            if (memberTotalPriceSection) {
                memberTotalPriceSection.style.display = '';
            }

            if (memberSavingsElement) {
                const memberTotalSavings = (normalPrice * memberTotalQty) - memberTotalPrice;
                memberSavingsElement.textContent = formatPrice(memberTotalSavings);
            }

            if (memberQtyBox && memberQtyText) {
                memberQtyText.textContent = buildQtyText(minQty, maxQty, getUOM(product));
                memberQtyBox.style.display = 'block';
            }
        } else {
            // No promotion running: show the plain per-unit member price only.
            if (memberTotalPriceSection) {
                memberTotalPriceSection.style.display = 'none';
            } else {
                // Defensive: if the markup ever changes and the row cannot be
                // found, blank it so no phantom quantity is advertised.
                updateElement('memberTotalPrice', '0.00');
                updateElement('memberTotalQty', '0');
            }

            if (memberSavingsElement) {
                memberSavingsElement.textContent = formatPrice(normalPrice - memberPrice);
            }

            if (memberQtyBox) {
                memberQtyBox.style.display = 'none';
            }
        }
    } else {
        memberPriceBox.style.display = 'none';

        // Reset the inner rows as well. The box itself is hidden so this is not
        // visible now, but it stops a previous item's bulk tier lingering inside
        // and flashing on the next item that does show the member box.
        const staleBulkRow = memberPriceBox.querySelectorAll('.price-value')[1];
        if (staleBulkRow) staleBulkRow.style.display = 'none';

        const staleQtyBox = document.getElementById('memberQuantity');
        if (staleQtyBox) staleQtyBox.style.display = 'none';
    }

    console.log('=== displayPricing complete ===');
}

// Display Promo Validity
function displayPromoValidity(product) {
    const promoValidity = document.getElementById('promoValidity');
    
    if (product.Promotion) {
        promoValidity.style.display = 'flex';
        
        const fromDate = product.Promotion.FromDate ? formatDate(product.Promotion.FromDate) : '-';
        const toDate = product.Promotion.ToDate ? formatDate(product.Promotion.ToDate) : '-';
        
        document.getElementById('validFrom').textContent = fromDate;
        document.getElementById('validUntil').textContent = toDate;
    } else {
        promoValidity.style.display = 'none';
    }
}

// Utility Functions
function updateElement(id, value) {
    const element = document.getElementById(id);
    if (element) {
        element.textContent = value;
    }
}

function formatPrice(price) {
    const num = parseFloat(price) || 0;
    return num.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatNumber(num) {
    return parseFloat(num).toLocaleString('en-MY', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
    });
}

function formatDate(dateString) {
    if (!dateString) return '-';
    
    try {
        const date = new Date(dateString);
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = date.getFullYear();
        return `${day}/${month}/${year}`;
    } catch (error) {
        return '-';
    }
}

function normalizeKeys(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    
    // Handle arrays
    if (Array.isArray(obj)) {
        return obj.map(item => normalizeKeys(item));
    }
    
    // Handle objects - normalize keys recursively
    const normalized = {};
    
    for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
            // Capitalize first letter of key
            const newKey = key.charAt(0).toUpperCase() + key.slice(1);
            
            // Recursively normalize nested objects!
            const value = obj[key];
            if (value !== null && typeof value === 'object') {
                normalized[newKey] = normalizeKeys(value);
            } else {
                normalized[newKey] = value;
            }
        }
    }
    
    return normalized;
}

function scheduleAutoReset() {
    // Clear existing timeout
    if (state.resetTimeout) {
        clearTimeout(state.resetTimeout);
    }
    
    // Schedule new reset
    state.resetTimeout = setTimeout(() => {
        resetDisplay();
    }, CONFIG.AUTO_RESET_DELAY);
}

function showLoading() {
    document.getElementById('loadingOverlay').style.display = 'flex';
}

function hideLoading() {
    document.getElementById('loadingOverlay').style.display = 'none';
}

function showError(message) {
    const errorMessage = document.getElementById('errorMessage');
    const errorContent = errorMessage.querySelector('p');
    
    if (errorContent) {
        errorContent.textContent = message || 'An error occurred';
    }
    
    errorMessage.style.display = 'flex';
    document.getElementById('slideshowContainer').style.display = 'none';
    document.getElementById('priceDisplay').style.display = 'none';
    
    resetToSlideshow();
}

function hideError() {
    document.getElementById('errorMessage').style.display = 'none';
}

function resetDisplay() {
    hideError();
    hideLoading();
    document.getElementById('priceDisplay').style.display = 'none';
    document.getElementById('slideshowContainer').style.display = 'block';
    startSlideshow();
}

function resetToSlideshow() {
    if (state.resetTimeout) {
        clearTimeout(state.resetTimeout);
    }
    
    state.resetTimeout = setTimeout(() => {
        resetDisplay();
    }, CONFIG.AUTO_RESET_DELAY);
}

// Event Listeners Setup
function setupEventListeners() {
    // Click anywhere to reset
    document.addEventListener('click', function(e) {
        // Don't reset if clicking on input fields or buttons
        if (e.target.tagName === 'INPUT' || 
            e.target.tagName === 'BUTTON' ||
            e.target.closest('button')) {
            return;
        }
        
        // If price display is showing, reset to slideshow
        if (document.getElementById('priceDisplay').style.display === 'block') {
            resetDisplay();
        }
    });
    
    // Escape key to reset
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            resetDisplay();
            exitFullscreen();
        }
    });
}

// Toggle Header Function
function toggleHeader() {
    const header = document.getElementById('header');
    const toggleBtn = document.getElementById('toggleHeaderBtn');
    
    if (header.style.display === 'none') {
        header.style.display = 'block';
        toggleBtn.innerHTML = '<i class="fas fa-times"></i> Close';
        // Focus on manual input when header is shown
        setTimeout(() => {
            document.getElementById('manualInput').focus();
        }, 100);
    } else {
        header.style.display = 'none';
        toggleBtn.innerHTML = '<i class="fas fa-search"></i> Search';
    }
}

// Fullscreen Functions
function requestFullscreen() {
    const elem = document.documentElement;
    
    if (elem.requestFullscreen) {
        elem.requestFullscreen().catch(err => {
            console.log('Fullscreen request failed:', err);
        });
    } else if (elem.webkitRequestFullscreen) { // Safari
        elem.webkitRequestFullscreen();
    } else if (elem.msRequestFullscreen) { // IE/Edge
        elem.msRequestFullscreen();
    }
}

function exitFullscreen() {
    if (document.exitFullscreen) {
        document.exitFullscreen().catch(err => {
            console.log('Exit fullscreen failed:', err);
        });
    } else if (document.webkitExitFullscreen) { // Safari
        document.webkitExitFullscreen();
    } else if (document.msExitFullscreen) { // IE/Edge
        document.msExitFullscreen();
    }
}

// Check if in fullscreen
function isFullscreen() {
    return !!(document.fullscreenElement || 
              document.webkitFullscreenElement || 
              document.msFullscreenElement);
}

// Listen for fullscreen changes
document.addEventListener('fullscreenchange', handleFullscreenChange);
document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
document.addEventListener('msfullscreenchange', handleFullscreenChange);

function handleFullscreenChange() {
    if (isFullscreen()) {
        console.log('Entered fullscreen mode');
        document.body.classList.add('fullscreen');
    } else {
        console.log('Exited fullscreen mode');
        document.body.classList.remove('fullscreen');
    }
}

// Expose functions to global scope for HTML onclick handlers
window.searchManual = searchManual;
window.resetDisplay = resetDisplay;
window.toggleHeader = toggleHeader;
window.goToSlide = goToSlide;

// Clean up on page unload
window.addEventListener('beforeunload', function() {
    if (state.slideInterval) {
        clearInterval(state.slideInterval);
    }
    if (state.resetTimeout) {
        clearTimeout(state.resetTimeout);
    }
    if (state.barcodeTimeout) {
        clearTimeout(state.barcodeTimeout);
    }
    if (state.updateCheckInterval) {
        clearInterval(state.updateCheckInterval);
    }
});

console.log('Price Checker initialized successfully');