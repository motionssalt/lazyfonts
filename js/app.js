/**
 * Font Extractor Pro
 * Extract and repackage fonts from ZIP files
 * 
 * Features:
 * - Multiple ZIP file import
 * - Deep recursive extraction (nested ZIPs and folders)
 * - Intelligent ZIP naming
 * - Client-side only processing
 */

// ==========================================================================
// Configuration
// ==========================================================================

const FONT_EXTENSIONS = ['.ttf', '.otf', '.woff', '.woff2', '.eot', '.svg'];
const MAX_RECURSION_DEPTH = 10; // Prevent infinite loops in nested ZIPs

// ==========================================================================
// DOM Elements
// ==========================================================================

const uploadArea = document.getElementById('uploadArea');
const fileInput = document.getElementById('fileInput');
const processingSection = document.getElementById('processingSection');
const processingList = document.getElementById('processingList');
const resultsSection = document.getElementById('resultsSection');
const resultsList = document.getElementById('resultsList');
const downloadAllBtn = document.getElementById('downloadAllBtn');
const emptyState = document.getElementById('emptyState');
const toastContainer = document.getElementById('toastContainer');

// ==========================================================================
// State
// ==========================================================================

let extractedResults = []; // Store all extraction results

// ==========================================================================
// Utility Functions
// ==========================================================================

/**
 * Check if a filename is a font file
 */
function isFontFile(filename) {
    const ext = filename.toLowerCase().substring(filename.lastIndexOf('.'));
    
    // For SVG files, try to detect if it's a font SVG
    if (ext === '.svg') {
        // We'll include all SVGs and let users decide
        // A more sophisticated check would parse the SVG content
        return true;
    }
    
    return FONT_EXTENSIONS.includes(ext);
}

/**
 * Check if a filename is a ZIP file
 */
function isZipFile(filename) {
    return filename.toLowerCase().endsWith('.zip');
}

/**
 * Extract the base filename from a path
 */
function getBasename(path) {
    return path.split('/').pop().split('\\').pop();
}

/**
 * Format file size for display
 */
function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Generate a safe filename by removing special characters
 */
function sanitizeFilename(name) {
    return name.replace(/[^a-zA-Z0-9-_. ]/g, '').trim();
}

/**
 * Detect font family name from font filenames
 */
function detectFontFamily(fontFiles) {
    if (fontFiles.length === 0) return null;
    
    // Common patterns to remove
    const patterns = [
        /-?(Regular|Bold|Italic|Light|Medium|SemiBold|ExtraBold|Black|Thin|Heavy)/gi,
        /-?(Oblique|Condensed|Extended|Narrow)/gi,
        /\.(ttf|otf|woff|woff2|eot|svg)$/i,
        /[-_]?(v\d+)/gi,
        /[-_]?(\d+)/g
    ];
    
    // Get all font basenames
    const names = fontFiles.map(f => getBasename(f.name));
    
    // Find common prefix
    if (names.length === 1) {
        let name = names[0];
        patterns.forEach(p => name = name.replace(p, ''));
        return sanitizeFilename(name) || null;
    }
    
    // Find longest common prefix
    let prefix = names[0];
    for (let i = 1; i < names.length; i++) {
        while (names[i].indexOf(prefix) !== 0) {
            prefix = prefix.substring(0, prefix.length - 1);
            if (prefix === '') break;
        }
    }
    
    if (prefix.length > 2) {
        patterns.forEach(p => prefix = prefix.replace(p, ''));
        // Remove trailing dashes/underscores
        prefix = prefix.replace(/[-_]+$/, '');
        return sanitizeFilename(prefix) || null;
    }
    
    return null;
}

/**
 * Generate intelligent ZIP filename
 */
