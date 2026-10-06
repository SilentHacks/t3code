import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";

/**
 * Drag payload type carrying a serialized composer mention. Set on drags that
 * start in the workspace file tree or file tabs so the composer can tell them apart from
 * OS file drags and plain text selections.
 */
export const COMPOSER_MENTION_DRAG_TYPE = "application/x-t3code-composer-mention";
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
  return types.includes(COMPOSER_MENTION_DRAG_TYPE);
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
 * What a mention drop is allowed to do to the composer. Deliberately narrow:
 * there is no way to focus the editor from here. Focusing it synchronously
 * during the drop makes the not-yet-reconciled editor sync its stale empty
 * state back over the inserted mention; the insert path already focuses on
 * the next frame, after the editor has caught up.
 */
export interface ComposerMentionDropHost {
  readonly sourceKey?: string;
  insertMentionAtEnd(text: string): boolean;
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
      // The tree allows move only; file tabs copy references without removing the tab.
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
