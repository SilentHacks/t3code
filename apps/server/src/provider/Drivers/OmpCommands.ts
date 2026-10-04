import type { ServerProviderSkill, ServerProviderSlashCommand } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const Command = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Struct({ hint: Schema.optional(Schema.String) })),
});

const decodeCommand = Schema.decodeUnknownOption(Command);

export interface OmpCommandCatalog {
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

const unmanagedCommands = new Set(["fresh", "move", "wt", "worktree"]);

export function isManagedOmpCommand(command: { readonly name: string }): boolean {
  return !unmanagedCommands.has(command.name.trim().replace(/^\//, "").split(/[\s:]/)[0]!);
}

export function isUnmanagedOmpPrompt(text: string): boolean {
  const command = /^\s*\/([^\s:]+)/.exec(text)?.[1];
  return command !== undefined && unmanagedCommands.has(command);
}

/** Shared by RPC discovery and live ACP available_commands_update projection. */
export function catalogFromCommandEntries(entries: ReadonlyArray<unknown>): OmpCommandCatalog {
  const commands = new Map<string, ServerProviderSlashCommand>();
  const skills = new Map<string, ServerProviderSkill>();
  for (const entry of entries) {
    const decoded = decodeCommand(entry);
    if (Option.isNone(decoded)) continue;
    const name = decoded.value.name.trim().replace(/^\//, "");
    // These rotate the native session/workspace behind the managed T3 thread.
    if (!name || !isManagedOmpCommand({ name })) continue;
    const description = decoded.value.description?.trim();
    if (name.startsWith("skill:")) {
      const skillName = name.slice(6).trim();
      if (skillName) {
        skills.set(skillName, {
          name: skillName,
          // OMP's catalog exposes a logical URI, not the winning filesystem root.
          path: `skill://${skillName}/SKILL.md`,
          enabled: true,
          ...(description ? { description } : {}),
        });
      }
    } else {
      const hint = decoded.value.input?.hint?.trim();
      commands.set(name, {
        name,
        ...(description ? { description } : {}),
        ...(hint ? { input: { hint } } : {}),
      });
    }
  }
  return {
    slashCommands: [...commands.values()].sort((a, b) => a.name.localeCompare(b.name)),
    skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}
