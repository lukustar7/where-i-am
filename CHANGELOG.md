# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-07-01

### Added

- Added H5 single-file dashboard implementation in `index.html` featuring zero external dependencies.
- Added iOS and Android compatibility layers for device orientation sensors with permission request controls.
- Added low-pass noise filtering and shortest angle rotation interpolation for steady compass updates.
- Added ray-casting polygon boundary geofencing for regional territory detection.
- Added coordinate deviation offset algorithm triggered inside designated boundary geofences.
- Added Apple Maps and Google Maps universal deep-linking handlers for both raw and deviated positions.
- Added Screen Wake Lock API integrations to prevent device sleep states during navigation.
- Added clipboard replication utilities with visual feedback cues for coordinate retrieval.
- Added local automated test suites for algorithm verification.