function generateZipName(originalZipName, fontFiles) {
    // Try to detect font family
    const fontFamily = detectFontFamily(fontFiles);
    
    if (fontFamily && fontFamily.length > 2) {
        return `${fontFamily}-Fonts.zip`;
    }
    
    // Use original ZIP name
    const baseName = originalZipName.replace(/\.zip$/i, '');
    const sanitized = sanitizeFilename(baseName);
    
    if (sanitized && sanitized.length > 2) {
        return `${sanitized}-Extracted-Fonts.zip`;
    }
    
    // Fallback with timestamp
    const timestamp = Date.now();
    return `extracted-fonts-${timestamp}.zip`;
}

/**
 * Handle duplicate filenames by adding suffix
 */
function makeUniqueFilename(filename, existingNames) {
    if (!existingNames.has(filename)) {
        return filename;
    }
    
    const ext = filename.substring(filename.lastIndexOf('.'));
    const base = filename.substring(0, filename.lastIndexOf('.'));
    
    let counter = 1;
    let newName;
    do {
        newName = `${base}-${counter}${ext}`;
        counter++;
    } while (existingNames.has(newName));
    
    return newName;
}

// ==========================================================================
// Toast Notifications
// ==========================================================================

function showToast(type, title, message, duration = 5000) {
    const icons = {
        success: 'fa-check-circle',
        error: 'fa-exclamation-circle',
        warning: 'fa-exclamation-triangle',
        info: 'fa-info-circle'
    };
    
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <i class="fas ${icons[type]} toast-icon"></i>
        <div class="toast-content">
            <div class="toast-title">${title}</div>
            <div class="toast-message">${message}</div>
        </div>
        <button class="toast-close" onclick="this.parentElement.remove()">
            <i class="fas fa-times"></i>
        </button>
    `;
    
    toastContainer.appendChild(toast);
    
    // Auto remove
    setTimeout(() => {
        toast.classList.add('fade-out');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// ==========================================================================
// UI Updates
// ==========================================================================

function showProcessingSection() {
    processingSection.classList.add('active');
    emptyState.classList.add('hidden');
}

function hideProcessingSection() {
    processingSection.classList.remove('active');
}

function showResultsSection() {
    resultsSection.classList.add('active');
    emptyState.classList.add('hidden');
}

function updateEmptyState() {
    if (extractedResults.length === 0) {
        emptyState.classList.remove('hidden');
        resultsSection.classList.remove('active');
    }
}

function addProcessingItem(id, filename) {
    const item = document.createElement('div');
    item.className = 'processing-item';
    item.id = `processing-${id}`;
    item.innerHTML = `
        <div class="icon">
            <i class="fas fa-file-archive"></i>
        </div>
        <div class="info">
            <div class="name">${filename}</div>
            <div class="status scanning">
                <i class="fas fa-circle"></i>
                <span>Scanning ZIP...</span>
            </div>
        </div>
        <div class="progress-bar">
            <div class="progress" style="width: 0%"></div>
        </div>
    `;
    processingList.appendChild(item);
    return item;
}

function updateProcessingStatus(id, status, statusText, progress) {
    const item = document.getElementById(`processing-${id}`);
    if (!item) return;
    
    const statusEl = item.querySelector('.status');
    const progressEl = item.querySelector('.progress');
    
    statusEl.className = `status ${status}`;
    statusEl.innerHTML = `<i class="fas fa-circle"></i><span>${statusText}</span>`;
    progressEl.style.width = `${progress}%`;
}

function removeProcessingItem(id) {
    const item = document.getElementById(`processing-${id}`);
    if (item) {
        item.remove();
    }
    
    // Hide processing section if empty
    if (processingList.children.length === 0) {
        hideProcessingSection();
    }
}

function addResultCard(result) {
    const fontTags = result.fonts.map(f => `
        <span class="font-tag">
            <i class="fas fa-font"></i>
            ${f.name}
        </span>
    `).join('');
    
    const card = document.createElement('div');
    card.className = 'result-card';
    card.id = `result-${result.id}`;
    card.innerHTML = `
        <div class="result-card-header">
            <div class="result-card-icon">
                <i class="fas fa-file-archive"></i>
            </div>
            <div class="result-card-info">
                <h3>${result.outputName}</h3>
                <div class="result-card-meta">
                    <span><i class="fas fa-font"></i> ${result.fonts.length} fonts</span>
                    <span><i class="fas fa-file"></i> ${formatFileSize(result.size)}</span>
                    <span><i class="fas fa-archive"></i> From: ${result.originalName}</span>
                </div>
            </div>
        </div>
        <div class="result-card-fonts">
            ${fontTags}
        </div>
        <div class="result-card-actions">
            <button class="btn btn-primary" onclick="downloadResult('${result.id}')">
                <i class="fas fa-download"></i> Download ZIP
            </button>
            <button class="btn btn-secondary" onclick="removeResult('${result.id}')">
                <i class="fas fa-trash"></i> Remove
            </button>
        </div>
    `;
    
    resultsList.appendChild(card);
}

// ==========================================================================
// Font Extraction Logic
// ==========================================================================

/**
 * Recursively extract fonts from a ZIP file
 * Handles nested ZIPs and folders
 */
async function extractFontsFromZip(zipData, depth = 0) {
    if (depth > MAX_RECURSION_DEPTH) {
        console.warn('Max recursion depth reached');
        return [];
    }
    
    const fonts = [];
    
    try {
        const zip = await JSZip.loadAsync(zipData);
        const entries = Object.keys(zip.files);
        
        for (const path of entries) {
            const entry = zip.files[path];
            
            // Skip directories
            if (entry.dir) continue;
            
            const filename = getBasename(path);
            
            // Check if it's a nested ZIP
            if (isZipFile(filename)) {
                try {
                    const nestedZipData = await entry.async('arraybuffer');
                    const nestedFonts = await extractFontsFromZip(nestedZipData, depth + 1);
                    fonts.push(...nestedFonts);
                } catch (e) {
                    console.warn(`Failed to process nested ZIP: ${filename}`, e);
                }
                continue;
            }
            
            // Check if it's a font file
            if (isFontFile(filename)) {
                try {
                    const data = await entry.async('arraybuffer');
                    fonts.push({
                        name: filename,
                        data: data,
                        size: data.byteLength,
                        originalPath: path
                    });
                } catch (e) {
                    console.warn(`Failed to extract font: ${filename}`, e);
                }
            }
        }
    } catch (e) {
        console.error('Failed to process ZIP:', e);
        throw e;
    }
    
    return fonts;
}

/**
 * Create a new ZIP with fonts at root level
 */
async function createFontZip(fonts) {
    const zip = new JSZip();
    const usedNames = new Set();
    
    for (const font of fonts) {
        // Ensure unique filename at root
        const uniqueName = makeUniqueFilename(font.name, usedNames);
        usedNames.add(uniqueName);
        
        zip.file(uniqueName, font.data);
    }
    
    const blob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }
    });
    
    return blob;
}

/**
 * Process a single ZIP file
 */
async function processZipFile(file) {
    const id = Date.now() + Math.random().toString(36).substr(2, 9);
    const processingItem = addProcessingItem(id, file.name);
    
    try {
        // Update status: Scanning
        updateProcessingStatus(id, 'scanning', 'Scanning ZIP...', 20);
        await sleep(100); // Allow UI update
        
        // Extract fonts recursively
        updateProcessingStatus(id, 'extracting', 'Extracting fonts...', 40);
        const arrayBuffer = await file.arrayBuffer();
        const fonts = await extractFontsFromZip(arrayBuffer);
        
        if (fonts.length === 0) {
            updateProcessingStatus(id, 'warning', 'No fonts found', 100);
            showToast('warning', 'No Fonts Found', `${file.name} doesn't contain any font files.`);
            
            setTimeout(() => removeProcessingItem(id), 2000);
            return null;
        }
        
        // Package fonts into new ZIP
        updateProcessingStatus(id, 'packaging', `Packaging ${fonts.length} fonts...`, 70);
        await sleep(100);
        
        const outputName = generateZipName(file.name, fonts);
        const zipBlob = await createFontZip(fonts);
        
        updateProcessingStatus(id, 'complete', `Complete! ${fonts.length} fonts`, 100);
        
        const result = {
            id: id,
            originalName: file.name,
            outputName: outputName,
            fonts: fonts.map(f => ({ name: f.name, size: f.size })),
            blob: zipBlob,
            size: zipBlob.size
        };
        
        extractedResults.push(result);
        
        // Remove processing item and add result
        setTimeout(() => {
            removeProcessingItem(id);
            addResultCard(result);
            showResultsSection();
        }, 500);
        
        showToast('success', 'Extraction Complete', `${fonts.length} fonts extracted from ${file.name}`);
        
        return result;
        
    } catch (error) {
        console.error('Error processing ZIP:', error);
        updateProcessingStatus(id, 'error', 'Error processing file', 100);
        showToast('error', 'Processing Error', `Failed to process ${file.name}: ${error.message}`);
        
        setTimeout(() => removeProcessingItem(id), 3000);
        return null;
    }
}

