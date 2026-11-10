// Mermaid -> Pele SVG -> literal-colour SVG -> resvg PNG.
// Usage: bun render.ts <file|-> [outDir] [verdigris|pele-default]
// Writes <outDir>/<stem>.<theme>.svg and 2x .png (outDir defaults to the input's directory, or the
// working directory for stdin, whose stem is `diagram`) and prints one JSON line:
// {type, theme, width, height, renderMs, inlineMs, rasterMs, svg, png, pngWidth, pngHeight}.
// `verdigris` (default) reads the adjacent verdigris.json on every render; `pele-default` keeps Pele's colours.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';

const DEPS = join(homedir(), '.local/share/pi-pele');
const PALETTE = join(import.meta.dir, 'verdigris.json');
const FONT = 'Liberation Sans'; // metric-compatible with the Arial width table Pele measures with
const MONO = 'Liberation Mono';
const THEMES = ['verdigris', 'pele-default'];

const fail = (msg: string): never => {
  console.error(`pele: ${msg}`);
  process.exit(1);
};

const [input, outArg, theme = 'verdigris'] = process.argv.slice(2);
if (!input || !THEMES.includes(theme)) {
  console.error('usage: bun render.ts <file|-> [outDir] [verdigris|pele-default]');
  process.exit(2);
}

// Pele and resvg come from the approved local Bun install, not from this skill directory.
const load = async (name: string) => {
  let path: string;
  try {
    path = Bun.resolveSync(name, DEPS);
  } catch {
    return fail(`missing ${name} in ${DEPS}; one-time setup: cd ${DEPS} && bun install`);
  }
  return import(path);
};
const { render } = await load('pele');
const { Resvg } = await load('@resvg/resvg-js');
for (const family of [FONT, MONO]) {
  const found = Bun.spawnSync(['fc-list', `:family=${family}`, 'family']).stdout.toString().trim();
  if (!found) fail(`font ${family} is not installed (Arch: pacman -S ttf-liberation)`);
}

function verdigris(): Record<string, string> {
  const tokens = JSON.parse(readFileSync(PALETTE, 'utf8')) as Record<string, string>;
  for (const [key, value] of Object.entries(tokens)) {
    if (!key.startsWith('--pele-') || !/^#([\da-f]{3}|[\da-f]{6})$/i.test(value)) {
      fail(`${PALETTE}: ${key} must be a --pele-* key with a #rgb or #rrggbb value, got ${JSON.stringify(value)}`);
    }
  }
  return tokens;
}

const hex = (s: string): number[] => {
  const m = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(s.trim());
  if (!m) throw new Error(`color-mix: unsupported colour ${s}`);
  const h = m[1].length === 3 ? [...m[1]].map((x) => x + x).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const toHex = (rgb: number[]) => '#' + rgb.map((n) => Math.round(n).toString(16).padStart(2, '0')).join('');

// Resolve var(), color-mix(in srgb, a p%, b) and calc(Npx + Mpx) to literals; resvg reads none of them.
function literal(svg: string, tokens: Record<string, string>): string {
  const root = /^<svg[^>]* style="([^"]*)"/.exec(svg)![1];
  const props: Record<string, string> = { ...tokens };
  for (const d of root.split(';')) {
    const m = /^\s*(--[\w-]+)\s*:(.*)$/.exec(d);
    if (m && !(m[1] in tokens)) props[m[1]] = m[2].trim();
  }
  const VAR = /var\(\s*(--[\w-]+)\s*(?:,((?:[^()]|\([^()]*\))*))?\)/g;
  const resolveVars = (s: string, depth = 0): string => {
    if (depth > 10) throw new Error('var() nesting too deep');
    return s.replace(VAR, (_, name, fb) => {
      if (props[name] !== undefined) return resolveVars(props[name], depth + 1);
      if (fb !== undefined) return resolveVars(fb.trim(), depth + 1);
      throw new Error(`unresolved ${name}`);
    });
  };
  // Only markup (attributes, styles) is rewritten; label text between tags is left as authored.
  return svg.replace(/<[^>]+>/g, (tag) => literalTag(tag, resolveVars));
}

function literalTag(tag: string, resolveVars: (s: string) => string): string {
  let out = tag;
  for (let prev = ''; prev !== out; ) (prev = out), (out = resolveVars(out));
  out = out.replace(/color-mix\(in srgb,\s*([^,\s]+)\s+([\d.]+)%\s*,\s*([^)\s]+)\s*\)/g, (_, a, p, b) => {
    const t = Number(p) / 100;
    const [x, y] = [hex(a), hex(b)];
    return toHex(x.map((v, i) => v * t + y[i] * (1 - t)));
  });
  out = out.replace(/calc\(\s*([\d.]+)(?:px)?\s*\+\s*([\d.]+)px\s*\)/g, (_, a, b) => `${Number(a) + Number(b)}px`);
  out = out.replace(/--[\w-]+:[^;"]*;?/g, '');
  const left = out.match(/var\(|color-mix\(|calc\(/g);
  if (left) throw new Error(`unresolved CSS function in markup: ${out.slice(0, 200)}`);
  return out;
}

const stdin = input === '-';
const src = stdin ? await Bun.stdin.text() : readFileSync(input, 'utf8');
const stem = stdin ? 'diagram' : basename(input, extname(input));
const outDir = resolve(outArg ?? (stdin ? '.' : dirname(input)));
mkdirSync(outDir, { recursive: true });

let t = performance.now();
const result = render(src, { fontFamily: FONT, fontFamilyMono: MONO, responsive: false });
const renderMs = performance.now() - t;

t = performance.now();
const tokens = theme === 'verdigris' ? verdigris() : {};
const svg = literal(result.svg, tokens);
const inlineMs = performance.now() - t;

const bg = tokens['--pele-bg'] ?? /--_bg:var\(--pele-bg,([^)]+)\)/.exec(result.svg)![1];
t = performance.now();
const png = new Resvg(svg, {
  background: bg,
  fitTo: { mode: 'zoom', value: 2 },
  font: { loadSystemFonts: true, defaultFontFamily: FONT, sansSerifFamily: FONT, monospaceFamily: MONO },
}).render();
const pngBytes = png.asPng();
const rasterMs = performance.now() - t;

const svgPath = join(outDir, `${stem}.${theme}.svg`);
const pngPath = join(outDir, `${stem}.${theme}.png`);
writeFileSync(svgPath, svg);
writeFileSync(pngPath, pngBytes);
const ms = (n: number) => Math.round(n * 10) / 10;
console.log(JSON.stringify({
  type: result.type, theme, width: result.width, height: result.height,
  renderMs: ms(renderMs), inlineMs: ms(inlineMs), rasterMs: ms(rasterMs),
  svg: svgPath, png: pngPath, pngWidth: png.width, pngHeight: png.height,
}));
