// Copies the self-hosted face-detection runtime and models from node_modules into web/public/mediapipe/.
// Everything is served from our own origin: no photo and no request ever goes to a third party.
// Run automatically before `dev` and `build` (see web/package.json). The copied files are git-ignored.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkgJson = require.resolve('@mediapipe/face_detection/package.json');
const src = dirname(pkgJson);
const dest = join(here, '..', 'public', 'mediapipe', 'face_detection');

const FILES = [
  'face_detection.js',
  'face_detection_full.binarypb',
  'face_detection_short.binarypb',
  'face_detection_full_range.tflite',
  'face_detection_full_range_sparse.tflite',
  'face_detection_short_range.tflite',
  'face_detection_solution_simd_wasm_bin.js',
  'face_detection_solution_simd_wasm_bin.wasm',
  'face_detection_solution_simd_wasm_bin.data',
  'face_detection_solution_wasm_bin.js',
  'face_detection_solution_wasm_bin.wasm',
];

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const f of FILES) {
  const from = join(src, f);
  if (!existsSync(from)) throw new Error(`Missing ${f} in @mediapipe/face_detection`);
  cpSync(from, join(dest, f));
}
cpSync(join(src, 'package.json'), join(dest, 'package.json'));
console.log(`Copied ${FILES.length} face-detection files to ${dest}`);