/**
 * Sleep utility for async operations
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Process multiple ZIP files
 */
async function processFiles(files) {
    const zipFiles = Array.from(files).filter(f => f.name.toLowerCase().endsWith('.zip'));
    
    if (zipFiles.length === 0) {
        showToast('warning', 'Invalid Files', 'Please upload ZIP files only.');
        return;
    }
    
    showProcessingSection();
    
    // Process files sequentially to avoid memory issues with large files
    for (const file of zipFiles) {
        await processZipFile(file);
    }
}

// ==========================================================================
// Download Functions
// ==========================================================================

function downloadResult(id) {
    const result = extractedResults.find(r => r.id === id);
    if (!result) return;
    
    const url = URL.createObjectURL(result.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = result.outputName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    showToast('success', 'Download Started', `Downloading ${result.outputName}`);
}

function removeResult(id) {
    const index = extractedResults.findIndex(r => r.id === id);
    if (index > -1) {
        extractedResults.splice(index, 1);
    }
    
    const card = document.getElementById(`result-${id}`);
    if (card) {
        card.remove();
    }
    
    updateEmptyState();
}

async function downloadAll() {
    if (extractedResults.length === 0) {
        showToast('info', 'Nothing to Download', 'No extracted fonts available.');
        return;
    }
    
    if (extractedResults.length === 1) {
        downloadResult(extractedResults[0].id);
        return;
    }
    
    // Create a master ZIP containing all font ZIPs
    showToast('info', 'Preparing Download', 'Creating combined archive...');
    
    const masterZip = new JSZip();
    
    for (const result of extractedResults) {
        const arrayBuffer = await result.blob.arrayBuffer();
        masterZip.file(result.outputName, arrayBuffer);
    }
    
    const masterBlob = await masterZip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }
    });
    
    const url = URL.createObjectURL(masterBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `all-extracted-fonts-${Date.now()}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    showToast('success', 'Download Started', `Downloading all ${extractedResults.length} font packages`);
}

// ==========================================================================
// Event Listeners
// ==========================================================================

// Click to upload
uploadArea.addEventListener('click', () => {
    fileInput.click();
});

// File input change
fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        processFiles(e.target.files);
        e.target.value = ''; // Reset for re-upload
    }
});

// Drag and drop
uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    uploadArea.classList.add('drag-over');
});

uploadArea.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    uploadArea.classList.remove('drag-over');
});

uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    uploadArea.classList.remove('drag-over');
    
    const files = e.dataTransfer.files;
    if (files.length > 0) {
        processFiles(files);
    }
});

// Download all button
downloadAllBtn.addEventListener('click', downloadAll);

// Prevent default drag behavior on window
window.addEventListener('dragover', (e) => {
    e.preventDefault();
});

window.addEventListener('drop', (e) => {
    e.preventDefault();
});

// ==========================================================================
// Initialize
// ==========================================================================

console.log('Font Extractor Pro initialized');
console.log('Supported formats:', FONT_EXTENSIONS.join(', '));
