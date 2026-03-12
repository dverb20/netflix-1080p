# Netflix Channel Surfer

A Chrome extension that turns Netflix into cable TV. Click **Surf** to instantly jump into a random episode or movie, already playing mid-way through — just like stumbling onto a channel.

## Install

1. Go to `chrome://extensions` and enable **Developer mode** (top right)
2. Click **Load unpacked** and select this folder
3. Netflix opens automatically on first install

## How to use

| Where | What happens |
|---|---|
| Any Netflix browse / category / home page | A **Surf** button appears in the nav bar. Click it to jump to a random title from the current page. |
| A show's title page (`/title/…`) | Surf picks a random episode from **all seasons**, not just what's visible. |
| A genre page (`/browse/genre/…`) | Surf picks from that genre's recommendations. |
| A watch / player page | A floating **Surf** button sits in the bottom-right corner. Click to jump to something else. |

After surfing, a toast shows where you landed: `📺 23:41 in · 42% through`

## Settings (popup)

Click the extension icon to configure:

- **Content preference** — TV Shows only, Movies only, or Both
- **Drop-in range** — control how early or late into the runtime you're dropped in (default: 15–80%)
- **Open Netflix & Surf** — opens Netflix and starts surfing automatically

## How it works

- **Shakti API** — Netflix's internal Falcor-over-HTTP API, used to fetch complete episode lists for shows and genre recommendations beyond what's visible in the DOM
- **Falcor cache** — `window.netflix.falcorCache` contains metadata for everything Netflix has loaded on the current page; accessed via an injected page-context bridge (content scripts run in an isolated JS world and can't read page variables directly)
- **Seek** — uses Netflix's internal `videoPlayer.seek()` API where available, falling back to `video.currentTime`; includes a re-seek check in case the player resets to position 0 during DRM initialisation
- **Manifest V3** — service worker, `chrome.storage.session` for transient state, `chrome.storage.local` for settings

## License

MIT — see [LICENSE](LICENSE)
