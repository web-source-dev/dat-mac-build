const fs = require('fs');
const path = require('path');

const dirs = [
  { src: 'main', dest: 'out/main' },
  { src: 'preload', dest: 'out/preload' }
];

function copyDir(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const file of fs.readdirSync(src)) {
    const from = path.join(src, file);
    const to = path.join(dest, file);
    if (fs.statSync(from).isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

for (const { src, dest } of dirs) {
  const from = path.resolve(__dirname, '..', src);
  const to = path.resolve(__dirname, '..', dest);
  if (fs.existsSync(from)) {
    console.log(`Copying ${src} -> ${dest}`);
    copyDir(from, to);
  }
}

// Keep static renderer assets next to Vite output without wiping it
const rendererSrcDir = path.resolve(__dirname, '../renderer');
const rendererDestDir = path.resolve(__dirname, '../out/renderer');
if (!fs.existsSync(rendererDestDir)) fs.mkdirSync(rendererDestDir, { recursive: true });
for (const file of ['tab-bar.html', 'dat-error.html']) {
  const from = path.join(rendererSrcDir, file);
  const to = path.join(rendererDestDir, file);
  if (fs.existsSync(from)) {
    fs.copyFileSync(from, to);
    console.log(`Copied renderer/${file} -> out/renderer/${file}`);
  } else {
    console.warn(`Warning: renderer/${file} not found`);
  }
}

console.log('Main/preload/renderer assets build complete');
