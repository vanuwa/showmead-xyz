# showmead-xyz

A sandbox for AdTech testing and prototyping — tools and test pages for ad formats, integrations, and specs.

## VAST Tag Tester

An interactive browser-based tool for testing and debugging [VAST](https://www.iab.com/guidelines/vast/) (Video Ad Serving Template) tags. Paste a tag URL or raw XML, then inspect the full wrapper chain, preview the ad, and monitor every tracking event as it fires.

### Features

- **Wrapper chain resolution** — follows redirects up to 5 hops, merging impression and tracking URLs at each level
- **Ad playback** — renders video, audio, and non-linear (banner) creatives via native HTML5 elements
- **Aspect ratio switcher** — preview in 16:9, 1:1, or 9:16
- **Skip logic** — skip button appears based on `skipOffset` from the VAST response
- **Live event log** — timestamped log of every tracking pixel fired (impression, quartiles, complete, skip, etc.)
- **VAST structure diagram** — ASCII tree of the wrapper chain, media files, and tracking events
- **Raw XML viewer** — inspect the fetched XML at each wrapper hop

### VAST support

- IAB VAST 3.0 / 4.0
- Ad types: Inline, Wrapper, no-ad (empty response)
- Tracking events: `creativeView`, `start`, `firstQuartile`, `midpoint`, `thirdQuartile`, `complete`, `pause`, `resume`, `mute`, `unmute`, `skip`, `close`
- Companion ads and non-linear creatives
- Standard VAST error codes (100, 303, 403, etc.)

### CORS note

VAST tags must be reachable from the browser. If a tag returns a CORS error, the tester will report it — use a CORS proxy or test from a whitelisted origin.

## Running locally

```bash
make up    # serves on http://localhost:8000
make down  # stop
```

Or without Docker:

```bash
python3 -m http.server 8000
```

## Strossle test pages (`/strossle`)

A set of legacy publisher and placement test pages for Strossle widget integrations. **Deprecated** — kept for reference only.
