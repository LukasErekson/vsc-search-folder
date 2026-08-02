import * as path from 'path';
import type { FolderEntry } from './tree';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScoredEntry {
  /** Display path relative to the search root (for the quick-pick label). */
  displayPath: string;
  /** Full absolute filesystem path. */
  fullPath: string;
  /** Fuzzy score (higher = better match). */
  score: number;
}

export interface ScoreConfig {
  /** Minimum fuzzy score (0–1) for an entry to be included in results. */
  threshold: number;
  /** Maximum number of results to return. */
  maxResults: number;
}

// ---------------------------------------------------------------------------
// Fuzzy scoring
// ---------------------------------------------------------------------------

// Scoring weights for `fuzzyScore` (higher is better). Tune these together;
// the JSDoc on `fuzzyScore` documents how they combine.
const CONSECUTIVE_BONUS = 20; // per consecutive matched character
const WORD_BOUNDARY_BONUS = 15; // match after _ - . / space
const START_OF_NAME_BONUS = 10; // match at the very start of the path
const EXACT_START_BONUS = 30; // contiguous match starting at position 0
const PATH_SEPARATOR_BONUS = 10; // match right after a / or \
const SHORT_NAME_RATIO = 2; // length bonus kicks in below this ratio (exact branch)
const SHORT_NAME_BONUS = 20; // max length bonus (exact branch)
const FUZZY_SHORT_NAME_RATIO = 2.5; // length bonus kicks in below this ratio (fuzzy branch)
const FUZZY_SHORT_NAME_BONUS = 15; // max length bonus (fuzzy branch)
const UNMATCHED_CHAR_PENALTY = 2; // penalty per unmatched character (fuzzy branch)
const THRESHOLD_SCALE = 50; // maps the 0–1 config threshold onto raw score space

/**
 * Score every entry against `query` using a fuzzy algorithm that mirrors
 * VS Code's Quick Open behaviour:
 *
 *  1. Characters of `query` must appear **in order** in the folder path
 *     (relative to `displayRoot`), so nested directories can be matched,
 *     e.g. `Models/Nomination` matches `Library/Models/Nomination`.
 *  2. `/` and `\` are interchangeable in the query and the matched paths, so
 *     the same query works on Linux and Windows.
 *  3. Matches are scored higher when they are:
 *      - consecutive
 *      - at word boundaries (camelCase, kebab-case, snake_case)
 *      - at the beginning of the folder path
 *      - in shorter folder paths (closer to query length)
 *
 * Returns entries sorted by score descending, capped at `maxResults`.
 */
export function scoreEntries(
  query: string,
  entries: FolderEntry[],
  displayRoot: string,
  config: ScoreConfig,
): ScoredEntry[] {
  // Normalise separators so "Models/Nomination" and "Models\Nomination"
  // behave identically on every platform.
  const lowerQuery = query.toLowerCase().replace(/\\/g, '/');

  const scored: ScoredEntry[] = [];

  for (const entry of entries) {
    // Match against the full path relative to the search root (with '/'
    // separators) instead of just the basename, so queries like
    // "Models/Nomination" can match "Library/Models/Nomination". The search
    // root itself is shown by its basename.
    const relativePath = path.relative(displayRoot, entry.fullPath);
    const displayPath = relativePath || path.basename(entry.fullPath);
    const normalizedPath = displayPath.replace(/\\/g, '/');
    const score = fuzzyScore(lowerQuery, normalizedPath.toLowerCase(), normalizedPath, config.threshold);
    if (score > 0) {
      scored.push({
        displayPath: normalizedPath,
        fullPath: entry.fullPath,
        score,
      });
    }
  }

  // Sort descending by score.
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, config.maxResults);
}

/**
 * Compute a fuzzy match score.
 *
 * @returns A positive score if `query` matches `lowerName`, or -1 if no match.
 *
 * Scoring breakdown (cumulative, higher is better):
 *  - +20 per consecutive matched character
 *  - +15 per word-boundary match (uppercase after lowercase, or after _ / - / . / space)
 *  - +10 per match at the very start of the path
 *  - +10 per match after a path separator (/ or \)
 *  - Length bonus: up to +15 bonus when path length ≈ query length
 */
export function fuzzyScore(
  lowerQuery: string,
  lowerName: string,
  originalName: string,
  threshold: number,
): number {
  if (lowerQuery.length === 0) {
    return -1;
  }

  // Fast exact-contains check – if it contains the query as a contiguous
  // substring it's always a match.
  const exactIdx = lowerName.indexOf(lowerQuery);
  if (exactIdx >= 0) {
    // Base score: contiguous match.
    let baseScore = lowerQuery.length * CONSECUTIVE_BONUS;
    // Bonus if it starts at a word boundary.
    if (exactIdx === 0) {
      baseScore += EXACT_START_BONUS; // starts at beginning of name
    } else {
      const prev = originalName[exactIdx - 1];
      if (isWordBoundary(prev)) {
        baseScore += WORD_BOUNDARY_BONUS;
      }
    }
    // Penalty proportional to how much longer the name is than the query
    // (shorter names get a bonus).
    const lengthRatio = lowerName.length / Math.max(lowerQuery.length, 1);
    if (lengthRatio < SHORT_NAME_RATIO) {
      baseScore += Math.round((1 - lengthRatio / SHORT_NAME_RATIO) * SHORT_NAME_BONUS);
    }
    return Math.max(baseScore, 1);
  }

  // ---- Fuzzy (non-contiguous) matching ----
  let qi = 0;
  let score = 0;
  let consecutive = 0;
  let totalMatched = 0;

  for (let ni = 0; ni < lowerName.length && qi < lowerQuery.length; ni++) {
    if (lowerName[ni] === lowerQuery[qi]) {
      qi++;
      totalMatched++;
      consecutive++;

      // Consecutive bonus.
      score += consecutive * CONSECUTIVE_BONUS;

      // Word-boundary bonus.
      if (ni === 0) {
        score += START_OF_NAME_BONUS; // start of name
      } else if (isWordBoundary(originalName[ni - 1])) {
        score += WORD_BOUNDARY_BONUS;
      }

      // Path-separator bonus.
      if (ni > 0 && (originalName[ni - 1] === '/' || originalName[ni - 1] === '\\')) {
        score += PATH_SEPARATOR_BONUS;
      }
    } else {
      consecutive = 0;
    }
  }

  // Did we match all characters?
  if (qi < lowerQuery.length) {
    return -1; // not all characters found in order
  }

  // Penalty for unmatched characters in the name (spread penalty).
  const unusedChars = lowerName.length - totalMatched;
  score -= unusedChars * UNMATCHED_CHAR_PENALTY;

  // Length bonus (prefer names closer to query length).
  const lengthRatio = lowerName.length / Math.max(lowerQuery.length, 1);
  if (lengthRatio < FUZZY_SHORT_NAME_RATIO) {
    score += Math.round((1 - lengthRatio / FUZZY_SHORT_NAME_RATIO) * FUZZY_SHORT_NAME_BONUS);
  }

  // Normalise so scores are comparable across different query lengths.
  const normalised = score / Math.max(lowerQuery.length, 1);

  // Apply the user-configurable threshold.
  if (normalised < threshold * THRESHOLD_SCALE) {
    return -1;
  }

  return Math.max(Math.round(normalised), 1);
}

/**
 * Returns true when `ch` is a character that typically separates "words" in
 * file/folder names.
 */
export function isWordBoundary(ch: string): boolean {
  return (
    ch === '_' ||
    ch === '-' ||
    ch === '.' ||
    ch === ' ' ||
    ch === '/' ||
    ch === '\\'
  );
}
