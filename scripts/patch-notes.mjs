/**
 * Builds `public/patch-notes.json` — the five most recent merged PRs, each
 * reduced to one line a player can read.
 *
 * **The list comes from `git log`, not from the API, and that is the whole
 * point.** GitHub writes the PR title into the merge commit body:
 *
 *     Merge pull request #43 from slimsheikki/claude/upgrades-...
 *     Cartridges: tier-scaled upgrades with step-based progression
 *
 * The merge commit that triggers the deploy *is* `HEAD` of the checkout, so the
 * newest merge is in the list by construction. It cannot be a request that has
 * not landed yet, it cannot be rate-limited, and it needs no token.
 *
 * This replaced an API-driven version that ran a merge behind, every time. Not
 * because the API lagged — the deploy fires within seconds of the merge and the
 * API had it — but because the *note* did not exist yet. A PR with no
 * `## Patch Notes` heading was skipped, adding the heading afterwards triggers
 * no deploy, and the entry only appeared when the *next* merge redeployed. One
 * behind, permanently.
 *
 * A hand-written `## Patch Notes` heading is still honoured when the API is
 * reachable, as a pure enrichment: it can only ever replace the *text* of an
 * entry that git already put in the list. If GitHub is unreachable, the token
 * is missing or the request is refused, every entry keeps its title and the
 * panel is still correct and still current.
 *
 * This runs at *deploy* time, not in the browser. Fetching api.github.com from
 * the menu would cost a loading state, a failure state, a markdown parser in
 * the bundle and a 60-request-per-hour shared limit — to render text that
 * cannot change between two deploys anyway.
 *
 * The output is a build artifact and is gitignored. `npm run dev` therefore has
 * no file, the fetch 404s, and the chip does not render — which is also what a
 * fresh clone looks like, so that path is the one exercised most.
 *
 *   node scripts/patch-notes.mjs            # git only; no network needed
 *   GITHUB_TOKEN=… node scripts/patch-notes.mjs
 */

import { execFileSync } from 'node:child_process';
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
 * Returns null when there is no such heading, and `fromTitle` picks it up from
 * there. **This never falls back to the body**, which is the distinction that
 * matters: every body in this repo opens on a technical write-up, so a body
 * fallback fails on the screen instead of in a function. A title is a different
 * thing — short, always present, and already written for a person.
 */
function extractNote(body) {
  if (!body) return null;
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => HEADING.test(line));
  if (start < 0) return null;

  const collected = [];
  for (const line of lines.slice(start + 1)) {
    // A heading ends the note, and so does a thematic break — bodies in this
    // repo routinely close a section with `---` before the footer, and it was
    // being collected and rendered on the menu as a trailing "---".
    if (/^\s{0,3}#{1,3}\s/.test(line)) break;
    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) break;
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

/**
 * The note for a PR that carries no heading: its own title.
 *
 * **The heading used to be mandatory and that is why the panel kept going
 * stale.** Of the four PRs that merged after the convention landed, two had no
 * heading (#41, #43) and both were silently skipped — so the chip sat on an
 * older merge and read exactly like a changelog that had stopped updating. A
 * convention that has to be remembered on every single PR, including the ones
 * opened from a UI that has never heard of it, is a convention that will be
 * missed about half the time.
 *
 * So the heading is now an **override, not a requirement**. Write one when a
 * change deserves the blunt player-facing voice; skip it and the title shows
 * up, which is worse copy than a hand-written note and far better than nothing.
 *
 * Titles are only lightly cleaned: a conventional-commit prefix goes, since it
 * is addressed to reviewers rather than players, and the first letter is
 * raised. **Only that fixed set** — an earlier version stripped any word before
 * a colon and turned "Cartridges: tier-scaled upgrades" into "Tier-scaled
 * upgrades", eating the subject of the sentence.
 */
const REVIEWER_PREFIX = /^\s*(?:fix|feat|feature|chore|docs?|refactor|test|ci|build|perf|style|revert)(?:\([^)]*\))?!?:\s+/i;

function fromTitle(title) {
  if (!title) return null;
  const cleaned = title
    .replace(REVIEWER_PREFIX, '')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned[0].toUpperCase() + cleaned.slice(1);
}

/** "5 Aug" — short enough to sit opposite the PR number in a 280px column. */
function shortDate(iso) {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`;
}

/**
 * Merged PRs, read out of the repository itself.
 *
 * `%x00`-delimited so a subject or body containing the delimiter is impossible
 * — commit messages can contain anything, and splitting on a printable
 * character would eventually eat a note.
 *
 * Needs real history: `actions/checkout` clones at depth 1 by default, which
 * would leave exactly one commit and therefore at most one merge. The workflow
 * sets `fetch-depth: 0` for this reason.
 */
function mergedPullsFromGit() {
  // Git's own hex escapes, so the *argument* stays plain text — Node refuses to
  // spawn a process with a null byte in argv, which the obvious `\u0000` hits.
  // 0x1f and 0x1e are the unit and record separators and cannot appear in a
  // commit message typed by a human or written by GitHub.
  const SEP = '\u001f';
  const REC = '\u001e';
  let out;
  try {
    // Deliberately **not** `--merges`. A "Squash and merge" produces an
    // ordinary commit, not a merge commit, so filtering to merges would find
    // nothing the day the button is clicked — the panel would silently freeze
    // and look exactly like the bug this whole rewrite was for.
    out = execFileSync(
      'git',
      ['log', '--format=%H%x1f%cI%x1f%s%x1f%b%x1e', '-n', '400'],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
  } catch (error) {
    console.warn(`[patch-notes] git log failed: ${error.message}`);
    return [];
  }

  const pulls = [];
  for (const record of out.split(REC)) {
    const [, iso, subject, body] = record.split(SEP);
    if (!subject) continue;
    const line = subject.trim();
    const firstBodyLine = (body ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';

    // Both ways GitHub can land a PR:
    //
    //   merge commit   subject "Merge pull request #50 from owner/branch"
    //                  body    "The PR title"
    //   squash merge   subject "The PR title (#50)"
    //                  body    the squashed commit messages
    //
    // Rebase-and-merge leaves no PR number anywhere and cannot be detected;
    // it is the one strategy this cannot support, and it is noted in STATE.md.
    const asMerge = /^Merge pull request #(\d+) /.exec(line);
    const asSquash = /^(.*?)\s*\(#(\d+)\)$/.exec(line);
    if (!asMerge && !asSquash) continue;

    pulls.push({
      number: Number(asMerge ? asMerge[1] : asSquash[2]),
      mergedAt: iso.trim(),
      title: asMerge ? firstBodyLine : asSquash[1],
    });
  }
  // Already newest-first out of git log, but sorted explicitly so a rebase or a
  // hand-written merge cannot quietly reorder the panel.
  pulls.sort((a, b) => new Date(b.mergedAt) - new Date(a.mergedAt));

  // One PR, one entry. Scanning every commit rather than only merges means a
  // squashed PR commit can also be reachable through the merge that carried it,
  // and the panel must never list the same number twice.
  const seen = new Set();
  return pulls.filter((pull) => {
    if (seen.has(pull.number)) return false;
    seen.add(pull.number);
    return true;
  });
}

/**
 * Hand-written notes, keyed by PR number — best effort, never required.
 *
 * This is the *only* thing the network is used for, and a failure costs nothing
 * but the custom wording: every entry already has a title from git. So no
 * try/catch drama and no empty-list fallback; on any problem this returns an
 * empty map and the panel renders titles.
 */
async function fetchAuthoredNotes(numbers) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': `${OWNER}-${REPO}-patch-notes`,
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const notes = new Map();
  await Promise.all(
    numbers.map(async (number) => {
      try {
        const res = await fetch(
          `https://api.github.com/repos/${OWNER}/${REPO}/pulls/${number}`,
          { headers },
        );
        if (!res.ok) return;
        const note = extractNote((await res.json()).body);
        if (note) notes.set(number, note);
      } catch {
        /* titles are already correct; a missing override is not an error */
      }
    }),
  );
  return notes;
}

async function main() {
  const pulls = mergedPullsFromGit().slice(0, SHOWN);
  if (pulls.length === 0) {
    console.warn('[patch-notes] no merge commits found — writing an empty list');
    await mkdir(dirname(OUT), { recursive: true });
    await writeFile(OUT, '[]\n');
    return;
  }

  const authored = await fetchAuthoredNotes(pulls.map((p) => p.number));

  const entries = pulls.map((pull) => ({
    number: pull.number,
    date: shortDate(pull.mergedAt),
    note: authored.get(pull.number) ?? BACKFILL[pull.number] ?? fromTitle(pull.title),
  }));

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(entries, null, 2)}\n`);

  const custom = entries.filter((e) => authored.has(e.number) || BACKFILL[e.number]).length;
  console.log(
    `[patch-notes] ${entries.length} written, newest #${entries[0].number}` +
      ` (${custom} hand-written, ${entries.length - custom} from the PR title)`,
  );
}

await main();
