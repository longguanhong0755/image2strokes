// 画家模式冒烟/观感台：node dev/artist_smoke.mjs [s1 s2 s3 portrait landscape] [1-5] [marker oil pencil]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(path.join(here, '..', 'js', 'pipeline.js')).href);

const args = process.argv.slice(2);
const all = ['s1', 's2', 's3', 'portrait', 'landscape'];
const STYLES = ['marker', 'oil', 'pencil'];
const samples = args.filter((a) => !/^[1-5]$/.test(a) && !STYLES.includes(a));
const levels = args.filter((a) => /^[1-5]$/.test(a)).map(Number);
const styles = args.filter((a) => STYLES.includes(a));
const useSamples = samples.length ? samples : ['s1'];
const useLevels = levels.length ? levels : [3];
const useStyles = styles.length ? styles : ['marker'];

for (const name of useSamples) {
  const p = path.join(here, name + '.raw');
  if (!fs.existsSync(p)) { console.log('missing', p); continue; }
  const buf = fs.readFileSync(p);
  const W = buf.readInt32LE(0), H = buf.readInt32LE(4);
  const base = new Uint8ClampedArray(buf.buffer, buf.byteOffset + 8, W * H * 4);
  for (const style of useStyles) {
    for (const fid of useLevels) {
      const px = new Uint8ClampedArray(base);
      const t0 = Date.now();
      let r;
      try {
        r = await globalThis.ISP_PIPELINE.run(px, W, H,
          { colors: 0, fidelity: fid, algo: (process.env.ALGO || 'artist'), style, returnCanvas: true, debug: true,
            debugMasks: !!process.env.ARTIST_MASK,
            seed: process.env.ARTIST_SEED ? +process.env.ARTIST_SEED : 1 }, () => {});
      } catch (e) {
        console.log(name, style, fid, 'THROW', e && e.stack || e);
        continue;
      }
      const sec = (Date.now() - t0) / 1000;
      const q = r.stats.quality || {};
      const d = (r.dbg && r.dbg.artist) || {};
      console.log([
        name.padEnd(9), style.padEnd(6), String(fid).padStart(2),
        String(r.stats.strokes).padStart(6) + '笔',
        sec.toFixed(2).padStart(6) + 's',
        'mean=' + q.mean, 'max=' + q.max, 'gt24=' + q.gt24 + '%', 'thumb=' + q.thumbMean,
        'unc=' + q.uncovered,
        'subj=' + q.subjectCoverage + '%', 'edge=' + q.edgeScore,
        'dur=' + (r.stats.strokes < 20
          ? Math.max(3.2, Math.min(30, r.stats.strokes * 1.1)).toFixed(1) + 's'
          : Math.max(30, Math.min(90, Math.round(r.stats.strokes * 0.024))) + 's'),
        'pal=' + d.palette, 'flat=' + d.isFlat, 'groups=' + d.groups,
        'budget=' + d.budget, 'base=' + d.baseStrokes,
        'ph=' + JSON.stringify(r.stats.phases), 'paper=' + d.paperPx,
      ].join(' '));
      if (process.env.ARTIST_MASK && r.dbg.artist.groupOf) {
        const out = path.join(here, 'out_mask_' + name + '_' + style + '_' + fid + '.bin');
        const hdr = Buffer.alloc(8); hdr.writeInt32LE(W, 0); hdr.writeInt32LE(H, 4);
        const g = Buffer.from(r.dbg.artist.groupOf.buffer, r.dbg.artist.groupOf.byteOffset, W * H * 4);
        const cv = Buffer.from(r.dbg.artist.covered.buffer, r.dbg.artist.covered.byteOffset, W * H);
        const sj = Buffer.from(r.dbg.artist.subject.buffer, r.dbg.artist.subject.byteOffset, W * H);
        const pp = Buffer.from(r.dbg.artist.paper.buffer, r.dbg.artist.paper.byteOffset, W * H);
        fs.writeFileSync(out, Buffer.concat([hdr, g, cv, sj, pp]));
        const qi = Buffer.from(r.dbg.artist.qimg.buffer, r.dbg.artist.qimg.byteOffset, W * H * 3);
        fs.writeFileSync(out.replace('.bin', '_q.raw'), Buffer.concat([hdr, qi]));
        if (r.dbg.artist.residualMask) {
          const rm = Buffer.from(r.dbg.artist.residualMask.buffer, r.dbg.artist.residualMask.byteOffset, W * H);
          fs.writeFileSync(out.replace('.bin', '_res.bin'), Buffer.concat([hdr, rm]));
        }
        console.log('mask dump', out);
      }
      if (process.env.ARTIST_DBG) console.log(JSON.stringify({ colors: d.paletteColors, groups: d.topGroups }, null, 0));
      if (process.env.ARTIST_HASH) {
        const h = crypto.createHash('sha1');
        for (const s of r.strokes) {
          h.update(s.ph + '|' + s.w + '|' + s.color.join(',') + '|' + s.tp.join(',') + '\n');
        }
        console.log('HASH', name, style, fid, 'seed=' + (r.stats.seed === undefined ? '-' : r.stats.seed),
          'mode=' + (r.stats.exactMode || '-'), h.digest('hex'),
          'exact=' + JSON.stringify(d.exact || null));
      }
      if (process.env.ARTIST_OUT) {
        const out = path.join(here, 'out_artist_' + name + '_' + style + '_' + fid + '.raw');
        const hdr = Buffer.alloc(8);
        hdr.writeInt32LE(W, 0); hdr.writeInt32LE(H, 4);
        fs.writeFileSync(out, Buffer.concat([hdr, Buffer.from(r.canvasRgb.buffer, r.canvasRgb.byteOffset, W * H * 3)]));
        const dom = Buffer.alloc(W * H * 4);
        for (let i = 0; i < W * H; i++) {
          dom[i * 4] = r.canvasRgb[i * 3]; dom[i * 4 + 1] = r.canvasRgb[i * 3 + 1];
          dom[i * 4 + 2] = r.canvasRgb[i * 3 + 2]; dom[i * 4 + 3] = 255;
        }
        fs.writeFileSync(out.replace('.raw', '.rgba'), Buffer.concat([hdr, dom]));
      }
    }
  }
}
