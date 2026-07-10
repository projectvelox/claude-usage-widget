// Icon drawing primitives + style variants. Shared by main.js (runtime tray)
// and scripts/build-icon.js (pre-baked assets). Pure Node, no canvas dep.
const zlib = require('zlib');

const ACCENT = [0x38, 0xAE, 0xEB, 0xFF];
const WHITE = [0xFF, 0xFF, 0xFF, 0xFF];
const DARK = [0x18, 0x1B, 0x20, 0xFF];

function crc32(buf) {
  if (!crc32.t) {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    crc32.t = t;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = crc32.t[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, pixels) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const filtered = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const dst = y * (1 + width * 4);
    filtered[dst] = 0;
    pixels.copy(filtered, dst + 1, y * width * 4, (y + 1) * width * 4);
  }
  const compressed = zlib.deflateSync(filtered);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
}

function makeCanvas(w, h) { return { w, h, buf: Buffer.alloc(w * h * 4) }; }

function set(canvas, x, y, rgba) {
  if (x < 0 || y < 0 || x >= canvas.w || y >= canvas.h) return;
  const i = (y * canvas.w + x) * 4;
  const sa = rgba[3] / 255;
  const da = canvas.buf[i + 3] / 255;
  const outA = sa + da * (1 - sa);
  if (outA === 0) { canvas.buf[i + 3] = 0; return; }
  for (let k = 0; k < 3; k++) {
    canvas.buf[i + k] = Math.round((rgba[k] * sa + canvas.buf[i + k] * da * (1 - sa)) / outA);
  }
  canvas.buf[i + 3] = Math.round(outA * 255);
}

function insideRounded(x, y, w, h, r) {
  if (x < 0 || x > w || y < 0 || y > h) return false;
  const cx = (x < r) ? r : (x > w - r ? w - r : x);
  const cy = (y < r) ? r : (y > h - r ? h - r : y);
  const dx = x - cx, dy = y - cy;
  return (dx * dx + dy * dy) <= r * r;
}

function fillRoundedRect(canvas, x, y, w, h, r, rgba) {
  const SS = 4;
  for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
    let hits = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      if (insideRounded(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS, w, h, r)) hits++;
    }
    if (!hits) continue;
    set(canvas, x + px, y + py, [rgba[0], rgba[1], rgba[2], Math.round(rgba[3] * hits / (SS * SS))]);
  }
}

function fillRoundedBar(c, x, y, w, h, rgba) { fillRoundedRect(c, x, y, w, h, h / 2, rgba); }

function strokeArc(canvas, cx, cy, rOuter, rInner, startDeg, endDeg, rgba) {
  // Supersampled annular sector
  const SS = 4;
  const start = startDeg * Math.PI / 180;
  const end = endDeg * Math.PI / 180;
  const inR2 = rInner * rInner;
  const outR2 = rOuter * rOuter;
  const minX = Math.max(0, Math.floor(cx - rOuter - 1));
  const maxX = Math.min(canvas.w, Math.ceil(cx + rOuter + 1));
  const minY = Math.max(0, Math.floor(cy - rOuter - 1));
  const maxY = Math.min(canvas.h, Math.ceil(cy + rOuter + 1));
  for (let py = minY; py < maxY; py++) for (let px = minX; px < maxX; px++) {
    let hits = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const fx = px + (sx + 0.5) / SS - cx;
      const fy = py + (sy + 0.5) / SS - cy;
      const d2 = fx * fx + fy * fy;
      if (d2 < inR2 || d2 > outR2) continue;
      let ang = Math.atan2(fy, fx);
      // Normalize so 0 is "top" and angles grow clockwise
      ang = ang + Math.PI / 2;
      if (ang < 0) ang += 2 * Math.PI;
      if (ang >= start && ang <= end) hits++;
    }
    if (!hits) continue;
    set(canvas, px, py, [rgba[0], rgba[1], rgba[2], Math.round(rgba[3] * hits / (SS * SS))]);
  }
}

