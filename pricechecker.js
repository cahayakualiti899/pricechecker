
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

    // Slider images - served locally from this site so the shelf display keeps
    // working with no internet.
    // Physical path: C:\inetpub\wwwroot\PriceChecker\images\slider\
    // Files must be slide1.jpg, slide2.jpg, ... with NO gaps (detection stops
    // at the first missing number).
    SLIDES_BASE: 'images/slider/',
    SLIDE_PREFIX: 'slide',
    SLIDE_EXT: '.jpg',
    MAX_SLIDES: 20,

    GITHUB_BASE: 'https://raw.githubusercontent.com/jayasuperstore/image/main/',
    PRODUCT_IMAGE_BASE: 'https://raw.githubusercontent.com/jayasuperstore/image/main/products/',
    DEFAULT_IMAGE: 'https://raw.githubusercontent.com/jayasuperstore/image/main/products/none.png',

    AUTO_UPDATE: {
        ENABLED: true,
        CHECK_INTERVAL: 300000,
        FILES: {
            HTML: 'https://raw.githubusercontent.com/jayasuperstore/image/main/pricechecker/index.html',
            JS:   'https://raw.githubusercontent.com/jayasuperstore/image/main/pricechecker/js/pricechecker.js',
            CSS:  'https://raw.githubusercontent.com/jayasuperstore/image/main/pricechecker/css/pricechecker.css'
        },
        VERSION_URL: 'https://raw.githubusercontent.com/jayasuperstore/image/main/pricechecker/version.json'
    },

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
    currentVersion: '1.7.3', // Increment this with each update
    lastUpdateCheck: null
};

// Initialize on page load
document.addEventListener('DOMContentLoaded', async function() {
    console.log(`Price Checker v${state.currentVersion} - Auto Update System Enabled`);

    // 1) Load per-device API config from ip.json
    await loadIpConfig();
    
    // Initialize auto-update system
    if (CONFIG.AUTO_UPDATE.ENABLED) {
        await initializeAutoUpdate();
    }
    
    await buildSlideshow(); // Build slideshow dynamically with auto-detection
    initializeBarcodeScanner();
    setupEventListeners();
    setupManualInput();
    
    // Auto-request fullscreen on page load
    setTimeout(() => {
        requestFullscreen();
    }, 500); // Small delay to ensure page is fully loaded
});

// ============================================
// AUTO-UPDATE SYSTEM
// ============================================

async function initializeAutoUpdate() {
    console.log('Initializing auto-update system...');
    
    // Check for updates immediately on startup
    await checkForUpdates();
    
    // Set up periodic update checks
    if (CONFIG.AUTO_UPDATE.CHECK_INTERVAL > 0) {
        state.updateCheckInterval = setInterval(async () => {
            await checkForUpdates();
        }, CONFIG.AUTO_UPDATE.CHECK_INTERVAL);
        
        console.log(`Auto-update check scheduled every ${CONFIG.AUTO_UPDATE.CHECK_INTERVAL / 1000} seconds`);
    }
}

async function checkForUpdates() {
    try {
        console.log('Checking for updates from GitHub...');
        state.lastUpdateCheck = new Date();
        
        // First, check version file if available
        const hasNewVersion = await checkVersion();
        
        if (hasNewVersion) {
            console.log('New version detected, updating files...');
            await updateFiles();
        } else {
            // Fallback: Check file modifications by comparing content hashes
            const needsUpdate = await checkFileChanges();
            if (needsUpdate) {
                console.log('File changes detected, updating...');
                await updateFiles();
            } else {
                console.log('All files are up to date');
            }
        }
        
        // Update the UI to show last check time
        updateLastCheckTime();
        
    } catch (error) {
        console.error('Error checking for updates:', error);
    }
}

// Compare two dotted version strings.
// Returns 1 if a > b, -1 if a < b, 0 if equal. Missing segments count as 0,
// so '1.7' and '1.7.0' compare equal.
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

async function checkVersion() {
    try {
        const response = await fetch(CONFIG.AUTO_UPDATE.VERSION_URL + '?t=' + Date.now(), {
            cache: 'no-cache'
        });

        if (response.ok) {
            const versionData = await response.json();
            console.log('Remote version:', versionData.version, 'Current version:', state.currentVersion);

            // Only update when the remote build is strictly NEWER.
            // The previous check was `remote !== current`, which meant a locally
            // patched kiosk running ahead of the repo would DOWNGRADE itself back
            // to the older GitHub copy on the very next check - silently undoing
            // any fix deployed straight to the machine.
            if (versionData.version && compareVersions(versionData.version, state.currentVersion) > 0) {
                console.log('Newer version available on GitHub - updating.');
                return true;
            }

            if (versionData.version && compareVersions(versionData.version, state.currentVersion) < 0) {
                console.log('This kiosk is NEWER than GitHub - staying put (no downgrade).');
            }
        }
    } catch (error) {
        console.log('Version file not found or error reading it, falling back to content check');
    }

    return false;
}

