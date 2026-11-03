const { app } = require('electron');
const fs = require('fs');
const path = require('path');

/** Zoom steps offered by the DAT window toolbar (same as Chrome). */
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

const zoomFile = () => path.join(app.getPath('userData'), 'dat-zoom.json');

function clampZoom(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], Math.max(ZOOM_STEPS[0], n));
}

/** Saved zoom for DAT pages on this PC (1 = 100%). */
function loadZoom() {
  try {
    return clampZoom(JSON.parse(fs.readFileSync(zoomFile(), 'utf8')).factor);
  } catch {
    return 1;
  }
}

function saveZoom(factor) {
  try {
    fs.writeFileSync(zoomFile(), JSON.stringify({ factor }));
  } catch (err) {
    console.warn('[ZOOM] save failed:', err.message);
  }
}

/** Next zoom step in a direction (+1 in, -1 out) from the current factor. */
function stepZoom(current, direction) {
  const f = clampZoom(current);
  if (direction > 0) return ZOOM_STEPS.find((s) => s > f + 0.001) ?? f;
  return [...ZOOM_STEPS].reverse().find((s) => s < f - 0.001) ?? f;
}

module.exports = { loadZoom, saveZoom, stepZoom, clampZoom };
