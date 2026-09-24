#!/usr/bin/env node
// Regenerates docs/images/install.svg from a real installer run.
//
//   node docs/images/make-hero.mjs
//
// The image is a faithful rendering of actual output, not a mockup: it runs
// `install.mjs --dry-run` against a throwaway home, substitutes that path for `~`,
// and renders the result with the same colours the terminal uses. Rerun it whenever
// the installer's output changes, so the README never shows a screenshot of
// something the tool no longer prints.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.dirname(path.dirname(HERE));
const OUT = path.join(HERE, 'install.svg');

// --- capture -------------------------------------------------------------------

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hero-'));
let raw;
try {
  raw = execFileSync(process.execPath, [
    path.join(KIT, 'install.mjs'), '--dry-run',
    '--vault', path.join(home, 'Documents', 'Obsidian Vault'),
  ], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
  });
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

const lines = raw
  .replaceAll(home, '~')
  // Machine-specific absolute paths add nothing to the picture and would date it to
  // one person's install layout.
  .replace(/^(\s+node:\s+v[\d.]+).*$/m, '$1')
  .replace(/^(\s+claude:\s+).*$/m, '$1on PATH')
  .split('\n');
while (lines.length && lines.at(-1).trim() === '') lines.pop();

// --- render --------------------------------------------------------------------

const PAD = 22;
const CHROME = 38;
const LH = 17;          // line height
const CH = 7.42;        // advance width of the 12.4px monospace face
const FS = 12.4;
const COLS = Math.max(...lines.map((l) => l.length), 64);
const W = Math.round(PAD * 2 + COLS * CH);
const H = CHROME + PAD + lines.length * LH + PAD - 4;

// Matches the installer's own palette.
const FG = '#c8d1d9';
const COLOURS = [
  [/^DRY RUN:/, '#c678dd', true],
  [/^>> /, '#56b6c2', true],
  [/^\s+~ would:/, '#c678dd', false],
  [/^\s+\+ /, '#89d185', false],
  [/^\s+! /, '#e5c07b', false],
  [/^\s+= /, '#7d8590', false],
  [/^-{10,}$/, '#3d4450', false],
  [/^(Dry run|Done):/, FG, true],
];

const esc = (s) => s
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const body = lines.map((line, i) => {
  if (line.trim() === '') return '';
  let fill = FG;
  let bold = false;
  for (const [re, colour, isBold] of COLOURS) {
    if (re.test(line)) { fill = colour; bold = isBold; break; }
  }
  const y = CHROME + PAD + i * LH + FS;
  // xml:space keeps the leading indentation, which carries the structure.
  return `  <text x="${PAD}" y="${y}" fill="${fill}"${bold ? ' font-weight="600"' : ''} xml:space="preserve">${esc(line)}</text>`;
}).filter(Boolean).join('\n');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Terminal output of node install.mjs --dry-run, listing each step it would take and reporting zero changes">
  <title>node install.mjs --dry-run</title>
  <rect width="${W}" height="${H}" rx="10" fill="#13171c"/>
  <rect width="${W}" height="${CHROME}" rx="10" fill="#1b2027"/>
  <rect y="${CHROME - 10}" width="${W}" height="10" fill="#1b2027"/>
  <line x1="0" y1="${CHROME}" x2="${W}" y2="${CHROME}" stroke="#2a313a" stroke-width="1"/>
  <circle cx="20" cy="19" r="5.5" fill="#3d4450"/>
  <circle cx="38" cy="19" r="5.5" fill="#3d4450"/>
  <circle cx="56" cy="19" r="5.5" fill="#3d4450"/>
  <text x="${Math.round(W / 2)}" y="24" fill="#7d8590" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="11.5" text-anchor="middle">node install.mjs --dry-run</text>
  <g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="${FS}">
${body}
  </g>
</svg>
`;

fs.writeFileSync(OUT, svg);
console.log(`wrote ${path.relative(KIT, OUT)}  (${lines.length} lines, ${W}x${H})`);
