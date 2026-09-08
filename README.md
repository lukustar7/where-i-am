# Where I AM GPS Compass

An offline-capable GPS compass PWA for mobile browsers. It has no runtime dependencies and must not be used for critical navigation.

## Features

- Real-time dual compass displaying simultaneous handheld phone heading and moving GPS trajectory course with vehicle mount compensation.
- Reports WGS-84 coordinates, optional GCJ-02 coordinates, altitude, accuracy, and speed.
- In-browser high-precision flight telemetry recorder capturing dual-track raw hardware inputs (GPS, magnetometer, gyroscope, accelerometer) alongside computed display output states.
- Export formats supporting human-readable TXT logs, standard GPX tracks, structured JSON logs, privacy masking, system share sheet invocation, and diagnostic summaries.
- Provides Apple Maps and Google Maps links only after a valid GPS fix.
- Supports offline startup and Screen Wake Lock where the browser permits them.

## Structure

- `index.html` and `styles.css`: interface markup and responsive presentation.
- `js/app.js`: browser permissions, sensor lifecycle, rendering, and user actions.
- `js/geo.js`: region detection and WGS-84 to GCJ-02 conversion.
- `js/heading.js`: heading normalization, relative angle resolution, and low-pass smoothing.
- `js/recorder.js`: high-frequency telemetry sampling, memory buffer management, IndexedDB persistence, and log formatting.
- `sw.js`: application-shell caching and offline request handling.

## Limitations

- Coordinate Precision: Both WGS-84 and GCJ-02 coordinates are generally accurate under typical mobile operating conditions. WGS-84 coordinates reflect direct satellite fixes from the device GNSS receiver. GCJ-02 coordinates apply high-precision polynomial offset transformation strictly bounded within mainland China. Overseas regions, Hong Kong, Macau, and Taiwan retain untransformed WGS-84 coordinates to prevent mapping offset errors.
- High-Speed Heading Behavior: Web browsers operate under platform sandbox constraints. When traveling at vehicular speeds (typically above 10–15 km/h), mobile operating systems (notably WebKit/CoreLocation on iOS) prioritize GPS course-over-ground trajectory over the hardware magnetometer heading. As a result, the compass heading automatically reflects vehicle travel direction rather than the physical orientation of the device itself. This is an intended operating system behavior and browser platform limitation rather than an application defect.

## Development

Requires Node.js 20 or later.

```bash
npm test
npm run build
```

The build writes a validated static package to `dist/`. Serve that directory through HTTPS for mobile sensor access; `localhost` may be used for local interface testing.