async function checkFileChanges() {
    try {
        // Get current page's script content
        const currentScript = document.querySelector('script[src*="pricechecker.js"]');
        if (!currentScript) return false;
        
        // Fetch the latest JS file from GitHub
        const response = await fetch(CONFIG.AUTO_UPDATE.FILES.JS + '?t=' + Date.now(), {
            cache: 'no-cache'
        });
        
        if (response.ok) {
            const remoteContent = await response.text();

            // REMOVED: the old size comparison
            //     const currentSize = currentScript.innerHTML ? ... : 0;   // always 0
            //     if (Math.abs(currentSize - remoteSize) > 100) return true;
            // `currentScript` is an EXTERNAL <script src="...">, so .innerHTML is
            // always '' and currentSize was always 0. Every single check therefore
            // reported "changed" and re-pulled the GitHub copy over the local file
            // on startup and every 5 minutes - which is how local fixes kept
            // disappearing. Version comparison is the only reliable signal here.
            const versionMatch = remoteContent.match(/currentVersion:\s*['"]([^'"]+)['"]/);

            if (versionMatch) {
                const remoteVersion = versionMatch[1];
                if (compareVersions(remoteVersion, state.currentVersion) > 0) {
                    console.log(`Remote script is newer (${remoteVersion} > ${state.currentVersion})`);
                    return true;
                }
                console.log(`Remote script ${remoteVersion} is not newer than ${state.currentVersion} - skipping.`);
            }
        }
    } catch (error) {
        console.error('Error checking file changes:', error);
    }
    
    return false;
}

async function updateFiles() {
    try {
        console.log('Starting file update process...');
        
        // Show update notification
        showUpdateNotification('Updating application...');
        
        // Update JavaScript
        await updateJavaScript();
        
        // Update CSS
        await updateCSS();
        
        // Update HTML (this will reload the page)
        await updateHTML();
        
    } catch (error) {
        console.error('Error updating files:', error);
        showUpdateNotification('Update failed. Please refresh manually.', 'error');
    }
}

async function updateJavaScript() {
    try {
        const response = await fetch(CONFIG.AUTO_UPDATE.FILES.JS + '?t=' + Date.now(), {
            cache: 'no-cache'
        });
        
        if (response.ok) {
            const newScript = await response.text();
            
            // Store in localStorage for persistence
            localStorage.setItem('pricechecker_js_content', newScript);
            localStorage.setItem('pricechecker_js_updated', new Date().toISOString());
            
            console.log('JavaScript updated in localStorage');
            
            // Create a new script element with the updated code
            const scriptElement = document.createElement('script');
            scriptElement.textContent = newScript;
            
            // Remove old script and add new one
            const oldScript = document.querySelector('script[src*="pricechecker.js"]');
            if (oldScript) {
                oldScript.remove();
            }
            
            document.body.appendChild(scriptElement);
            console.log('JavaScript hot-reloaded');
        }
    } catch (error) {
        console.error('Error updating JavaScript:', error);
        throw error;
    }
}

async function updateCSS() {
    try {
        const response = await fetch(CONFIG.AUTO_UPDATE.FILES.CSS + '?t=' + Date.now(), {
            cache: 'no-cache'
        });
        
        if (response.ok) {
            const newCSS = await response.text();
            
            // Store in localStorage
            localStorage.setItem('pricechecker_css_content', newCSS);
            localStorage.setItem('pricechecker_css_updated', new Date().toISOString());
            
            // Hot-reload CSS
            let styleElement = document.getElementById('dynamic-styles');
            if (!styleElement) {
                styleElement = document.createElement('style');
                styleElement.id = 'dynamic-styles';
                document.head.appendChild(styleElement);
            }
            
            styleElement.textContent = newCSS;
            console.log('CSS hot-reloaded');
        }
    } catch (error) {
        console.error('Error updating CSS:', error);
        // CSS update failure is not critical, continue
    }
}

async function updateHTML() {
    try {
        const response = await fetch(CONFIG.AUTO_UPDATE.FILES.HTML + '?t=' + Date.now(), {
            cache: 'no-cache'
        });
        
        if (response.ok) {
            const newHTML = await response.text();
            
            // Store in localStorage
            localStorage.setItem('pricechecker_html_content', newHTML);
            localStorage.setItem('pricechecker_html_updated', new Date().toISOString());
            
            console.log('HTML updated in localStorage');
            
            // Schedule page reload after a short delay
            showUpdateNotification('Update complete! Reloading...', 'success');
            
            setTimeout(() => {
                // Clear cache and reload
                if ('caches' in window) {
                    caches.keys().then(names => {
                        names.forEach(name => caches.delete(name));
                    });
                }
                
                // Force reload with cache bypass
                window.location.reload(true);
            }, 2000);
        }
    } catch (error) {
        console.error('Error updating HTML:', error);
        throw error;
    }
}

