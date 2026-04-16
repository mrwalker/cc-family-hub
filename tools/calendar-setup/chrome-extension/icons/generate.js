#!/usr/bin/env node
/**
 * Generates PNG icons for the Chrome extension using the Canvas API.
 * Run once after cloning: node tools/calendar-setup/chrome-extension/icons/generate.js
 *
 * Requires Node 18+ (built-in canvas not available — uses a small dependency).
 * If canvas isn't available, just use any 16x16, 48x48, 128x128 PNG files.
 */

import { createCanvas } from "canvas";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function drawIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  const r = size / 2;

  // Background circle
  ctx.fillStyle = "#1a73e8";
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.fill();

  // Simple calendar grid icon
  ctx.fillStyle = "white";
  const pad = size * 0.22;
  const w = size - pad * 2;
  const h = size - pad * 2;

  // Calendar body
  ctx.fillRect(pad, pad + h * 0.18, w, h * 0.72);

  // Header bar
  ctx.fillStyle = "#1557b0";
  ctx.fillRect(pad, pad + h * 0.18, w, h * 0.22);

  // Calendar header text area (white stripe)
  ctx.fillStyle = "white";
  ctx.fillRect(pad + 1, pad + h * 0.18 + 1, w - 2, h * 0.2);

  // Dots for calendar grid
  ctx.fillStyle = "#1a73e8";
  const dotR = Math.max(1, size * 0.05);
  const cols = 3, rows = 2;
  const cellW = w / (cols + 1);
  const cellH = (h * 0.5) / (rows + 0.5);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      ctx.beginPath();
      ctx.arc(
        pad + cellW * (col + 1),
        pad + h * 0.22 + h * 0.22 + cellH * (row + 0.8),
        dotR, 0, Math.PI * 2
      );
      ctx.fill();
    }
  }

  return canvas.toBuffer("image/png");
}

try {
  for (const size of [16, 48, 128]) {
    const buf = drawIcon(size);
    writeFileSync(join(__dirname, `icon${size}.png`), buf);
    console.log(`  wrote icon${size}.png`);
  }
  console.log("Icons generated.");
} catch (err) {
  console.error("Could not generate icons (canvas module not available).");
  console.error("Add any 16x16, 48x48, 128x128 PNG files as icon16.png, icon48.png, icon128.png");
  console.error(err.message);
}
