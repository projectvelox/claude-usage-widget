# Clawd pet SVGs

The `clawd-*.svg` files in this folder are from **[clawd-pet](https://github.com/abderrahimghazali/clawd-pet)** by [@abderrahimghazali](https://github.com/abderrahimghazali), used unmodified under the MIT license (see `LICENSE` in this folder).

## Files bundled

| File | Widget state that renders it |
|---|---|
| `clawd-happy.svg` | OK — usage under the warn threshold |
| `clawd-working-thinking.svg` | Warn — approaching threshold |
| `clawd-mindblown.svg` | Critical — over the critical threshold |
| `clawd-sleeping.svg` | Paused — rate-limited by Anthropic |
| `clawd-shrug.svg` | No Claude Code credentials found |
| `clawd-401.svg` | Auth expired (401 from Anthropic) |
| `clawd-disconnected.svg` | Offline / network unreachable |
| `clawd-celebrating.svg` | Quota reset event (temporary swap on `usage:reset`) |
| `clawd-waving.svg` | User clicked the mascot (temporary swap) |
| `clawd-static-base.svg` | Fallback if a mood key is unknown |

Upstream has 140+ additional pets. If you want to add more or swap the mapping, drop the SVG in this folder and reference it from `renderer/widget.js`.

## Attribution

If you fork this project and keep the pet system, keep this `NOTICE.md` and `LICENSE` in place. The pets are the author's work, not ours.
