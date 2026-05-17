import { writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { readFileSync } from 'fs';

const dir = import.meta.dirname;
const playlistPath = join(dir, '..', 'public', 'playlist.json');
const fullList = JSON.parse(readFileSync(playlistPath, 'utf-8'));
const audioDir = join(dir, '..', 'public', 'audio');
const count = 30;
const CONCURRENCY = 5;

const shuffled = [...fullList].sort(() => Math.random() - 0.5);
const selected = shuffled.slice(0, count);

if (existsSync(audioDir)) rmSync(audioDir, { recursive: true });
mkdirSync(audioDir, { recursive: true });

const filteredPath = join(dir, '..', 'public', 'playlist-selected.json');
writeFileSync(filteredPath, JSON.stringify(selected));
console.log(`Picked ${count} random tracks, downloading with ${CONCURRENCY} threads\n`);

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Referer': 'https://www.bilibili.com/',
};

let done = 0, totalSize = 0;

async function downloadTrack(t, i) {
  const filePath = join(audioDir, t.bvid + '.m4a');
  try {
    const viewRes = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${t.bvid}`, { headers });
    const cid = (await viewRes.json())?.data?.cid;
    if (!cid) { console.log(`[${i+1}/${count}] ${t.bvid} - no cid`); return; }

    const playRes = await fetch(`https://api.bilibili.com/x/player/playurl?bvid=${t.bvid}&cid=${cid}&fnval=16`, { headers });
    const audio = (await playRes.json())?.data?.dash?.audio;
    if (!audio?.length) { console.log(`[${i+1}/${count}] ${t.bvid} - no audio`); return; }

    const audioRes = await fetch(audio[0].baseUrl, { headers });
    const buf = Buffer.from(await audioRes.arrayBuffer());
    writeFileSync(filePath, buf);
    done++;
    totalSize += buf.length;
    console.log(`[${i+1}/${count}] ${t.videoTitle || t.bvid} - ${(buf.length/1024).toFixed(0)}KB`);
  } catch(e) {
    console.log(`[${i+1}/${count}] ${t.bvid} - ${e.message}`);
  }
}

// Run in batches
for (let batch = 0; batch < selected.length; batch += CONCURRENCY) {
  const tasks = selected.slice(batch, batch + CONCURRENCY).map((t, j) => downloadTrack(t, batch + j));
  await Promise.allSettled(tasks);
}

console.log(`\nDone: ${done} files, ${(totalSize/1024/1024).toFixed(1)} MB`);
