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
  // 2. SMART VOICE LIMITATIONS & FAST PREDICTOR ENGINE (INDIAN ENGLISH TUNED)
  // =========================================================================
  const NUM_WORDS = {
    ZERO: 0, SHERO: 0, SIFAR: 0, NIL: 0, OH: 0, O: 0,
    ONE: 1, WON: 1, WAN: 1, VAN: 1, ON: 1, FIRST: 1, "1ST": 1, SINGLE: 1, EK: 1,
    TWO: 2, TO: 2, TOO: 2, TU: 2, DO: 2, DOO: 2, SECOND: 2, "2ND": 2, DOU: 2,
    THREE: 3, TREE: 3, TRI: 3, FREE: 3, THEE: 3, TEA: 3, THIRD: 3, "3RD": 3, TEEN: 3,
    FOUR: 4, FOR: 4, FORE: 4, POUR: 4, FOURTH: 4, "4TH": 4, CHAAR: 4, CHAR: 4,
    FIVE: 5, FI: 5, FIV: 5, FAIV: 5, FIFTH: 5, "5TH": 5, PIPE: 5, FINE: 5, FIRE: 5, PAANCH: 5, PANCH: 5,
    SIX: 6, SEX: 6, SIKS: 6, SIK: 6, SIXTH: 6, "6TH": 6, FIX: 6, CHE: 6, CHHA: 6,
    SEVEN: 7, SEVAN: 7, SEVN: 7, SEVENTH: 7, "7TH": 7, HEAVEN: 7, SAAT: 7,
    EIGHT: 8, ATE: 8, AIT: 8, EIGHTH: 8, "8TH": 8, HATE: 8, HEIGHT: 8, AATH: 8,
    NINE: 9, NAIN: 9, NINTH: 9, "9TH": 9, LINE: 9, MINE: 9, NIGHT: 9, NAU: 9,
    TEN: 10, TAN: 10, TENTH: 10, "10TH": 10, TIN: 10, DEN: 10, THEN: 10, DAS: 10,
    ELEVEN: 11, ELVEN: 11, ILAVEN: 11, ELEVENTH: 11, "11TH": 11, LEVEL: 11, GYARAH: 11,
    TWELVE: 12, TWELV: 12, TWELF: 12, TWELFTH: 12, "12TH": 12, BARAH: 12,
    THIRTEEN: 13, THIRTEAN: 13, TARTIN: 13, THIRTEENTH: 13, "13TH": 13, TERAH: 13,
    FOURTEEN: 14, FORTEAM: 14, FORTIN: 14, FOURTEENTH: 14, "14TH": 14, CHAUDAH: 14,
    FIFTEEN: 15, FIFTEAN: 15, FIFTIN: 15, FIFTEENTH: 15, "15TH": 15, PANDRAH: 15,
    SIXTEEN: 16, SIXTEAN: 16, SIXTIN: 16, SIXTEENTH: 16, "16TH": 16, SOLAH: 16,
    SEVENTEEN: 17, SEVENTEAN: 17, SEVENTIN: 17, SEVENTEENTH: 17, "17TH": 17, SATRAH: 17,
    EIGHTEEN: 18, EIGHTEAN: 18, EIGHTIN: 18, EIGHTEENTH: 18, "18TH": 18, ATETEEN: 18, ATTHARAH: 18,
    NINETEEN: 19, NINETEAN: 19, NINETIN: 19, NINETEENTH: 19, "19TH": 19, UNNEES: 19,
    TWENTY: 20, TWENTI: 20, TWENTE: 20, TWENTIETH: 20, "20TH": 20, BEES: 20,
    THIRTY: 30, THIRTI: 30, THERTY: 30, THIRTIETH: 30, "30TH": 30, TEES: 30,
    FORTY: 40, FOURTY: 40, FORTI: 40, FORTIETH: 40, "40TH": 40, CHAALEES: 40, CHALIS: 40,
    FIFTY: 50, FIFTI: 50, FIFTIETH: 50, "50TH": 50, PACHAS: 50
  };

  // Populate compound numbers 21-55
  (function () {
    const tens = [
      { p: "TWENTY", v: 20 },
      { p: "THIRTY", v: 30 },
      { p: "FORTY", v: 40 },
      { p: "FOURTY", v: 40 },
      { p: "FIFTY", v: 50 }
    ];
    const ones = [
      { s: "ONE", v: 1 }, { s: "TWO", v: 2 }, { s: "THREE", v: 3 }, { s: "FOUR", v: 4 },
      { s: "FIVE", v: 5 }, { s: "SIX", v: 6 }, { s: "SEVEN", v: 7 }, { s: "EIGHT", v: 8 }, { s: "NINE", v: 9 }
    ];
    tens.forEach(function (t) {
      ones.forEach(function (o) {
        const total = t.v + o.v;
        if (total <= 55) {
          NUM_WORDS[t.p + o.s] = total;
          NUM_WORDS[t.p + "-" + o.s] = total;
        }
      });
    });
  })();

  // Comprehensive letter homophone & Indian English pronunciation dictionary
  const LETTER_MAP_SLOT1 = {
    // A
    A: "A", AY: "A", EH: "A", AE: "A", EI: "A", EY: "A", AA: "A", AI: "A",
    AYE: "A", AYY: "A", YAY: "A", ALPHA: "A", APPLE: "A", HEY: "A", HAY: "A", ACE: "A", ABEL: "A", AN: "A",
    // B
    B: "B", BE: "B", BEE: "B", BEA: "B", BI: "B", BRAVO: "B", BALL: "B", BOY: "B",
    VE: "B", VEE: "B", VI: "B", BHI: "B", PEA: "B", WE: "B",
    // C
    C: "C", SEE: "C", SEA: "C", SI: "C", SE: "C", CE: "C", CEE: "C", CHARLIE: "C",
    CAT: "C", SHE: "C", SAY: "C", SCENE: "C", SEEN: "C", SIGHT: "C",
    // D
    D: "D", DE: "D", DEE: "D", DI: "D", DA: "D", DEY: "D", THE: "D", DELTA: "D",
    DOG: "D", TEA: "D", TI: "D", DAY: "D", THEY: "D", DEED: "D",
    // E
    E: "E", EE: "E", EA: "E", YE: "E", YEE: "E", YI: "E", ECHO: "E", ELEPHANT: "E",
    EGG: "E", HE: "E", EASY: "E",
    // F
    F: "F", EF: "F", EFF: "F", AF: "F", EP: "F", AP: "F", EPH: "F", FOXTROT: "F",
    FISH: "F", FAN: "F", APP: "F", IF: "F", IFF: "F", OFF: "F", HALF: "F", FOX: "F",
    // G
    G: "G", GE: "G", GEE: "G", GI: "G", JI: "G", JEE: "G", JE: "G", GOLF: "G",
    GUN: "G", GIRL: "G", ZEE: "G",
    // H
    H: "H", AITCH: "H", ETCH: "H", HETCH: "H", ACH: "H", ATCH: "H", HOTEL: "H", HEN: "H",
    HUT: "H", EDGE: "H", AGE: "H", EACH: "H", ITCH: "H", ACHE: "H", HATCH: "H",
    // I
    I: "I", AI: "I", AY: "I", EYE: "I", AYE: "I", HYE: "I", INDIA: "I", ICE: "I",
    INK: "I", HIGH: "I", HI: "I"
  };

  const LETTER_MAP_SLOT3 = Object.assign({}, LETTER_MAP_SLOT1, {
    // J
    J: "J", JE: "J", JAY: "J", JAI: "J", JEI: "J", JULIET: "J", JOY: "J", JUG: "J", JACK: "J",
    // K
    K: "K", KE: "K", KAY: "K", CAY: "K", KILO: "K", KING: "K", KITE: "K", OKAY: "K", CARE: "K",
    // L
    L: "L", EL: "L", ELL: "L", AL: "L", ALE: "L", LIMA: "L", LION: "L", OIL: "L", AIL: "L", WELL: "L", HELL: "L"
  });

  const FRONT_REGEX = /^(FRONT|FRONTS|FRONTT|FRNT|FONT|FONTS|FROND|FRONDS|FRO|PRINT|PRINTS|PRNT|PLANT|PLANTS|FLONT|FROUNT|FRAUNT|FRUNT|FRENT|FRIEND|FRIENDS|FRONTED|FRONTLINE|PRONT|PRONTO|POINT|POINTS|FOREFRONT|FRONTSIDE|FRONT-SIDE|TAUNT|RUND|RUN|TRUNK|FRANK|PROMPT|PHRONT)$/i;

  const BACK_REGEX = /^(BACK|BACKS|PACK|PACKS|BAG|BAGS|BAK|BECK|BACKED|BLACK|BAKED|BAKE|BANK|BANKS|BAT|BATS|BAD|PEK|PAC|BAC|BACC|BAKK|BACKSIDE|BACK-SIDE|BAX|BEG|BEGS|BEGG|BOOK|BOOKS|BIKE|BIKES|PAG|BEAK|BARK|BARKS|BUCK|BUCKS|BUG|BUGS)$/i;

  // Fused words and common speech-to-text contractions
  const FUSED_WORDS = {
    BEFORE: ["B", "4"],
    B4: ["B", "4"],
    ANYONE: ["E", "1"],
    EVERYONE: ["E", "1"],
    DEFINE: ["D", "5"],
    DETAIL: ["D", "12"],
    A1: ["A", "1"], A2: ["A", "2"], A3: ["A", "3"], A4: ["A", "4"], A5: ["A", "5"],
    B1: ["B", "1"], B2: ["B", "2"], B3: ["B", "3"], B5: ["B", "5"],
    C1: ["C", "1"], C2: ["C", "2"], C3: ["C", "3"], C4: ["C", "4"], C5: ["C", "5"],
    D1: ["D", "1"], D2: ["D", "2"], D3: ["D", "3"], D4: ["D", "4"], D5: ["D", "5"],
    E1: ["E", "1"], E2: ["E", "2"], E3: ["E", "3"], E4: ["E", "4"], E5: ["E", "5"],
    F1: ["F", "1"], F2: ["F", "2"], F3: ["F", "3"], F4: ["F", "4"], F5: ["F", "5"],
    G1: ["G", "1"], G2: ["G", "2"], G3: ["G", "3"], G4: ["G", "4"], G5: ["G", "5"],
    H1: ["H", "1"], H2: ["H", "2"], H3: ["H", "3"], H4: ["H", "4"], H5: ["H", "5"],
    I1: ["I", "1"], I2: ["I", "2"], I3: ["I", "3"], I4: ["I", "4"], I5: ["I", "5"],
    J1: ["J", "1"], J2: ["J", "2"], J3: ["J", "3"],
    K1: ["K", "1"], K2: ["K", "2"], K3: ["K", "3"],
    L1: ["L", "1"], L2: ["L", "2"], L3: ["L", "3"],
    SEEONE: ["C", "1"], SEETWO: ["C", "2"], SEETHREE: ["C", "3"], SEEFOUR: ["C", "4"], SEEFIVE: ["C", "5"],
    DEEONE: ["D", "1"], DEETWO: ["D", "2"], DEETHREE: ["D", "3"], DEEFOUR: ["D", "4"], DEEFIVE: ["D", "5"],
    EFFONE: ["F", "1"], EFFTWO: ["F", "2"], EFFTHREE: ["F", "3"], EFFFOUR: ["F", "4"], EFFFIVE: ["F", "5"]
  };

  const FILLER_WORDS_REGEX = /\b(DASH|HYPHEN|MINUS|NUMBER|NO|DIGIT|LETTER|CODE|SLOT|PLEASE)\b/gi;

  function parseNumber(tok) {
    if (!tok) return null;
    if (/^\d+$/.test(tok)) return parseInt(tok, 10);
    const u = tok.toUpperCase();
    return NUM_WORDS[u] !== undefined ? NUM_WORDS[u] : null;
  }

  function parseTokens(raw) {
    if (!raw) return [];
    const separated = raw
      .replace(FILLER_WORDS_REGEX, " ")
      .replace(/([a-zA-Z]+)(\d+)/g, "$1 $2")
      .replace(/(\d+)([a-zA-Z]+)/g, "$1 $2")
      .replace(/[^a-zA-Z0-9]+/g, " ")
      .trim();
    if (!separated) return [];
    const initial = separated.split(/\s+/).map(function (t) {
      return t.toUpperCase();
    });

    // Expand fused words
    const expanded = [];
    for (let i = 0; i < initial.length; i++) {
      const tok = initial[i];
      if (FUSED_WORDS[tok]) {
        for (let j = 0; j < FUSED_WORDS[tok].length; j++) {
          expanded.push(FUSED_WORDS[tok][j]);
        }
      } else {
        expanded.push(tok);
      }
    }

    // Combine compound numbers (e.g. 20 1, TWENTY ONE, TWENTY 5, 30 2, etc.)
    const tokens = [];
    for (let i = 0; i < expanded.length; i++) {
      const cur = expanded[i];
      const next = expanded[i + 1];

      let tensVal = null;
      if (cur === "TWENTY" || cur === "TWENTI" || cur === "20") tensVal = 20;
      else if (cur === "THIRTY" || cur === "THIRTI" || cur === "30") tensVal = 30;
      else if (cur === "FORTY" || cur === "FOURTY" || cur === "FORTI" || cur === "40") tensVal = 40;
      else if (cur === "FIFTY" || cur === "FIFTI" || cur === "50") tensVal = 50;

      if (tensVal !== null && next !== undefined) {
        let unitVal = parseNumber(next);
        if (unitVal !== null && unitVal >= 1 && unitVal <= 9 && tensVal + unitVal <= 55) {
          tokens.push(String(tensVal + unitVal));
          i++;
          continue;
        }
      }

      tokens.push(cur);
    }
    return tokens;
  }

  function formatVoiceCommandWithLimitations(formatCode, rawCommand) {
    const cleanPrefix = (formatCode || "MRTN")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9-]/g, "") || "MRTN";

    const rawTokens = parseTokens(rawCommand);
    if (rawTokens.length === 0) return { text: cleanPrefix, isValid: false, score: 0 };

    // 1. Strip Prefix if present
    let tokens = rawTokens.slice();

    // Check if initial tokens concatenate to cleanPrefix (e.g. ['MR', 'TN'] -> 'MRTN', or ['M', 'R', 'T', 'N'] -> 'MRTN')
    let prefixStripped = false;
    for (let len = Math.min(tokens.length, cleanPrefix.length); len >= 1; len--) {
      const combined = tokens.slice(0, len).join("");
      if (combined === cleanPrefix) {
        tokens = tokens.slice(len);
        prefixStripped = true;
        break;
      }
    }

    if (!prefixStripped && tokens.length > 0) {
      const first = tokens[0];
      if (
        cleanPrefix === "MRTN" &&
        /^(MARTIN|MARTEN|MARTIAN|MERTEN|MODERN|MORTEN|MARTAN)$/.test(first)
      ) {
        tokens = tokens.slice(1);
      }
    }

    // 2. Extract Slot 5 (FRONT / BACK) from ANYWHERE in the phrase
    let slot5 = null;
    const filteredTokens = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (!slot5 && FRONT_REGEX.test(t)) {
        slot5 = "FRONT";
      } else if (!slot5 && BACK_REGEX.test(t)) {
        slot5 = "BACK";
      } else {
        filteredTokens.push(t);
      }
    }

    let slot1 = null;
    let slot2 = null;
    let slot3 = null;
    let slot4 = null;

    let idx = 0;

    // 3. Slot 1: Must be A-I
    if (idx < filteredTokens.length) {
      const t = filteredTokens[idx];
      const letter =
        LETTER_MAP_SLOT1[t] ||
        (t.length === 1 && t >= "A" && t <= "I" ? t : null);
      if (letter && letter >= "A" && letter <= "I") {
        slot1 = letter;
        idx++;
      }
    }

    // 4. Slot 2: Must be 1-55
    if (idx < filteredTokens.length) {
      const t1 = filteredTokens[idx];
      const n1 = parseNumber(t1);

      // Check if next two tokens are individual digits forming 10-55 (e.g. "two five" -> 25)
      if (idx + 1 < filteredTokens.length) {
        const t2 = filteredTokens[idx + 1];
        const n2 = parseNumber(t2);
        if (n1 !== null && n2 !== null && n1 >= 1 && n1 <= 5 && n2 >= 0 && n2 <= 9) {
          const combined = n1 * 10 + n2;
          if (combined <= 55) {
            slot2 = combined;
            idx += 2;
          }
        }
      }

      if (slot2 === null && n1 !== null && n1 >= 1 && n1 <= 55) {
        slot2 = n1;
        idx++;
      }
    }

    // 5. Slot 3 (optional): A-L
    if (idx < filteredTokens.length) {
      const t = filteredTokens[idx];
      const letter =
        LETTER_MAP_SLOT3[t] ||
        (t.length === 1 && t >= "A" && t <= "L" ? t : null);
      if (letter && letter >= "A" && letter <= "L") {
        slot3 = letter;
        idx++;
      }
    }

    // 6. Slot 4 (optional, only if slot3 exists): 1-7
    if (slot3 !== null && idx < filteredTokens.length) {
      const num = parseNumber(filteredTokens[idx]);
      if (num !== null && num >= 1 && num <= 7) {
        slot4 = num;
        idx++;
      }
    }

    // Calculate matching score and validity
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

      const unconsumedTokens = filteredTokens.length - idx;
      const score =
        1000 +
        (slot3 ? 100 : 0) +
        (slot4 ? 50 : 0) +
        (slot5 ? 50 : 0) -
        unconsumedTokens * 30;
      return { text: parts.join("-"), isValid: true, score: score };
    }

    // Fallback if pattern is invalid
    const fallbackParts = [cleanPrefix];
    filteredTokens.forEach(function (t) {
      if (LETTER_MAP_SLOT1[t]) fallbackParts.push(LETTER_MAP_SLOT1[t]);
      else {
        const n = parseNumber(t);
        fallbackParts.push(n !== null ? String(n) : t);
      }
    });
    if (slot5) fallbackParts.push(slot5);

    return { text: fallbackParts.join("-"), isValid: false, score: 0 };
  }

  // =========================================================================
  // 3. APP STATE & ELEMENT REFERENCES
  // =========================================================================
  const STORAGE_KEY_LANG = "voice_qr_speech_lang";

  let state = {
    formatCode: "MRTN",
    lastCommand: "E 1 F 2 front",
    formattedPayload: "MRTN-E-1-F-2-FRONT",
    sourceMode: "voice", // "voice" | "raw"
    formatRulesEnabled: true,
    speechLang: (function () {
      try {
        return localStorage.getItem(STORAGE_KEY_LANG) || "en-IN";
      } catch (e) {
        return "en-IN";
      }
    })(),
    isListening: false,
    isEditing: false,
    isScanning: false,
    themeMode: "auto"
  };

  const mobileShell = document.querySelector(".mobile-shell");
  const topFormatBox = document.getElementById("topFormatBox");
  const topFormatInput = document.getElementById("topFormatInput");
  const langToggleBtn = document.getElementById("langToggleBtn");
  const langIconHolder = document.getElementById("langIconHolder");
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
  // 9. SPEECH LANGUAGE & FORMAT RULES TOGGLE
  // =========================================================================
  function updateLanguageUI() {
    if (!langToggleBtn || !langIconHolder) return;
    const isIndian = state.speechLang === "en-IN";
    langIconHolder.textContent = isIndian ? "IN" : "US";
    langToggleBtn.title = isIndian
      ? "Speech Language: English (India) [en-IN] / Tap for US"
      : "Speech Language: English (US) [en-US] / Tap for India";
    langToggleBtn.setAttribute(
      "aria-label",
      isIndian
        ? "Current speech language English (India). Click to toggle to English (US)."
        : "Current speech language English (US). Click to toggle to English (India)."
    );
  }

  if (langToggleBtn) {
    langToggleBtn.addEventListener("click", function () {
      abortListeningIfActive();
      state.speechLang = state.speechLang === "en-IN" ? "en-US" : "en-IN";
      try {
        localStorage.setItem(STORAGE_KEY_LANG, state.speechLang);
      } catch (e) {}
      updateLanguageUI();
      showToast(
        state.speechLang === "en-IN"
          ? "Speech Engine: English (India) - en-IN"
          : "Speech Engine: English (US) - en-US"
      );
    });
  }

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

    // Hardware initialization: continuous=false, interimResults=false, maxAlternatives=10
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 10;
    recognition.lang = state.speechLang || "en-IN";

    const SpeechGrammarList =
      window.SpeechGrammarList || window.webkitSpeechGrammarList || null;
    if (SpeechGrammarList && state.formatRulesEnabled) {
      try {
        const grammarList = new SpeechGrammarList();
        const grammarRules =
          "#JSGF V1.0; grammar qrCode; public <qr> = [MRTN | martin] (A | B | C | D | E | F | G | H | I) (1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30 | 31 | 32 | 33 | 34 | 35 | 36 | 37 | 38 | 39 | 40 | 41 | 42 | 43 | 44 | 45 | 46 | 47 | 48 | 49 | 50 | 51 | 52 | 53 | 54 | 55) [A | B | C | D | E | F | G | H | I | J | K | L] [1 | 2 | 3 | 4 | 5 | 6 | 7] [FRONT | BACK];";
        grammarList.addFromString(grammarRules, 1);
        recognition.grammars = grammarList;
      } catch (e) {}
    }

    recognition.onresult = function (event) {
      let selectedTranscript = "";
      let bestParsed = null;
      let bestScore = -Infinity;

      if (event.results && event.results.length > 0 && event.results[0]) {
        const alts = event.results[0];

        if (!state.formatRulesEnabled) {
          // Exact speech mode: take primary verbatim transcript
          selectedTranscript =
            alts[0] && alts[0].transcript ? alts[0].transcript.trim() : "";
          bestParsed = { text: selectedTranscript, isValid: true, score: 100 };
        } else {
          // Smart format rules mode: rank all alternatives and select best match
          for (let i = 0; i < alts.length; i++) {
            const alt = alts[i];
            const trans = (alt.transcript || "").trim();
            if (!trans) continue;

            const parsed = formatVoiceCommandWithLimitations(
              state.formatCode,
              trans
            );
            let score = parsed.score;
            if (parsed.isValid) {
              score += 500 + (alt.confidence || 0.5) * 50;
            } else {
              score += (alt.confidence || 0.5) * 10;
            }

            if (score > bestScore) {
              bestScore = score;
              bestParsed = parsed;
              selectedTranscript = trans;
            }
          }
        }
      }

      if (!bestParsed && selectedTranscript) {
        bestParsed = formatVoiceCommandWithLimitations(
          state.formatCode,
          selectedTranscript
        );
      }

      // Immediately execute recognition.stop() to close audio tracks instantly
      try {
        recognition.stop();
      } catch (e) {}

      state.isListening = false;

      if (bestParsed && selectedTranscript) {
        state.sourceMode = "voice";
        state.lastCommand = selectedTranscript;

        const isPatternValid = bestParsed.isValid;
        state.formattedPayload = bestParsed.text;

        if (state.formatRulesEnabled) {
          spokenTranscriptDisplay.textContent =
            'Voice command: "' + selectedTranscript + '"';
        } else {
          spokenTranscriptDisplay.textContent =
            'Exact speech: "' + selectedTranscript + '"';
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
  updateLanguageUI();
  updateFormatRuleUI();
  initHistory();
  updateQRFromState();
  updateVoiceUI("idle");
})();
