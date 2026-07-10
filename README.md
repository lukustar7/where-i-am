# Where I AM GPS Compass

An offline-capable GPS compass PWA for mobile browsers. It has no runtime dependencies and must not be used for critical navigation.

## Features

- Displays PHONE, DUAL, COURSE, and CHECKING heading modes.
- Reports WGS-84 coordinates, optional GCJ-02 coordinates, altitude, accuracy, and speed.
- Provides Apple Maps and Google Maps links only after a valid GPS fix.
- Supports offline startup and Screen Wake Lock where the browser permits them.

## Structure

- `index.html` and `styles.css`: interface markup and responsive presentation.
- `js/app.js`: browser permissions, sensor lifecycle, rendering, and user actions.
- `js/geo.js`: region detection and WGS-84 to GCJ-02 conversion.
- `js/heading.js`: heading normalization, smoothing, and mode arbitration.
- `sw.js`: application-shell caching and offline request handling.

## Development

Requires Node.js 20 or later.

```bash
npm test
npm run build
```

The build writes a validated static package to `dist/`. Serve that directory through HTTPS for mobile sensor access; `localhost` may be used for local interface testing.
