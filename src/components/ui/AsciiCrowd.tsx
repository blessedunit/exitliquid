"use client";
// The loader's picture: our own pixel traders redrawn as ASCII on a <canvas>, walking one by one into a glowing
// EXIT door. Each sprite PNG is read once, cut into monospace cells and every cell becomes a glyph picked by its
// brightness, coloured with the sprite's own colour pulled toward the brand green. One crisp pass + one cheap
// blurred "lighter" pass for the glow, light scanlines, a few glyphs re-picked now and then so it feels alive.
// ~12 fps, paused off-screen / in a hidden tab, one still frame under prefers-reduced-motion.
// The canvas only exists in effects; the server renders the sized, empty box (CSS reserves the size).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Skin } from "@/lib/skins";

type Variant = "scene" | "mini";
type Cell = { g: number; c: string } | null;
type Fig = { cols: number; rows: number; cells: Cell[] };
type Look = { cw: number; ch: number; sign: boolean; skins: Skin[]; speed: number; doorW: number; inPlace: boolean; boost: number };

const RAMP = " .:-=+*#%@";
const GREEN: [number, number, number] = [61, 220, 132];
const FPS = 12;
const LOOKS: Record<"scene" | "mini" | "miniTall", Look> = {
  // a strip: four traders walk in from the left and go through the door one by one
  scene: { cw: 4, ch: 6, sign: true, skins: ["hood", "getaway", "plain", "suit"], speed: 0.5, doorW: 10, inPlace: false, boost: 0 },
  // small: one trader stepping in place toward the door while the floor slides under him
  miniTall: { cw: 3, ch: 5, sign: true, skins: ["hood"], speed: 0.5, doorW: 6, inPlace: true, boost: 1 },
  // inline (next to a caption, 24 px tall): cells this small read as glowing dots, so denser glyphs, looser edges
  mini: { cw: 2, ch: 3, sign: false, skins: ["hood"], speed: 0.5, doorW: 5, inPlace: true, boost: 3 },
};

// ---- sprites: read once per page, cut into cells once per size ----
const pixels = new Map<Skin, Promise<ImageData | null>>();
function loadPixels(skin: Skin): Promise<ImageData | null> {
  let p = pixels.get(skin);
  if (!p) {
    p = new Promise((done) => {
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement("canvas");
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          const x = c.getContext("2d", { willReadFrequently: true });
          if (!x) return done(null);
          x.drawImage(img, 0, 0);
          done(x.getImageData(0, 0, c.width, c.height));
        } catch {
          done(null);
        }
      };
      img.onerror = () => done(null);
      img.src = `/sprites/${skin}@2x.png`;
    });
    pixels.set(skin, p);
  }
  return p;
}

const figs = new Map<string, Fig>();
function toFig(key: string, im: ImageData, rows: number, cw: number, ch: number, boost: number): Fig {
  const hit = figs.get(key);
  if (hit) return hit;
  const { width: W, height: H, data } = im;
  const cols = Math.max(2, Math.round(((rows * ch) / cw) * (W / H)));
  const cells: Cell[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = Math.floor((c * W) / cols), x1 = Math.floor(((c + 1) * W) / cols);
      const y0 = Math.floor((r * H) / rows), y1 = Math.floor(((r + 1) * H) / rows);
      let a = 0, R = 0, G = 0, B = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * W + x) * 4, al = data[i + 3];
          a += al; R += data[i] * al; G += data[i + 1] * al; B += data[i + 2] * al; n++;
        }
      }
      const cov = n ? a / (n * 255) : 0;
      if (cov < (boost > 2 ? 0.18 : 0.3)) { cells.push(null); continue; }
      R /= a; G /= a; B /= a;
      const lum = (0.2126 * R + 0.7152 * G + 0.0722 * B) / 255;
      const g = Math.min(9, boost + Math.max(1, Math.round(1 + (0.22 + 0.78 * lum) * (0.6 + 0.4 * cov) * 8.6)));
      // the sprite's colour pulled toward the brand green, lifted so dark outlines still read on the dark page
      const t = 0.4;
      let r2 = R * (1 - t) + GREEN[0] * t, g2 = G * (1 - t) + GREEN[1] * t, b2 = B * (1 - t) + GREEN[2] * t;
      const lift = 0.75 + 0.55 * lum;
      r2 *= lift; g2 *= lift; b2 *= lift;
      const top = Math.max(r2, g2, b2);
      if (top > 255) { r2 *= 255 / top; g2 *= 255 / top; b2 *= 255 / top; }
      cells.push({ g, c: `rgb(${r2 | 0},${g2 | 0},${b2 | 0})` });
    }
  }
  const f = { cols, rows, cells };
  figs.set(key, f);
  return f;
}

