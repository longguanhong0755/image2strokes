# b74：照片分层细化（误差驱动、多档笔宽）
import io

p = 'js/pipeline.js'
s = io.open(p, encoding='utf-8').read()

anchor = '''      // ---- 画家·过程版分支：作画交给 paintHumanFlow，跳过近似铺底/底色层 ----'''
assert s.count(anchor) == 1

NEW = r'''      // ---- 照片分层细化：按"画布误差"补笔，先中笔、后细笔 ----
      // 人画照片是分层来的：大色块铺完，在颜色不对的地方补中笔，最后用细笔
      // 收毛发/石缝/轮廓。这里每一层只挑"当前画布和原图差得最多"的地方落笔，
      // 笔身沿着结构流向、颜色取原图在这一带的局部均值；落笔前先算这一笔
      // 到底能减少多少误差，不能减少就不画（每笔都有真实贡献）。
      // 只给画家·过程版的照片用：artist 的照片笔流保持逐字节不变。
      const paintPhotoLayers = async () => {
        if (paperPx > N * 0.004) return 0;   // 扫描纸白不参与照片细化
        const layers = [
          { h: 8.4, T: 21, lenK: 2.4, ph: 2, cap: 2600, hr: 5 },
          { h: 5.0, T: 16, lenK: 2.3, ph: 2, cap: 3400, hr: 3 },
          { h: 3.0, T: 12.5, lenK: 2.2, ph: 3, cap: 4600, hr: 2 },
        ];
        let added = 0, tried = 0, kept = 0;
        const segD2 = (px, py, ax, ay, bx, by) => {
          const dx = bx - ax, dy = by - ay;
          const l2 = dx * dx + dy * dy;
          let t = l2 > 1e-6 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
          t = t < 0 ? 0 : (t > 1 ? 1 : t);
          const qx = ax + dx * t - px, qy = ay + dy * t - py;
          return qx * qx + qy * qy;
        };
        for (let li = 0; li < layers.length; li++) {
          const L = layers[li];
          const h = Math.max(2.2, L.h * Math.min(1.35, scaleB));
          const step = Math.max(2, Math.round(h * 0.92));
          const refR = blurU8(R, L.hr), refG = blurU8(G, L.hr), refB = blurU8(B, L.hr);
          const done = new Uint8Array(N);
          const ox = (srnd(31.7 + li * 7.3, 4.1) * step) | 0;
          const oy = (srnd(37.1 + li * 5.9, 5.3) * step) | 0;
          let n = 0;
          for (let y = oy; y < H - 1; y += step) {
            for (let x = ox; x < W - 1; x += step) {
              if (n >= L.cap || added >= 11000) break;
              const p = y * W + x;
              if (done[p] || segPaper[p]) continue;
              const q = p * 3;
              // 当前画布误差（最大通道差）
              const e0 = Math.max(
                Math.abs(canvas[q] - R[p]),
                Math.abs(canvas[q + 1] - G[p]),
                Math.abs(canvas[q + 2] - B[p]));
              if (e0 < L.T) continue;
              tried++;
              // 方向：结构张量的切线（flowX/flowY 存的是 2θ），低相干时给随机角
              let ang;
              if (coh[p] > 0.10) ang = 0.5 * Math.atan2(flowY[p], flowX[p]);
              else ang = srnd(p * 0.013, 6.7) * Math.PI;
              ang += (srnd(p * 0.021 + li * 3.1, 8.3) - 0.5) * 0.24;
              const ca = Math.cos(ang), sa = Math.sin(ang);
              const len = clamp(h * L.lenK * (0.8 + 1.6 * Math.min(1, coh[p])), h * 1.2, h * 5.2)
                * (0.85 + 0.3 * srnd(p * 0.017, 2.9));
              const ax = x + 0.5 - ca * len * 0.5, ay = y + 0.5 - sa * len * 0.5;
              const bx = x + 0.5 + ca * len * 0.5, by = y + 0.5 + sa * len * 0.5;
              // 笔色 = 原图在笔身中段/两端的局部均值（模糊到本层笔宽）
              const pi0 = Math.max(0, Math.min(N - 1, ((ay + by) * 0.5 | 0) * W + ((ax + bx) * 0.5 | 0)));
              const piA = Math.max(0, Math.min(N - 1, (ay | 0) * W + (ax | 0)));
              const piB = Math.max(0, Math.min(N - 1, (by | 0) * W + (bx | 0)));
              const col = [
                Math.round((refR[pi0] + refR[piA] + refR[piB]) / 3),
                Math.round((refG[pi0] + refG[piA] + refG[piB]) / 3),
                Math.round((refB[pi0] + refB[piA] + refB[piB]) / 3),
              ];
              // 这一笔能减少多少误差：逐像素算"画之前 vs 画之后"
              const rx0 = Math.max(0, Math.floor(Math.min(ax, bx) - h));
              const rx1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + h));
              const ry0 = Math.max(0, Math.floor(Math.min(ay, by) - h));
              const ry1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + h));
              const r2 = h * h * 0.94;
              let gain = 0, cnt = 0, worst = 0;
              for (let yy = ry0; yy <= ry1; yy++) {
                const row = yy * W;
                for (let xx = rx0; xx <= rx1; xx++) {
                  if (segD2(xx + 0.5, yy + 0.5, ax, ay, bx, by) > r2) continue;
                  const pp = row + xx;
                  if (segPaper[pp]) continue;
                  const qq = pp * 3;
                  const oldE = Math.max(
                    Math.abs(canvas[qq] - R[pp]),
                    Math.abs(canvas[qq + 1] - G[pp]),
                    Math.abs(canvas[qq + 2] - B[pp]));
                  const newE = Math.max(
                    Math.abs(col[0] - R[pp]),
                    Math.abs(col[1] - G[pp]),
                    Math.abs(col[2] - B[pp]));
                  gain += oldE - newE;
                  if (newE - oldE > worst) worst = newE - oldE;
                  cnt++;
                }
              }
              if (cnt < 6 || gain < cnt * 0.75 || worst > 22) { done[p] = 1; continue; }
              const nP = 4;
              const sp = new Float64Array(nP * 2), halfs = new Float64Array(nP);
              const bow = (srnd(p * 0.011 + li * 1.7, 3.9) - 0.5) * h * 0.9;
              for (let i = 0; i < nP; i++) {
                const f = i / (nP - 1);
                const off = bow * Math.sin(Math.PI * f) +
                  (srnd(p * 0.007 + i * 1.13, 4.7) - 0.5) * 0.7;
                sp[i * 2] = ax + (bx - ax) * f - sa * off;
                sp[i * 2 + 1] = ay + (by - ay) * f + ca * off;
                halfs[i] = h * (0.80 + 0.24 * Math.sin(Math.PI * f)) *
                  (0.92 + 0.16 * srnd(p * 0.009 + i * 2.1, 3.3));
              }
              const si = emitPlan(sp, halfs, col, L.ph, {
                color: col, pen: 0, noCover: 1, noZone: 1, forceKeep: 1,
                minInk: 1, ms: Math.round(55 + len * 0.85),
              });
              if (si < 0) { done[p] = 1; continue; }
              kept++; n++; added++;
              // 这一笔盖过的范围在同一层里不再重复挑
              const md = h * 1.25;
              const mx0 = Math.max(0, Math.floor(Math.min(ax, bx) - md));
              const mx1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + md));
              const my0 = Math.max(0, Math.floor(Math.min(ay, by) - md));
              const my1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + md));
              for (let yy = my0; yy <= my1; yy++) {
                const row = yy * W;
                for (let xx = mx0; xx <= mx1; xx++) {
                  if (segD2(xx + 0.5, yy + 0.5, ax, ay, bx, by) <= md * md) done[row + xx] = 1;
                }
              }
            }
            if ((y & 63) === 0) await yieldUI();
            if (n >= L.cap || added >= 11000) break;
          }
          if (opts.debug) {
            console.log('[photolayer] L' + (li + 1) + ' h=' + h.toFixed(1) + ' T=' + L.T +
              ' tried=' + tried + ' kept=' + kept + ' added=' + added);
          }
          if (added >= 11000) break;
        }
        return added;
      };

''' + anchor
s = s.replace(anchor, NEW)

old = '''      if (washIdx.length) {'''
new = '''      // 照片分层细化：主色区都画完之后，按误差补中笔/细笔（只给过程版）
      if (painterFlow && !flatArt) await paintPhotoLayers();

      if (washIdx.length) {'''
assert s.count(old) == 1
s = s.replace(old, new)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('patched')
