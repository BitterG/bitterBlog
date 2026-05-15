import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, relative, dirname } from 'path';

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

function replaceOutsideScripts(html, regex, replacer) {
  // Split by script tags, only replace in non-script segments
  const parts = html.split(/(<script[\s>][\s\S]*?<\/script>)/g);
  return parts.map((part, i) => {
    if (part.startsWith('<script')) return part; // skip script blocks
    return part.replace(regex, replacer);
  }).join('');
}

const htmlFiles = findHtmlFiles(distDir);

for (const filePath of htmlFiles) {
  const depth = getRelativeDepth(filePath);
  const prefix = depth === 0 ? './' : '../'.repeat(depth);

  let html = readFileSync(filePath, 'utf-8');

  html = replaceOutsideScripts(
    html,
    /(href|src)="\/([^/][^"]*)"/g,
    (match, attr, path) => `${attr}="${prefix}${path}"`
  );

  writeFileSync(filePath, html, 'utf-8');
}

console.log(`Processed ${htmlFiles.length} HTML files for file:// compatibility.`);
