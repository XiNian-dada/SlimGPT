(() => {
  "use strict";

  const CONFIG = {
    messageSelector: "[data-message-author-role]",
    placeholderSelector: "[data-slimgpt-placeholder='1']",
    userRole: "user",
    assistantRole: "assistant",
    turnsAroundViewport: 3,
    maxTurnsAroundViewportFastScroll: 12,
    jumpPreloadTurns: 24,
    maxLiveTurns: 8,
    maxLiveTurnsTyping: 4,
    minimapVisibleDots: 20,
    minimapThrottleMs: 140,
    typingMinimapThrottleMs: 260,
    fastScrollWindowMs: 220,
    collapseOpsPerFrame: 4,
    collapseOpsPerFrameTyping: 1,
    budgetCollapseOpsPerSync: 40,
    budgetCollapseOpsPerSyncTyping: 10,
    collapsePauseAfterScrollMs: 160,
    modelRebuildMinIntervalMs: 220,
    pinToBottomThresholdPx: 260,
    startupCollapseDelayMs: 1100,
    typingHotMs: 1300,
    composerExpandFactor: 5,
    composerExpandViewportCap: 0.8,
    composerExpandMinExtraPx: 120,
    inlineLatexDebounceMs: 90,
    inlineLatexStreamRenderMinIntervalMs: 240,
    inlineLatexInitialReadyDelayMs: 1200,
    inlineLatexPostLoadReadyDelayMs: 320,
    inlineLatexBootstrapScanMs: 700,
    inlineLatexBootstrapScanMaxRuns: 18,
    inlineLatexLiveAssistantScanLimit: 28,
    bootstrapModelRetryMs: 260,
    bootstrapModelMaxRetries: 70,
    composerInitDelayMs: 1200,
    maxSnippetLength: 120,
    minPlaceholderHeight: 24
  };

  const STATE = {
    mode: "dynamic", // dynamic | expanded
    nextMessageId: 1,
    rafSyncScheduled: false,
    observerMuted: false,
    modelDirty: true,
    nextModelBuildAt: 0,
    modelBuildTimer: 0,
    bootstrapSyncTimer: 0,
    bootstrapSyncAttempts: 0,
    typingSyncTimer: 0,
    lastUrl: location.href,
    lastScrollAt: 0,
    lastInputAt: 0,
    inputFocused: false,
    composing: false,
    allowCollapseAt: performance.now() + CONFIG.startupCollapseDelayMs,

    scrollRoot: null,
    messages: [],
    messageById: new Map(),
    turnToIds: new Map(),
    totalTurns: 0,
    currentAnchorTurn: 0,
    previousAnchorTurn: 0,
    lastMiniMapAnchorTurn: -1,
    lastMiniMapSignature: "",
    lastMiniMapRenderAt: 0,
    minimapDeferredTimer: 0,
    typingSyncDueAt: 0,
    composerInitStarted: false,
    composerSubmitListenerBound: false,
    inlineLatexObserver: null,
    inlineLatexPendingRoots: new Map(),
    inlineLatexFlushTimer: 0,
    inlineLatexSafetyTimer: 0,
    inlineLatexBootstrapTimer: 0,
    inlineLatexBootstrapRuns: 0,
    inlineLatexReadyAt: 0,
    inlineLatexSourceByHost: new WeakMap(),
    inlineLatexLastRenderAt: new WeakMap(),
    latexCopyDelegateBound: false,

    collapsedById: new Map(),
    heightById: new Map(),
    collapseTargetRange: null,
    collapseWorkerRunning: false,
    collapsePlan: null
  };

  function init() {
    cleanupLegacyUi();
    ensureKatexStyles();
    ensureMiniMap();
    bindGlobalListeners();
    observeDomChanges();
    observeUrlChanges();
    initLatexCopyButtons();
    initInlineLatexRenderer();
    initComposerExpand();
    scheduleSync();
    scheduleBootstrapSync();
  }

  function cleanupLegacyUi() {
    document.querySelector("[data-slimgpt-controls]")?.remove();
    document.querySelector("[data-slimgpt-minimap]")?.remove();
    document.querySelector("[data-slimgpt-preview]")?.remove();
    document.getElementById("slimgpt-katex-js")?.remove();
    document.getElementById("slimgpt-katex-css")?.remove();
    document.querySelectorAll("script[src*='cdn.jsdelivr.net/npm/katex'], link[href*='cdn.jsdelivr.net/npm/katex']")
      .forEach((el) => el.remove());
    document.querySelectorAll("[data-slimgpt-latex-btn='1'], [data-slimgpt-latex-inline-btn='1']").forEach((el) => el.remove());
    if (STATE.minimapDeferredTimer !== 0) {
      clearTimeout(STATE.minimapDeferredTimer);
      STATE.minimapDeferredTimer = 0;
    }
    if (STATE.typingSyncTimer !== 0) {
      clearTimeout(STATE.typingSyncTimer);
      STATE.typingSyncTimer = 0;
    }
    if (STATE.bootstrapSyncTimer !== 0) {
      clearTimeout(STATE.bootstrapSyncTimer);
      STATE.bootstrapSyncTimer = 0;
    }
    if (STATE.inlineLatexSafetyTimer !== 0) {
      clearInterval(STATE.inlineLatexSafetyTimer);
      STATE.inlineLatexSafetyTimer = 0;
    }
    if (STATE.inlineLatexBootstrapTimer !== 0) {
      clearInterval(STATE.inlineLatexBootstrapTimer);
      STATE.inlineLatexBootstrapTimer = 0;
    }
    if (STATE.inlineLatexFlushTimer !== 0) {
      clearTimeout(STATE.inlineLatexFlushTimer);
      STATE.inlineLatexFlushTimer = 0;
    }
    STATE.inlineLatexPendingRoots.clear();
    STATE.inlineLatexSourceByHost = new WeakMap();
    STATE.inlineLatexLastRenderAt = new WeakMap();
    STATE.inlineLatexBootstrapRuns = 0;
    STATE.bootstrapSyncAttempts = 0;
    STATE.lastMiniMapSignature = "";
    STATE.lastMiniMapAnchorTurn = -1;
    STATE.lastMiniMapRenderAt = 0;
  }

  function bindGlobalListeners() {
    window.addEventListener("resize", scheduleSync, { passive: true });

    // Capture scroll from nested scroll containers as well.
    document.addEventListener(
      "scroll",
      () => {
        STATE.lastScrollAt = Date.now();
        if (isTypingHot()) {
          return;
        }
        scheduleSync();
      },
      { passive: true, capture: true }
    );

    document.addEventListener(
      "keydown",
      (event) => {
        if (!(event.target instanceof Element)) {
          return;
        }

        if (!isEditableTarget(event.target)) {
          return;
        }

        markTypingActivity();
      },
      { capture: true }
    );

    document.addEventListener(
      "input",
      (event) => {
        if (!(event.target instanceof Element)) {
          return;
        }

        if (!isEditableTarget(event.target)) {
          return;
        }

        markTypingActivity();
      },
      { capture: true }
    );

    document.addEventListener(
      "focusin",
      (event) => {
        if (!(event.target instanceof Element)) {
          return;
        }

        if (!isEditableTarget(event.target)) {
          return;
        }

        STATE.inputFocused = true;
      },
      { capture: true }
    );

    document.addEventListener(
      "focusout",
      (event) => {
        if (!(event.target instanceof Element)) {
          return;
        }

        if (!isEditableTarget(event.target)) {
          return;
        }

        STATE.inputFocused = false;
        STATE.composing = false;
      },
      { capture: true }
    );

    document.addEventListener(
      "compositionstart",
      (event) => {
        if (!(event.target instanceof Element)) {
          return;
        }

        if (!isEditableTarget(event.target)) {
          return;
        }

        STATE.composing = true;
        markTypingActivity();
      },
      { capture: true }
    );

    document.addEventListener(
      "compositionend",
      (event) => {
        if (!(event.target instanceof Element)) {
          return;
        }

        if (!isEditableTarget(event.target)) {
          return;
        }

        STATE.composing = false;
        markTypingActivity();
      },
      { capture: true }
    );

    // Alt+ArrowUp / Alt+ArrowDown: jump between turns without touching the mouse.
    // Skip when focus is inside an editable so we don't hijack text editing.
    document.addEventListener("keydown", (event) => {
      if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      jumpToTurn(STATE.currentAnchorTurn + delta);
    }, { capture: true });
  }

  function markTypingActivity() {
    STATE.lastInputAt = Date.now();

    // Keep only one pending sync and move it after the latest keystroke.
    if (STATE.modelDirty || STATE.typingSyncTimer !== 0) {
      scheduleSyncAfterTyping(true);
    }
  }

  function isEditableTarget(target) {
    if (!(target instanceof Element)) {
      return false;
    }

    if (target.closest("[data-slimgpt-minimap]") || target.closest("[data-slimgpt-preview]")) {
      return false;
    }

    if (target instanceof HTMLTextAreaElement) {
      return true;
    }

    if (target instanceof HTMLInputElement) {
      const type = (target.type || "").toLowerCase();
      return type === "text" || type === "search";
    }

    if (target instanceof HTMLElement && target.isContentEditable) {
      return true;
    }

    const editableAncestor = target.closest("[contenteditable='true'], textarea, input[type='text'], input[type='search']");
    return editableAncestor instanceof Element;
  }

  function isTypingHot() {
    if (STATE.composing) {
      return true;
    }

    if (!STATE.inputFocused) {
      return false;
    }

    return Date.now() - STATE.lastInputAt < CONFIG.typingHotMs;
  }

  function scheduleSyncAfterTyping(resetTimer = true) {
    const idleFor = Date.now() - STATE.lastInputAt;
    const wait = Math.max(120, CONFIG.typingHotMs - idleFor);
    const dueAt = performance.now() + wait;

    if (STATE.typingSyncTimer !== 0) {
      if (!resetTimer && dueAt >= STATE.typingSyncDueAt - 16) {
        return;
      }

      clearTimeout(STATE.typingSyncTimer);
    }

    STATE.typingSyncDueAt = dueAt;
    STATE.typingSyncTimer = window.setTimeout(() => {
      STATE.typingSyncTimer = 0;
      STATE.typingSyncDueAt = 0;
      scheduleSync();
    }, wait);
  }

  function observeDomChanges() {
    const observer = new MutationObserver((records) => {
      if (STATE.observerMuted) {
        return;
      }

      const typingHot = isTypingHot();
      if (typingHot) {
        // Input responsiveness first: defer all structure checks until typing cools down.
        STATE.modelDirty = true;
        scheduleSyncAfterTyping(false);
        return;
      }

      if (!hasStructuralMutation(records)) {
        return;
      }

      const now = performance.now();
      if (now < STATE.nextModelBuildAt) {
        if (STATE.modelBuildTimer !== 0) {
          return;
        }

        const wait = Math.max(16, Math.ceil(STATE.nextModelBuildAt - now));
        STATE.modelBuildTimer = window.setTimeout(() => {
          STATE.modelBuildTimer = 0;
          STATE.modelDirty = true;
          scheduleSync();
        }, wait);
        return;
      }

      STATE.modelDirty = true;
      scheduleSync();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function hasStructuralMutation(records) {
    for (const record of records) {
      if (!record || record.type !== "childList") {
        continue;
      }

      if (isThreadMutationRecord(record)) {
        return true;
      }
    }

    return false;
  }

  function isThreadMutationRecord(record) {
    if (record.addedNodes.length === 0 && record.removedNodes.length === 0) {
      return false;
    }

    const target = record.target;
    if (target instanceof Element && target.closest("[data-slimgpt-item='1'], article[data-testid^='conversation-turn']")) {
      return true;
    }

    for (const node of record.addedNodes) {
      if (node instanceof Element && node.matches("article[data-testid^='conversation-turn']")) {
        return true;
      }
    }

    for (const node of record.removedNodes) {
      if (node instanceof Element && node.matches("article[data-testid^='conversation-turn']")) {
        return true;
      }
    }

    return false;
  }

  function observeUrlChanges() {
    setInterval(() => {
      if (location.href === STATE.lastUrl) {
        return;
      }

      STATE.lastUrl = location.href;
      STATE.mode = "dynamic";
      STATE.modelDirty = true;
      if (STATE.modelBuildTimer !== 0) {
        clearTimeout(STATE.modelBuildTimer);
        STATE.modelBuildTimer = 0;
      }
      if (STATE.typingSyncTimer !== 0) {
        clearTimeout(STATE.typingSyncTimer);
        STATE.typingSyncTimer = 0;
      }
      if (STATE.bootstrapSyncTimer !== 0) {
        clearTimeout(STATE.bootstrapSyncTimer);
        STATE.bootstrapSyncTimer = 0;
      }
      STATE.typingSyncDueAt = 0;
      STATE.nextModelBuildAt = 0;
      STATE.bootstrapSyncAttempts = 0;
      STATE.currentAnchorTurn = 0;
      STATE.previousAnchorTurn = 0;
      STATE.lastMiniMapAnchorTurn = -1;
      STATE.lastMiniMapSignature = "";
      STATE.lastMiniMapRenderAt = 0;
      if (STATE.minimapDeferredTimer !== 0) {
        clearTimeout(STATE.minimapDeferredTimer);
        STATE.minimapDeferredTimer = 0;
      }
      STATE.collapseTargetRange = null;
      STATE.collapsePlan = null;
      STATE.allowCollapseAt = performance.now() + CONFIG.startupCollapseDelayMs;
      STATE.lastInputAt = 0;
      STATE.inputFocused = false;
      STATE.composing = false;
      STATE.inlineLatexPendingRoots.clear();
      STATE.inlineLatexSourceByHost = new WeakMap();
      STATE.inlineLatexLastRenderAt = new WeakMap();
      STATE.inlineLatexBootstrapRuns = 0;
      STATE.inlineLatexReadyAt = performance.now() + CONFIG.inlineLatexPostLoadReadyDelayMs;
      if (STATE.inlineLatexFlushTimer !== 0) {
        clearTimeout(STATE.inlineLatexFlushTimer);
        STATE.inlineLatexFlushTimer = 0;
      }
      startInlineLatexBootstrapTimer();

      restoreAllCollapsedMessages();
      scheduleSync();
      scheduleBootstrapSync();
    }, 900);
  }

  function scheduleSync() {
    if (STATE.rafSyncScheduled) {
      return;
    }

    STATE.rafSyncScheduled = true;
    requestAnimationFrame(() => {
      STATE.rafSyncScheduled = false;
      sync();
    });
  }

  function sync() {
    ensureMiniMap();

    const typingHot = isTypingHot();
    const scrollingHot = Date.now() - STATE.lastScrollAt < CONFIG.fastScrollWindowMs;

    if (STATE.modelDirty) {
      if (typingHot && !scrollingHot) {
        scheduleSyncAfterTyping(false);
        return;
      }

      rebuildModel();
    }

    if (STATE.totalTurns <= 0 || STATE.messages.length === 0) {
      scheduleBootstrapSync();
      updateMiniMap();
      return;
    }
    cancelBootstrapSync();

    if (STATE.mode === "expanded") {
      restoreAllCollapsedMessages();
      if (STATE.modelDirty) {
        rebuildModel();
      }

      STATE.collapseTargetRange = null;
      updateMiniMap();
      queueInlineLatexForViewportTurns(2);
      return;
    }

    if (typingHot && !scrollingHot) {
      // Typing has highest priority for rendering, but still keep collapsing far turns in background.
      const anchorTurn = findAnchorTurn();
      STATE.previousAnchorTurn = STATE.currentAnchorTurn;
      STATE.currentAnchorTurn = anchorTurn;
      const minTurn = clamp(anchorTurn - 1, 0, STATE.totalTurns - 1);
      const maxTurn = clamp(anchorTurn + 1, 0, STATE.totalTurns - 1);
      enforceLiveTurnBudget(anchorTurn, true);
      requestBackgroundCollapse(minTurn, maxTurn);
      updateMiniMap();
      queueInlineLatexForViewportTurns(2);
      scheduleSyncAfterTyping(false);
      return;
    }

    const anchorTurn = findAnchorTurn();
    const anchorDelta = Math.abs(anchorTurn - STATE.currentAnchorTurn);
    STATE.previousAnchorTurn = STATE.currentAnchorTurn;
    STATE.currentAnchorTurn = anchorTurn;

    const dynamicTurnsAround = getDynamicTurnsAroundViewport(anchorDelta);
    const effectiveTurnsAround = STATE.inputFocused
      ? Math.min(dynamicTurnsAround, 2)
      : dynamicTurnsAround;
    const minTurn = clamp(anchorTurn - effectiveTurnsAround, 0, STATE.totalTurns - 1);
    const maxTurn = clamp(anchorTurn + effectiveTurnsAround, 0, STATE.totalTurns - 1);

    // Critical path: restore around viewport immediately.
    restoreTurnsImmediately(minTurn, maxTurn);

    // Hard cap: never keep too many full turns in DOM.
    enforceLiveTurnBudget(anchorTurn, false);

    // Background path: collapse far turns lazily.
    requestBackgroundCollapse(minTurn, maxTurn);

    updateMiniMap();
    queueInlineLatexForViewportTurns();
  }

  function rebuildModel() {
    STATE.modelDirty = false;
    STATE.nextModelBuildAt = performance.now() + CONFIG.modelRebuildMinIntervalMs;

    STATE.messages = [];
    STATE.messageById.clear();
    STATE.turnToIds.clear();

    const nodes = document.querySelectorAll(
      `${CONFIG.messageSelector}, ${CONFIG.placeholderSelector}`
    );

    const seenRoots = new Set();
    let turn = -1;
    let sampleRoot = null;

    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }

      const directPlaceholder = node.getAttribute("data-slimgpt-placeholder") === "1";
      let root = node;
      let role = "";

      if (directPlaceholder) {
        role = normalizeRole(node.getAttribute("data-slimgpt-role"));
      } else {
        role = normalizeRole(node.getAttribute("data-message-author-role"));
        if (role !== CONFIG.userRole && role !== CONFIG.assistantRole) {
          continue;
        }

        root = getMessageRoot(node);
        if (!(root instanceof HTMLElement)) {
          continue;
        }

        if (seenRoots.has(root)) {
          continue;
        }

        seenRoots.add(root);
      }

      const isPlaceholder = root.getAttribute("data-slimgpt-placeholder") === "1";
      if (isPlaceholder) {
        role = normalizeRole(root.getAttribute("data-slimgpt-role") || role);
      }

      if (role === CONFIG.userRole) {
        turn += 1;
      } else if (turn < 0) {
        turn = 0;
      }

      const id = ensureMessageId(root);

      root.setAttribute("data-slimgpt-item", "1");
      root.setAttribute("data-slimgpt-id", id);
      root.setAttribute("data-slimgpt-turn", String(turn));
      root.setAttribute("data-slimgpt-role", role);

      const item = {
        id,
        role,
        turnIndex: turn,
        el: root,
        isPlaceholder,
        snippet: root.getAttribute("data-slimgpt-snippet") || ""
      };

      STATE.messages.push(item);
      STATE.messageById.set(id, item);

      const ids = STATE.turnToIds.get(turn) || [];
      ids.push(id);
      STATE.turnToIds.set(turn, ids);

      if (!sampleRoot) {
        sampleRoot = root;
      }
    }

    STATE.totalTurns = Math.max(0, turn + 1);
    resolveScrollRoot(sampleRoot);

    if (STATE.totalTurns === 0) {
      STATE.currentAnchorTurn = 0;
      return;
    }

    if (isPinnedToBottom()) {
      STATE.currentAnchorTurn = STATE.totalTurns - 1;
    } else {
      STATE.currentAnchorTurn = clamp(STATE.currentAnchorTurn, 0, STATE.totalTurns - 1);
    }

    cleanupCollapsedRecords();
    if (STATE.inlineLatexBootstrapRuns < CONFIG.inlineLatexBootstrapScanMaxRuns) {
      queueInlineLatexForViewportTurns(4, CONFIG.inlineLatexLiveAssistantScanLimit);
    }
  }

  function getMessageRoot(roleNode) {
    const article = roleNode.closest("article");
    if (article instanceof HTMLElement) {
      return article;
    }

    const turnContainer = roleNode.closest("[data-testid^='conversation-turn']");
    if (turnContainer instanceof HTMLElement) {
      return turnContainer;
    }

    const block = roleNode.closest(".group");
    if (block instanceof HTMLElement) {
      return block;
    }

    return roleNode;
  }

  function resolveScrollRoot(sampleNode) {
    if (sampleNode instanceof HTMLElement) {
      const scrollable = findScrollableAncestor(sampleNode);
      if (scrollable) {
        STATE.scrollRoot = scrollable;
        return;
      }
    }

    STATE.scrollRoot = document.scrollingElement || document.documentElement;
  }

  function findScrollableAncestor(startNode) {
    let cursor = startNode.parentElement;

    while (cursor && cursor !== document.body && cursor !== document.documentElement) {
      const style = window.getComputedStyle(cursor);
      const overflowY = style.overflowY;
      const canScroll =
        (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
        cursor.scrollHeight > cursor.clientHeight + 4;

      if (canScroll) {
        return cursor;
      }

      cursor = cursor.parentElement;
    }

    return null;
  }

  function requestBackgroundCollapse(minTurn, maxTurn) {
    const target = {
      min: minTurn,
      max: maxTurn,
      key: `${minTurn}:${maxTurn}`
    };

    if (STATE.collapseTargetRange && STATE.collapseTargetRange.key === target.key) {
      return;
    }

    STATE.collapseTargetRange = target;
    STATE.collapsePlan = null;

    if (!STATE.collapseWorkerRunning) {
      STATE.collapseWorkerRunning = true;
      requestAnimationFrame(collapseWorkerTick);
    }
  }

  function collapseWorkerTick() {
    if (STATE.mode !== "dynamic") {
      STATE.collapseWorkerRunning = false;
      return;
    }

    if (STATE.modelDirty) {
      STATE.collapseWorkerRunning = false;
      scheduleSync();
      return;
    }

    const target = STATE.collapseTargetRange;
    if (!target) {
      STATE.collapseWorkerRunning = false;
      return;
    }

    const nowPerf = performance.now();
    const nowTs = Date.now();

    if (nowPerf < STATE.allowCollapseAt || nowTs - STATE.lastScrollAt < CONFIG.collapsePauseAfterScrollMs) {
      requestAnimationFrame(collapseWorkerTick);
      return;
    }

    if (!STATE.collapsePlan || STATE.collapsePlan.key !== target.key) {
      const queue = [];
      for (const item of STATE.messages) {
        if (item.isPlaceholder) {
          continue;
        }

        if (item.turnIndex >= target.min && item.turnIndex <= target.max) {
          continue;
        }

        queue.push(item.id);
      }

      STATE.collapsePlan = { key: target.key, queue, index: 0 };
    }

    const plan = STATE.collapsePlan;
    if (!plan || plan.key !== target.key) {
      requestAnimationFrame(collapseWorkerTick);
      return;
    }

    const typingHot = isTypingHot();
    const opsLimit = typingHot ? CONFIG.collapseOpsPerFrameTyping : CONFIG.collapseOpsPerFrame;
    let ops = 0;
    muteObserver(true);

    while (ops < opsLimit && plan.index < plan.queue.length) {
      collapseMessage(plan.queue[plan.index], typingHot);
      plan.index += 1;
      ops += 1;
    }

    muteObserver(false);

    if (plan.index < plan.queue.length) {
      requestAnimationFrame(collapseWorkerTick);
      return;
    }

    STATE.collapsePlan = null;
    STATE.collapseWorkerRunning = false;
  }

  function restoreTurnsImmediately(minTurn, maxTurn) {
    if (STATE.collapsedById.size === 0) {
      return;
    }

    muteObserver(true);

    for (let turn = minTurn; turn <= maxTurn; turn += 1) {
      const ids = STATE.turnToIds.get(turn) || [];
      for (const id of ids) {
        restoreMessage(id);
      }
    }

    muteObserver(false);
  }

  function enforceLiveTurnBudget(anchorTurn, typingHot) {
    if (STATE.totalTurns <= 0) {
      return;
    }

    const budgetTurns = typingHot ? CONFIG.maxLiveTurnsTyping : CONFIG.maxLiveTurns;
    if (STATE.totalTurns <= budgetTurns) {
      return;
    }

    const maxOps = typingHot
      ? CONFIG.budgetCollapseOpsPerSyncTyping
      : CONFIG.budgetCollapseOpsPerSync;
    if (maxOps <= 0) {
      return;
    }

    const keepStart = clamp(
      anchorTurn - Math.floor((budgetTurns - 1) / 2),
      0,
      Math.max(STATE.totalTurns - budgetTurns, 0)
    );
    const keepEnd = clamp(keepStart + budgetTurns - 1, 0, STATE.totalTurns - 1);

    let ops = 0;
    muteObserver(true);

    for (const item of STATE.messages) {
      if (ops >= maxOps) {
        break;
      }

      if (item.isPlaceholder) {
        continue;
      }

      if (item.turnIndex >= keepStart && item.turnIndex <= keepEnd) {
        continue;
      }

      collapseMessage(item.id, true);
      ops += 1;
    }

    muteObserver(false);

    // Continue trimming on next frame when there is still excess full DOM.
    if (ops >= maxOps) {
      scheduleSync();
    }
  }

  function getDynamicTurnsAroundViewport(anchorDelta) {
    const base = CONFIG.turnsAroundViewport;
    const fastScroll = Date.now() - STATE.lastScrollAt < CONFIG.fastScrollWindowMs;
    if (!fastScroll) {
      return base;
    }

    if (anchorDelta <= 1) {
      return base + 4;
    }

    return clamp(
      base + 4 + anchorDelta * 2,
      base + 4,
      CONFIG.maxTurnsAroundViewportFastScroll
    );
  }

  function collapseMessage(id, lowCostMode = false) {
    const item = STATE.messageById.get(id);
    if (!item || item.isPlaceholder) {
      return;
    }

    const node = item.el;
    if (!node.isConnected || !node.parentNode) {
      STATE.modelDirty = true;
      return;
    }

    let height = STATE.heightById.get(id) || 0;
    if (height <= 0) {
      if (lowCostMode) {
        // Avoid layout reads while typing: estimate and remove heavy DOM first.
        height = item.role === CONFIG.userRole ? 84 : 180;
      } else {
        height = Math.max(node.offsetHeight, CONFIG.minPlaceholderHeight);
      }
      STATE.heightById.set(id, height);
    }

    const placeholder = document.createElement("div");
    placeholder.className = "slimgpt-placeholder";
    placeholder.style.height = `${height}px`;

    placeholder.setAttribute("data-slimgpt-placeholder", "1");
    placeholder.setAttribute("data-slimgpt-item", "1");
    placeholder.setAttribute("data-slimgpt-id", item.id);
    placeholder.setAttribute("data-slimgpt-turn", String(item.turnIndex));
    placeholder.setAttribute("data-slimgpt-role", item.role);

    if (item.snippet) {
      placeholder.setAttribute("data-slimgpt-snippet", item.snippet);
    }

    node.parentNode.insertBefore(placeholder, node);
    node.parentNode.removeChild(node);
    node.setAttribute("data-slimgpt-collapsed", "1");

    STATE.collapsedById.set(item.id, { node, placeholder });

    item.el = placeholder;
    item.isPlaceholder = true;
  }

  function restoreMessage(id) {
    const item = STATE.messageById.get(id);
    const record = STATE.collapsedById.get(id);

    if (!item || !record) {
      return;
    }

    if (record.placeholder.isConnected) {
      record.placeholder.replaceWith(record.node);
    }

    if (!STATE.heightById.has(id) && record.node.isConnected) {
      const measured = Math.max(record.node.offsetHeight, CONFIG.minPlaceholderHeight);
      STATE.heightById.set(id, measured);
    }

    record.node.removeAttribute("data-slimgpt-collapsed");
    STATE.collapsedById.delete(id);

    item.el = record.node;
    item.isPlaceholder = false;

    // Restored turns are likely to become visible immediately while scrolling/jumping.
    // Queue inline math render for the restored subtree so old messages render too.
    queueInlineLatexRender(record.node);
  }

  function isConversationPage() {
    return /^\/c\//.test(location.pathname);
  }

  function scheduleBootstrapSync() {
    if (!isConversationPage()) {
      return;
    }

    if (STATE.bootstrapSyncAttempts >= CONFIG.bootstrapModelMaxRetries) {
      return;
    }

    if (STATE.bootstrapSyncTimer !== 0) {
      return;
    }

    STATE.bootstrapSyncTimer = window.setTimeout(() => {
      STATE.bootstrapSyncTimer = 0;
      STATE.bootstrapSyncAttempts += 1;
      STATE.modelDirty = true;
      scheduleSync();
    }, CONFIG.bootstrapModelRetryMs);
  }

  function cancelBootstrapSync() {
    if (STATE.bootstrapSyncTimer !== 0) {
      clearTimeout(STATE.bootstrapSyncTimer);
      STATE.bootstrapSyncTimer = 0;
    }

    STATE.bootstrapSyncAttempts = 0;
  }

  function restoreAllCollapsedMessages() {
    if (STATE.collapsedById.size === 0) {
      return;
    }

    muteObserver(true);
    for (const id of Array.from(STATE.collapsedById.keys())) {
      restoreMessage(id);
    }
    muteObserver(false);

    STATE.modelDirty = true;
  }

  function cleanupCollapsedRecords() {
    for (const [id, record] of Array.from(STATE.collapsedById.entries())) {
      const item = STATE.messageById.get(id);
      if (!item || !item.isPlaceholder) {
        STATE.collapsedById.delete(id);
        continue;
      }

      if (item.el !== record.placeholder) {
        record.placeholder = item.el;
      }
    }
  }

  function findAnchorTurn() {
    if (STATE.totalTurns <= 0) {
      return 0;
    }

    if (isPinnedToBottom()) {
      return STATE.totalTurns - 1;
    }

    const viewport = getViewportRect();
    const centerX = Math.floor(viewport.left + viewport.width * 0.5);
    const ySamples = [0.5, 0.35, 0.65, 0.2, 0.8];
    for (const ratio of ySamples) {
      const y = Math.floor(viewport.top + viewport.height * ratio);
      const hitTurn = findTurnFromPoint(centerX, y);
      if (hitTurn >= 0) {
        return hitTurn;
      }
    }

    const scrollRange = Math.max(getScrollHeight() - getViewportHeight(), 1);
    const ratio = clamp(getScrollTop() / scrollRange, 0, 1);

    return clamp(Math.round(ratio * (STATE.totalTurns - 1)), 0, STATE.totalTurns - 1);
  }

  function findTurnFromPoint(x, y) {
    const hitNode = document.elementFromPoint(x, y);
    if (!(hitNode instanceof HTMLElement)) {
      return -1;
    }

    const itemNode = hitNode.closest("[data-slimgpt-item='1']");
    if (!(itemNode instanceof HTMLElement)) {
      return -1;
    }

    const turn = Number.parseInt(itemNode.getAttribute("data-slimgpt-turn") || "", 10);
    if (!Number.isFinite(turn)) {
      return -1;
    }

    return clamp(turn, 0, STATE.totalTurns - 1);
  }

  function getViewportRect() {
    const root = STATE.scrollRoot;

    if (root instanceof HTMLElement && root !== document.documentElement && root !== document.body) {
      const rect = root.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height
      };
    }

    return {
      left: 0,
      top: 0,
      width: window.innerWidth,
      height: window.innerHeight
    };
  }

  function isPinnedToBottom() {
    const maxTop = Math.max(getScrollHeight() - getViewportHeight(), 0);
    if (maxTop <= 0) {
      return true;
    }

    return maxTop - getScrollTop() <= CONFIG.pinToBottomThresholdPx;
  }

  function getScrollTop() {
    const root = STATE.scrollRoot;
    if (root instanceof HTMLElement && root !== document.documentElement && root !== document.body) {
      return root.scrollTop;
    }

    return window.scrollY || document.documentElement.scrollTop || 0;
  }

  function getScrollHeight() {
    const root = STATE.scrollRoot;
    if (root instanceof HTMLElement && root !== document.documentElement && root !== document.body) {
      return root.scrollHeight;
    }

    return document.documentElement.scrollHeight;
  }

  function getViewportHeight() {
    const root = STATE.scrollRoot;
    if (root instanceof HTMLElement && root !== document.documentElement && root !== document.body) {
      return root.clientHeight;
    }

    return window.innerHeight;
  }

  function scrollToPosition(top) {
    const root = STATE.scrollRoot;
    if (root instanceof HTMLElement && root !== document.documentElement && root !== document.body) {
      root.scrollTo({ top, behavior: "auto" });
      return;
    }

    window.scrollTo({ top, behavior: "auto" });
  }

  function getElementTopInScrollContext(el) {
    const root = STATE.scrollRoot;

    if (root instanceof HTMLElement && root !== document.documentElement && root !== document.body) {
      const rootRect = root.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      return elRect.top - rootRect.top + root.scrollTop;
    }

    return el.getBoundingClientRect().top + window.scrollY;
  }

  function ensureMessageId(node) {
    const existing = node.getAttribute("data-slimgpt-id");
    if (existing) {
      return existing;
    }

    const next = String(STATE.nextMessageId++);
    node.setAttribute("data-slimgpt-id", next);
    return next;
  }

  function ensureMiniMap() {
    if (document.querySelector("[data-slimgpt-minimap]")) {
      return;
    }

    const minimap = document.createElement("div");
    minimap.id = "slimgpt-minimap";
    minimap.setAttribute("data-slimgpt-minimap", "1");

    const track = document.createElement("div");
    track.className = "slimgpt-minimap-track";

    const preview = document.createElement("div");
    preview.className = "slimgpt-dot-preview";
    preview.setAttribute("data-slimgpt-preview", "1");

    track.addEventListener("click", (event) => {
      const directTarget = event.target;
      if (directTarget instanceof HTMLElement) {
        const dot = directTarget.closest("[data-turn-index]");
        if (dot instanceof HTMLElement) {
          const turn = Number.parseInt(dot.getAttribute("data-turn-index") || "", 10);
          if (Number.isFinite(turn)) {
            jumpToTurn(turn);
            return;
          }
        }
      }

      const total = STATE.totalTurns;
      if (total <= 0) {
        return;
      }

      const rect = track.getBoundingClientRect();
      const localY = clamp(event.clientY - rect.top, 0, rect.height);
      const ratio = rect.height > 0 ? localY / rect.height : 0;

      const start = Number.parseInt(track.getAttribute("data-window-start") || "0", 10);
      const visible = Number.parseInt(track.getAttribute("data-window-size") || "1", 10);

      const localIndex = Math.round(ratio * Math.max(visible - 1, 0));
      const turn = clamp(start + localIndex, 0, total - 1);

      jumpToTurn(turn);
    });

    track.addEventListener("mouseover", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const dot = target.closest(".slimgpt-minimap-dot");
      if (!(dot instanceof HTMLButtonElement)) {
        return;
      }

      const turn = Number.parseInt(dot.getAttribute("data-turn-index") || "", 10);
      if (!Number.isFinite(turn)) {
        return;
      }

      // Lazy-load only hovered turn and neighbors for preview details.
      if (STATE.mode === "dynamic") {
        const minTurn = clamp(turn - 1, 0, Math.max(STATE.totalTurns - 1, 0));
        const maxTurn = clamp(turn + 1, 0, Math.max(STATE.totalTurns - 1, 0));
        restoreTurnsImmediately(minTurn, maxTurn);
      }

      const snapshot = buildTurnSnapshot(turn);
      if (!snapshot) {
        hideDotPreview();
        return;
      }

      renderDotPreview(snapshot, dot);
      dot.setAttribute("aria-label", `Turn ${turn + 1}`);
    });

    track.addEventListener("mousemove", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const dot = target.closest(".slimgpt-minimap-dot");
      if (!(dot instanceof HTMLButtonElement)) {
        hideDotPreview();
        return;
      }

      positionDotPreview(dot);
    });

    track.addEventListener("mouseleave", () => {
      hideDotPreview();
    });

    minimap.appendChild(track);
    document.body.appendChild(minimap);
    document.body.appendChild(preview);
  }

  function updateMiniMap(force = false) {
    const root = document.querySelector("[data-slimgpt-minimap]");
    if (!(root instanceof HTMLElement)) return;

    const track = root.querySelector(".slimgpt-minimap-track");
    if (!(track instanceof HTMLElement)) return;

    if (force && STATE.minimapDeferredTimer !== 0) {
      clearTimeout(STATE.minimapDeferredTimer);
      STATE.minimapDeferredTimer = 0;
    }

    const now = performance.now();
    const typingHot = isTypingHot();
    const scrollingHot = Date.now() - STATE.lastScrollAt < CONFIG.fastScrollWindowMs;
    const throttleMs = typingHot ? CONFIG.typingMinimapThrottleMs : CONFIG.minimapThrottleMs;
    if (!force && (scrollingHot || typingHot) && now - STATE.lastMiniMapRenderAt < throttleMs) {
      if (STATE.minimapDeferredTimer === 0) {
        const wait = Math.max(
          16,
          Math.ceil(throttleMs - (now - STATE.lastMiniMapRenderAt))
        );
        STATE.minimapDeferredTimer = window.setTimeout(() => {
          STATE.minimapDeferredTimer = 0;
          scheduleSync();
        }, wait);
      }
      return;
    }

    const total = STATE.totalTurns;
    if (total <= 0) {
      if (STATE.lastMiniMapSignature !== "empty") {
        track.replaceChildren();
        hideDotPreview();
        STATE.lastMiniMapSignature = "empty";
        STATE.lastMiniMapAnchorTurn = -1;
        STATE.lastMiniMapRenderAt = now;
      }
      return;
    }

    const visible = Math.min(CONFIG.minimapVisibleDots, total);
    const half = Math.floor(visible / 2);
    const maxStart = Math.max(0, total - visible);
    const start = clamp(STATE.currentAnchorTurn - half, 0, maxStart);
    const signature = `${total}|${visible}|${start}|${STATE.currentAnchorTurn}`;
    if (signature === STATE.lastMiniMapSignature) {
      return;
    }

    hideDotPreview();

    if (track.getAttribute("data-window-start") !== String(start)) {
      track.setAttribute("data-window-start", String(start));
    }
    if (track.getAttribute("data-window-size") !== String(visible)) {
      track.setAttribute("data-window-size", String(visible));
    }

    const dots = ensureMiniMapDotPool(track, visible);
    for (let index = 0; index < visible; index += 1) {
      const dot = dots[index];
      const turn = start + index;
      // 8%–92% keeps dots away from track edges for visual breathing room.
      const raw = visible === 1 ? 0.5 : index / (visible - 1);
      const slot = 0.08 + raw * 0.84;
      const topPct = `${slot * 100}%`;
      const isActive = turn === STATE.currentAnchorTurn;
      // A turn is collapsed when ALL its messages are placeholders.
      const isCollapsed = isTurnCollapsed(turn);

      if (dot.style.top !== topPct) {
        dot.style.top = topPct;
      }

      const turnAttr = String(turn);
      if (dot.getAttribute("data-turn-index") !== turnAttr) {
        dot.setAttribute("data-turn-index", turnAttr);
      }

      if (dot.hasAttribute("title")) {
        dot.removeAttribute("title");
      }

      const label = `Turn ${turn + 1}`;
      if (dot.getAttribute("aria-label") !== label) {
        dot.setAttribute("aria-label", label);
      }

      const wasActive = dot.classList.contains("is-active");
      dot.classList.toggle("is-active", isActive);
      dot.classList.toggle("is-collapsed", isCollapsed && !isActive);
      const allowPulse = Date.now() - STATE.lastScrollAt > CONFIG.fastScrollWindowMs;

      if (isActive && !wasActive && STATE.lastMiniMapAnchorTurn !== -1 && allowPulse) {
        dot.classList.remove("is-active-pulse");
        dot.offsetTop; // eslint-disable-line no-unused-expressions
        dot.classList.add("is-active-pulse");
      } else if (!isActive) {
        dot.classList.remove("is-active-pulse");
      }
    }

    STATE.lastMiniMapAnchorTurn = STATE.currentAnchorTurn;
    STATE.lastMiniMapSignature = signature;
    STATE.lastMiniMapRenderAt = now;
  }

  function ensureMiniMapDotPool(track, visible) {
    const current = Array.from(track.querySelectorAll(".slimgpt-minimap-dot"));
    if (current.length === visible) {
      return current;
    }

    track.replaceChildren();
    const dots = [];
    for (let i = 0; i < visible; i += 1) {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "slimgpt-minimap-dot is-entered";
      dot.setAttribute("data-turn-index", "0");
      track.appendChild(dot);
      dots.push(dot);
    }

    return dots;
  }

  function jumpToTurn(turnIndex) {
    if (STATE.totalTurns <= 0) {
      return;
    }

    const turn = clamp(turnIndex, 0, STATE.totalTurns - 1);
    STATE.currentAnchorTurn = turn;
    STATE.previousAnchorTurn = turn;

    const minTurn = clamp(turn - CONFIG.jumpPreloadTurns, 0, STATE.totalTurns - 1);
    const maxTurn = clamp(turn + CONFIG.jumpPreloadTurns, 0, STATE.totalTurns - 1);

    restoreTurnsImmediately(minTurn, maxTurn);
    requestBackgroundCollapse(minTurn, maxTurn);
    updateMiniMap(true);
    STATE.allowCollapseAt = performance.now() + 320;
    STATE.lastScrollAt = Date.now();

    const target = getTurnElement(turn);
    if (target instanceof HTMLElement) {
      const top = getElementTopInScrollContext(target) - getViewportHeight() * 0.35;
      scrollToPosition(Math.max(0, top));
    } else {
      const scrollRange = Math.max(getScrollHeight() - getViewportHeight(), 0);
      const ratio = STATE.totalTurns > 1 ? turn / (STATE.totalTurns - 1) : 0;
      scrollToPosition(Math.round(scrollRange * ratio));
    }

    scheduleSync();
    window.setTimeout(scheduleSync, 40);
    window.setTimeout(scheduleSync, 120);
  }

  function getTurnElement(turn) {
    const ids = STATE.turnToIds.get(turn) || [];

    for (const id of ids) {
      const item = STATE.messageById.get(id);
      if (!item || item.isPlaceholder) {
        continue;
      }

      if (item.el instanceof HTMLElement && item.el.isConnected) {
        return item.el;
      }
    }

    for (const id of ids) {
      const item = STATE.messageById.get(id);
      if (!item) {
        continue;
      }

      if (item.el instanceof HTMLElement && item.el.isConnected) {
        return item.el;
      }
    }

    return null;
  }

  function buildTurnSnapshot(turn) {
    const prevAssistant = clampSnippet(
      getNearestRoleText(turn - 1, CONFIG.assistantRole, -1, 3),
      84
    );
    const userText = clampSnippet(
      getNearestRoleText(turn, CONFIG.userRole, 0, 1) ||
        getNearestRoleText(turn - 1, CONFIG.userRole, -1, 2),
      96
    );
    const nextAssistant = clampSnippet(
      getNearestRoleText(turn, CONFIG.assistantRole, 1, 3),
      72
    );

    return {
      prevAssistant: prevAssistant || "\u2026",
      userText: userText || "\u2026",
      nextAssistant: nextAssistant || "\u2026"
    };
  }

  function getRoleTextForTurn(turn, role) {
    if (turn < 0 || turn >= STATE.totalTurns) {
      return "";
    }

    const ids = STATE.turnToIds.get(turn) || [];
    for (const id of ids) {
      const item = STATE.messageById.get(id);
      if (!item || item.role !== role) {
        continue;
      }

      const text = getItemText(item);
      if (text) {
        return text;
      }
    }

    return "";
  }

  function getNearestRoleText(baseTurn, role, direction, maxSteps) {
    if (STATE.totalTurns <= 0) {
      return "";
    }

    if (direction === 0) {
      return getRoleTextForTurn(baseTurn, role);
    }

    let turn = baseTurn;
    for (let step = 0; step < maxSteps; step += 1) {
      if (turn < 0 || turn >= STATE.totalTurns) {
        break;
      }

      const text = getRoleTextForTurn(turn, role);
      if (text) {
        return text;
      }

      turn += direction;
    }

    return "";
  }

  function renderDotPreview(snapshot, dot) {
    const preview = document.querySelector("[data-slimgpt-preview='1']");
    if (!(preview instanceof HTMLDivElement)) return;

    preview.replaceChildren(
      buildPreviewRow("\u2191 GPT", snapshot.prevAssistant),
      buildPreviewRow("You", snapshot.userText),
      buildPreviewRow("\u2193 GPT", snapshot.nextAssistant)
    );
    preview.classList.add("is-visible");
    positionDotPreview(dot);
  }

  function buildPreviewRow(label, text) {
    const row = document.createElement("div");
    row.className = "slimgpt-dot-preview-row";

    const labelEl = document.createElement("span");
    labelEl.className = "slimgpt-dot-preview-label";
    labelEl.textContent = `${label}: `;

    const textEl = document.createElement("span");
    textEl.className = "slimgpt-dot-preview-text";
    textEl.textContent = text;

    row.appendChild(labelEl);
    row.appendChild(textEl);

    return row;
  }

  function hideDotPreview() {
    const preview = document.querySelector("[data-slimgpt-preview='1']");
    if (!(preview instanceof HTMLDivElement)) {
      return;
    }

    preview.classList.remove("is-visible");
  }

  function positionDotPreview(dot) {
    const preview = document.querySelector("[data-slimgpt-preview='1']");
    if (!(preview instanceof HTMLDivElement)) {
      return;
    }

    if (!preview.classList.contains("is-visible")) {
      return;
    }

    const dotRect = dot.getBoundingClientRect();
    const previewRect = preview.getBoundingClientRect();

    const centerY = dotRect.top + dotRect.height / 2;
    const top = clamp(
      centerY - previewRect.height / 2,
      8,
      window.innerHeight - previewRect.height - 8
    );

    const showOnRight = dotRect.left < window.innerWidth / 2;
    const left = showOnRight ? dotRect.right + 8 : dotRect.left - previewRect.width - 8;

    preview.style.top = `${top}px`;
    preview.style.left = `${Math.max(8, left)}px`;
  }

  function getItemText(item) {
    if (item.snippet) {
      return item.snippet;
    }

    let source = item.el.getAttribute("data-slimgpt-snippet") || "";

    if (!source && !item.isPlaceholder && item.el.isConnected) {
      source = item.el.textContent || "";
    }

    if (!source && item.isPlaceholder) {
      const record = STATE.collapsedById.get(item.id);
      if (record && record.node) {
        source = record.node.textContent || "";
      }
    }

    const snippet = makeSnippet(source);
    if (!snippet) {
      return "";
    }

    item.snippet = snippet;
    item.el.setAttribute("data-slimgpt-snippet", snippet);
    return snippet;
  }

  function muteObserver(value) {
    STATE.observerMuted = value;
  }

  function normalizeRole(value) {
    const role = (value || "").trim().toLowerCase();
    if (role === CONFIG.userRole || role === CONFIG.assistantRole) {
      return role;
    }

    return CONFIG.assistantRole;
  }

  function makeSnippet(text) {
    const cleaned = (text || "").replace(/\s+/g, " ").trim();
    if (!cleaned) {
      return "";
    }

    return cleaned.slice(0, CONFIG.maxSnippetLength);
  }

  function clampSnippet(text, maxLength) {
    if (!text) {
      return "";
    }

    if (text.length <= maxLength) {
      return text;
    }

    return `${text.slice(0, maxLength)}...`;
  }

  // A turn is considered collapsed when every message in it is a placeholder.
  function isTurnCollapsed(turn) {
    const ids = STATE.turnToIds.get(turn);
    if (!ids || ids.length === 0) return false;
    return ids.every(id => {
      const item = STATE.messageById.get(id);
      return item && item.isPlaceholder;
    });
  }

  // ── LaTeX copy interaction ───────────────────────────────────────────────────
  // ChatGPT renders KaTeX into <annotation encoding="application/x-tex">.
  // We bind copy-on-click directly on the rendered formula for cleaner UI.

  function initLatexCopyButtons() {
    ensureLatexCopyDelegate();

    // Inject buttons into any math already on the page, then watch for new ones.
    document.querySelectorAll("annotation[encoding='application/x-tex']")
      .forEach(injectLatexCopyBtn);

    const obs = new MutationObserver((records) => {
      for (const r of records) {
        for (const node of r.addedNodes) {
          if (!(node instanceof Element)) continue;
          node.querySelectorAll("annotation[encoding='application/x-tex']")
            .forEach(injectLatexCopyBtn);
          if (node.matches("annotation[encoding='application/x-tex']")) {
            injectLatexCopyBtn(node);
          }
        }
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  function injectLatexCopyBtn(annotation) {
    const displayContainer = annotation.closest(".katex-display");
    const container = displayContainer || annotation.closest(".katex");
    if (!container) return;

    const latex = annotation.textContent.trim();
    if (!latex) return;

    if (container.closest("[data-slimgpt-inline-math='1']")) {
      return;
    }

    if (displayContainer) {
      container.querySelectorAll("[data-slimgpt-latex-btn='1']").forEach((el) => el.remove());
      bindLatexCopyTarget(container, latex);
      return;
    }

    const next = container.nextElementSibling;
    if (next instanceof HTMLElement && next.getAttribute("data-slimgpt-latex-inline-btn") === "1") {
      next.remove();
    }
    bindLatexCopyTarget(container, latex);
  }

  function bindLatexCopyTarget(target, latex) {
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const value = String(latex || "").trim();
    if (!value) {
      return;
    }

    target.setAttribute("data-slimgpt-latex-copy", "1");
    target.setAttribute("data-slimgpt-latex-source", value);
    target.setAttribute("data-slimgpt-copy-label", "TeX");
    target.style.cursor = "copy";
  }

  function ensureLatexCopyDelegate() {
    if (STATE.latexCopyDelegateBound) {
      return;
    }

    document.addEventListener(
      "click",
      (event) => {
        if (!(event.target instanceof Element)) {
          return;
        }

        const target = event.target.closest("[data-slimgpt-latex-copy='1']");
        if (!(target instanceof HTMLElement)) {
          return;
        }

        const latex = target.getAttribute("data-slimgpt-latex-source") || "";
        if (!latex) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();

        copyTextToClipboard(latex).then((ok) => {
          if (!ok) return;
          target.classList.add("is-copied");
          window.setTimeout(() => {
            target.classList.remove("is-copied");
          }, 900);
        });
      },
      { capture: true }
    );

    STATE.latexCopyDelegateBound = true;
  }

  function copyTextToClipboard(text) {
    const value = String(text || "");
    if (!value) {
      return Promise.resolve(false);
    }

    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      return navigator.clipboard.writeText(value).then(() => true).catch(() => legacyCopy(value));
    }

    return legacyCopy(value);
  }

  function legacyCopy(text) {
    return new Promise((resolve) => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "true");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      ta.style.pointerEvents = "none";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      ta.remove();
      resolve(ok);
    });
  }

  // ── Composer expand button ───────────────────────────────────────────────────
  // Injects a resize button into ChatGPT's composer toolbar.
  // The button expands the textarea to 5× its natural height; clicking again
  // or sending a message collapses it back.

  function initComposerExpand() {
    if (STATE.composerInitStarted) {
      return;
    }

    STATE.composerInitStarted = true;
    runAfterWindowLoad(CONFIG.composerInitDelayMs, () => {
      tryInjectExpandBtn();
      // Composer may not exist yet on first paint; keep watching for late mounts.
      const obs = new MutationObserver(() => tryInjectExpandBtn());
      obs.observe(document.body, { childList: true, subtree: true });
    });

    if (!STATE.composerSubmitListenerBound) {
      document.addEventListener(
        "click",
        (event) => {
          if (!(event.target instanceof Element)) return;
          if (
            event.target.closest(
              "[data-testid='send-button'], [aria-label='发送消息'], [aria-label='Send message']"
            )
          ) {
            collapseAllExpandedComposers();
          }
        },
        { capture: true }
      );
      STATE.composerSubmitListenerBound = true;
    }
  }

  function tryInjectExpandBtn() {
    const surfaces = document.querySelectorAll("[data-composer-surface='true']");
    for (const surface of surfaces) {
      if (!(surface instanceof HTMLElement)) continue;

      const trailing = surface.querySelector("[grid-area='trailing'], .\\[grid-area\\:trailing\\]");
      if (!(trailing instanceof HTMLElement)) continue;
      if (trailing.querySelector("[data-slimgpt-expand-btn='1']")) continue;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "slimgpt-expand-btn composer-btn";
      btn.setAttribute("data-slimgpt-expand-btn", "1");
      btn.setAttribute("aria-label", "Expand composer");
      btn.setAttribute("aria-pressed", "false");
      btn.innerHTML =
        `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;

      btn.addEventListener("click", () => toggleComposerExpand(btn));
      trailing.insertBefore(btn, trailing.firstChild);

      if (surface.getAttribute("data-slimgpt-expand-keybound") !== "1") {
        surface.addEventListener(
          "keydown",
          (event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
              collapseAllExpandedComposers();
            }
          },
          { capture: true }
        );
        surface.setAttribute("data-slimgpt-expand-keybound", "1");
      }
    }
  }

  function collapseAllExpandedComposers() {
    const buttons = document.querySelectorAll("[data-slimgpt-expand-btn='1'][aria-pressed='true']");
    for (const btn of buttons) {
      if (btn instanceof HTMLButtonElement) {
        collapseComposer(btn);
      }
    }
  }

  function toggleComposerExpand(btn) {
    const expanded = btn.getAttribute("aria-pressed") === "true";
    expanded ? collapseComposer(btn) : expandComposer(btn);
  }

  function expandComposer(btn) {
    const surface = btn.closest("[data-composer-surface='true']");
    if (!surface) return;
    setComposerExpandedState(surface, true);
    const scrollable = findComposerScrollable(surface);
    if (!scrollable) return;

    const base = getComposerBaseHeight(scrollable);
    const maxByViewport = Math.floor(window.innerHeight * CONFIG.composerExpandViewportCap);
    const targetByFactor = Math.round(base * CONFIG.composerExpandFactor);
    const target = Math.max(
      base + CONFIG.composerExpandMinExtraPx,
      Math.min(maxByViewport, targetByFactor)
    );
    const extraHeight = Math.max(0, target - base);

    surface.style.setProperty("--deep-research-composer-extra-height", `${extraHeight}px`);
    scrollable.style.setProperty("max-height", `${target}px`, "important");
    scrollable.style.setProperty("overflow-y", "auto", "important");

    btn.setAttribute("aria-pressed", "true");
    btn.setAttribute("aria-label", "Collapse composer");
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/></svg>`;
  }

  function collapseComposer(btn) {
    const surface = btn.closest("[data-composer-surface='true']");
    if (!surface) return;
    setComposerExpandedState(surface, false);
    const scrollable = findComposerScrollable(surface);
    if (scrollable) {
      scrollable.style.removeProperty("max-height");
      scrollable.style.removeProperty("overflow-y");
    }
    surface.style.removeProperty("--deep-research-composer-extra-height");

    btn.setAttribute("aria-pressed", "false");
    btn.setAttribute("aria-label", "Expand composer");
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;
  }

  function findComposerScrollable(surface) {
    const direct = surface.querySelector(".wcDTda_prosemirror-parent");
    if (direct instanceof HTMLElement) {
      return direct;
    }

    const prose = surface.querySelector("#prompt-textarea, .ProseMirror");
    if (prose instanceof HTMLElement) {
      const container = prose.closest(
        ".wcDTda_prosemirror-parent, [class*='prosemirror-parent'], [class*='overflow-auto']"
      );
      if (container instanceof HTMLElement) {
        return container;
      }
    }

    const fallback = surface.querySelector("[class*='prosemirror-parent'], [class*='overflow-auto']");
    return fallback instanceof HTMLElement ? fallback : null;
  }

  function getComposerBaseHeight(scrollable) {
    const cached = Number.parseFloat(scrollable.getAttribute("data-slimgpt-base-height") || "");
    if (Number.isFinite(cached) && cached > 0) {
      return cached;
    }

    const rectHeight = scrollable.getBoundingClientRect().height;
    const computed = window.getComputedStyle(scrollable);
    const computedMax = Number.parseFloat(computed.maxHeight || "");
    let base = Number.isFinite(rectHeight) && rectHeight > 0 ? rectHeight : 0;

    if (Number.isFinite(computedMax) && computedMax > 0) {
      base = Math.max(base, computedMax);
    }

    if (!Number.isFinite(base) || base <= 0) {
      base = 160;
    }

    scrollable.setAttribute("data-slimgpt-base-height", String(Math.round(base)));
    return base;
  }

  function setComposerExpandedState(surface, expanded) {
    const form = surface.closest("form");
    const trailing = surface.querySelector("[grid-area='trailing'], .\\[grid-area\\:trailing\\]");

    if (expanded) {
      if (form instanceof HTMLFormElement) {
        form.setAttribute("data-expanded", "true");
      }
      surface.setAttribute("data-slimgpt-expanded", "1");
      surface.style.setProperty(
        "grid-template-areas",
        "'header header header' 'primary primary primary' 'leading footer trailing'",
        "important"
      );
      if (trailing instanceof HTMLElement) {
        trailing.style.setProperty("align-self", "end", "important");
      }
      return;
    }

    if (form instanceof HTMLFormElement) {
      form.removeAttribute("data-expanded");
    }
    surface.removeAttribute("data-slimgpt-expanded");
    surface.style.removeProperty("grid-template-areas");
    if (trailing instanceof HTMLElement) {
      trailing.style.removeProperty("align-self");
    }
  }

  function ensureKatexRuntime() {
    return Promise.resolve(!!(window.katex && typeof window.katex.render === "function"));
  }

  function ensureKatexStyles() {
    if (document.getElementById("slimgpt-katex-local-css")) {
      return;
    }

    if (!chrome?.runtime?.getURL) {
      return;
    }

    const href = chrome.runtime.getURL("vendor/katex/katex.min.css");
    const link = document.createElement("link");
    link.id = "slimgpt-katex-local-css";
    link.rel = "stylesheet";
    link.href = href;
    (document.head || document.documentElement).appendChild(link);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function runAfterWindowLoad(delayMs, callback) {
    const run = () => {
      window.setTimeout(() => {
        callback();
      }, Math.max(0, delayMs));
    };

    if (document.readyState === "complete") {
      run();
      return;
    }

    window.addEventListener("load", run, { once: true });
  }

  // ── Inline LaTeX renderer ────────────────────────────────────────────────────
  // ChatGPT sometimes leaves $...$ inline math as raw text instead of rendering
  // it with KaTeX. We scan assistant message paragraphs and render them ourselves.

  function initInlineLatexRenderer() {
    ensureKatexStyles();
    ensureKatexRuntime();

    const now = performance.now();
    STATE.inlineLatexReadyAt = now + CONFIG.inlineLatexInitialReadyDelayMs;
    runAfterWindowLoad(CONFIG.inlineLatexPostLoadReadyDelayMs, () => {
      STATE.inlineLatexReadyAt = Math.min(
        STATE.inlineLatexReadyAt,
        performance.now() + CONFIG.inlineLatexPostLoadReadyDelayMs
      );
      queueInlineLatexForViewportTurns(4, CONFIG.inlineLatexLiveAssistantScanLimit);
    });

    if (STATE.inlineLatexObserver instanceof MutationObserver) {
      return;
    }

    STATE.inlineLatexObserver = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "characterData") {
          const parent = r.target && r.target.parentElement;
          if (parent instanceof Element) {
            const inlineHost = parent.closest(".markdown p, .markdown li, .markdown td");
            if (inlineHost) {
              queueInlineLatexRender(inlineHost);
            }
          }
          continue;
        }

        if (r.target instanceof Element) {
          const host = r.target.closest(".markdown p, .markdown li, .markdown td");
          if (host) {
            queueInlineLatexRender(host);
          }
        }

        for (const node of r.addedNodes) {
          if (node instanceof Element) {
            const host = node.closest(".markdown p, .markdown li, .markdown td");
            if (host) {
              queueInlineLatexRender(host);
            }
          }
        }
      }
    });
    STATE.inlineLatexObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });

    if (STATE.inlineLatexSafetyTimer === 0) {
      STATE.inlineLatexSafetyTimer = window.setInterval(() => {
        if (document.visibilityState !== "visible") {
          return;
        }
        ensureKatexRuntime();
        queueInlineLatexForViewportTurns(2, CONFIG.inlineLatexLiveAssistantScanLimit);
      }, 900);
    }

    startInlineLatexBootstrapTimer();
  }

  function startInlineLatexBootstrapTimer() {
    if (STATE.inlineLatexBootstrapTimer !== 0) {
      return;
    }

    STATE.inlineLatexBootstrapTimer = window.setInterval(() => {
      if (STATE.inlineLatexBootstrapRuns >= CONFIG.inlineLatexBootstrapScanMaxRuns) {
        clearInterval(STATE.inlineLatexBootstrapTimer);
        STATE.inlineLatexBootstrapTimer = 0;
        return;
      }

      if (document.visibilityState !== "visible") {
        return;
      }

      STATE.inlineLatexBootstrapRuns += 1;
      queueInlineLatexForViewportTurns(5, CONFIG.inlineLatexLiveAssistantScanLimit);
    }, CONFIG.inlineLatexBootstrapScanMs);
  }

  function queueInlineLatexRender(root) {
    const key = root instanceof Element ? root : document.body;
    STATE.inlineLatexPendingRoots.set(key, performance.now());
    scheduleInlineLatexFlush();
  }

  function scheduleInlineLatexFlush() {
    const now = performance.now();
    const waitForReady = Math.max(0, STATE.inlineLatexReadyAt - now);
    const delay = Math.max(CONFIG.inlineLatexDebounceMs, Math.ceil(waitForReady));

    if (STATE.inlineLatexFlushTimer !== 0) {
      clearTimeout(STATE.inlineLatexFlushTimer);
    }

    STATE.inlineLatexFlushTimer = window.setTimeout(() => {
      STATE.inlineLatexFlushTimer = 0;
      flushInlineLatexQueue();
    }, delay);
  }

  function flushInlineLatexQueue() {
    if (STATE.inlineLatexPendingRoots.size === 0) {
      return;
    }

    if (performance.now() < STATE.inlineLatexReadyAt) {
      scheduleInlineLatexFlush();
      return;
    }

    const roots = Array.from(STATE.inlineLatexPendingRoots.keys());
    STATE.inlineLatexPendingRoots.clear();

    let deferred = false;
    for (const root of roots) {
      const hosts = getInlineLatexHosts(root);
      for (const host of hosts) {
        if (!isInlineLatexHostStable(host)) {
          STATE.inlineLatexPendingRoots.set(host, performance.now());
          deferred = true;
          continue;
        }

        renderInlineLatexInElement(host);
      }
    }

    if (deferred) {
      scheduleInlineLatexFlush();
    }
  }

  function getInlineLatexHosts(root) {
    if (!(root instanceof Element)) {
      return [];
    }

    if (root.matches(".markdown p, .markdown li, .markdown td")) {
      return [root];
    }

    return Array.from(root.querySelectorAll(".markdown p, .markdown li, .markdown td"));
  }

  function isInlineLatexHostStable(host) {
    if (!(host instanceof Element) || !host.isConnected) {
      return false;
    }

    if (host.closest("[data-writing-block]")) {
      return false;
    }

    if (host.closest("pre, code")) {
      return false;
    }

    return true;
  }

  function queueInlineLatexForViewportTurns(extraTurns = 0, limit = CONFIG.inlineLatexLiveAssistantScanLimit) {
    if (STATE.totalTurns <= 0 || STATE.messages.length === 0) {
      return;
    }

    const anchor = clamp(STATE.currentAnchorTurn, 0, STATE.totalTurns - 1);
    const around = CONFIG.turnsAroundViewport + Math.max(0, extraTurns);
    const minTurn = clamp(anchor - around, 0, STATE.totalTurns - 1);
    const maxTurn = clamp(anchor + around, 0, STATE.totalTurns - 1);
    queueInlineLatexForTurnRange(minTurn, maxTurn, limit);
  }

  function queueInlineLatexForTurnRange(minTurn, maxTurn, limit) {
    let queued = 0;
    for (let turn = minTurn; turn <= maxTurn; turn += 1) {
      const ids = STATE.turnToIds.get(turn) || [];
      for (const id of ids) {
        const item = STATE.messageById.get(id);
        if (!item || item.isPlaceholder || item.role !== CONFIG.assistantRole) {
          continue;
        }

        if (item.el instanceof Element && item.el.isConnected) {
          queueInlineLatexRender(item.el);
          queued += 1;
        }

        if (queued >= limit) {
          return;
        }
      }
    }
  }

  function processInlineLatex(root) {
    const containers = root.querySelectorAll
      ? root.querySelectorAll(".markdown p, .markdown li, .markdown td")
      : [];
    for (const el of containers) {
      renderInlineLatexInElement(el);
    }
    if (root instanceof Element && root.matches(".markdown p, .markdown li, .markdown td")) {
      renderInlineLatexInElement(root);
    }
  }

  function renderInlineLatexInElement(el) {
    const textSnapshot = el.textContent || "";
    if (!textSnapshot.includes("$")) {
      STATE.inlineLatexSourceByHost.set(el, textSnapshot);
      return;
    }

    if (STATE.inlineLatexSourceByHost.get(el) === textSnapshot) {
      return;
    }

    const inStreamingBlock = !!el.closest("[data-writing-block]");
    if (inStreamingBlock) {
      const lastRenderAt = STATE.inlineLatexLastRenderAt.get(el) || 0;
      if (performance.now() - lastRenderAt < CONFIG.inlineLatexStreamRenderMinIntervalMs) {
        return;
      }
    }

    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) textNodes.push(node);

    let changed = false;
    for (const textNode of textNodes) {
      if (textNode.parentElement?.closest(".katex, code, pre, [data-slimgpt-inline-math='1']")) continue;
      const text = textNode.textContent || "";
      if (!text.includes("$")) continue;

      const parts = splitInlineMathSegments(text);
      if (!parts.some(part => part.type === "math")) continue;

      const frag = document.createDocumentFragment();
      for (const part of parts) {
        if (part.type === "math") {
          frag.appendChild(buildInlineMathNode(part.value));
        } else {
          frag.appendChild(document.createTextNode(part.value));
        }
      }
      textNode.replaceWith(frag);
      changed = true;
    }

    if (changed) {
      STATE.inlineLatexSourceByHost.set(el, el.textContent || "");
      STATE.inlineLatexLastRenderAt.set(el, performance.now());
    } else {
      STATE.inlineLatexSourceByHost.set(el, textSnapshot);
    }
  }

  function splitInlineMathSegments(text) {
    const result = [];
    let buffer = "";
    let mathBuffer = "";
    let inMath = false;

    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      const next = i + 1 < text.length ? text[i + 1] : "";

      if (ch === "\\" && next === "$") {
        if (inMath) {
          mathBuffer += "$";
        } else {
          buffer += "$";
        }
        i += 1;
        continue;
      }

      if (ch === "$") {
        if (inMath) {
          const latex = mathBuffer.trim();
          if (latex) {
            result.push({ type: "math", value: latex });
          } else {
            buffer += "$$";
          }
          mathBuffer = "";
          inMath = false;
        } else {
          if (buffer) {
            result.push({ type: "text", value: buffer });
            buffer = "";
          }
          inMath = true;
        }
        continue;
      }

      if (inMath && (ch === "\n" || ch === "\r")) {
        buffer += `$${mathBuffer}${ch}`;
        mathBuffer = "";
        inMath = false;
        continue;
      }

      if (inMath) {
        mathBuffer += ch;
      } else {
        buffer += ch;
      }
    }

    if (inMath) {
      buffer += `$${mathBuffer}`;
    }
    if (buffer) {
      result.push({ type: "text", value: buffer });
    }

    return result;
  }

  function buildInlineMathNode(latex) {
    const wrap = document.createElement("span");
    wrap.className = "slimgpt-inline-math-wrap";
    wrap.setAttribute("data-slimgpt-inline-math", "1");

    const rendered = document.createElement("span");
    rendered.className = "slimgpt-inline-math";
    renderInlineMathToNode(rendered, latex);

    wrap.appendChild(rendered);
    bindLatexCopyTarget(wrap, latex);
    return wrap;
  }

  function renderInlineMathToNode(target, latex) {
    const source = String(latex || "").trim();
    const normalized = normalizeInlineLatexForRetry(source);
    const candidates = normalized && normalized !== source ? [source, normalized] : [source];

    if (window.katex && typeof window.katex.render === "function") {
      for (const expr of candidates) {
        try {
          window.katex.render(expr, target, {
            throwOnError: true,
            displayMode: false,
            strict: "ignore"
          });
          target.classList.remove("is-fallback");
          return;
        } catch {
          // Try next candidate.
        }
      }
    }

    target.classList.add("is-fallback");
    target.textContent = formatInlineLatexFallback(normalized || source);
  }

  function normalizeInlineLatexForRetry(latex) {
    let text = String(latex || "").trim();
    if (!text) {
      return text;
    }

    text = text
      .replace(/\\([，。；：、])/g, "$1")
      .replace(/[，]/g, ",")
      .replace(/[；]/g, ";")
      .replace(/[：]/g, ":")
      .replace(/[（]/g, "(")
      .replace(/[）]/g, ")")
      .replace(/[【]/g, "[")
      .replace(/[】]/g, "]");

    // Recover missing leading backslash for common environments.
    text = text
      .replace(/(^|[^\\])begin\{(cases|matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|array)\}/g, "$1\\\\begin{$2}")
      .replace(/(^|[^\\])end\{(cases|matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|array)\}/g, "$1\\\\end{$2}");

    // Common LLM slip: row break in cases/matrix is emitted as "\-x" or "\3".
    text = text.replace(/([0-9A-Za-z\}\)])\\(?=\s*[-+0-9])/g, "$1\\\\");

    return text;
  }

  function formatInlineLatexFallback(latex) {
    let text = String(latex || "").trim();
    if (!text) {
      return text;
    }

    text = replaceFractionLike(text);
    text = text
      .replace(/\\?sqrt\s*\{([^{}]+)\}/g, "√($1)")
      .replace(/\\?operatorname\s*\{([^{}]+)\}/g, "$1")
      .replace(/\\?mathrm\s*\{([^{}]+)\}/g, "$1")
      .replace(/\\?mathbb\s*\{([RNCQZ])\}/g, (_, setName) => {
        const map = { R: "ℝ", N: "ℕ", C: "ℂ", Q: "ℚ", Z: "ℤ" };
        return map[setName] || setName;
      });

    const macros = [
      ["\\to", "→"],
      ["\\rightarrow", "→"],
      ["\\leftarrow", "←"],
      ["\\approx", "≈"],
      ["\\neq", "≠"],
      ["\\leq", "≤"],
      ["\\geq", "≥"],
      ["\\infty", "∞"],
      ["\\partial", "∂"],
      ["\\sum", "∑"],
      ["\\int", "∫"],
      ["\\lambda", "λ"],
      ["\\theta", "θ"],
      ["\\pi", "π"],
      ["\\sin", "sin"],
      ["\\cos", "cos"],
      ["\\tan", "tan"],
      ["\\ln", "ln"],
      ["\\det", "det"],
      ["\\cdot", "·"],
      ["\\times", "×"]
    ];

    for (const [token, value] of macros) {
      text = text.split(token).join(value);
    }

    const bareGreek = [
      ["alpha", "α"],
      ["beta", "β"],
      ["gamma", "γ"],
      ["delta", "δ"],
      ["epsilon", "ε"],
      ["lambda", "λ"],
      ["mu", "μ"],
      ["pi", "π"],
      ["sigma", "σ"],
      ["theta", "θ"],
      ["rho", "ρ"],
      ["omega", "ω"]
    ];

    for (const [word, symbol] of bareGreek) {
      text = text.replace(new RegExp(`\\\\?${word}\\b`, "g"), symbol);
      text = text.replace(new RegExp(`\\\\?${capitalize(word)}\\b`, "g"), symbol);
    }

    text = text
      .replace(/([A-Za-z0-9)\]])in(ℝ|ℕ|ℂ|ℚ|ℤ)/g, "$1∈$2")
      .replace(/([A-Za-z0-9)\]])\\in(ℝ|ℕ|ℂ|ℚ|ℤ)/g, "$1∈$2");

    text = text.replace(/\^([A-Za-z0-9+\-()])/g, (_, value) => toSuperscript(value));
    text = text.replace(/_([A-Za-z0-9+\-()])/g, (_, value) => toSubscript(value));

    text = text
      .replace(/\^\{([^{}]+)\}/g, (_, value) => toSuperscript(value))
      .replace(/_\{([^{}]+)\}/g, (_, value) => toSubscript(value))
      .replace(/\\,/g, " ")
      .replace(/\\left/g, "")
      .replace(/\\right/g, "")
      .replace(/\\\(/g, "(")
      .replace(/\\\)/g, ")")
      .replace(/\\\[/g, "[")
      .replace(/\\\]/g, "]")
      .replace(/\\([a-zA-Z]+)/g, "$1")
      .replace(/\s+/g, " ")
      .trim();

    return text;
  }

  function replaceFractionLike(input) {
    let text = String(input || "");
    let previous = "";

    // Handle both \frac{a}{b} and frac{a}{b}; repeat to reduce nested cases.
    while (text !== previous) {
      previous = text;
      text = text.replace(/\\?frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, "($1)/($2)");
    }

    return text;
  }

  function toSuperscript(value) {
    const map = {
      "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
      "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
      "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
      "n": "ⁿ", "i": "ⁱ"
    };
    let out = "";
    for (const ch of String(value || "")) {
      if (!map[ch]) {
        return `^(${value})`;
      }
      out += map[ch];
    }
    return out || `^(${value})`;
  }

  function toSubscript(value) {
    const map = {
      "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
      "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
      "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
      "a": "ₐ", "e": "ₑ", "h": "ₕ", "i": "ᵢ", "j": "ⱼ",
      "k": "ₖ", "l": "ₗ", "m": "ₘ", "n": "ₙ", "o": "ₒ",
      "p": "ₚ", "r": "ᵣ", "s": "ₛ", "t": "ₜ", "u": "ᵤ",
      "v": "ᵥ", "x": "ₓ"
    };
    let out = "";
    for (const ch of String(value || "")) {
      const key = ch.toLowerCase();
      if (!map[key]) {
        return `_(${value})`;
      }
      out += map[key];
    }
    return out || `_(${value})`;
  }

  function capitalize(text) {
    const s = String(text || "");
    if (!s) return s;
    return s[0].toUpperCase() + s.slice(1);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
