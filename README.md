# FeedRank ⚡ — Sort Any Social Feed

<p align="center">
  <img src="Icons/icon-128.png" width="100" height="100" alt="FeedRank Logo" />
</p>

<p align="center">
  <b>Sort Instagram Reels & Posts, TikTok, Facebook, and YouTube by views, likes, comments, outliers, or date.</b><br>
  Free, open-source, and privacy-first browser extension for Chromium browsers.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Manifest-V3-blue?style=flat-square" alt="Manifest V3" />
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=flat-square" alt="License: MIT" />
  <img src="https://img.shields.io/badge/Platform-Chrome%20%7C%20Edge%20%7C%20Brave%20%7C%20Arc-orange?style=flat-square" alt="Browsers" />
</p>

---

## ✨ Features

- 📊 **Sort by Key Metrics**: Rank content by **Views**, **Likes**, **Comments**, **Oldest**, or **Outlier Score** (viral breakout multiplier).
- 📅 **Flexible Filtering**: Sort the latest 25, 50, 100 posts or set a **custom date range** using the built-in calendar picker.
- 🌐 **Multi-Platform Support**:
  - **Instagram**: Sort Reels and Posts on Profiles, Explore/Search, and Saved Collections.
  - **TikTok**: Sort user profiles, searches, and saved collections.
  - **Facebook**: Sort user Profile Reels.
  - **YouTube**: Sort Shorts and Videos on channel feeds.
- 💾 **Media Downloader**: Optional in-page Download button directly on posts and videos.
- 📑 **Spreadsheet Export**: Export sorted video data to Excel (`.xlsx`) or `.csv`.
- 🔒 **Privacy-First**: Runs 100% locally in your browser. No account registration, no remote tracking, no server storage.

---

## 🚀 Installation Guide

FeedRank is built on Chrome Extension Manifest V3 and runs on all Chromium-based browsers (Google Chrome, Microsoft Edge, Brave, Arc, Opera, Vivaldi).

### Step 1: Download the Extension
1. Click the green **Code** button at the top right of this repository.
2. Select **Download ZIP**.
3. Extract (unzip) the downloaded zip file on your computer.

### Step 2: Load into Your Browser
1. Open your browser and navigate to the Extensions page:
   - **Chrome**: `chrome://extensions`
   - **Edge**: `edge://extensions`
   - **Brave**: `brave://extensions`
2. Enable **Developer mode** using the toggle switch in the top-right corner.
3. Click the **Load unpacked** button in the top-left corner.
4. Select the unzipped folder containing `manifest.json`.
5. FeedRank is now installed! Pin it to your extension toolbar for easy access.

---

## 🛠️ How to Use

1. Navigate to any supported social media profile or search page (e.g. an Instagram profile or TikTok search).
2. Click the **FeedRank** extension icon in your browser toolbar.
3. Select your feed filter:
   - **Posts / Items**: Choose how many items to sort (e.g., *Latest 25 Posts* or *Custom Posts*).
   - **Date Range**: Choose a timeframe or select a specific date window.
4. Click your desired sort metric: **Likes**, **Views**, **Outlier score**, **Comments**, or **Oldest**.
5. FeedRank will fetch and rank the feed directly on the page!

---

## 📁 Project Structure

```text
├── manifest.json       # Chrome Extension Manifest V3 configuration
├── background.js       # Background service worker (message dispatcher & tab management)
├── popup.html          # Extension popup user interface
├── popup_scripts/      # Popup logic & dropdown/calendar controls
├── popup_styles/       # Popup UI styling & animations
├── Instagram/          # Instagram content scripts & DOM injectors
├── Tiktok/             # TikTok content scripts & API interceptors
├── Facebook/           # Facebook content scripts & reel handlers
├── YouTube/            # YouTube content scripts & video processors
├── Icons/              # Extension icons & UI glyphs
├── shared/             # Shared banner primitives & UI components
└── lib/                # Third-party utilities (e.g. SheetJS xlsx)
```

---

## 🔐 Permissions & Privacy

FeedRank requests only the permissions necessary to function:
- **`activeTab` / `tabs`**: Detects current page URL to activate the appropriate platform mode.
- **`storage`**: Saves your local preferences (default sort mode, download toggle).
- **`declarativeNetRequest`**: Enables clean client-side request interception for TikTok item list pagination.
- **`host_permissions`**: Allows content scripts to read public posts on Instagram, TikTok, Facebook, and YouTube feeds when you initiate a sort.

No user credentials, passwords, or personal data are ever collected, logged, or transmitted.

---

## 🤝 Contributing

Contributions, bug reports, and feature requests are welcome!

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## ☕ Support the Developer

If you find FeedRank helpful, consider supporting its continued development:

[![Buy Me A Tea](https://img.shields.io/badge/Support-Buy%20Me%20A%20Tea-ffd500?style=for-the-badge&logoColor=black)](https://buymeatea.in/bytanmay)

---

## ⚖️ Disclaimer

FeedRank is an independent, non-commercial, open-source browser utility developed for personal productivity and research. It is completely decoupled from any third-party commercial services and has no affiliation with Meta Platforms (Instagram, Facebook), ByteDance (TikTok), Alphabet / Google (YouTube), or any commercial extension providers. All feed ranking and spreadsheet exports operate 100% locally on the client machine.

---

## 📄 License

Distributed under the MIT License for all community modifications, decoupling, and client-side restructuring. See [`LICENSE`](LICENSE) for complete terms and third-party notices.
