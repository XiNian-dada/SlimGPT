# SlimGPT

SlimGPT is a Manifest V3 browser extension for ChatGPT that keeps long conversations responsive by dynamically collapsing off-screen messages.

## Features

- Dynamic message collapsing based on viewport proximity.
- Fast minimap for quick turn navigation.
- Hover preview for local conversation snapshot.
- No OpenAI API usage, no account binding, no cloud dependency.
- Pure Content Script + DOM + MutationObserver.
- Works on Chrome / Edge.

## Performance (Current Test)

Test environment:

- macOS
- Apple M1 Pro
- ~141 turns in one conversation

Measured metric:

- Time from clicking refresh to first visible character

Results:

- Without SlimGPT: `9.44s`
- With SlimGPT: `8.21s`
- Improvement: `1.23s` (~13.0%)

Windows test: pending.

## Project Structure

```text
SlimGPT/
├── manifest.json
├── content.js
├── styles.css
└── .github/workflows/package.yml
```

## Local Install (Chrome / Edge)

1. Open extension management page (`chrome://extensions` or `edge://extensions`).
2. Enable Developer mode.
3. Click "Load unpacked".
4. Select this folder.

## CI Packaging

This repo contains GitHub Actions workflow:

- Trigger: every push
- Output: `slimgpt-<short_sha>.zip` artifact
- Packaging scope: extension runtime files (`manifest.json`, `content.js`, `styles.css`)

