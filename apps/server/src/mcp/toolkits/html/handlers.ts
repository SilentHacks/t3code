// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import { CommandId, OrchestratorMcpFailure, TurnItemId } from "@t3tools/contracts";
import { readHtmlRenderReference, type HtmlRenderReference } from "@t3tools/shared/htmlRender";
import * as Effect from "effect/Effect";

import * as HtmlRender from "../../../htmlRender/HtmlRender.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { HtmlPreviewToolkit, HtmlRenderToolkit, type HtmlToolkit } from "./tools.ts";

const INVALID_PAGE_ERRORS = new Set([
  "HtmlRenderImagesNotFoundError",
  "HtmlRenderImageTooLargeError",
  "HtmlRenderPageTooLargeError",
  "HtmlRenderViewportHeightError",
]);

const toFailure = (error: { readonly _tag: string; readonly message: string }) =>
  new OrchestratorMcpFailure({
    code: INVALID_PAGE_ERRORS.has(error._tag) ? "invalid_request" : "orchestration_error",
    message: error.message,
  });

const handlers = {
  // Local-file access limits this host browser to T3-launched agents.
  html_preview: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const htmlRender = yield* HtmlRender.HtmlRender;
      const { png, ...preview } = yield* htmlRender.preview(input).pipe(Effect.mapError(toFailure));
      return {
        ...preview,
        screenshot: {
          mimeType: "image/png" as const,
          data: png,
          width: preview.width,
          height: preview.capturedHeight,
        },
      };
    }),
  ),
  html_render: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "html_render");
      const htmlRender = yield* HtmlRender.HtmlRender;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
      const identity = digest(
        `${thread.threadId.length}:${thread.threadId}${input.publicationKey ?? NodeCrypto.randomUUID()}`,
      );
      const itemId = TurnItemId.make(`item:html-render:${identity}`);
      const requestHash = NodeCrypto.createHash("sha256")
        .update(`${input.html.length}:`)
        .update(input.html)
        .update(`${input.title.length}:`)
        .update(input.title)
        .update(String(input.height))
        .digest("hex");
      const committed = Effect.fnUntraced(function* (
        item: { readonly type: string; readonly input?: unknown; readonly output?: unknown } | null,
      ): Effect.fn.Return<HtmlRenderReference | undefined, OrchestratorMcpFailure> {
        if (item?.type !== "dynamic_tool" || typeof item.input !== "object" || item.input === null)
          return undefined;
        const publication = (item.input as { publication?: { requestHash?: string } }).publication;
        if (publication?.requestHash !== requestHash) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "The publication key was already used for different HTML, title, or height.",
          });
        }
        return readHtmlRenderReference(
          (item.output as { htmlRender?: unknown } | undefined)?.htmlRender,
        );
      });
      const prior =
        input.publicationKey === undefined
          ? null
          : yield* threads
              .getTurnItem({ threadId: thread.threadId, itemId })
              .pipe(Effect.mapError(toFailure));
      let reference = yield* committed(prior?.item ?? null);
      if (reference === undefined) {
        const staged = yield* htmlRender
          .preparePublication({
            threadId: thread.threadId,
            html: input.html,
            title: input.title,
            height: input.height,
          })
          .pipe(Effect.mapError(toFailure));
        const commandId = CommandId.make(`command:html-render:${identity}`);
        // The receipt and its projection commit before dispatch resolves. An ambiguous failure
        // deliberately leaves an orphan for reconciliation instead of deleting published bytes.
        yield* threads
          .dispatch({
            type: "html-render.publish",
            commandId,
            threadId: thread.threadId,
            providerInstanceId: thread.providerInstanceId,
            providerSessionId: thread.providerSessionId,
            itemId,
            requestHash,
            reference: staged,
          })
          .pipe(Effect.mapError(toFailure));
        const saved = yield* threads
          .getTurnItem({ threadId: thread.threadId, itemId })
          .pipe(Effect.mapError(toFailure));
        reference = yield* committed(saved.item);
        if (reference === undefined) {
          return yield* new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "The HTML publication could not be verified.",
          });
        }
        if (reference.attachmentId !== staged.attachmentId) {
          yield* htmlRender.discardPublication(staged);
        }
        yield* htmlRender.confirmPublication(reference);
      }
      return {
        htmlRender: reference,
        message:
          "Published to this thread. The reader's client may not have displayed it yet; don't restate the page in your reply.",
      };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof HtmlToolkit.tools>;

export const layerPreview = McpToolAccess.toLayer(HtmlPreviewToolkit, {
  html_preview: handlers.html_preview,
});

export const layerRender = McpToolAccess.toLayer(HtmlRenderToolkit, {
  html_render: handlers.html_render,
});
