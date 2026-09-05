import { assert, describe, it } from "@effect/vitest";

import { canReplaceThreadTitle, deriveThreadTitleFromIssueKey } from "./threadTitles.ts";

describe("deriveThreadTitleFromIssueKey", () => {
  it("titles a thread from the issue key and what the message says about it", () => {
    assert.equal(
      deriveThreadTitleFromIssueKey("Bab-24123 fix login timing"),
      "Bab-24123 fix login timing",
    );
    assert.equal(
      deriveThreadTitleFromIssueKey("#Bab-24123: fix login timing"),
      "Bab-24123 fix login timing",
    );
    assert.equal(deriveThreadTitleFromIssueKey("ABC-123"), "ABC-123");
    // The rest of the message is only there to say which issue this is.
    assert.equal(deriveThreadTitleFromIssueKey("  ABC-7  \n\n  "), "ABC-7");
  });

  it("keeps the title to one short line", () => {
    const title = deriveThreadTitleFromIssueKey(
      "ABC-123 rework the reconnect handshake so a dropped tunnel recovers\nwithout a restart",
    );
    assert.equal(title, "ABC-123 rework the reconnect handshake so a");
    assert.isFalse(title?.includes("\n"));
    // 40 characters of message, cut at a word boundary rather than mid-word.
    assert.isAtMost((title?.length ?? 0) - "ABC-123 ".length, 40);
  });

  it("reads the key out of a tracker link when the message never spells it out", () => {
    assert.equal(
      deriveThreadTitleFromIssueKey(
        "have a look at https://favro.com/organization/abc/board?card=Bab-24123 please",
      ),
      "Bab-24123 have a look at please",
    );
    assert.equal(
      deriveThreadTitleFromIssueKey("https://linear.app/acme/issue/abc-4821/fix-the-thing"),
      "abc-4821",
    );
    assert.equal(
      deriveThreadTitleFromIssueKey("https://acme.atlassian.net/browse/PROJ-42"),
      "PROJ-42",
    );
  });

  it("does not read issue keys out of ordinary links", () => {
    assert.isNull(
      deriveThreadTitleFromIssueKey("see https://example.com/docs/Guide-2024 for the details"),
    );
  });

  it("leaves messages that only look like they name an issue alone", () => {
    // Version and encoding tokens are the common false positive; an all
    // lowercase prefix in free text is not treated as a key.
    assert.isNull(deriveThreadTitleFromIssueKey("switch the export to utf-8"));
    assert.isNull(deriveThreadTitleFromIssueKey("try this on gpt-5 instead"));
    assert.isNull(deriveThreadTitleFromIssueKey("bump react-19 in the web app"));
    // A one-letter prefix is a coordinate, not a project.
    assert.isNull(deriveThreadTitleFromIssueKey("move the panel to X-2"));
    assert.isNull(deriveThreadTitleFromIssueKey("Fix the flaky reconnect test"));
    assert.isNull(deriveThreadTitleFromIssueKey(""));
  });

  it("protects a key-derived title from being replaced later", () => {
    const title = deriveThreadTitleFromIssueKey("Bab-24123 fix login timing");
    assert.isNotNull(title);
    // A provider that later reports its own name for the thread passes no seed,
    // so it can only ever replace the placeholder.
    assert.isFalse(canReplaceThreadTitle(title));
    // A generated title arriving for a different seed is discarded too.
    assert.isFalse(canReplaceThreadTitle(title, "fix login timing"));
  });
});
