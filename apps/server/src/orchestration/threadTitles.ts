export const DEFAULT_THREAD_TITLE = "New thread";

export function canReplaceThreadTitle(currentTitle: string, titleSeed?: string): boolean {
  const trimmedCurrentTitle = currentTitle.trim();
  if (trimmedCurrentTitle === DEFAULT_THREAD_TITLE) {
    return true;
  }

  const trimmedTitleSeed = titleSeed?.trim();
  return trimmedTitleSeed !== undefined && trimmedTitleSeed.length > 0
    ? trimmedCurrentTitle === trimmedTitleSeed
    : false;
}

// Issue keys look like `Bab-24123` or `ABC-123`: a short prefix, a dash, and a
// few digits.
const ISSUE_KEY_PATTERN = /\b([A-Za-z][A-Za-z0-9_]*)-(\d{1,7})\b/g;
const MIN_ISSUE_KEY_PREFIX_LENGTH = 2;
const MAX_ISSUE_KEY_PREFIX_LENGTH = 10;
const URL_PATTERN = /\bhttps?:\/\/\S+/gi;
// Hosts where a link's path is known to name an issue, so a key found there is
// a key even when the surrounding message never spells it out.
const ISSUE_TRACKER_HOSTS = ["favro.com", "linear.app", "atlassian.net"] as const;
const MAX_TITLE_FRAGMENT_LENGTH = 40;

function isTrackerUrl(url: URL): boolean {
  return ISSUE_TRACKER_HOSTS.some(
    (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
  );
}

// In free text the prefix has to carry an uppercase letter. Without that rule
// every `utf-8`, `gpt-5` and `react-19` in a message reads as an issue key,
// which is a far worse outcome than missing an all-lowercase key. Keys taken
// out of a tracker link skip the check: the host has already vouched for them.
function findIssueKey(text: string, requireUppercase: boolean): string | null {
  for (const match of text.matchAll(ISSUE_KEY_PATTERN)) {
    const prefix = match[1] ?? "";
    if (
      prefix.length < MIN_ISSUE_KEY_PREFIX_LENGTH ||
      prefix.length > MAX_ISSUE_KEY_PREFIX_LENGTH
    ) {
      continue;
    }
    if (requireUppercase && prefix === prefix.toLowerCase()) {
      continue;
    }
    return match[0];
  }
  return null;
}

function findIssueKeyInTrackerLinks(urls: readonly string[]): string | null {
  for (const raw of urls) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (!isTrackerUrl(url)) continue;
    // Path and query both carry the key depending on the tracker (Linear and
    // Jira put it in the path, Favro in a `card` parameter). The host is not
    // searched: `foo-1.atlassian.net` names a tenant, not an issue.
    const key = findIssueKey(`${url.pathname}${url.search}`, false);
    if (key !== null) return key;
  }
  return null;
}

// What the message says beyond the key itself, as one short line. Empty when
// the message was only the key (or only a link to it).
function buildTitleFragment(text: string, key: string): string {
  const withoutKey = text.split(key).join(" ");
  const collapsed = withoutKey.replace(/\s+/g, " ").trim();
  // Whatever punctuation held the key to the sentence ("#Bab-1: fix login")
  // is noise once the key is gone.
  const cleaned = collapsed.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N})\]]+$/u, "");
  if (cleaned.length <= MAX_TITLE_FRAGMENT_LENGTH) {
    return cleaned;
  }
  const clipped = cleaned.slice(0, MAX_TITLE_FRAGMENT_LENGTH);
  const lastSpace = clipped.lastIndexOf(" ");
  return (lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped).trim();
}

/**
 * The title to give a thread whose first message names an issue, or `null` when
 * it names none. A key-derived title is exact by construction, so the caller
 * uses it instead of asking a model to invent one.
 */
export function deriveThreadTitleFromIssueKey(messageText: string): string | null {
  const urls = messageText.match(URL_PATTERN) ?? [];
  // Keys inside a link's path are only meaningful on a known tracker, so the
  // links come out of the text before it is searched.
  const textWithoutUrls = messageText.replace(URL_PATTERN, " ");
  const key = findIssueKey(textWithoutUrls, true) ?? findIssueKeyInTrackerLinks(urls);
  if (key === null) {
    return null;
  }
  const fragment = buildTitleFragment(textWithoutUrls, key);
  return fragment.length > 0 ? `${key} ${fragment}` : key;
}
