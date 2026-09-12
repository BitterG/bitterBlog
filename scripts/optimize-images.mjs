import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, unlinkSync } from 'fs';
import { join, extname, basename, dirname } from 'path';
import sharp from 'sharp';

const root = join(import.meta.dirname, '..');
const imgDir = join(root, 'public', 'img');
const postsDir = join(root, 'src', 'content', 'posts');
const MIN_SIZE = 30720; // 30KB - only convert images larger than this
const convertedSet = new Set(); // 记录真正被转成 webp 的图片 URL，用于精确改写 markdown 引用

function walkDir(dir) {
  const results = [];
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        results.push(...walkDir(full));
      } else if (/\.(png|jpe?g)$/i.test(entry)) {
        results.push(full);
      }
    }
  } catch(e) {}
  return results;
}

async function convertToWebp(filePath) {
  const size = statSync(filePath).size;
  if (size < MIN_SIZE) return null;

  const webpPath = filePath.replace(/\.(png|jpe?g)$/i, '.webp');
  if (existsSync(webpPath)) return null; // already converted

  try {
    await sharp(filePath)
      .webp({ quality: 80 })
      .toFile(webpPath);
    const newSize = statSync(webpPath).size;
    const saved = ((size - newSize) / size * 100).toFixed(0);
    unlinkSync(filePath); // delete original
    // 记录对应的 URL 路径（/img/...png），只有这些才需要把 markdown 引用改成 .webp
    const publicRoot = join(root, 'public');
    const rel = '/' + filePath.substring(publicRoot.length + 1).replace(/\\/g, '/');
    convertedSet.add(rel);
    return { old: filePath, new: webpPath, saved, oldSize: size, newSize };
  } catch(e) {
    console.error(`  Failed: ${filePath} - ${e.message}`);
    return null;
  }
}

const images = walkDir(imgDir);
console.log(`Found ${images.length} PNG/JPG files (>30KB will be converted)\n`);

let converted = 0;
let totalSaved = 0;

for (const img of images) {
  const result = await convertToWebp(img);
  if (result) {
    console.log(`  ${basename(result.old)} ${(result.oldSize/1024).toFixed(0)}KB → ${(result.newSize/1024).toFixed(0)}KB (${result.saved}%)`);
    converted++;
    totalSaved += result.oldSize - result.newSize;
  }
}

// Update markdown references: .png/.jpg → .webp
const posts = readdirSync(postsDir).filter(f => f.endsWith('.md'));
let updated = 0;

for (const post of posts) {
  const postPath = join(postsDir, post);
  let content = readFileSync(postPath, 'utf-8');
  const original = content;
  // 只把"确实被转成 webp"的图片引用改成 .webp；≤30KB 未转换的图片保持原后缀
  content = content.replace(/\/img\/[^)\s"]+\.(png|jpe?g)/gi, (match) => {
    return convertedSet.has(match) ? match.replace(/\.(png|jpe?g)$/i, '.webp') : match;
  });
  if (content !== original) {
    writeFileSync(postPath, content, 'utf-8');
    updated++;
  }
}

console.log(`\nConverted: ${converted} images, saved ${(totalSaved/1024/1024).toFixed(1)}MB`);
console.log(`Updated: ${updated} markdown files`);
