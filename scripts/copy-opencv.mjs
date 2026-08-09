import { copyFileSync, mkdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules/@techstark/opencv-js/dist/opencv.js');
const destDir = join(root, 'public/opencv');
const dest = join(destDir, 'opencv.js');

mkdirSync(destDir, { recursive: true });

try {
  const needsCopy =
    !statSync(dest, { throwIfNoEntry: false }) ||
    statSync(src).mtimeMs > statSync(dest).mtimeMs;
  if (needsCopy) {
    copyFileSync(src, dest);
    console.log('OpenCV copied to public/opencv/opencv.js');
  }
} catch (err) {
  console.error('copy-opencv failed:', err.message);
  process.exit(1);
}