function showUpdateNotification(message, type = 'info') {
    // Remove existing notification if any
    const existingNotification = document.getElementById('update-notification');
    if (existingNotification) {
        existingNotification.remove();
    }
    
    // Create notification element
    const notification = document.createElement('div');
    notification.id = 'update-notification';
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        padding: 15px 30px;
        background: ${type === 'error' ? '#dc2626' : type === 'success' ? '#10b981' : '#3b82f6'};
        color: white;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        z-index: 10000;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        font-weight: 600;
        animation: slideDown 0.3s ease;
    `;
    
    notification.innerHTML = `
        <i class="fas ${type === 'error' ? 'fa-exclamation-triangle' : type === 'success' ? 'fa-check-circle' : 'fa-sync fa-spin'}" style="margin-right: 10px;"></i>
        ${message}
    `;
    
    document.body.appendChild(notification);
    
    // Add animation
    const style = document.createElement('style');
    style.textContent = `
        @keyframes slideDown {
            from {
                opacity: 0;
                transform: translateX(-50%) translateY(-20px);
            }
            to {
                opacity: 1;
                transform: translateX(-50%) translateY(0);
            }
        }
    `;
    document.head.appendChild(style);
    
    // Auto-remove after 5 seconds (except for reload notifications)
    if (type !== 'success') {
        setTimeout(() => {
            if (notification.parentNode) {
                notification.remove();
            }
        }, 5000);
    }
}

function updateLastCheckTime() {
    // Create or update a small indicator showing last update check
    let indicator = document.getElementById('update-indicator');
    if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = 'update-indicator';
        indicator.style.cssText = `
            position: fixed;
            bottom: 10px;
            left: 10px;
            font-size: 10px;
            color: #999;
            z-index: 100;
            font-family: monospace;
        `;
        document.body.appendChild(indicator);
    }
    
    const time = state.lastUpdateCheck ? state.lastUpdateCheck.toLocaleTimeString() : 'Never';
    indicator.textContent = `Last update check: ${time}`;
}

// Load cached content on page startup (for offline capability)
function loadCachedContent() {
    // Check if we have cached content in localStorage
    const cachedJS = localStorage.getItem('pricechecker_js_content');
    const cachedCSS = localStorage.getItem('pricechecker_css_content');
    
    if (cachedCSS) {
        // Apply cached CSS immediately
        const styleElement = document.createElement('style');
        styleElement.id = 'cached-styles';
        styleElement.textContent = cachedCSS;
        document.head.appendChild(styleElement);
        console.log('Loaded cached CSS');
    }
    
    // Note: Cached JS is already running if this code is executing
    // This function is mainly for applying cached CSS
}

// Call this at the very start
loadCachedContent();

// ============================================
// ORIGINAL PRICE CHECKER FUNCTIONALITY
// ============================================

// Auto-detect available slides and build slideshow
async function buildSlideshow() {
    const baseImageUrl = CONFIG.SLIDES_BASE; // local folder - no internet required
    const slideshowContainer = document.getElementById('slideshowContainer');
    const maxSlides = CONFIG.MAX_SLIDES; // Maximum slides to check
    const availableSlides = [];

    const slideName = (i) => `${CONFIG.SLIDE_PREFIX}${i}${CONFIG.SLIDE_EXT}`;

    console.log(`Detecting available slides in "${baseImageUrl}"...`);

    // Check slides sequentially
    for (let i = 1; i <= maxSlides; i++) {
        const imageUrl = `${baseImageUrl}${slideName(i)}`;
        const exists = await checkImageExists(imageUrl);

        if (exists) {
            availableSlides.push(imageUrl);
            console.log(`Found: ${slideName(i)}`);
        } else {
            // Stop checking after first missing slide
            console.log(`${slideName(i)} not found, stopping detection`);
            break;
        }
    }

    // If no slides found, default to slide1
    if (availableSlides.length === 0) {
        console.warn(`No slides found in "${baseImageUrl}" - check the folder exists and files are named ${slideName(1)}, ${slideName(2)}, ...`);
        availableSlides.push(`${baseImageUrl}${slideName(1)}`);
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

// Display Pricing - FIXED to show promo even when price equals normal but has minQty
function displayPricing(product) {
    console.log('=== displayPricing called ===');

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

    if (memberGateOpen && memberPrice > 0 && (!isPromoValid || !promoPrice || memberPrice < promoPrice)) {
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