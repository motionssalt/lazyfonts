# Font Extractor Pro

A powerful, fully client-side web application that extracts font files from ZIP archives—even if the fonts are deeply nested inside folders or inside other ZIP files—and repackages them into clean, organized ZIP files.

![Font Extractor Pro](https://img.shields.io/badge/Status-Production%20Ready-brightgreen)
![License](https://img.shields.io/badge/License-MIT-blue)
![Client Side](https://img.shields.io/badge/Processing-100%25%20Client%20Side-purple)

## 🎯 Features

### Core Functionality
- **Multiple ZIP Import**: Upload multiple ZIP files at once via drag-and-drop or file picker
- **Deep Recursive Extraction**: Automatically scans nested folders and ZIP files within ZIP files
- **Smart Font Detection**: Detects and extracts all common font formats
- **Clean Repackaging**: Places all fonts at the root level of the output ZIP (no nested folders)
- **Intelligent Naming**: Automatically generates meaningful ZIP filenames based on font family names

### Supported Font Formats
- `.ttf` - TrueType Font
- `.otf` - OpenType Font
- `.woff` - Web Open Font Format
- `.woff2` - Web Open Font Format 2
- `.eot` - Embedded OpenType
- `.svg` - SVG Font

### User Experience
- **Dark Mode Design**: Modern, beautiful dark theme with subtle glow effects
- **Real-time Progress**: Visual indicators showing scanning, extracting, and packaging stages
- **Toast Notifications**: Informative messages for success, warnings, and errors
- **Responsive Layout**: Works seamlessly on desktop and mobile devices
- **Download All**: One-click download of all extracted font packages

## 📁 Project Structure

```
font-extractor-pro/
├── index.html          # Main HTML page
├── css/
│   └── style.css       # Complete styling with dark theme
├── js/
│   └── app.js          # Main application logic
└── README.md           # Project documentation
```

## 🚀 Entry Point

- **Main Page**: `index.html` - The single-page application

## 💻 Technical Details

### Dependencies (CDN)
- **JSZip v3.10.1** - ZIP file creation and extraction
- **Font Awesome 6.4.0** - UI icons
- **Google Fonts (Inter)** - Typography

### Key Algorithms

#### Recursive Font Extraction
The app recursively scans:
1. All files in the root ZIP
2. All files in nested folders
3. All files in nested ZIP files (up to 10 levels deep)

#### Intelligent ZIP Naming
Priority for output filename:
1. Detected font family name (e.g., "Roboto-Fonts.zip")
2. Original ZIP filename (e.g., "my-fonts-Extracted-Fonts.zip")
3. Timestamp fallback (e.g., "extracted-fonts-1703696400000.zip")

#### Duplicate Handling
When fonts with the same filename are found:
- First instance: `Roboto-Regular.ttf`
- Second instance: `Roboto-Regular-1.ttf`
- Third instance: `Roboto-Regular-2.ttf`

### Browser Compatibility
- Chrome 88+
- Firefox 78+
- Safari 14+
- Edge 88+

## 🔒 Privacy & Security

- **100% Client-Side**: All processing happens in your browser
- **No Server Upload**: Your files never leave your device
- **No Data Collection**: No analytics or tracking
- **Works Offline**: After initial page load, works without internet

## ✅ Completed Features

1. ✅ Multiple ZIP file upload (drag-and-drop + file picker)
2. ✅ Deep recursive extraction from nested ZIPs and folders
3. ✅ Support for all major font formats (TTF, OTF, WOFF, WOFF2, EOT, SVG)
4. ✅ Font repackaging with root-level placement
5. ✅ Intelligent ZIP filename generation
6. ✅ Individual download buttons for each extracted package
7. ✅ "Download All" feature (creates master ZIP)
8. ✅ Dark mode UI with modern design
9. ✅ Progress indicators and status messages
10. ✅ Toast notifications for user feedback
11. ✅ Edge case handling (no fonts, duplicates, corrupted ZIPs)
12. ✅ Responsive design for mobile and desktop
13. ✅ Async processing to prevent UI freezing

## 🚧 Not Yet Implemented

- Font preview functionality (display font glyphs)
- Font metadata extraction (family name, version, author)
- Batch rename fonts before packaging
- Custom output ZIP naming
- Font format conversion
- Direct URL import (fetch ZIP from URL)

## 📝 Recommended Next Steps

1. **Font Preview**: Add ability to preview fonts before downloading
2. **Metadata Display**: Show font metadata (family, weight, style)
3. **Filter Options**: Allow users to filter by font format or family
4. **History**: Save extraction history in localStorage
5. **Batch Rename**: Allow users to rename fonts before packaging
6. **PWA Support**: Add service worker for offline-first experience

## 🎨 Design System

### Color Palette
- **Background Primary**: `#0d0d0f`
- **Background Secondary**: `#141418`
- **Accent Primary**: `#6366f1` (Indigo)
- **Accent Secondary**: `#8b5cf6` (Purple)
- **Success**: `#10b981`
- **Warning**: `#f59e0b`
- **Error**: `#ef4444`

### Typography
- **Font Family**: Inter (Google Fonts)
- **Weights**: 300, 400, 500, 600, 700

## 📄 License

This project is open source and available under the MIT License.

---

**Font Extractor Pro** - Extract fonts with confidence. All processing happens locally in your browser.
