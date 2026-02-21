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
    startupCollapseDelayMs: 160,
    typingHotMs: 1300,
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

    collapsedById: new Map(),
    heightById: new Map(),
    collapseTargetRange: null,
    collapseWorkerRunning: false,
    collapsePlan: null
  };

  function init() {
    cleanupLegacyUi();
    ensureMiniMap();
    bindGlobalListeners();
    observeDomChanges();
    observeUrlChanges();
    scheduleSync();
  }

  function cleanupLegacyUi() {
    document.querySelector("[data-slimgpt-controls]")?.remove();
    document.querySelector("[data-slimgpt-minimap]")?.remove();
    document.querySelector("[data-slimgpt-preview]")?.remove();
    if (STATE.minimapDeferredTimer !== 0) {
      clearTimeout(STATE.minimapDeferredTimer);
      STATE.minimapDeferredTimer = 0;
    }
    if (STATE.typingSyncTimer !== 0) {
      clearTimeout(STATE.typingSyncTimer);
      STATE.typingSyncTimer = 0;
    }
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
  }

  function markTypingActivity() {
    STATE.inputFocused = true;
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
      STATE.typingSyncDueAt = 0;
      STATE.nextModelBuildAt = 0;
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

      restoreAllCollapsedMessages();
      scheduleSync();
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
      updateMiniMap();
      return;
    }

    if (STATE.mode === "expanded") {
      restoreAllCollapsedMessages();
      if (STATE.modelDirty) {
        rebuildModel();
      }

      STATE.collapseTargetRange = null;
      updateMiniMap();
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
      const slot = visible === 1 ? 0.5 : index / (visible - 1);
      const topPct = `${slot * 100}%`;
      const isActive = turn === STATE.currentAnchorTurn;

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

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
