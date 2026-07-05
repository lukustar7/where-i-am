# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-07-05

### Added

- Added a heading mode explanation popover so PHONE, DUAL, COURSE, and CHECKING states can be inspected without leaving the dashboard.

### Changed

- Added time-based heading mode arbitration so high-speed COURSE takeover only happens after PHONE and COURSE stay aligned long enough to be trusted.
- Sequenced iOS motion and location permission requests to reduce inconsistent sensor startup caused by overlapping system prompts.

### Fixed

- Added relative-orientation fallback handling when absolute compass data is missing, improving cases where the numeric heading updated inconsistently or the dial appeared stuck.
- Bumped the offline cache namespace to `where-i-am-v6` so this mode and permission update is picked up after deployment.

## [0.2.0] - 2026-07-03

### Added

- Added an iOS-style circular compass with fixed PHONE heading and separate COURSE marker so two heading sources remain visible in one view.

### Changed

- Changed heading arbitration so GPS course no longer replaces PHONE heading above 8 km/h, preserving live device direction during vehicle use.
- Changed the fourth metric from Course to Mode to remove one duplicated heading readout and expose PHONE, COURSE, or DUAL state directly.

### Fixed

- Bumped the offline cache namespace to `where-i-am-v4` and made page navigation network-first so the redesigned compass refreshes after deployment while preserving offline fallback.
- Fixed mobile browser SVG rotation reliability by switching the compass dial and COURSE marker to native SVG transform attributes.
- Removed the residual inner level-guide line from the compass center to keep the display focused on heading only.
- Bumped the offline cache namespace to `where-i-am-v5` so this sensor rendering fix is picked up after deployment.

## [0.1.0] - 2026-07-02

### Added

- Added a horizontal heading tape so the compass, GPS metrics, coordinates, and map actions fit within one mobile viewport.
- Added GPS course priority above 8 km/h to reduce magnetic sensor drift during vehicle use.

### Changed

- Renamed the PWA shell to "Where I AM GPS Compass".
- Reworked coordinates and map actions into a compact glass-style layout while preserving the WGS-84/GCJ-02 dual-coordinate flow and four map-link state.

### Fixed

- Fixed a northern boundary gap in the configured geofence self-test.
- Fixed retry behavior after denied or failed sensor/location initialization.
- Limited Service Worker fetch handling to same-origin GET requests to avoid intercepting external map links or non-cacheable requests.

## [0.0.2] - 2026-07-02

### Added

- Added Progressive Web App (PWA) installation support with `manifest.json`.
- Added Stale-While-Revalidate offline caching via Service Worker script `sw.js`.
- Added custom high-contrast anime character App icon `icon.jpg` for home screen display.

### Fixed

- Fixed iOS orientation sensor activation context Bug. Consent trigger is now synchronously handled in the user gesture callback stack, resolving the unresponsive compass issue.
- Fixed layout space overhead by replacing the bulky "Copy Coordinates" button block with compact inline SVG copy icons featuring micro-interactions.

### Removed

- Removed the "System Self-Test" button from the footer UI for a cleaner user experience (retained the JavaScript function `runSystemSelfTest()` in the browser console for manual developer testing).

---

## [0.0.1] - 2026-07-01

### Added

- Added H5 single-file dashboard implementation in `index.html` featuring zero external dependencies.
- Added iOS and Android compatibility layers for device orientation sensors with permission request controls.
- Added low-pass noise filtering and shortest angle rotation interpolation for steady compass updates.
- Added ray-casting polygon boundary detection for configured offset rules.
- Added coordinate deviation offset algorithm triggered inside designated boundary geofences.
- Added Apple Maps and Google Maps universal deep-linking handlers for both raw and deviated positions.
- Added Screen Wake Lock API integrations to prevent device sleep states during navigation.
- Added clipboard replication utilities with visual feedback cues for coordinate retrieval.
- Added local automated test suites for algorithm verification.
