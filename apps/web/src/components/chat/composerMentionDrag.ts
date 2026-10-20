import { PullRequestContextMetadata } from "@t3tools/contracts";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { Option, Schema } from "effect";

export const COMPOSER_MENTION_DRAG_TYPE = "application/x-t3code-composer-mention";

/**
 * Drag payload type carrying a pull request, as JSON `PullRequestContextMetadata`. Set on drags
 * that start on a pull request row; the composer drops it as the same chip the `#` picker adds.
 */
export const COMPOSER_PULL_REQUEST_DRAG_TYPE = "application/x-t3code-pull-request";

const PullRequestDragPayload = Schema.fromJsonString(PullRequestContextMetadata);
const decodePullRequestPayload = Schema.decodeUnknownOption(PullRequestDragPayload);

/** The `COMPOSER_PULL_REQUEST_DRAG_TYPE` data for a pull request row's drag. */
export const encodePullRequestDragPayload = Schema.encodeSync(PullRequestDragPayload);

export const COMPOSER_MENTION_SOURCE_TYPE = "application/x-t3code-composer-mention-source";

export function composerMentionFromFileTab(surface: {
  kind: string;
  relativePath?: string;
  attachment?: unknown;
}): string | null {
  return surface.kind === "file" && surface.attachment === undefined && surface.relativePath
    ? serializeComposerFileLink(surface.relativePath)
    : null;
}

export function writeComposerMentionDrag(
  transfer: { setData(format: string, data: string): void },
  mentions: ReadonlyArray<string>,
  sourceKey?: string,
): void {
  transfer.setData(COMPOSER_MENTION_DRAG_TYPE, mentions.join(" "));
  if (sourceKey !== undefined) transfer.setData(COMPOSER_MENTION_SOURCE_TYPE, sourceKey);
}

export function composerMentionFromTreePath(treePath: string): string | null {
  const relativePath = treePath.replace(/\/+$/, "");
  if (relativePath.length === 0) {
    return null;
  }
  return serializeComposerFileLink(relativePath);
}

export function dataTransferHasComposerMention(types: ReadonlyArray<string>): boolean {
  return (
    types.includes(COMPOSER_MENTION_DRAG_TYPE) || types.includes(COMPOSER_PULL_REQUEST_DRAG_TYPE)
  );
}

export interface ComposerMentionDragTransfer {
  readonly types: ReadonlyArray<string>;
  getData(format: string): string;
  dropEffect: string;
  readonly effectAllowed?: string;
}

export interface ComposerMentionDragEvent {
  readonly dataTransfer: ComposerMentionDragTransfer;
  readonly nativeEvent: { stopPropagation(): void };
  preventDefault(): void;
  stopPropagation(): void;
}

/**
 * Deliberately narrow: there is no way to focus the editor from here. Focusing
 * it synchronously during the drop makes the not-yet-reconciled editor sync its
 * stale empty state back over the inserted mention; the insert path already
 * focuses on the next frame, after the editor has caught up.
 */
export interface ComposerMentionDropHost {
  readonly sourceKey?: string;
  insertMentionAtEnd(text: string): boolean;
  insertPullRequestAtEnd(pullRequest: PullRequestContextMetadata): boolean;
  setDragActive(active: boolean): void;
  onInsertRejected(reason: "busy" | "scope-mismatch"): void;
}

export interface ComposerMentionDragHandlers {
  onDragEnter(event: ComposerMentionDragEvent): void;
  onDragOver(event: ComposerMentionDragEvent): void;
  onDrop(event: ComposerMentionDragEvent): void;
}

export function makeComposerMentionDragHandlers(
  host: ComposerMentionDropHost,
): ComposerMentionDragHandlers {
  // Claim the event for the composer: React's stopPropagation only halts the
  // synthetic dispatch, so the native event must be stopped too or the
  // editor's own DOM listeners still process the drag.
  const claim = (event: ComposerMentionDragEvent): boolean => {
    if (!dataTransferHasComposerMention(event.dataTransfer.types)) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    event.nativeEvent.stopPropagation();
    return true;
  };
  return {
    onDragEnter(event) {
      if (claim(event)) {
        host.setDragActive(true);
      }
    },
    onDragOver(event) {
      if (!claim(event)) {
        return;
      }
      // The tree allows move only; file tabs copy; pull request links allow anything. Naming any
      // other effect makes the browser cancel the drop without firing it.
      event.dataTransfer.dropEffect = event.dataTransfer.effectAllowed === "copy" ? "copy" : "move";
      host.setDragActive(true);
    },
    onDrop(event) {
      if (!claim(event)) {
        return;
      }
      host.setDragActive(false);
      const sourceKey = event.dataTransfer.getData(COMPOSER_MENTION_SOURCE_TYPE);
      if (sourceKey && sourceKey !== host.sourceKey) {
        host.onInsertRejected("scope-mismatch");
        return;
      }
      if (event.dataTransfer.types.includes(COMPOSER_PULL_REQUEST_DRAG_TYPE)) {
        const pullRequest = decodePullRequestPayload(
          event.dataTransfer.getData(COMPOSER_PULL_REQUEST_DRAG_TYPE),
        );
        if (Option.isSome(pullRequest) && !host.insertPullRequestAtEnd(pullRequest.value)) {
          host.onInsertRejected("busy");
        }
        return;
      }
      const mention = event.dataTransfer.getData(COMPOSER_MENTION_DRAG_TYPE);
      if (mention.length === 0) {
        return;
      }
      if (!host.insertMentionAtEnd(`${mention} `)) {
        host.onInsertRejected("busy");
      }
    },
  };
}
