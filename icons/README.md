# Icons

Placeholder icons for the PWA.

- `icon.svg` — vector icon already in use by `manifest.json` and the favicon.
- `icon-192.png` / `icon-512.png` — referenced by `manifest.json` but **not yet
  generated**. For full installability (especially iOS / Chrome install prompts)
  generate these from `icon.svg` (e.g. with `sharp`, ImageMagick, or any favicon
  generator).

  Maskable versions should keep the glyph inside the ~80% "safe zone".