function severityColor(pct, cfg) {
  if (pct >= cfg.critical) return hexToRgba(cfg.criticalColor);
  if (pct >= cfg.warn) return hexToRgba(cfg.warnColor);
  return hexToRgba(cfg.okColor);
}

function hexToRgba(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 255];
}

// --- Styles ---

function drawBars(size, opts = {}) {
  const c = makeCanvas(size, size);
  const pad = Math.max(1, Math.round(size * 0.0625));
  const radius = Math.round(size * 0.22);
  const accent = opts.accent ? hexToRgba(opts.accent) : ACCENT;
  fillRoundedRect(c, pad, pad, size - pad * 2, size - pad * 2, radius, accent);
  const barH = Math.max(2, Math.round(size * 0.09));
  const barX = Math.round(size * 0.22);
  const innerW = size - Math.round(size * 0.22) - barX;
  const gapY = Math.round(size * 0.06);
  const totalH = barH * 3 + gapY * 2;
  const startY = Math.round((size - totalH) / 2);
  [1.0, 0.72, 0.5].forEach((w, i) => {
    fillRoundedBar(c, barX, startY + i * (barH + gapY), Math.round(innerW * w), barH, WHITE);
  });
  return c;
}

function drawBattery(size, opts = {}) {
  const c = makeCanvas(size, size);
  const accent = opts.accent ? hexToRgba(opts.accent) : ACCENT;
  const pct = Math.max(0, Math.min(1, (opts.pct ?? 0) / 100));
  const fill = opts.severity || accent;
  // Outline pill
  const w = Math.round(size * 0.78);
  const h = Math.round(size * 0.42);
  const x = Math.round((size - w) / 2) - 1;
  const y = Math.round((size - h) / 2);
  const r = Math.round(h / 2);
  // Outer border via two rounded rects
  fillRoundedRect(c, x, y, w, h, r, [accent[0], accent[1], accent[2], 255]);
  const inset = Math.max(2, Math.round(size * 0.06));
  fillRoundedRect(c, x + inset, y + inset, w - inset * 2, h - inset * 2, r - inset, [0, 0, 0, 0]);
  // Erase the inner by overlaying transparent — actually need to clear; use dark fill instead
  const innerW = w - inset * 2;
  const innerH = h - inset * 2;
  const innerX = x + inset;
  const innerY = y + inset;
  // Clear with dark for contrast
  fillRoundedRect(c, innerX, innerY, innerW, innerH, Math.max(0, r - inset), DARK);
  // Fill
  const fillW = Math.max(0, Math.round(innerW * pct));
  if (fillW > 0) fillRoundedRect(c, innerX, innerY, fillW, innerH, Math.max(0, r - inset), fill);
  // Terminal nub
  const nubW = Math.round(size * 0.06);
  const nubH = Math.round(h * 0.5);
  fillRoundedRect(c, x + w, y + Math.round((h - nubH) / 2), nubW, nubH, 1, accent);
  return c;
}

function drawGauge(size, opts = {}) {
  const c = makeCanvas(size, size);
  const accent = opts.accent ? hexToRgba(opts.accent) : ACCENT;
  const pct = Math.max(0, Math.min(100, opts.pct ?? 0));
  const cx = size / 2, cy = size / 2;
  const rOuter = size * 0.42;
  const rInner = size * 0.32;
  // Track (faint)
  const trackColor = [accent[0], accent[1], accent[2], 70];
  strokeArc(c, cx, cy, rOuter, rInner, 0, 360, trackColor);
  // Filled arc
  const fill = opts.severity || accent;
  strokeArc(c, cx, cy, rOuter, rInner, 0, (pct / 100) * 360, fill);
  // Center dot
  fillRoundedRect(c, Math.round(cx - size * 0.06), Math.round(cy - size * 0.06), Math.round(size * 0.12), Math.round(size * 0.12), Math.round(size * 0.06), accent);
  return c;
}

