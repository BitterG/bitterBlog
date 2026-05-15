import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const dir = import.meta.dirname;
const playlistPath = join(dir, '..', 'public', 'playlist.json');
const playlist = JSON.parse(readFileSync(playlistPath, 'utf-8'));
const audioDir = join(dir, '..', 'public', 'audio');
mkdirSync(audioDir, { recursive: true });

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Referer': 'https://www.bilibili.com/',
};

let downloaded = 0;
let totalSize = 0;

for (let i = 0; i < playlist.length; i++) {
  const t = playlist[i];
  const filePath = join(audioDir, t.bvid + '.m4a');

  if (existsSync(filePath)) {
    const { size } = await import('fs').then(fs => fs.statSync(filePath));
    downloaded++;
    totalSize += size;
    continue; // skip existing
  }

  try {
    const viewRes = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${t.bvid}`, { headers });
    const cid = (await viewRes.json())?.data?.cid;
    if (!cid) { console.log(`[${i+1}] ${t.bvid} - no cid`); continue; }

    const playRes = await fetch(`https://api.bilibili.com/x/player/playurl?bvid=${t.bvid}&cid=${cid}&fnval=16`, { headers });
    const audio = (await playRes.json())?.data?.dash?.audio;
    if (!audio?.length) { console.log(`[${i+1}] ${t.bvid} - no audio`); continue; }

    const audioRes = await fetch(audio[0].baseUrl, { headers });
    const buf = Buffer.from(await audioRes.arrayBuffer());
    writeFileSync(filePath, buf);
    downloaded++;
    totalSize += buf.length;
    console.log(`[${i+1}/${playlist.length}] ${t.videoTitle || t.bvid} - ${(buf.length/1024).toFixed(0)}KB`);
  } catch(e) {
    console.log(`[${i+1}] ${t.bvid} - error: ${e.message}`);
  }

  await new Promise(r => setTimeout(r, 300));
}

console.log(`\nDone: ${downloaded} files, ${(totalSize/1024/1024).toFixed(1)} MB total`);
