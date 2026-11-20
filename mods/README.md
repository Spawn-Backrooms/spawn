# Mods

Mods change how a Backroom looks or works. Anyone can make one; a room's owner installs it from **Mods** in the room's tools. Installed mods are pinned to an exact version, so a room never changes underneath its owner.

Version 1 mods contain a `mod.json` file and an optional preview image. The local checker validates the manifest. The hosted renderer applies its own validation. [Known caption color discrepancy](../CONTRIBUTING.md#known-source-findings)

## Kinds

| Kind | What it changes | Shows up in |
| --- | --- | --- |
| `caption-style` | A caption look for CLIPS: font, size, colors, outline, shadow, position, words per group, uppercase, entrance animation | Captions, next to the built-in presets |
| `clip-recipe` | A clipping starter: 1–4 clips with a length, aspect and framing each, built on a base starter | The recipe library |

More kinds (room themes, role packs) are planned.

## Make a mod

Start from the repository root.

1. Copy the caption style in `mods/neon-karaoke/` or the clip recipe in `mods/quick-three/` to `mods/<your-mod-id>/`.
2. Edit `mod.json`. Set `id` to match the new folder and set `author` to your GitHub handle. Keep `"version": 1` for a new mod.
3. Run `node mods/check.mjs` until it passes.
4. Open a pull request with a screenshot or short clip of it in use, and sign off your commits (`git commit -s`).

A maintainer reviews taste, licensing and honesty, then adds it to SPAWN's mod catalogue. Each published version is fixed: to change a mod, add a new version. The previous version keeps working in rooms that have it.

## `mod.json`

| Field | Rules |
| --- | --- |
| `schema_version` | `"spawn.mod.v1"` |
| `id` | Lowercase letters, digits and single hyphens, at most 64 characters. Must match the folder name. |
| `version` | A whole number, 1 or more |
| `kind` | `"caption-style"` or `"clip-recipe"` |
| `name` | Up to 60 characters, no markup |
| `description` | Up to 200 characters, no markup |
| `author` | Your GitHub handle |
| `license` | `Apache-2.0`, `MIT`, `CC0-1.0` or `CC-BY-4.0` |
| `content` | Depends on the kind; see below |

**`caption-style` content**

| Field | Values |
| --- | --- |
| `enabled` | `true` or `false` |
| `font` | `"sans"`, `"condensed"` or `"mono"` |
| `font_size` | 40–112 |
| `text_color`, `highlight_color`, `outline_color` | `"#RRGGBB"` |
| `outline_width` | 0–10 |
| `shadow` | 0–6 |
| `x_pct`, `y_pct` | 10–90 (percent across and down) |
| `words_per_group` | 1–4 |
| `uppercase` | `true` or `false` |
| `animation` | `"none"`, `"pop"`, `"fade"` or `"rise"` |
| `animation_ms` | 80–400 |

**`clip-recipe` content**

| Field | Values |
| --- | --- |
| `base` | `"clip-one"`, `"three-clips"` or `"walkthrough"` |
| `clips` | 1–4 clips, each `{ "length_ms": 3000–60000, "aspect": "9:16" \| "1:1" \| "16:9", "framing": "contain" \| "cover" }` |

`cover` fills the frame (cropping the edges); `contain` keeps the whole picture.

## Licensing

Your mod is published under the license you choose in `license`. Only include a preview image you made or are allowed to share.
