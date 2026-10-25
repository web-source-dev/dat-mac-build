/**
 * Generate Dat Desk app icons from the branded source assets.
 * Source: public/datdesk-icon.png (app mark) + public/datdesk-logo.png (wordmark)
 * Outputs: resources/* sizes, icon.ico, and syncs public/ generic + leftover names.
 *
 * Usage: node scripts/generate-icons.js
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RESOURCES = path.join(ROOT, 'resources');
const PUBLIC = path.join(ROOT, 'public');
const ASSETS = path.join(ROOT, 'assets');

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

function findIconSource() {
  const candidates = [
    path.join(PUBLIC, 'datdesk-icon.png'),
    path.join(RESOURCES, 'datdesk-icon.png'),
    path.join(ASSETS, 'datdesk-icon.png')
  ];
  for (const file of candidates) {
    if (fs.existsSync(file) && fs.statSync(file).size > 50_000) return file;
  }
  throw new Error('No Dat Desk icon source found (expected public/datdesk-icon.png)');
}

function findLogoSource() {
  const candidates = [
    path.join(PUBLIC, 'datdesk-logo.png'),
    path.join(RESOURCES, 'datdesk-logo.png'),
    path.join(ASSETS, 'datdesk-logo.png')
  ];
  for (const file of candidates) {
    if (fs.existsSync(file) && fs.statSync(file).size > 50_000) return file;
  }
  return null;
}

function resizeWithPowerShell(source, size, dest) {
  const ps = `
Add-Type -AssemblyName System.Drawing
$srcPath = '${source.replace(/'/g, "''")}'
$destPath = '${dest.replace(/'/g, "''")}'
$size = ${size}
$src = [System.Drawing.Image]::FromFile($srcPath)
try {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.DrawImage($src, 0, 0, $size, $size)
  $g.Dispose()
  $dir = Split-Path $destPath
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
  $bmp.Save($destPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
} finally {
  $src.Dispose()
}
`;
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(
      `Failed to resize to ${size}x${size}: ${result.stderr || result.stdout || 'unknown error'}`
    );
  }
  if (!fs.existsSync(dest)) {
    throw new Error(`Resize claimed success but file missing: ${dest}`);
  }
}

/** Build a multi-size .ico that embeds PNG frames (Vista+ / electron-builder compatible). */
function writeIcoFromPngs(pngPaths, outPath) {
  const images = pngPaths.map((p) => fs.readFileSync(p));
  const count = images.length;
  const headerSize = 6;
  const entrySize = 16;
  const dataOffset = headerSize + entrySize * count;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const entries = [];
  let offset = dataOffset;
  for (let i = 0; i < count; i++) {
    const png = images[i];
    const match = path.basename(pngPaths[i]).match(/(\d+)\.png$/i);
    const size = match ? parseInt(match[1], 10) : SIZES[i] || 256;
    const entry = Buffer.alloc(entrySize);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }

  fs.writeFileSync(outPath, Buffer.concat([header, ...entries, ...images]));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function main() {
  const iconSource = findIconSource();
  const logoSource = findLogoSource();
  console.log('[icons] Icon source:', iconSource);
  if (logoSource) console.log('[icons] Logo source:', logoSource);

  ensureDir(RESOURCES);
  ensureDir(PUBLIC);

  // Keep full-res branded masters in resources + public
  fs.copyFileSync(iconSource, path.join(PUBLIC, 'datdesk-icon.png'));
  fs.copyFileSync(iconSource, path.join(RESOURCES, 'datdesk-icon.png'));
  if (logoSource) {
    fs.copyFileSync(logoSource, path.join(PUBLIC, 'datdesk-logo.png'));
    fs.copyFileSync(logoSource, path.join(RESOURCES, 'datdesk-logo.png'));
  }

  const sized = {};
  for (const size of SIZES) {
    const dest = path.join(RESOURCES, `icon${size}.png`);
    resizeWithPowerShell(iconSource, size, dest);
    sized[size] = dest;
    console.log(`[icons] Wrote ${path.basename(dest)} (${size}x${size})`);
  }

  // Primary build icon (electron-builder requires >= 256)
  fs.copyFileSync(sized[512], path.join(RESOURCES, 'icon.png'));
  console.log('[icons] Wrote resources/icon.png (512x512)');

  // Public generic names + remove Horizon leftovers by overwriting with Dat Desk
  fs.copyFileSync(sized[512], path.join(PUBLIC, 'icon.png'));
  fs.copyFileSync(sized[512], path.join(PUBLIC, 'horizon-icon.png'));
  if (logoSource) {
    fs.copyFileSync(logoSource, path.join(PUBLIC, 'logo.png'));
    fs.copyFileSync(logoSource, path.join(PUBLIC, 'horizon-logo.png'));
    fs.copyFileSync(logoSource, path.join(RESOURCES, 'horizon-logo.png'));
  } else {
    fs.copyFileSync(sized[512], path.join(PUBLIC, 'logo.png'));
    fs.copyFileSync(sized[512], path.join(PUBLIC, 'horizon-logo.png'));
  }
  fs.copyFileSync(sized[512], path.join(RESOURCES, 'horizon-icon.png'));

  if (fs.existsSync(ASSETS)) {
    fs.copyFileSync(sized[512], path.join(ASSETS, 'datdesk-icon.png'));
    fs.copyFileSync(sized[512], path.join(ASSETS, 'icon.png'));
    if (logoSource) fs.copyFileSync(logoSource, path.join(ASSETS, 'datdesk-logo.png'));
  }

  const icoSources = [16, 24, 32, 48, 64, 128, 256, 512].map((s) => sized[s]);
  const icoPath = path.join(RESOURCES, 'icon.ico');
  writeIcoFromPngs(icoSources, icoPath);
  fs.copyFileSync(icoPath, path.join(RESOURCES, 'logo.ico'));
  fs.copyFileSync(icoPath, path.join(PUBLIC, 'icon.ico'));
  console.log('[icons] Wrote icon.ico + logo.ico');

  console.log('[icons] Done. All Dat Desk icons synced for electron-builder.');
}

main();
