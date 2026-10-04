import { assert, describe, it } from "@effect/vitest";
import { catalogFromCommandEntries, isUnmanagedOmpPrompt } from "./OmpCommands.ts";

describe("OmpCommands", () => {
  it("splits native skill commands, preserves input hints, and applies the latest catalog entry", () => {
    assert.deepEqual(
      catalogFromCommandEntries([
        { name: "/compact", description: "old" },
        { name: "compact", description: " Reduce context ", input: { hint: " instructions " } },
        { name: "skill:review", description: " Review code " },
        { name: "skill:" },
        { name: "/fresh" },
        { name: "move" },
        { name: "/wt" },
        { name: "worktree" },
        { name: "fresh:" },
        { name: "/move:/elsewhere" },
        { name: " " },
        null,
      ]),
      {
        slashCommands: [
          { name: "compact", description: "Reduce context", input: { hint: "instructions" } },
        ],
        skills: [
          {
            name: "review",
            path: "skill://review/SKILL.md",
            enabled: true,
            description: "Review code",
          },
        ],
      },
    );
  });
  it("does not invent terminal commands absent from the provider catalog", () => {
    assert.deepEqual(catalogFromCommandEntries([]), { slashCommands: [], skills: [] });
  });
  it("blocks native whitespace and colon syntax without blocking ordinary text or skills", () => {
    for (const text of ["/fresh:", " /move:/tmp", "/wt clean", "/worktree:clean"]) {
      assert.isTrue(isUnmanagedOmpPrompt(text));
    }
    for (const text of ["Explain /fresh", "/freshness", "/skill:fresh", "/compact:"]) {
      assert.isFalse(isUnmanagedOmpPrompt(text));
    }
  });
});
