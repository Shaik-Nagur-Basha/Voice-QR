(function () {
  "use strict";

  // =========================================================================
  // 1. FAST ZERO-ALLOCATION OFFLINE ISO/IEC 18004 QR CODE ENGINE
  // =========================================================================
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  let gfX = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = gfX;
    LOG[gfX] = i;
    gfX <<= 1;
    if (gfX & 0x100) gfX ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

  const gfMul = function (a, b) {
    return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
  };

  const QR_VERSIONS = [
    null,
    { v: 1, data: 19, ec: 7, align: [] },
    { v: 2, data: 34, ec: 10, align: [6, 18] },
    { v: 3, data: 55, ec: 15, align: [6, 22] },
    { v: 4, data: 80, ec: 20, align: [6, 26] },
    { v: 5, data: 108, ec: 26, align: [6, 30] }
  ];

  const RS_GEN = {};
  [7, 10, 15, 20, 26].forEach(function (deg) {
    let gen = [1];
    for (let i = 0; i < deg; i++) {
      const next = new Array(gen.length + 1).fill(0);
      for (let j = 0; j < gen.length; j++) {
        next[j] ^= gen[j];
        next[j + 1] ^= gfMul(gen[j], EXP[i]);
      }
      gen = next;
    }
    RS_GEN[deg] = gen;
  });

  function generateQRMatrix(text) {
    const utf8 = Array.from(new TextEncoder().encode(text || "MRTN"));
    let ver = QR_VERSIONS[5];
    for (let i = 1; i <= 5; i++) {
      if (utf8.length + 2 <= QR_VERSIONS[i].data) {
        ver = QR_VERSIONS[i];
        break;
      }
    }
    const V = ver.v;
    const size = 17 + V * 4;

    const bits = [];
    const pushBits = function (val, len) {
      for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
    };
    pushBits(0b0100, 4);
    const safeBytes = utf8.slice(0, ver.data - 2);
    pushBits(safeBytes.length, 8);
    for (let i = 0; i < safeBytes.length; i++) pushBits(safeBytes[i], 8);

    const maxBits = ver.data * 8;
    pushBits(0, Math.min(4, maxBits - bits.length));
    while (bits.length % 8 !== 0) bits.push(0);
    const padBytes = [0xec, 0x11];
    let padIdx = 0;
    while (bits.length < maxBits) {
      pushBits(padBytes[padIdx % 2], 8);
      padIdx++;
    }

    const dataWords = new Array(ver.data);
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      dataWords[i >> 3] = b;
    }

    const gen = RS_GEN[ver.ec];
    const msg = dataWords.concat(new Array(ver.ec).fill(0));
    for (let i = 0; i < dataWords.length; i++) {
      const coef = msg[i];
      if (coef !== 0) {
        for (let j = 0; j < gen.length; j++) {
          msg[i + j] ^= gfMul(gen[j], coef);
        }
      }
    }

    const ecWords = msg.slice(dataWords.length);
    const allWords = dataWords.concat(ecWords);
    const allBits = [];
    for (let i = 0; i < allWords.length; i++) {
      for (let b = 7; b >= 0; b--) allBits.push((allWords[i] >> b) & 1);
    }

    const mat = Array.from({ length: size }, function () {
      return new Uint8Array(size);
    });
    const isFunc = Array.from({ length: size }, function () {
      return new Uint8Array(size);
    });

    const setFunc = function (r, c, val) {
      if (r >= 0 && r < size && c >= 0 && c < size) {
        mat[r][c] = val ? 1 : 0;
        isFunc[r][c] = 1;
      }
    };

    const drawFinder = function (r0, c0) {
      for (let dr = -1; dr <= 7; dr++) {
        for (let dc = -1; dc <= 7; dc++) {
          const inside = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
          const border = dr === 0 || dr === 6 || dc === 0 || dc === 6;
          const center = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
          setFunc(r0 + dr, c0 + dc, inside && (border || center));
        }
      }
    };
    drawFinder(0, 0);
    drawFinder(0, size - 7);
    drawFinder(size - 7, 0);

    for (let i = 8; i < size - 8; i++) {
      setFunc(6, i, i % 2 === 0);
      setFunc(i, 6, i % 2 === 0);
    }

    const ac = ver.align;
    for (let ri = 0; ri < ac.length; ri++) {
      for (let ci = 0; ci < ac.length; ci++) {
        const r = ac[ri];
        const c = ac[ci];
        if (
          (r === 6 && c === 6) ||
          (r === 6 && c === size - 7) ||
          (r === size - 7 && c === 6)
        )
          continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const v = Math.max(Math.abs(dr), Math.abs(dc));
            setFunc(r + dr, c + dc, v !== 1);
          }
        }
      }
    }

    for (let i = 0; i < 9; i++) {
      if (!isFunc[8][i]) setFunc(8, i, false);
      if (!isFunc[i][8]) setFunc(i, 8, false);
    }
    for (let i = 0; i < 8; i++) {
      if (!isFunc[8][size - 1 - i]) setFunc(8, size - 1 - i, false);
      if (!isFunc[size - 1 - i][8]) setFunc(size - 1 - i, 8, false);
    }
    setFunc(size - 8, 8, true);

    let bitIdx = 0;
    let up = true;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        const r = up ? size - 1 - vert : vert;
        for (let j = 0; j < 2; j++) {
          const c = right - j;
          if (!isFunc[r][c]) {
            const bit = bitIdx < allBits.length ? allBits[bitIdx++] : 0;
            mat[r][c] = bit ^ ((r + c) % 2 === 0 ? 1 : 0);
          }
        }
      }
      up = !up;
    }

    const fmt = 0x77c4;
    for (let i = 0; i <= 5; i++) setFunc(8, i, (fmt >> (14 - i)) & 1);
    setFunc(8, 7, (fmt >> 8) & 1);
    setFunc(8, 8, (fmt >> 7) & 1);
    setFunc(7, 8, (fmt >> 6) & 1);
    for (let i = 9; i < 15; i++) setFunc(14 - i, 8, (fmt >> (14 - i)) & 1);

    for (let i = 0; i < 8; i++) setFunc(8, size - 1 - i, (fmt >> i) & 1);
    for (let i = 8; i < 15; i++) setFunc(size - 15 + i, 8, (fmt >> i) & 1);

    return mat;
  }

  let lastRenderedPayload = "";
  function renderQRToCanvas(canvas, text) {
    if (text === lastRenderedPayload) return;
    lastRenderedPayload = text;

    const mat = generateQRMatrix(text);
    const quietZone = 2;
    const totalModules = mat.length + quietZone * 2;
    const sizePx = 280;
    canvas.width = sizePx;
    canvas.height = sizePx;
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, sizePx, sizePx);

    const scale = sizePx / totalModules;
    ctx.fillStyle = "#000000";
    for (let r = 0; r < mat.length; r++) {
      for (let c = 0; c < mat.length; c++) {
        if (mat[r][c]) {
          const x = Math.floor((c + quietZone) * scale);
          const y = Math.floor((r + quietZone) * scale);
          const w = Math.ceil((c + quietZone + 1) * scale) - x;
          const h = Math.ceil((r + quietZone + 1) * scale) - y;
          ctx.fillRect(x, y, w, h);
        }
      }
    }
  }

  // =========================================================================
  // 2. SMART VOICE LIMITATIONS & FAST PREDICTOR ENGINE
  // =========================================================================
  const NUM_WORDS = {
    ZERO: 0, ONE: 1, WON: 1, TWO: 2, TO: 2, TOO: 2,
    THREE: 3, TREE: 3, FOUR: 4, FOR: 4, FORE: 4,
    FIVE: 5, SIX: 6, SEVEN: 7, EIGHT: 8, ATE: 8,
    NINE: 9, TEN: 10, ELEVEN: 11, TWELVE: 12,
    THIRTEEN: 13, FOURTEEN: 14, FIFTEEN: 15, SIXTEEN: 16,
    SEVENTEEN: 17, EIGHTEEN: 18, NINETEEN: 19,
    TWENTY: 20, THIRTY: 30, FORTY: 40, FIFTY: 50
  };

  const LETTER_MAP = {
    A: "A", AY: "A", ALPHA: "A", EH: "A",
    B: "B", BE: "B", BEE: "B", BRAVO: "B",
    C: "C", SEE: "C", SEA: "C", SI: "C", CHARLIE: "C", CE: "C",
    D: "D", DEE: "D", THE: "D", DELTA: "D",
    E: "E", EE: "E", ECHO: "E",
    F: "F", EF: "F", EFF: "F", FOXTROT: "F",
    G: "G", GEE: "G", JI: "G", GOLF: "G",
    H: "H", AITCH: "H", HOTEL: "H",
    I: "I", EYE: "I", AYE: "I", INDIA: "I",
    J: "J", JAY: "J", JULIET: "J",
    K: "K", KAY: "K", KILO: "K",
    L: "L", EL: "L", ELL: "L", LIMA: "L"
  };

  function parseNumber(tok) {
    if (/^\d+$/.test(tok)) return parseInt(tok, 10);
    const u = tok.toUpperCase();
    return NUM_WORDS[u] !== undefined ? NUM_WORDS[u] : null;
  }

  function parseTokens(raw) {
    if (!raw) return [];
    const separated = raw
      .replace(/([a-zA-Z]+)(\d+)/g, "$1 $2")
      .replace(/(\d+)([a-zA-Z]+)/g, "$1 $2")
      .replace(/[^a-zA-Z0-9]+/g, " ")
      .trim();
    if (!separated) return [];
    const rawTokens = separated.split(/\s+/).map(function (t) {
      return t.toUpperCase();
    });

    const tokens = [];
    for (let i = 0; i < rawTokens.length; i++) {
      const cur = rawTokens[i];
      const next = rawTokens[i + 1];
      if (
        (cur === "TWENTY" || cur === "THIRTY" || cur === "FORTY" || cur === "FIFTY") &&
        next &&
        NUM_WORDS[next] &&
        NUM_WORDS[next] < 10
      ) {
        tokens.push(String(NUM_WORDS[cur] + NUM_WORDS[next]));
        i++;
      } else {
        tokens.push(cur);
      }
    }
    return tokens;
  }

  function formatVoiceCommandWithLimitations(formatCode, rawCommand) {
    const cleanPrefix = (formatCode || "MRTN")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9-]/g, "") || "MRTN";

    const tokens = parseTokens(rawCommand);
    if (tokens.length === 0) return { text: cleanPrefix, isValid: false };

    let startIdx = 0;
    if (tokens[0] === cleanPrefix) startIdx = 1;
    const remaining = tokens.slice(startIdx);
    if (remaining.length === 0) return { text: cleanPrefix, isValid: false };

    let slot1 = null;
    let slot2 = null;
    let slot3 = null;
    let slot4 = null;
    let slot5 = null;

    let idx = 0;

    // Slot 1: A-I
    if (idx < remaining.length) {
      const t = remaining[idx];
      const letter = LETTER_MAP[t] || (t.length === 1 && t >= "A" && t <= "I" ? t : null);
      if (letter && letter >= "A" && letter <= "I") {
        slot1 = letter;
        idx++;
      }
    }

    // Slot 2: 1-55
    if (idx < remaining.length) {
      const num = parseNumber(remaining[idx]);
      if (num !== null && num >= 1 && num <= 55) {
        slot2 = num;
        idx++;
      }
    }

    // Slot 5: FRONT / BACK
    for (let j = idx; j < remaining.length; j++) {
      const t = remaining[j];
      if (/^(FRONT|PRINT|FRNT|FONT|FROND|FRO|FRONTS)$/.test(t)) {
        slot5 = "FRONT";
        remaining.splice(j, 1);
        break;
      } else if (/^(BACK|PACK|BAG|BAK|BECK|BACKED|BLACK)$/.test(t)) {
        slot5 = "BACK";
        remaining.splice(j, 1);
        break;
      }
    }

    // Slot 3 (optional): A-L
    if (idx < remaining.length) {
      const t = remaining[idx];
      const letter = LETTER_MAP[t] || (t.length === 1 && t >= "A" && t <= "L" ? t : null);
      if (letter && letter >= "A" && letter <= "L") {
        slot3 = letter;
        idx++;
      }
    }

    // Slot 4 (optional): 1-7
    if (idx < remaining.length) {
      const num = parseNumber(remaining[idx]);
      if (num !== null && num >= 1 && num <= 7) {
        slot4 = num;
        idx++;
      }
    }

    if (slot1 !== null && slot2 !== null) {
      const parts = [cleanPrefix, slot1, slot2];
      if (slot3 !== null && slot4 !== null) {
        parts.push(slot3, slot4);
      } else if (slot3 !== null) {
        parts.push(slot3);
      }
      if (slot5 !== null) {
        parts.push(slot5);
      }
      return { text: parts.join("-"), isValid: true };
    }

    const fallbackTokens = remaining.map(function (t) {
      if (/^(FRONT|PRINT|FRNT|FONT|FROND|FRO|FRONTS)$/.test(t)) return "FRONT";
      if (/^(BACK|PACK|BAG|BAK|BECK|BACKED|BLACK)$/.test(t)) return "BACK";
      if (LETTER_MAP[t]) return LETTER_MAP[t];
      const n = parseNumber(t);
      return n !== null ? String(n) : t;
    });
    return { text: cleanPrefix + "-" + fallbackTokens.join("-"), isValid: false };
  }

  // =========================================================================
  // 3. APP STATE & ELEMENT REFERENCES
  // =========================================================================
  let state = {
    formatCode: "MRTN",
    lastCommand: "E 1 F 2 front",
    formattedPayload: "MRTN-E-1-F-2-FRONT",
    sourceMode: "voice", // "voice" | "raw"
    formatRulesEnabled: true,
    isListening: false,
    isEditing: false,
    isScanning: false,
    themeMode: "auto"
  };

  const mobileShell = document.querySelector(".mobile-shell");
  const topFormatBox = document.getElementById("topFormatBox");
  const topFormatInput = document.getElementById("topFormatInput");
  const themeToggleBtn = document.getElementById("themeToggleBtn");
  const themeIconHolder = document.getElementById("themeIconHolder");
  const formatModeToggleBtn = document.getElementById("formatModeToggleBtn");
  const ruleIconHolder = document.getElementById("ruleIconHolder");
  const scannerBtn = document.getElementById("scannerBtn");

  const statusBadge = document.getElementById("statusBadge");
  const statusText = document.getElementById("statusText");
  const qrCanvas = document.getElementById("qrCanvas");

  const prevCodeBtn = document.getElementById("prevCodeBtn");
  const nextCodeBtn = document.getElementById("nextCodeBtn");
  const codeBoxWrapper = document.getElementById("codeBoxWrapper");
  const formattedCodeDisplay = document.getElementById("formattedCodeDisplay");
  const liveEditInput = document.getElementById("liveEditInput");
  const copyCodeBtn = document.getElementById("copyCodeBtn");
  const spokenTranscriptDisplay = document.getElementById("spokenTranscriptDisplay");
  const historyIndicator = document.getElementById("historyIndicator");

  const micWrapper = document.getElementById("micWrapper");
  const voiceToggleBtn = document.getElementById("voiceToggleBtn");
  const voiceHint = document.getElementById("voiceHint");

  const scannerModal = document.getElementById("scannerModal");
  const scannerVideo = document.getElementById("scannerVideo");
  const barcodeWedgeInput = document.getElementById("barcodeWedgeInput");
  const applyScannedTextBtn = document.getElementById("applyScannedTextBtn");
  const closeScannerModalBtn = document.getElementById("closeScannerModalBtn");
  const toastMsg = document.getElementById("toastMsg");

  // Premium Pixel-Perfect Vector Icons
  const ICONS = {
    sun: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="4.5" stroke="currentColor" stroke-width="2"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>',
    rulesOn: '<svg viewBox="0 0 24 24" fill="none"><line x1="4" y1="21" x2="4" y2="14" stroke="currentColor" stroke-width="2" stroke-linecap="round"></line><line x1="4" y1="10" x2="4" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round"></line><line x1="12" y1="21" x2="12" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"></line><line x1="12" y1="8" x2="12" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round"></line><line x1="20" y1="21" x2="20" y2="16" stroke="currentColor" stroke-width="2" stroke-linecap="round"></line><line x1="20" y1="12" x2="20" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round"></line><line x1="1" y1="14" x2="7" y2="14" stroke="currentColor" stroke-width="2" stroke-linecap="round"></line><line x1="9" y1="8" x2="15" y2="8" stroke="currentColor" stroke-width="2" stroke-linecap="round"></line><line x1="17" y1="16" x2="23" y2="16" stroke="currentColor" stroke-width="2" stroke-linecap="round"></line></svg>',
    rulesOff: '<svg viewBox="0 0 24 24" fill="none"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.75-2-2-2H4c-1.25 0-2 .75-2 2v6c0 1.25.75 2 2 2 0 4-1.5 6-3 6M15 21c3 0 7-1 7-8V5c0-1.25-.75-2-2-2h-4c-1.25 0-2 .75-2 2v6c0 1.25.75 2 2 2 0 4-1.5 6-3 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none"><rect width="13" height="13" x="8.5" y="8.5" rx="2.5" stroke="currentColor" stroke-width="2"></rect><path d="M5 15.5H4a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></path></svg>'
  };

  let toastTimer = null;
  function showToast(text) {
    toastMsg.textContent = text;
    toastMsg.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastMsg.classList.remove("show");
    }, 1800);
  }

  // =========================================================================
  // 4. MOBILE VIEWPORT & KEYBOARD SENSING FOR DYNAMIC QR RESIZE
  // =========================================================================
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", function () {
      const isKeyboardOpen = window.visualViewport.height < window.innerHeight * 0.75;
      document.body.classList.toggle("keyboard-open", isKeyboardOpen);
    });
  }

  // =========================================================================
  // 5. LOCAL STORAGE HISTORY PERSISTENCE (Max 5 Prev, Present 1, Max 5 Fwd = Total 11)
  // =========================================================================
  const STORAGE_KEY_HISTORY = "voice_qr_history_codes";
  const STORAGE_KEY_INDEX = "voice_qr_history_idx";

  let historyList = [];
  let historyIndex = 0;
  let voicePersistTimer = null;

  function updateHistoryUI() {
    const hasPrev = historyIndex > 0;
    const hasNext = historyIndex < historyList.length - 1;

    prevCodeBtn.style.display = hasPrev ? "inline-flex" : "none";
    prevCodeBtn.disabled = !hasPrev;

    nextCodeBtn.style.display = hasNext ? "inline-flex" : "none";
    nextCodeBtn.disabled = !hasNext;

    if (historyIndicator) {
      historyIndicator.textContent = historyList.length > 0
        ? (historyIndex + 1) + " / " + historyList.length
        : "1 / 1";
    }
  }

  function saveHistoryState() {
    try {
      localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(historyList));
      localStorage.setItem(STORAGE_KEY_INDEX, String(historyIndex));
    } catch (e) {}
    updateHistoryUI();
  }

  function commitCodeToHistory(newCode) {
    if (!newCode || typeof newCode !== "string") return;
    newCode = newCode.trim();
    if (!newCode) return;

    // If identical to current active code, do not add duplicate
    if (historyList.length > 0 && historyList[historyIndex] === newCode) {
      return;
    }

    // When new code is added, drop any forward codes ahead of current position
    if (historyIndex < historyList.length - 1) {
      historyList = historyList.slice(0, historyIndex + 1);
    }

    historyList.push(newCode);
    historyIndex = historyList.length - 1;

    // Maintain bounds: previous up to 5
    if (historyIndex > 5) {
      const trimCount = historyIndex - 5;
      historyList = historyList.slice(trimCount);
      historyIndex = 5;
    }

    // Maintain bounds: total up to 11
    if (historyList.length > 11) {
      historyList = historyList.slice(historyList.length - 11);
      historyIndex = historyList.length - 1;
    }

    saveHistoryState();
  }

  // Voice code persist: Only saved after minimum wait of 2.5s after command
  function scheduleVoiceCodePersist(code) {
    if (voicePersistTimer) {
      clearTimeout(voicePersistTimer);
      voicePersistTimer = null;
    }
    voicePersistTimer = setTimeout(function () {
      commitCodeToHistory(code);
      voicePersistTimer = null;
    }, 2500);
  }

  function initHistory() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_HISTORY);
      const rawIdx = localStorage.getItem(STORAGE_KEY_INDEX);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          historyList = parsed.slice(0, 11);
          let idx = parseInt(rawIdx, 10);
          if (isNaN(idx) || idx < 0 || idx >= historyList.length) {
            idx = historyList.length - 1;
          }
          historyIndex = idx;
          state.formattedPayload = historyList[historyIndex];
        }
      }
    } catch (e) {}

    if (historyList.length === 0) {
      historyList = [state.formattedPayload || "MRTN-E-1-F-2-FRONT"];
      historyIndex = 0;
      saveHistoryState();
    }
    updateHistoryUI();
  }

  // History navigation: Previous (Only appears when previous items exist)
  prevCodeBtn.addEventListener("click", function () {
    abortListeningIfActive();
    setEditMode(false);
    if (historyIndex > 0) {
      historyIndex--;
      const code = historyList[historyIndex];
      state.sourceMode = "raw";
      state.formattedPayload = code;
      formattedCodeDisplay.textContent = code;
      liveEditInput.value = code;
      spokenTranscriptDisplay.textContent = 'History code: "' + code + '"';
      renderQRToCanvas(qrCanvas, code);
      saveHistoryState();
    }
  });

  // History navigation: Forward (Only appears when forward items exist)
  nextCodeBtn.addEventListener("click", function () {
    abortListeningIfActive();
    setEditMode(false);
    if (historyIndex < historyList.length - 1) {
      historyIndex++;
      const code = historyList[historyIndex];
      state.sourceMode = "raw";
      state.formattedPayload = code;
      formattedCodeDisplay.textContent = code;
      liveEditInput.value = code;
      spokenTranscriptDisplay.textContent = 'History code: "' + code + '"';
      renderQRToCanvas(qrCanvas, code);
      saveHistoryState();
    }
  });

  // =========================================================================
  // 6. COPY ACTIVE CODE TO CLIPBOARD
  // =========================================================================
  function copyActiveCode() {
    const textToCopy = state.formattedPayload || formattedCodeDisplay.textContent || "";
    if (!textToCopy) return;

    function onCopied() {
      showToast("Copied: " + textToCopy);
      copyCodeBtn.innerHTML = ICONS.check;
      setTimeout(function () {
        copyCodeBtn.innerHTML = ICONS.copy;
      }, 1200);
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(textToCopy).then(onCopied).catch(function () {
        fallbackCopy(textToCopy, onCopied);
      });
    } else {
      fallbackCopy(textToCopy, onCopied);
    }
  }

  function fallbackCopy(text, cb) {
    try {
      const temp = document.createElement("textarea");
      temp.value = text;
      temp.style.position = "fixed";
      temp.style.left = "-9999px";
      document.body.appendChild(temp);
      temp.select();
      document.execCommand("copy");
      document.body.removeChild(temp);
      if (cb) cb();
    } catch (err) {
      showToast("Failed to copy");
    }
  }

  copyCodeBtn.addEventListener("click", copyActiveCode);

  // =========================================================================
  // 7. CLICK-ANYWHERE TO EDIT (START AT CLICK POSITION, AUTO-ADJUST QR SIZE)
  // =========================================================================
  function getCaretOffsetFromClick(e, elem) {
    let offset = (elem.textContent || "").length;
    if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (range && range.startContainer) {
        offset = range.startOffset;
      }
    } else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
      if (pos) {
        offset = pos.offset;
      }
    }
    return offset;
  }

  function setEditMode(enabled, caretOffset) {
    state.isEditing = enabled;
    if (mobileShell) {
      mobileShell.classList.toggle("editing", enabled);
    }

    if (enabled) {
      abortListeningIfActive();
      codeBoxWrapper.classList.add("editing");
      formattedCodeDisplay.classList.add("hidden");
      liveEditInput.classList.remove("hidden");
      liveEditInput.value = state.formattedPayload;
      liveEditInput.focus();

      const textLen = liveEditInput.value.length;
      const pos = (typeof caretOffset === "number")
        ? Math.max(0, Math.min(caretOffset, textLen))
        : textLen;

      try {
        liveEditInput.setSelectionRange(pos, pos);
      } catch (e) {}

      spokenTranscriptDisplay.textContent = "Editing code... (Enter to save)";
    } else {
      codeBoxWrapper.classList.remove("editing");
      liveEditInput.classList.add("hidden");
      formattedCodeDisplay.classList.remove("hidden");
    }
  }

  codeBoxWrapper.addEventListener("click", function (e) {
    if (state.isEditing) return;
    const offset = getCaretOffsetFromClick(e, formattedCodeDisplay);
    setEditMode(true, offset);
  });

  liveEditInput.addEventListener("input", function () {
    const rawText = liveEditInput.value.trim();
    state.sourceMode = "raw";
    state.formattedPayload = rawText || "MRTN";
    formattedCodeDisplay.textContent = state.formattedPayload;
    renderQRToCanvas(qrCanvas, state.formattedPayload);
  });

  liveEditInput.addEventListener("blur", function () {
    if (state.isEditing) {
      setEditMode(false);
      commitCodeToHistory(state.formattedPayload);
      showToast("Saved: " + state.formattedPayload);
    }
  });

  liveEditInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      setEditMode(false);
      commitCodeToHistory(state.formattedPayload);
      showToast("Saved: " + state.formattedPayload);
    } else if (e.key === "Escape") {
      liveEditInput.value = state.formattedPayload;
      setEditMode(false);
    }
  });

  // =========================================================================
  // 8. DEVICE AUTO DARK/LIGHT THEME
  // =========================================================================
  const systemDarkQuery = window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : { matches: false, addEventListener: null };

  function isCurrentlyDark() {
    if (state.themeMode === "dark") return true;
    if (state.themeMode === "light") return false;
    return !!systemDarkQuery.matches;
  }

  function applyTheme() {
    const effectiveDark = isCurrentlyDark();
    document.documentElement.setAttribute(
      "data-theme",
      effectiveDark ? "dark" : "light"
    );
    themeIconHolder.innerHTML = effectiveDark ? ICONS.sun : ICONS.moon;
  }

  if (systemDarkQuery.addEventListener) {
    systemDarkQuery.addEventListener("change", function () {
      if (state.themeMode === "auto") applyTheme();
    });
  }

  themeToggleBtn.addEventListener("click", function () {
    const nextDark = !isCurrentlyDark();
    state.themeMode = nextDark ? "dark" : "light";
    applyTheme();
    showToast(nextDark ? "Dark Mode" : "Light Mode");
  });

  // =========================================================================
  // 9. FORMAT RULES TOGGLE (Default: ON / Off: Exact Verbatim Voice Command)
  // =========================================================================
  function updateFormatRuleUI() {
    if (state.formatRulesEnabled) {
      formatModeToggleBtn.classList.add("active-rule");
      formatModeToggleBtn.classList.remove("inactive-rule");
      formatModeToggleBtn.title = "Format Rules Mode (ON: MRTN Rules / Tap for Exact Speech)";
      ruleIconHolder.innerHTML = ICONS.rulesOn;
      topFormatBox.classList.remove("disabled");
    } else {
      formatModeToggleBtn.classList.remove("active-rule");
      formatModeToggleBtn.classList.add("inactive-rule");
      formatModeToggleBtn.title = "Exact Speech Mode (OFF: Raw Voice / Tap for MRTN Rules)";
      ruleIconHolder.innerHTML = ICONS.rulesOff;
      topFormatBox.classList.add("disabled");
    }
  }

  formatModeToggleBtn.addEventListener("click", function () {
    abortListeningIfActive();
    state.formatRulesEnabled = !state.formatRulesEnabled;
    updateFormatRuleUI();
    if (state.formatRulesEnabled) {
      showToast("Format Rules Mode ON (MRTN format applied)");
    } else {
      showToast("Exact Voice Mode ON (Raw speech, no rules)");
    }
    if (state.sourceMode === "voice") {
      updateQRFromState();
    }
    if (!state.isListening) {
      updateVoiceUI("idle");
    }
  });

  // =========================================================================
  // 10. QR CODE RENDERING & FORMAT SYNCHRONIZATION
  // =========================================================================
  function updateQRFromState() {
    if (state.sourceMode === "voice") {
      if (state.formatRulesEnabled) {
        const res = formatVoiceCommandWithLimitations(
          state.formatCode,
          state.lastCommand
        );
        state.formattedPayload = res.text;
        spokenTranscriptDisplay.textContent = state.lastCommand
          ? 'Last command: "' + state.lastCommand + '"'
          : "Waiting for voice command...";
      } else {
        state.formattedPayload = (state.lastCommand || "").trim() || "hi, how are you";
        spokenTranscriptDisplay.textContent = state.lastCommand
          ? 'Exact speech: "' + state.lastCommand + '"'
          : "Waiting for exact voice command...";
      }
    }
    formattedCodeDisplay.textContent = state.formattedPayload;
    if (!state.isEditing) {
      liveEditInput.value = state.formattedPayload;
    }
    renderQRToCanvas(qrCanvas, state.formattedPayload);
  }

  topFormatInput.addEventListener("focus", abortListeningIfActive);

  topFormatInput.addEventListener("input", function () {
    abortListeningIfActive();
    const cleaned = topFormatInput.value
      .toUpperCase()
      .replace(/[^A-Z0-9-]/g, "");
    topFormatInput.value = cleaned;
    state.formatCode = cleaned || "MRTN";
    if (state.sourceMode === "voice" && state.formatRulesEnabled) {
      updateQRFromState();
    }
    if (!state.isListening) {
      updateVoiceUI("idle");
    }
  });

  topFormatInput.addEventListener("blur", function () {
    if (!topFormatInput.value.trim()) {
      state.formatCode = "MRTN";
      topFormatInput.value = "MRTN";
      if (state.sourceMode === "voice" && state.formatRulesEnabled) {
        updateQRFromState();
      }
    }
  });

  // =========================================================================
  // 11. SCANNER ENGINE
  // =========================================================================
  let cameraStream = null;
  let scanTimerId = null;
  let barcodeDetector = null;

  if ("BarcodeDetector" in window) {
    try {
      barcodeDetector = new window.BarcodeDetector({
        formats: [
          "qr_code",
          "code_128",
          "code_39",
          "code_93",
          "ean_13",
          "ean_8",
          "upc_a",
          "upc_e",
          "itf",
          "codabar",
          "data_matrix",
          "pdf417",
          "aztec"
        ]
      });
    } catch (e) {
      try {
        barcodeDetector = new window.BarcodeDetector();
      } catch (err) {
        barcodeDetector = null;
      }
    }
  }

  function handleScannedCode(rawScannedValue) {
    const cleanVal = (rawScannedValue || "").trim();
    if (!cleanVal) return;
    stopScanner();
    setEditMode(false);
    state.sourceMode = "raw";
    state.formattedPayload = cleanVal;
    formattedCodeDisplay.textContent = cleanVal;
    liveEditInput.value = cleanVal;
    spokenTranscriptDisplay.textContent = 'Scanned code: "' + cleanVal + '"';
    statusBadge.className = "status-badge ready";
    statusText.textContent = "READY";
    renderQRToCanvas(qrCanvas, cleanVal);
    commitCodeToHistory(cleanVal);
    showToast("Scanned: " + cleanVal);
  }

  function stopScanner() {
    state.isScanning = false;
    scannerBtn.classList.remove("active-tool");
    if (scanTimerId) {
      clearTimeout(scanTimerId);
      scanTimerId = null;
    }
    if (cameraStream) {
      cameraStream.getTracks().forEach(function (track) {
        track.stop();
      });
      cameraStream = null;
    }
    scannerVideo.srcObject = null;
    scannerModal.classList.add("hidden");
  }

  function runScanCycle() {
    if (!state.isScanning) return;
    if (
      barcodeDetector &&
      scannerVideo.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA
    ) {
      barcodeDetector
        .detect(scannerVideo)
        .then(function (codes) {
          if (codes && codes.length > 0 && codes[0].rawValue) {
            handleScannedCode(codes[0].rawValue);
            return;
          }
          if (state.isScanning) {
            scanTimerId = setTimeout(runScanCycle, 110);
          }
        })
        .catch(function () {
          if (state.isScanning) {
            scanTimerId = setTimeout(runScanCycle, 110);
          }
        });
    } else if (state.isScanning) {
      scanTimerId = setTimeout(runScanCycle, 110);
    }
  }

  function startScanner() {
    abortListeningIfActive();
    setEditMode(false);
    state.isScanning = true;
    scannerBtn.classList.add("active-tool");
    barcodeWedgeInput.value = "";
    scannerModal.classList.remove("hidden");
    setTimeout(function () {
      barcodeWedgeInput.focus();
    }, 50);

    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices
        .getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false
        })
        .then(function (stream) {
          if (!state.isScanning) {
            stream.getTracks().forEach(function (t) {
              t.stop();
            });
            return;
          }
          cameraStream = stream;
          scannerVideo.srcObject = stream;
          scannerVideo.play().catch(function () {});
          scanTimerId = setTimeout(runScanCycle, 110);
        })
        .catch(function () {
          showToast("Use scanner input box or enable camera");
        });
    }
  }

  scannerBtn.addEventListener("click", function () {
    if (state.isScanning) {
      stopScanner();
    } else {
      startScanner();
    }
  });

  closeScannerModalBtn.addEventListener("click", function () {
    stopScanner();
  });

  applyScannedTextBtn.addEventListener("click", function () {
    if (barcodeWedgeInput.value.trim()) {
      handleScannedCode(barcodeWedgeInput.value.trim());
    }
  });

  barcodeWedgeInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && barcodeWedgeInput.value.trim()) {
      handleScannedCode(barcodeWedgeInput.value.trim());
    }
  });

  // =========================================================================
  // 12. TACTILE VOICE RECEIVER STATE MACHINE & HARDWARE LIFECYCLE
  // =========================================================================
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition || null;
  let recognition = null;
  let uiResetTimer = null;

  function updateVoiceUI(mode) {
    if (uiResetTimer) {
      clearTimeout(uiResetTimer);
      uiResetTimer = null;
    }

    if (mode === "listening") {
      micWrapper.classList.add("listening");
      voiceToggleBtn.classList.add("active");
      voiceToggleBtn.title = "Listening... Tap to Cancel";
      voiceHint.textContent = "LISTENING... SPEAK NOW";
      statusBadge.className = "status-badge listening";
      statusText.textContent = "LISTENING...";
    } else if (mode === "transcribed") {
      micWrapper.classList.remove("listening");
      voiceToggleBtn.classList.remove("active");
      voiceToggleBtn.title = "Tap to Speak";
      statusBadge.className = "status-badge ready";
      statusText.textContent = "TRANSCRIBED";
      voiceHint.textContent = state.formatRulesEnabled
        ? "FORMAT: " + state.formatCode + "-[A-I]-[1-55]"
        : "VERBATIM SPEECH ACTIVE";

      uiResetTimer = setTimeout(function () {
        if (!state.isListening) {
          updateVoiceUI("idle");
        }
      }, 3500);
    } else if (mode === "mismatch") {
      micWrapper.classList.remove("listening");
      voiceToggleBtn.classList.remove("active");
      voiceToggleBtn.title = "Tap to Speak";
      statusBadge.className = "status-badge mismatch";
      statusText.textContent = "PATTERN MISMATCH";
      voiceHint.textContent = "EXPECTED: " + state.formatCode + " [A-I] [1-55]";

      uiResetTimer = setTimeout(function () {
        if (!state.isListening) {
          updateVoiceUI("idle");
        }
      }, 3500);
    } else {
      // Default: Idle State
      micWrapper.classList.remove("listening");
      voiceToggleBtn.classList.remove("active");
      voiceToggleBtn.title = "Tap to Speak";
      statusBadge.className = "status-badge ready";
      statusText.textContent = "READY";
      voiceHint.textContent = state.formatRulesEnabled
        ? "TAP TO SPEAK"
        : "TAP TO SPEAK (EXACT)";
    }
  }

  function abortListeningIfActive() {
    if (state.isListening) {
      if (recognition) {
        try {
          recognition.abort();
        } catch (e) {}
      }
      state.isListening = false;
      updateVoiceUI("idle");
    }
  }

  function startListening() {
    if (!SpeechRecognition) {
      showToast("Speech Recognition supported on Chrome / Android");
      return;
    }

    if (!recognition) {
      recognition = new SpeechRecognition();
    }

    // Hardware initialization: continuous=false, interimResults=false, maxAlternatives=1
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.lang = "en-US";

    recognition.onresult = function (event) {
      let transcript = "";
      if (
        event.results &&
        event.results.length > 0 &&
        event.results[0] &&
        event.results[0][0]
      ) {
        transcript = event.results[0][0].transcript.trim();
      }

      // Immediately execute recognition.stop() to close audio tracks instantly
      try {
        recognition.stop();
      } catch (e) {}

      state.isListening = false;

      if (transcript) {
        state.sourceMode = "voice";
        state.lastCommand = transcript;

        let isPatternValid = true;
        if (state.formatRulesEnabled) {
          const parseResult = formatVoiceCommandWithLimitations(
            state.formatCode,
            transcript
          );
          state.formattedPayload = parseResult.text;
          isPatternValid = parseResult.isValid;
          spokenTranscriptDisplay.textContent = 'Voice command: "' + transcript + '"';
        } else {
          state.formattedPayload = transcript;
          spokenTranscriptDisplay.textContent = 'Exact speech: "' + transcript + '"';
        }

        formattedCodeDisplay.textContent = state.formattedPayload;
        liveEditInput.value = state.formattedPayload;
        renderQRToCanvas(qrCanvas, state.formattedPayload);

        // Persist after minimum wait 2.5s after voice command
        scheduleVoiceCodePersist(state.formattedPayload);

        if (state.formatRulesEnabled && !isPatternValid) {
          updateVoiceUI("mismatch");
          showToast("Mismatch: " + state.formattedPayload);
        } else {
          updateVoiceUI("transcribed");
          showToast("Generated: " + state.formattedPayload);
        }
      } else {
        updateVoiceUI("idle");
      }
    };

    recognition.onerror = function (event) {
      state.isListening = false;
      updateVoiceUI("idle");
      if (
        event.error === "not-allowed" ||
        event.error === "service-not-allowed"
      ) {
        showToast("Microphone permission required");
      } else if (event.error !== "aborted" && event.error !== "no-speech") {
        showToast("Voice error: " + event.error);
      }
    };

    recognition.onend = function () {
      if (state.isListening) {
        state.isListening = false;
        updateVoiceUI("idle");
      }
    };

    state.isListening = true;
    updateVoiceUI("listening");

    try {
      recognition.start();
    } catch (err) {
      state.isListening = false;
      updateVoiceUI("idle");
    }
  }

  voiceToggleBtn.addEventListener("click", function () {
    if (state.isListening) {
      // Early Termination / Cancellation: immediately call recognition.abort()
      if (recognition) {
        try {
          recognition.abort();
        } catch (e) {}
      }
      state.isListening = false;
      updateVoiceUI("idle");
      showToast("Listening cancelled");
    } else {
      setEditMode(false);
      startListening();
    }
  });

  // Initialize App on Load
  applyTheme();
  updateFormatRuleUI();
  initHistory();
  updateQRFromState();
  updateVoiceUI("idle");
})();
