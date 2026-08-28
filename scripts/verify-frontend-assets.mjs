#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const distDir = path.resolve(process.argv[2] || 'client/dist');
const indexPath = path.join(distDir, 'index.html');

if (!fs.existsSync(indexPath)) {
  console.error(`Missing frontend entrypoint: ${indexPath}`);
  process.exit(1);
}

const html = fs.readFileSync(indexPath, 'utf8');
const assetPaths = [...html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)]
  .map((match) => match[1]);

if (assetPaths.length === 0) {
  console.error(`No hashed frontend assets referenced by ${indexPath}`);
  process.exit(1);
}

const missingAssets = assetPaths.filter((assetPath) => (
  !fs.existsSync(path.join(distDir, assetPath.replace(/^\//, '')))
));

if (missingAssets.length > 0) {
  console.error(`Missing frontend assets: ${missingAssets.join(', ')}`);
  process.exit(1);
}

console.log(`Verified ${assetPaths.length} frontend assets in ${distDir}`);
