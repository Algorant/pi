// Words -> one self-contained Verdigris HTML document, or a Verdigris terminal view.
// Usage: bun render.ts <file> [outDir] [--trusted]
//        bun render.ts <file> --terminal [width]
// HTML mode writes <outDir>/<stem>.html (outDir defaults to the input's directory) with Words'
// styles.css and words/verdigris.css inlined, TeX math as SVG, `mermaid` fences as Pele SVG, and
// raw HTML removed unless --trusted. Terminal mode prints only Words ANSI at `width` columns
// (default 80) with its 256-colour accents remapped to Verdigris truecolour.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';

const DEPS = join(homedir(), '.local/share/pi-studio');
const PALETTE = join(import.meta.dir, '..', 'pele', 'verdigris.json');
const CSS = join(import.meta.dir, 'verdigris.css');
const SETUP =
  'mkdir -p ~/.local/share/pi-studio && cp ~/.pi/agent/skills/studio/package.json ~/.local/share/pi-studio/ && cd ~/.local/share/pi-studio && bun install';

const fail = (msg: string): never => {
  console.error(`words: ${msg}`);
  process.exit(1);
};

// Words, Pele and their renderers come from the one approved local Bun install, not this skill.
// Bun also resolves from its own package cache, so a hit outside the install still counts as missing.
const installed = (name: string): string => {
  let path: string;
  try {
    path = Bun.resolveSync(name, DEPS);
  } catch {
    return fail(`missing ${name} in ${DEPS}; one-time setup: ${SETUP}`);
  }
  if (!resolve(path).startsWith(DEPS + sep)) return fail(`missing ${name} in ${DEPS}; one-time setup: ${SETUP}`);
  return path;
};
const load = async (name: string): Promise<any> => import(installed(name));

const [input, ...rest] = process.argv.slice(2);
let outArg: string | undefined;
let terminal: number | undefined;
let trusted = false;
for (let i = 0; i < rest.length; i++) {
  const arg = rest[i];
  if (arg === '--trusted') trusted = true;
  else if (arg === '--terminal') terminal = /^\d+$/.test(rest[i + 1] ?? '') ? Number(rest[++i]) : 80;
  else if (outArg === undefined) outArg = arg;
  else fail(`unexpected argument ${arg}`);
}
if (!input) fail('usage: bun render.ts <file> [outDir] [--trusted] | <file> --terminal [width]');
if (terminal !== undefined && terminal <= 0) fail(`--terminal width must be a positive number of columns`);

// In trusted mode raw HTML is lifted out before rendering and put back afterwards, because Words'
// HTML session always drops it. Fenced code and inline code spans are left as written.
const MARKER = (i: number) => `WORDSRAWHTML${i}END`;
const TAG = /<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>/g;
function preserveHtml(src: string): { source: string; html: string[] } {
  const html: string[] = [];
  const keep = (tag: string) => MARKER(html.push(tag) - 1);
  let fence: string | null = null;
  const source = src
    .split('\n')
    .map((line) => {
      const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (open && open[1][0] === fence[0] && open[1].length >= fence.length && line.trim() === open[1]) fence = null;
        return line;
      }
      if (open) {
        fence = open[1];
        return line;
      }
      let out = '';
      for (let i = 0; ; ) {
        const start = line.indexOf('`', i);
        if (start < 0) return out + line.slice(i).replace(TAG, keep);
        const run = /^`+/.exec(line.slice(start))![0];
        const end = line.indexOf(run, start + run.length);
        if (end < 0) return out + line.slice(i).replace(TAG, keep);
        out += line.slice(i, start).replace(TAG, keep) + line.slice(start, end + run.length);
        i = end + run.length;
      }
    })
    .join('\n');
  return { source, html };
}
function restoreHtml(rendered: string, html: string[]): string {
  const raw = (marker: string) => html[Number(/^WORDSRAWHTML(\d+)END$/.exec(marker)![1])];
  return rendered
    .replace(/<p[^>]*data-markdown="p"[^>]*>\s*(WORDSRAWHTML\d+END)\s*<\/p>/g, (_, marker: string) => raw(marker))
    .replace(/WORDSRAWHTML\d+END/g, (marker) => raw(marker));
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function title(src: string, fallback: string): string {
  const heading = /^\s{0,3}#\s+(.+)$/m.exec(src)?.[1];
  if (!heading) return fallback;
  const text = heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*`]/g, '')
    .trim();
  return text || fallback;
}

const src = readFileSync(input, 'utf8');
const stem = basename(input, extname(input));
const t0 = performance.now();

if (terminal !== undefined) {
  const { renderToAnsi } = await load('@pierre/words');
  // Words' ANSI accents: 39 headings, links and task checkboxes; 203 inline code and math source;
  // 240 the blockquote bar. Anything else Words emits keeps its own colour.
  const ACCENTS: Record<string, string> = {
    '39': '#8ec07c', // fern
    '203': '#c66f70', // Verdigris red text
    '240': '#689d6a', // patina
  };
  const ansi = new TextDecoder().decode(renderToAnsi(src, { width: terminal, math: true }));
  const verdigris = ansi.replace(/\u001b\[(3|4)8;5;(\d+)m/g, (all, layer: string, index: string) => {
    const hex = ACCENTS[index];
    if (!hex) return all;
    const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return `\u001b[${layer}8;2;${rgb.join(';')}m`;
  });
  process.stdout.write(verdigris);
} else {
  const [{ createHtmlRenderer }, { createMermaidPlugin }, pele] = await Promise.all([
    load('@pierre/words/html'),
    load('@pierre/words/mermaid'),
    load('pele'),
  ]);
  const wordsCss = await Bun.file(installed('@pierre/words/styles.css')).text();
  const tokens = JSON.parse(readFileSync(PALETTE, 'utf8')) as Record<string, string>;

  let mermaid = 0;
  const plugin = createMermaidPlugin(pele);
  const counted = {
    render: (options: unknown) => {
      const out = plugin.render(options);
      if (out) mermaid++;
      return out;
    },
  };
  const { source, html: raw } = trusted ? preserveHtml(src) : { source: src, html: [] };
  const renderer = createHtmlRenderer({ math: true, plugins: { mermaid: counted } });
  const body = renderer.render(source, false).html;
  renderer.dispose();

  const outDir = resolve(outArg ?? dirname(input));
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${stem}.html`);
  const palette = Object.entries(tokens)
    .map(([key, value]) => `${key}:${value}`)
    .join(';');
  const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title(src, stem))}</title>
<style>${wordsCss}
.words-doc{${palette}}
${readFileSync(CSS, 'utf8')}</style>
</head>
<body>
<article class="words-doc" data-markdown="root">${restoreHtml(body, raw)}</article>
</body>
</html>
`;
  writeFileSync(outPath, page);
  console.log(
    JSON.stringify({
      mode: 'html',
      html: outPath,
      title: title(src, stem),
      bytes: page.length,
      mermaid,
      ms: Math.round((performance.now() - t0) * 10) / 10,
    }),
  );
}
