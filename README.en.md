# Imaginy

[![SillyTavern extension](https://img.shields.io/badge/SillyTavern-extension-blue)](https://github.com/SillyTavern/SillyTavern)
[![version](https://img.shields.io/badge/version-0.3.1-informational)](CHANGELOG.md)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[Русский](README.md) · **English**

An **add-on extension** for [SillyTavern](https://github.com/SillyTavern/SillyTavern): it sits on
top of the popular inline image generation extensions (SLAY Images and its forks) and adds what they
don't have — the ability to **rewrite the prompt of an already generated image and regenerate it**
in one click, without opening the message editor or hand-editing JSON.

Don't like the pose, the lighting, the background? Click the pencil next to the image, change the
text, get a new version.

## In short

- ✏️ **A pencil button next to the image** — opens a dialog with prompt, style and aspect ratio.
- 🔁 **"Save and regenerate"** — a new image from the new text, no manual re-run.
- 🧩 **Four host extensions** — SLAY Images and its three forks are detected automatically.
- 💾 **The edit lives in the chat** — the prompt is written to every message storage location and
  survives a reload.
- 🎨 **The style is remembered** across images and chats.
- 🔒 **Zero network requests** made by Imaginy itself.

## Requirements

Imaginy is an add-on; it does not generate images on its own. One of the inline image generation
extensions must already be installed:

| Extension | Regenerating a single image from Imaginy |
|---|---|
| [SLAY Images](https://github.com/wewwaistyping/SLAYimages) | yes (except failed generations and videos) |
| [delidgi/sillyimages](https://github.com/delidgi/sillyimages) | yes, including failed generations |
| [aceeenvw/notsosillynotsoimages](https://github.com/aceeenvw/notsosillynotsoimages) | yes (except failed generations) |
| [0xl0cal/sillyimages](https://github.com/0xl0cal/sillyimages) | only if the message contains a single image |

Editing and saving the prompt works with all four. What differs is whether Imaginy can press the
regenerate button itself; when it can't, it says so honestly instead of pretending it worked.

One such extension is enough — don't keep two installed at once, they conflict with each other.

## Installation

### Option 1 — from inside SillyTavern (easiest)

1. Open the **Extensions** panel → **Install extension**.
2. Paste this repository's URL:

   ```
   https://github.com/aika636/Imaginy
   ```

3. Press **Install** and reload the tab.

### Option 2 — manually

1. Download the repository (**Code → Download ZIP**, or `git clone`).
2. Put the folder, named `Imaginy`, into SillyTavern's extensions directory:

   ```
   <SillyTavern>/data/default-user/extensions/Imaginy
   ```

   Older SillyTavern builds use a different path:
   `<SillyTavern>/public/scripts/extensions/third-party/Imaginy`

3. Hard-reload the SillyTavern tab (Ctrl+F5).

Settings appear in the **Extensions** panel, in the **Imaginy** block — which also shows which image
extension was detected as the active host.

## Usage

1. Hover a generated image in the chat — a **pencil** appears next to the host extension's own
   buttons.
2. Clicking it opens the editor: **prompt**, **style** and **aspect ratio**.
3. Then either:
   - **Save** — the new prompt is stored in the message, the image stays as it is;
   - **Save and regenerate** — generation of a new image from the new text starts immediately
     (Ctrl+Enter does the same).

Small conveniences:

- the last style you typed is **remembered** and pre-filled in the next editor — there's a "Forget"
  button next to it;
- if the style or aspect ratio is hard-set in the host extension's own settings, it overrides the
  per-image value — Imaginy warns about it right in the editor;
- there's a copy-prompt button;
- **Esc** closes the dialog, **Ctrl+Enter** saves and regenerates.

Clicking the image itself behaves as before — the host's own lightbox opens; Imaginy never
intercepts it.

## Settings

| Toggle | What it does |
|---|---|
| Enable Imaginy | Turns the extension off completely without uninstalling it |
| Show the pencil button on images | Hides the pencil while keeping the extension active |
| Regenerate after saving the prompt | Makes plain "Save" start generation right away |

## Limitations

| What | Why |
|---|---|
| For **videos** the prompt is editable, but there is no regeneration | No host draws a regenerate button for videos |
| For **failed SLAY Images generations** the prompt is saved, but regeneration does not start | The "Try again" button holds the old prompt in a closure and never re-reads the new one — rather than silently regenerating from stale text, Imaginy refuses |
| Two images in the same message with an identical prompt are edited together | They cannot be told apart |

If saving fails, Imaginy **will not pretend everything is fine** — you get an error message instead.

## Privacy

Imaginy makes **no network requests at all**. It only edits data inside your own chat and clicks the
host extension's button; all generation goes through your own settings in that host.

## Development

There is no build step — plain ES modules, so you can edit files directly in the extensions
directory and hard-reload the tab.

```bash
# syntax check
for f in index.js src/*.js src/hosts/*.js; do node --check "$f"; done

# smoke tests (jsdom is the only dev dependency)
npm install --no-save jsdom
node tests/hosts.test.mjs
node tests/persist.test.mjs
```

Supporting another fork of the same family takes one file in `src/hosts/` — no other code needs to
change. An unknown fork is picked up too: prompt editing works, and the regenerate button is probed
among the known variants.

## Credits

Imaginy only exists because someone else already did the hard part — the inline image generation
itself. Thanks to the authors of the host extensions:

- [**SLAY Images**](https://github.com/wewwaistyping/SLAYimages) — wewwaistyping, aceeenvw, 0xl0cal:
  the ancestor of the whole family, the `data-iig-instruction` format and all of the inline
  generation machinery;
- [**delidgi/sillyimages**](https://github.com/delidgi/sillyimages) — delidgi;
- [**aceeenvw/notsosillynotsoimages**](https://github.com/aceeenvw/notsosillynotsoimages) — aceeenvw;
- [**0xl0cal/sillyimages**](https://github.com/0xl0cal/sillyimages) — 0xl0cal.

Imaginy neither forks nor patches their code: it only reads and writes their generation-parameters
attribute and clicks their own regenerate button.

## License

[MIT](LICENSE) © aika636
