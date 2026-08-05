/**
 * Builds `public/patch-notes.json` — the five most recent merged PRs, each
 * reduced to one line a player can read.
 *
 * This runs at *deploy* time, not in the browser. The alternative was fetching
 * api.github.com from the menu, which costs a loading state, a failure state,
 * a markdown parser in the bundle, and a 60-request-per-hour unauthenticated
 * limit shared by everyone behind one NAT — all to render text that cannot
 * change between two deploys anyway, since a deploy is what publishes the build
 * the notes describe.
 *
 * The output is a build artifact and is gitignored. `npm run dev` therefore has
 * no file, the fetch 404s, and the chip does not render — which is also what a
 * fresh clone looks like, so that path is the one exercised most.
 *
 *   node scripts/patch-notes.mjs            # anonymous, fine for a public repo
 *   GITHUB_TOKEN=… node scripts/patch-notes.mjs
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OWNER = 'slimsheikki';
const REPO = 'surf-proto';

/** How many merges the panel shows. The UI scrolls past this; the file doesn't. */
const SHOWN = 5;

/**
 * How many closed PRs to ask for before filtering. Closed-unmerged PRs and PRs
 * with no note both fall out here, so this has to be comfortably larger than
 * SHOWN or a run of unmerged ones empties the panel.
 */
const FETCH = 50;

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../public/patch-notes.json');

/**
 * The one thing a PR has to carry to appear on the menu. Everything above this
 * heading stays as long and as technical as it needs to be — this is the part
 * written for whoever is about to press Play.
 */
const HEADING = /^\s{0,3}#{2,3}\s*patch\s*notes\s*$/i;

/**
 * Notes for the PRs that merged before the convention existed (#33–#39 have no
 * heading). Without these the panel would be empty until the next merge, which
 * is a worse first impression than a short list.
 *
 * Nothing new should ever be added here — a PR that merges from now on carries
 * its own note. This is a backfill, and it stops mattering the moment five more
 * PRs have landed.
 */
const BACKFILL = {
  39: 'XP bar sits ON the HP frame now. Before it floated. Looked wrong.',
  38: 'Health, XP and dash charges moved. Top-left corner now, painted panel. Big. Easy to see.',
  37: 'Enemies OFF now really means off, from the first second of the run. Big boss too.',
  36: 'New switch in Settings turns enemies off. Off is just ramps and you. No drones. No bombs. No boss.',
  35: 'Blessing rings show up in new places every time. Before, same five spots, every run.',
  34: 'New Beginner Mode. Hold W on a ramp and it strafes for you. Sweep the mouse to go fast.',
  33: 'W and S do nothing in the air now. Only A and D. They were killing your speed.',
};

/**
 * Pulls the text under a `## Patch Notes` heading, stopping at the next heading
 * of the same level or higher.
 *
 * Returns null when there is no such heading — deliberately, rather than
 * falling back to the first paragraph of the body. A fallback fails on the
 * screen instead of in this function, and it makes the heading optional, which
 * is the same as making it stop getting written.
 */
function extractNote(body) {
  if (!body) return null;
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => HEADING.test(line));
  if (start < 0) return null;

  const collected = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s{0,3}#{1,3}\s/.test(line)) break;
    collected.push(line);
  }

  // Markdown leftovers a note might reasonably pick up: a bullet dash, emphasis
  // markers, backticks. Anything more elaborate than this is a note that has
  // stopped being one sentence, which is a copy problem and not a parser's job.
  const note = collected
    .join(' ')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return note.length > 0 ? note : null;
}

/** "5 Aug" — short enough to sit opposite the PR number in a 280px column. */
function shortDate(iso) {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`;
}

async function listMergedPulls() {
  const url =
    `https://api.github.com/repos/${OWNER}/${REPO}/pulls` +
    `?state=closed&per_page=${FETCH}&sort=updated&direction=desc`;

  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': `${OWNER}-${REPO}-patch-notes`,
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GitHub said ${res.status} ${res.statusText}`);

  // `sort=updated` orders by last touch, not by merge, so the order the API
  // hands back is not the order the panel wants. Sorted here instead.
  return (await res.json())
    .filter((pr) => pr.merged_at)
    .sort((a, b) => new Date(b.merged_at) - new Date(a.merged_at));
}

async function main() {
  let pulls;
  try {
    pulls = await listMergedPulls();
  } catch (error) {
    // A failed generate must not fail the build: the site is perfectly usable
    // with no chip on the menu, and a red deploy over a changelog is a bad
    // trade. Written as an empty list so a stale file cannot survive either.
    console.warn(`[patch-notes] ${error.message} — writing an empty list`);
    await mkdir(dirname(OUT), { recursive: true });
    await writeFile(OUT, '[]\n');
    return;
  }

  const entries = [];
  for (const pr of pulls) {
    if (entries.length >= SHOWN) break;
    const note = extractNote(pr.body) ?? BACKFILL[pr.number] ?? null;
    if (!note) continue;
    entries.push({ number: pr.number, date: shortDate(pr.merged_at), note });
  }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(entries, null, 2)}\n`);

  const skipped = pulls.length - entries.length;
  console.log(
    `[patch-notes] ${entries.length} note${entries.length === 1 ? '' : 's'} written` +
      (skipped > 0 ? ` (${skipped} merged PRs had none)` : ''),
  );
}

await main();