// cheap stable noise: same cell + same time bucket = same answer
function hash(a: number, b: number, c: number): number {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export default function AsciiCrowd({ variant, grow = false, className, tallClassName }: {
  variant: Variant;
  /** mini only: when the box around it is tall (the grade square), draw the bigger mini */
  grow?: boolean;
  className?: string;
  tallClassName?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  // the bigger mini, sized to the box it sits in (72 px grade square on desktop, 56 px on phones)
  const [tall, setTall] = useState<{ w: number; h: number } | null>(null);

  useLayoutEffect(() => {
    if (variant !== "mini" || !grow) return;
    const box = ref.current?.parentElement?.parentElement;
    if (!box || box.clientHeight < 48 || box.clientWidth < 48) return;
    setTall({ w: Math.min(64, box.clientWidth - 8), h: Math.min(60, box.clientHeight - 8) });
  }, [variant, grow]);

  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const look = LOOKS[variant === "mini" ? (tall ? "miniTall" : "mini") : "scene"];
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const layer = document.createElement("canvas");
    const lx = layer.getContext("2d");
    const glow = document.createElement("canvas");
    const gx = glow.getContext("2d");
    if (!lx || !gx) return;

    let W = 0, H = 0, dpr = 1, cols = 0, rows = 0;
    let shapes: (ImageData | null)[] = look.skins.map(() => null);
    let tick = 0, raf = 0, last = 0, onScreen = true, dead = false;

    const size = () => {
      const r = cv.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
      cv.width = layer.width = Math.round(W * dpr); cv.height = layer.height = Math.round(H * dpr);
      glow.width = Math.max(1, Math.round(W / 4)); glow.height = Math.max(1, Math.round(H / 4));
      cols = Math.floor(W / look.cw); rows = Math.floor(H / look.ch);
    };

    const draw = () => {
      const { cw, ch, doorW } = look;
      const ox = Math.floor((W - cols * cw) / 2), oy = H - rows * ch;
      lx.setTransform(dpr, 0, 0, dpr, 0, 0);
      lx.clearRect(0, 0, W, H);
      lx.font = `700 ${Math.round(ch * 1.05)}px ui-monospace, Menlo, Consolas, "Courier New", monospace`;
      lx.textAlign = "center";
      lx.textBaseline = "middle";
      const put = (ch_: string, col: number, row: number, color: string, alpha = 1) => {
        if (col < 0 || col >= cols || row < 0 || row >= rows || alpha <= 0.02 || ch_ === " ") return;
        lx.globalAlpha = Math.min(1, alpha);
        lx.fillStyle = color;
        lx.fillText(ch_, ox + col * cw + cw / 2, oy + row * ch + ch / 2 + 0.5);
      };
      const shimmerT = Math.floor(tick / 4);

      const floor = rows - 1;
      const doorTop = look.sign ? 1 : 0;
      const dx = cols - doorW - (look.sign ? 1 : 0);
      const figRows = look.sign ? floor - doorTop - 1 : floor - doorTop;

      // floor, and the door's light spilling on it
      for (let c = 0; c < cols; c++) {
        const d = dx + doorW / 2 - c;
        const lit = Math.max(0, 1 - Math.abs(d) / (doorW * 1.6));
        // walking in place: the floor slides back under the trader
        const seam = look.inPlace && c < dx && (c + Math.floor(tick * look.speed)) % 5 === 0;
        if (lit > 0.05) put(lit > 0.6 ? "=" : lit > 0.3 ? "-" : seam ? "." : "_", c, floor, "#3ddc84", 0.3 + 0.7 * lit);
        else put(seam ? "." : "_", c, floor, "#a2aba5", seam ? 0.8 : 0.5);
      }
      // the open doorway: soft green light, a few glyphs flickering
      for (let r = doorTop + 1; r < floor; r++) {
        for (let c = dx + 1; c < dx + doorW - 1; c++) {
          const depth = (r - doorTop) / (floor - doorTop);
          const n = hash(c, r, shimmerT);
          put(n < 0.3 ? " " : n < 0.75 ? "." : ":", c, r, "#5ceb9c", 0.15 + 0.35 * depth);
        }
      }
      // traders: walk in from the left, step (legs apart / together), fade inside the door
      const loop = dx + 2;
      look.skins.forEach((_, i) => {
        const im = shapes[i];
        if (!im) return;
        const f = toFig(`${look.skins[i]}:${figRows}:${cw}x${ch}:${look.boost}`, im, figRows, cw, ch, look.boost);
        const span = loop + f.cols;
        const p = look.inPlace ? tick * look.speed : (tick * look.speed + (i * span) / look.skins.length) % span;
        const x = look.inPlace ? Math.max(0, dx - f.cols - Math.max(2, Math.round(doorW * 0.6))) : Math.floor(p) - f.cols;
        const stepB = Math.floor(p) % 2 === 1;
        const legs = Math.max(1, Math.round(f.rows * 0.2));
        const fade = look.inPlace ? 1 : Math.min(1, Math.max(0, (dx + 1 - x) / (f.cols * 0.9)));
        const mid = f.cols / 2;
        for (let r = 0; r < f.rows; r++) {
          for (let c = 0; c < f.cols; c++) {
            const cell = f.cells[r * f.cols + c];
            if (!cell) continue;
            let X = x + c;
            if (stepB && r >= f.rows - legs) X += c < mid ? -1 : 1;
            if (X >= dx + doorW - 1) continue;
            let a = look.inPlace ? 1 : fade * Math.min(1, (X + 2) / 5);
            if (X > dx) a *= Math.max(0, 1 - (X - dx) / (doorW - 1)) * 0.85;
            let g = cell.g;
            const n = hash(i * 977 + c, r, shimmerT);
            if (n < 0.07) g = Math.max(1, g - 1); else if (n > 0.93) g = Math.min(9, g + 1);
            put(RAMP[g], X, doorTop + 1 + r, cell.c, a);
          }
        }
      });
      // door frame on top, so traders go in behind it
      for (let c = dx; c < dx + doorW; c++) {
        const edge = c === dx || c === dx + doorW - 1;
        put(edge ? "+" : look.sign ? "-" : "=", c, doorTop, edge || look.sign ? "#8a948e" : "#5ceb9c", 0.8);
      }
      for (let r = doorTop + 1; r < floor; r++) { put("|", dx, r, "#8a948e", 0.75); put("|", dx + doorW - 1, r, "#8a948e", 0.75); }
      // the sign, with the odd flicker of a cheap tube
      if (look.sign) {
        const buzz = hash(7, 7, Math.floor(tick / 3)) < 0.08 ? 0.35 : 1;
        const gap = doorW >= 8 ? 2 : 1;
        const s = dx + Math.floor((doorW - (4 * gap - (gap - 1))) / 2);
        for (let k = 0; k < 4; k++) put("EXIT"[k], s + k * gap, 0, "#5ceb9c", buzz);
      }
      lx.globalAlpha = 1;

      // compose: blurred glow underneath (downscaled copy drawn back up, additive), crisp glyphs on top, scanlines
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, cv.width, cv.height);
      gx.clearRect(0, 0, glow.width, glow.height);
      gx.imageSmoothingEnabled = true;
      gx.drawImage(layer, 0, 0, glow.width, glow.height);
      ctx.imageSmoothingEnabled = true;
      ctx.globalAlpha = 0.85;
      ctx.drawImage(glow, 0, 0, cv.width, cv.height);
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = hash(3, 1, tick) < 0.04 ? 0.8 : 1;
      ctx.drawImage(layer, 0, 0);
      ctx.globalCompositeOperation = "destination-out";
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = "#000";
      const step = 2 * dpr;
      for (let y = dpr; y < cv.height; y += step) ctx.fillRect(0, y, cv.width, Math.max(1, dpr * 0.6));
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
    };

    const frame = (now: number) => {
      raf = 0;
      if (dead || !onScreen || document.hidden) return;
      raf = requestAnimationFrame(frame);
      if (now - last < 1000 / FPS - 2) return;
      last = now;
      tick++;
      draw();
    };
    const run = () => {
      if (still) { draw(); return; }
      if (!raf && onScreen && !document.hidden && !dead) raf = requestAnimationFrame(frame);
    };

    size();
    // still frame: traders spread along the line
    tick = still ? 9 : 0;
    draw();
    Promise.all(look.skins.map(loadPixels)).then((res) => {
      if (dead) return;
      shapes = res;
      draw();
      run();
    });

    const io = new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; run(); });
    io.observe(cv);
    const ro = new ResizeObserver(() => { size(); draw(); });
    ro.observe(cv);
    const vis = () => run();
    document.addEventListener("visibilitychange", vis);
    return () => {
      dead = true;
      if (raf) cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      document.removeEventListener("visibilitychange", vis);
    };
  }, [variant, tall]);

  return (
    <canvas
      ref={ref}
      aria-hidden
      className={`${className ?? ""} ${tall ? tallClassName ?? "" : ""}`}
      style={tall ? { width: tall.w, height: tall.h } : undefined}
    />
  );
}
