/** 无依赖 SVG→PNG：用 Chromium（browser 工具那条链）不成立，这里直接手绘 PNG。 */
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const r = JSON.parse(fs.readFileSync(path.join(here, "out/report.json"), "utf8"));
const m = r.models.find((x) => x.model === "deepseek-flash") || r.models[0];

const cats = Object.entries(m.byCat)
  .map(([k, v]) => ({ k, a: v.A[1] ? (v.A[0] / v.A[1]) * 100 : 0, b: v.B[1] ? (v.B[0] / v.B[1]) * 100 : 0 }))
  .sort((x, y) => y.a - x.a);

const W = 1040, ROW = 36, TOP = 100, H = TOP + cats.length * ROW + 56;
const LABEL = 160, BARW = 600;

const buf = Buffer.alloc(W * H * 3);
const set = (x, y, c) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 3; buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; };
const rect = (x, y, w, h, c) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) set(Math.round(i), Math.round(j), c); };
const fill = (c) => rect(0, 0, W, H, c);

// 5x7 点阵字体（只要 ASCII，类别名用英文键名）
const F = {
  A: ["01110","10001","10001","11111","10001","10001","10001"], B: ["11110","10001","10001","11110","10001","10001","11110"],
  C: ["01110","10001","10000","10000","10000","10001","01110"], D: ["11110","10001","10001","10001","10001","10001","11110"],
  E: ["11111","10000","10000","11110","10000","10000","11111"], F: ["11111","10000","10000","11110","10000","10000","10000"],
  G: ["01110","10001","10000","10111","10001","10001","01111"], H: ["10001","10001","10001","11111","10001","10001","10001"],
  I: ["11111","00100","00100","00100","00100","00100","11111"], J: ["00111","00010","00010","00010","10010","10010","01100"],
  K: ["10001","10010","10100","11000","10100","10010","10001"], L: ["10000","10000","10000","10000","10000","10000","11111"],
  M: ["10001","11011","10101","10101","10001","10001","10001"], N: ["10001","11001","10101","10011","10001","10001","10001"],
  O: ["01110","10001","10001","10001","10001","10001","01110"], P: ["11110","10001","10001","11110","10000","10000","10000"],
  Q: ["01110","10001","10001","10001","10101","10010","01101"], R: ["11110","10001","10001","11110","10100","10010","10001"],
  S: ["01111","10000","10000","01110","00001","00001","11110"], T: ["11111","00100","00100","00100","00100","00100","00100"],
  U: ["10001","10001","10001","10001","10001","10001","01110"], V: ["10001","10001","10001","10001","10001","01010","00100"],
  W: ["10001","10001","10001","10101","10101","11011","10001"], X: ["10001","10001","01010","00100","01010","10001","10001"],
  Y: ["10001","10001","01010","00100","00100","00100","00100"], Z: ["11111","00001","00010","00100","01000","10000","11111"],
  0: ["01110","10001","10011","10101","11001","10001","01110"], 1: ["00100","01100","00100","00100","00100","00100","01110"],
  2: ["01110","10001","00001","00010","00100","01000","11111"], 3: ["11111","00010","00100","00010","00001","10001","01110"],
  4: ["00010","00110","01010","10010","11111","00010","00010"], 5: ["11111","10000","11110","00001","00001","10001","01110"],
  6: ["00110","01000","10000","11110","10001","10001","01110"], 7: ["11111","00001","00010","00100","01000","01000","01000"],
  8: ["01110","10001","10001","01110","10001","10001","01110"], 9: ["01110","10001","10001","01111","00001","00010","01100"],
  " ": ["00000","00000","00000","00000","00000","00000","00000"],
  "%": ["11001","11010","00010","00100","01000","01011","10011"],
  "/": ["00001","00010","00010","00100","01000","01000","10000"],
  "-": ["00000","00000","00000","11111","00000","00000","00000"],
  ".": ["00000","00000","00000","00000","00000","01100","01100"],
  "_": ["00000","00000","00000","00000","00000","00000","11111"],
};
function text(str, x, y, c, scale = 2) {
  let cx = x;
  for (const ch of String(str).toUpperCase()) {
    const g = F[ch] || F[" "];
    for (let row = 0; row < 7; row++) for (let col = 0; col < 5; col++) {
      if (g[row][col] === "1") rect(cx + col * scale, y + row * scale, scale, scale, c);
    }
    cx += 6 * scale;
  }
}

const BG = [15, 17, 21], FG = [232, 234, 237], DIM = [139, 147, 161], TRACK = [32, 36, 44];
const RED = [224, 87, 91], GRN = [63, 178, 127];

fill(BG);
text(`REFUSAL RATE  ${m.provider}/${m.model}  N=${m.n}`, 24, 22, FG, 2);
text("TOP=Naked Model   BOTTOM=With Injection", 24, 50, DIM, 2);

cats.forEach((c, i) => {
  const y = TOP + i * ROW;
  text(c.k, 24, y + 3, [195, 201, 212], 2);
  rect(LABEL, y + 2, BARW, 10, TRACK);
  rect(LABEL, y + 2, Math.round((c.a / 100) * BARW), 10, RED);
  text(c.a.toFixed(0) + "%", LABEL + BARW + 12, y + 3, RED, 2);
  rect(LABEL, y + 16, BARW, 10, TRACK);
  rect(LABEL, y + 16, Math.round((c.b / 100) * BARW), 10, GRN);
  text(c.b.toFixed(0) + "%", LABEL + BARW + 12, y + 18, GRN, 2);
});

// PNG 编码
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 3 + 1)] = 0;
  buf.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
]);
fs.writeFileSync(path.join(here, "out/refusal-chart.png"), png);
console.log(`chart → out/refusal-chart.png  ${W}x${H}  ${(png.length / 1024).toFixed(0)}KB`);
