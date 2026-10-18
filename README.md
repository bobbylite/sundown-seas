# Sundown Seas

Two little toon boats on one real-time ocean, built with three.js and TypeScript.

- **Sunset Skipper**: sail a tiny boat through a sunset archipelago, trim the sail to the wind and chase golden sun stars.
- **Montauk Rips**: troll the rips off Montauk Point in a sportfisher with outriggers. Find the birds, fight stripers, bluefish, albies and bluefin on rod and reel, take the seas about 45° off the bow, and keep the cockpit from filling faster than the scuppers drain.

A selection page picks the game; each game loads on demand. The ocean is a GPU FFT simulation (three cascades) with
an interactive wake, planar reflections, refraction with caustics, and foam.

## Run it

Needs Node.js 20 or newer.

```bash
npm install
npm run dev        # http://localhost:5173 (also on your LAN, for testing on a phone)
```

```bash
npm run build      # type-checks, then builds to dist/
npm run preview    # serves dist/ at http://localhost:4173
```

## Deploy to GitHub Pages

The build uses a relative base path and hash routing (`#sunset`, `#montauk`), so it works at
`https://<user>.github.io/<repo>/` without any configuration.

1. Push this repository to GitHub with `main` as the default branch.
2. In the repository, open **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Every push to `main` runs `.github/workflows/deploy.yml`, which builds and publishes `dist/`. You can also run it by hand from the **Actions** tab.

## Phones

- Works in portrait and landscape; landscape gives the widest view of the horizon.
- Touch controls appear automatically on touch screens: arrow buttons steer, the vertical lever sets the sail or throttle, and the action buttons hop, call the wind, set lines and reel.
- On iPhone, **Share → Add to Home Screen** runs it full screen with its own icon.
- The renderer drops resolution on its own if a device can't hold about 48 fps.

## Controls (keyboard)

| | Sunset Skipper | Montauk Rips |
|---|---|---|
| `A` / `D` | steer | steer |
| `W` / `S` | raise / lower the sail | throttle up / down (`X` for neutral) |
| `Space` | hop | reel (hold) |
| `E` | call the wind | tighten the drag (`Q` eases it) |
| `L` | | set or clear the lines |
| `Esc` | back to the games | back to the games |

## Layout

```
index.html              app shell, PWA meta tags
public/                 icons, web app manifest
src/main.ts             hash router: selection page and game mounting
src/menu/               game selection page
src/engine/             shared ocean renderer, audio and math
src/ui/controls.ts      keyboard, hold buttons and touch levers
src/games/sunset/       Sunset Skipper
src/games/montauk/      Montauk Rips (geography, rules, game)
```

Tuning lives near the top of each game: the sea state passed to `createEngine`, and for Montauk the `TIERS` and
`SPECIES` tables in `src/games/montauk/rules.ts`.
