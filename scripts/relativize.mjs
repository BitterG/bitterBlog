import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, relative, dirname } from 'path';

// Read base from astro config
const configPath = join(import.meta.dirname, '..', 'astro.config.mjs');
const configText = readFileSync(configPath, 'utf-8');
const baseMatch = configText.match(/base:\s*['"]([^'"]*)['"]/);
const basePath = baseMatch ? baseMatch[1] : '/';

const distDir = join(import.meta.dirname, '..', 'dist');

function findHtmlFiles(dir) {
  const results = [];
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      results.push(...findHtmlFiles(fullPath));
    } else if (entry.endsWith('.html')) {
      results.push(fullPath);
    }
  }
  return results;
}

function getRelativeDepth(htmlPath) {
  const rel = relative(distDir, dirname(htmlPath));
  if (rel === '') return 0;
  return rel.split(/[\\/]/).filter(Boolean).length;
}

const htmlFiles = findHtmlFiles(distDir);

for (const filePath of htmlFiles) {
  const depth = getRelativeDepth(filePath);
  const prefix = depth === 0 ? './' : '../'.repeat(depth);

  let html = readFileSync(filePath, 'utf-8');

  // Replace all absolute local paths (href="/..." or src="/...") with relative paths
  // Matches href="/ANYTHING" and src="/ANYTHING" but not href="//" (protocol-relative)
  // and not https:// etc.
  html = html.replace(
    /(href|src)="\/([^/][^"]*)"/g,
    (match, attr, path) => `${attr}="${prefix}${path}"`
  );

  writeFileSync(filePath, html, 'utf-8');
}

console.log(`Processed ${htmlFiles.length} HTML files for file:// compatibility.`);
