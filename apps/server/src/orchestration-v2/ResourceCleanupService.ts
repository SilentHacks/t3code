import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import { parseAttachmentFileExtension, resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export const reconcileHtmlRenderPublications = Effect.fn(
  "ResourceCleanupService.reconcileHtmlRenderPublications",
)(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const names = yield* fileSystem.readDirectory(config.attachmentsDir);
  yield* Effect.forEach(
    names.filter((name) => name.endsWith("-html.html.part")),
    (name) => {
      const attachmentId = name.slice(0, -".html.part".length);
      const path = resolveAttachmentRelativePath({
        attachmentsDir: config.attachmentsDir,
        relativePath: `${attachmentId}.html`,
      });
      return path === null ? Effect.void : fileSystem.remove(`${path}.part`, { force: true });
    },
    { discard: true, concurrency: 4 },
  );
  yield* Effect.forEach(
    names.filter((name) => name.endsWith("-html.html.pending")),
    (name) =>
      Effect.gen(function* () {
        const attachmentId = name.slice(0, -".html.pending".length);
        const path = resolveAttachmentRelativePath({
          attachmentsDir: config.attachmentsDir,
          relativePath: `${attachmentId}.html`,
        });
        if (path === null) return;
        if (!(yield* projections.isHtmlRenderAttachmentReferenced(attachmentId))) {
          yield* fileSystem.remove(path, { force: true });
        }
        yield* fileSystem.remove(`${path}.pending`, { force: true });
      }),
    { discard: true, concurrency: 4 },
  );
});

export class ResourceCleanupError extends Schema.TaggedError<ResourceCleanupError>()(
  "ResourceCleanupError",
  {
    operation: Schema.Literals(["terminal", "preview", "attachment", "scheduled-tasks"]),
    threadId: Schema.optional(Schema.String),
    attachmentId: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {}

export class ResourceCleanupService extends Context.Reference<{
  readonly cleanupScheduledTasks: (threadId: ThreadId) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupTerminals: (threadId: string) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupPreviews: (threadId: string) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupAttachments: (
    attachmentIds: ReadonlyArray<string>,
  ) => Effect.Effect<void, ResourceCleanupError>;
}>("t3/orchestration-v2/ResourceCleanupService", {
  defaultValue: () => ({
    cleanupScheduledTasks: () => Effect.void,
    cleanupTerminals: () => Effect.void,
    cleanupPreviews: () => Effect.void,
    cleanupAttachments: () => Effect.void,
  }),
}) {}

export const layer = Layer.effect(
  ResourceCleanupService,
  Effect.gen(function* () {
    const terminals = yield* TerminalManager.TerminalManager;
    const previews = yield* PreviewManager.PreviewManager;
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    // Startup runs before MCP accepts publications; unfinished final files can now be reconciled.
    yield* reconcileHtmlRenderPublications().pipe(
      Effect.catch((cause) =>
        Effect.logWarning(
          "Could not reconcile unfinished HTML publications; retaining their files.",
          { cause },
        ),
      ),
    );
    return {
      cleanupScheduledTasks: Effect.fn("ResourceCleanupService.cleanupScheduledTasks")(function (
        threadId: ThreadId,
      ) {
        return scheduledTasks
          .deleteForThread(threadId)
          .pipe(
            Effect.mapError(
              (cause) =>
                new ResourceCleanupError({ operation: "scheduled-tasks", threadId, cause }),
            ),
          );
      }),
      cleanupTerminals: Effect.fn("ResourceCleanupService.cleanupTerminals")(function (
        threadId: string,
      ) {
        return terminals
          .close({ threadId, deleteHistory: true })
          .pipe(
            Effect.mapError(
              (cause) => new ResourceCleanupError({ operation: "terminal", threadId, cause }),
            ),
          );
      }),
      cleanupPreviews: Effect.fn("ResourceCleanupService.cleanupPreviews")(function (
        threadId: string,
      ) {
        return previews
          .close({ threadId: ThreadId.make(threadId) })
          .pipe(
            Effect.mapError(
              (cause) => new ResourceCleanupError({ operation: "preview", threadId, cause }),
            ),
          );
      }),
      cleanupAttachments: Effect.fn("ResourceCleanupService.cleanupAttachments")(function (
        attachmentIds: ReadonlyArray<string>,
      ) {
        return Effect.forEach(
          attachmentIds,
          (attachmentId) =>
            Effect.gen(function* () {
              const extension = parseAttachmentFileExtension(attachmentId);
              if (
                extension === "html" &&
                (yield* projections
                  .isHtmlRenderAttachmentReferenced(attachmentId)
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new ResourceCleanupError({ operation: "attachment", attachmentId, cause }),
                    ),
                  ))
              )
                return;
              const path =
                resolveAttachmentPathById({
                  attachmentsDir: config.attachmentsDir,
                  attachmentId,
                }) ??
                (extension
                  ? resolveAttachmentRelativePath({
                      attachmentsDir: config.attachmentsDir,
                      relativePath: `${attachmentId}.${extension}`,
                    })
                  : null);
              if (path === null) return;
              yield* fileSystem.remove(path, { force: true }).pipe(
                Effect.andThen(fileSystem.remove(`${path}.txt`, { force: true })),
                Effect.andThen(fileSystem.remove(`${path}.pending`, { force: true })),
                Effect.mapError(
                  (cause) =>
                    new ResourceCleanupError({ operation: "attachment", attachmentId, cause }),
                ),
              );
            }),
          { discard: true, concurrency: 4 },
        );
      }),
    };
  }),
);
