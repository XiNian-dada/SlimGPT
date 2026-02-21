# SlimGPT

**Make ChatGPT fast again.** A Chrome / Edge extension that keeps long conversations responsive by dynamically managing the DOM.

## Why it exists

ChatGPT renders every message as a full React subtree. In a long conversation this means hundreds of deeply nested DOM nodes all participating in layout, scroll, and re-render — even the ones you scrolled past an hour ago. The page gets progressively slower as the conversation grows.

SlimGPT fixes this with one idea: **only keep the messages near your viewport alive in the DOM. Everything else becomes a lightweight placeholder.**

## How it works

### DOM virtualization via placeholder swap

When a message scrolls far enough from the viewport, SlimGPT:

1. Measures the element's rendered height.
2. Replaces it in the DOM with an empty `<div>` of the same height (the placeholder). This preserves scroll position and layout.
3. Detaches the original node from the document, removing its entire subtree from layout and rendering.

When you scroll back toward that message, the placeholder is swapped back out for the real node before it enters view.

This is done entirely through DOM manipulation — no React state is touched, no ChatGPT internals are accessed.

### Viewport anchor + priority zones

On every scroll or DOM change, SlimGPT finds the **anchor turn** — the conversation turn closest to the center of the viewport. It then defines two zones around it:

- **Near zone** (±3 turns): restored immediately and synchronously.
- **Far zone** (±3–12 turns, adaptive): kept alive during fast scrolling, collapsed lazily in the background.
- **Beyond far zone**: collapsed via a background worker that processes a few nodes per animation frame to avoid jank.

During fast scrolling the near zone expands automatically so content is ready before you stop. During typing the collapse budget is reduced to avoid competing with input responsiveness.

### MutationObserver for new messages

A `MutationObserver` watches for new conversation turns being added by ChatGPT's React layer. When a new message appears, the model is rebuilt and the viewport zones are recalculated. Mutations that happen while you're typing are deferred until the keyboard goes idle.

### Minimap navigation

A thin vertical strip sits between the sidebar and the chat content. Each dot represents one conversation turn. Clicking a dot jumps directly to that turn — the extension pre-restores a wide window of turns around the destination before scrolling, so the content is already in the DOM when you arrive.

The active dot (green) shows your current position with a breathing animation. All dots slide smoothly when the visible window shifts.

### Hover preview

Hovering a minimap dot shows a small tooltip with the user message and assistant reply for that turn. If the turn is currently collapsed, it is temporarily restored to read the text, then re-collapsed by the background worker.

### Typing protection

The extension tracks focus and keystroke timing. While the input box is active and recent keystrokes have been detected, DOM collapse operations are throttled to their minimum budget so the main thread stays free for input handling.

### URL change detection

ChatGPT navigates between conversations without a full page reload. SlimGPT polls `location.href` and resets all state when the URL changes, restoring any collapsed messages before rebuilding the model for the new conversation.

## Features

- Zero configuration — install and it works
- Dynamically collapses off-screen messages into height-preserving placeholders
- Adaptive viewport zones that widen during fast scrolling
- Typing-aware: collapse work pauses while you're writing
- Minimap with smooth animated dots for quick navigation
- Hover preview shows conversation content without leaving the minimap
- No API calls, no account, no cloud, no data collection
- Pure Content Script — does not modify ChatGPT's JS or React state
- Manifest V3, works on Chrome and Edge

## Project structure

```
SlimGPT/
├── manifest.json   — extension manifest (MV3)
├── content.js      — all logic: model, collapse worker, minimap, preview
└── styles.css      — minimap, placeholder, tooltip styles
```

## Install (Chrome / Edge)

1. Open `chrome://extensions` or `edge://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder
