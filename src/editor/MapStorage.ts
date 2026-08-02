import { cloneMap, FreeMap, parseMap } from './MapData';

const MAPS_KEY = 'surf-proto.freeMaps.v1';
const LAST_MAP_KEY = 'surf-proto.freeMaps.last';

/**
 * Persistence for free-mode maps: one localStorage entry holding a name → map
 * table, plus a pointer at the last map opened so reopening free mode resumes
 * where the player left off.
 *
 * Every access is wrapped. `localStorage` throws outright when the browser has
 * storage disabled (Safari private browsing, some embedded webviews) and again
 * when a write exceeds the quota — and a map editor that dies on load because
 * saving is unavailable is far worse than one that simply cannot save. So the
 * failure mode everywhere here is "no maps" or "not saved", never an exception
 * out of the editor.
 */

type MapTable = Record<string, FreeMap>;

function readTable(): MapTable {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(MAPS_KEY);
  } catch {
    return {};
  }
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) return {};

  const table: MapTable = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    const map = parseMap(value);
    // A map that fails to parse is skipped, not repaired: the rest of the
    // table is still perfectly good and should stay loadable.
    if (map) table[name] = { ...map, name };
  }
  return table;
}

function writeTable(table: MapTable): boolean {
  try {
    localStorage.setItem(MAPS_KEY, JSON.stringify(table));
    return true;
  } catch {
    return false;
  }
}

/** Saved map names, alphabetical so the picker's order is stable between sessions. */
export function listMapNames(): string[] {
  return Object.keys(readTable()).sort((a, b) => a.localeCompare(b));
}

export function loadMap(name: string): FreeMap | null {
  const map = readTable()[name];
  return map ? cloneMap(map) : null;
}

/** Returns false when storage rejected the write, so the caller can say so. */
export function saveMap(map: FreeMap): boolean {
  const table = readTable();
  table[map.name] = cloneMap(map);
  if (!writeTable(table)) return false;
  rememberLastMap(map.name);
  return true;
}

export function deleteMap(name: string): void {
  const table = readTable();
  delete table[name];
  writeTable(table);
  if (lastMapName() === name) rememberLastMap(null);
}

/**
 * A name that isn't already taken, suffixing until it isn't.
 *
 * Needed because this module keys purely by name and `saveMap` overwrites
 * without asking. That is fine for your own maps — saving twice should replace,
 * not accumulate — but it is destructive for an imported one: a friend sends
 * you their "Mickey", you press Save, and yours is gone with no warning and no
 * undo. Renaming on the way in is the cheapest place to stop that.
 */
export function uniqueMapName(name: string): string {
  const taken = new Set(Object.keys(readTable()));
  if (!taken.has(name)) return name;

  const shared = `${name} (shared)`;
  if (!taken.has(shared)) return shared;
  // Bounded rather than `while (true)`: a thousand collisions on one name means
  // something is wrong, and a hung editor is a worse answer than a stale suffix.
  for (let i = 2; i < 1000; i++) {
    const candidate = `${shared} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return shared;
}

export function rememberLastMap(name: string | null): void {
  try {
    if (name === null) localStorage.removeItem(LAST_MAP_KEY);
    else localStorage.setItem(LAST_MAP_KEY, name);
  } catch {
    // Nothing to do — the pointer is a convenience, not state anything needs.
  }
}

export function lastMapName(): string | null {
  try {
    return localStorage.getItem(LAST_MAP_KEY);
  } catch {
    return null;
  }
}
