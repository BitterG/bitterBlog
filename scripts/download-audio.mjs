import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

const dir = import.meta.dirname;
const playlistPath = join(dir, '..', 'public', 'playlist.json');
const fullList = JSON.parse(readFileSync(playlistPath, 'utf-8'));
const audioDir = join(dir, '..', 'public', 'audio');
const count = 30;

// Shuffle and pick N
const shuffled = [...fullList].sort(() => Math.random() - 0.5);
const selected = shuffled.slice(0, count);

// Clear old audio
if (existsSync(audioDir)) rmSync(audioDir, { recursive: true });
mkdirSync(audioDir, { recursive: true });

// Save filtered playlist
const filteredPath = join(dir, '..', 'public', 'playlist-selected.json');
writeFileSync(filteredPath, JSON.stringify(selected));
console.log(`Picked ${count} random tracks for this build`);

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Referer': 'https://www.bilibili.com/',
};

let downloaded = 0;
let totalSize = 0;

for (let i = 0; i < selected.length; i++) {
  const t = selected[i];
  const filePath = join(audioDir, t.bvid + '.m4a');

  try {
    const viewRes = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${t.bvid}`, { headers });
    const cid = (await viewRes.json())?.data?.cid;
    if (!cid) { console.log(`[${i+1}/${count}] ${t.bvid} - no cid`); continue; }

    const playRes = await fetch(`https://api.bilibili.com/x/player/playurl?bvid=${t.bvid}&cid=${cid}&fnval=16`, { headers });
    const audio = (await playRes.json())?.data?.dash?.audio;
    if (!audio?.length) { console.log(`[${i+1}/${count}] ${t.bvid} - no audio`); continue; }

    const audioRes = await fetch(audio[0].baseUrl, { headers });
    const buf = Buffer.from(await audioRes.arrayBuffer());
    writeFileSync(filePath, buf);
    downloaded++;
    totalSize += buf.length;
    console.log(`[${i+1}/${count}] ${t.videoTitle || t.bvid} - ${(buf.length/1024).toFixed(0)}KB`);
  } catch(e) {
    console.log(`[${i+1}/${count}] ${t.bvid} - error: ${e.message}`);
  }

  await new Promise(r => setTimeout(r, 300));
}

console.log(`\nDone: ${downloaded} files, ${(totalSize/1024/1024).toFixed(1)} MB total`);