function drawMinimal(size, opts = {}) {
  const c = makeCanvas(size, size);
  const fill = opts.severity || (opts.accent ? hexToRgba(opts.accent) : ACCENT);
  const r = Math.round(size * 0.32);
  fillRoundedRect(c, Math.round(size / 2 - r), Math.round(size / 2 - r), r * 2, r * 2, r, fill);
  return c;
}

// 5-column × 7-row bitmap font. Rows are top-to-bottom; each row is a bit
// mask with the leftmost column at bit 4 and the rightmost at bit 0.
// Covers digits 0–9 and %, which is all the tray text style needs.
const FONT_5X7 = {
  '0': [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  '1': [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  '2': [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  '3': [0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110],
  '4': [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  '5': [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  '6': [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  '7': [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  '8': [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  '9': [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
  '%': [0b11001, 0b11010, 0b00100, 0b00100, 0b00100, 0b01011, 0b10011],
};
const GLYPH_W = 5, GLYPH_H = 7;

function drawGlyph(canvas, glyph, x, y, scale, color) {
  const rows = FONT_5X7[glyph];
  if (!rows) return;
  for (let ry = 0; ry < GLYPH_H; ry++) {
    for (let cx = 0; cx < GLYPH_W; cx++) {
      if (!(rows[ry] & (1 << (GLYPH_W - 1 - cx)))) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          set(canvas, x + cx * scale + dx, y + ry * scale + dy, color);
        }
      }
    }
  }
}

function drawText(size, opts = {}) {
  const c = makeCanvas(size, size);
  // Clamp to 0–100 but display 100 without a "%" so the string still fits
  // three characters even at "MAX" — otherwise "100%" would overflow.
  const raw = Math.max(0, Math.min(100, Math.round(opts.pct ?? 0)));
  const text = raw >= 100 ? '100' : `${raw}%`;
  const color = opts.severity || (opts.accent ? hexToRgba(opts.accent) : ACCENT);
  // Pick the biggest scale that still fits horizontally with a 1-scale gap
  // between glyphs. At 32px this lands on scale=2 (glyphs 10 wide + 2 gap =
  // 32 for 3 chars). At 64px it lands on scale=4.
  const gapUnits = 1;
  const chars = text.length;
  const maxScale = Math.max(1, Math.floor((size - 2) / (chars * GLYPH_W + (chars - 1) * gapUnits)));
  const scale = maxScale;
  const gap = gapUnits * scale;
  const totalW = chars * GLYPH_W * scale + (chars - 1) * gap;
  const totalH = GLYPH_H * scale;
  const startX = Math.round((size - totalW) / 2);
  const startY = Math.round((size - totalH) / 2);
  for (let i = 0; i < chars; i++) {
    drawGlyph(c, text[i], startX + i * (GLYPH_W * scale + gap), startY, scale, color);
  }
  return c;
}

const STYLES = {
  bars: drawBars,
  battery: drawBattery,
  gauge: drawGauge,
  minimal: drawMinimal,
  text: drawText,
};

function draw(style, size, opts = {}) {
  const fn = STYLES[style] || drawBars;
  return fn(size, opts);
}

function drawDynamic(size, usage, cfg) {
  // "dynamic" picks a sensible representation from the live data:
  // gauge of the most-utilized limit, colored by its severity.
  const accent = cfg.accentColor || '#38AEEB';
  if (!usage || !Array.isArray(usage.limits) || usage.limits.length === 0) {
    return drawBars(size, { accent });
  }
  const worst = usage.limits.reduce((a, b) => (a.utilization > b.utilization ? a : b));
  const severity = severityColor(worst.utilization, {
    warn: cfg.thresholds.warn,
    critical: cfg.thresholds.critical,
    okColor: cfg.colors.ok,
    warnColor: cfg.colors.warn,
    criticalColor: cfg.colors.critical,
  });
  return drawGauge(size, { accent, pct: worst.utilization, severity });
}

module.exports = {
  encodePNG,
  draw,
  drawDynamic,
  drawText,
  STYLES: Object.keys(STYLES),
};
