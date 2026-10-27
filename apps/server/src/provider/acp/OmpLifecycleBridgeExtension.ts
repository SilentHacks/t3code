// OMP drops updates outside an open ACP prompt; relay later turns and job completions.
// Prompt acknowledgements distinguish already-forwarded events from later runs.
// Always relay idempotent async terminal frames, including at the prompt boundary.
// OMP loads this unbundled source with Bun; imports must be Node built-ins only.
export const OMP_LIFECYCLE_BRIDGE_PROTOCOL_VERSION = 1;

export const OMP_LIFECYCLE_BRIDGE_EXTENSION_SOURCE = String.raw`
import * as net from "node:net";

const PROTOCOL = ${OMP_LIFECYCLE_BRIDGE_PROTOCOL_VERSION};

export default function t3LifecycleBridge(pi: any) {
  const socketPath = process.env.T3_OMP_BRIDGE_SOCKET;
  const token = process.env.T3_OMP_BRIDGE_TOKEN;
  if (!socketPath || !token) return;

  let sessionId: string | undefined;
  let promptActive = false;
  let runSeq = 0;
  let activeRun: number | null = null;
  let runFrames: Array<unknown> = [];
  let messageSeq = 0;
  let input = "";
  const socket = net.createConnection(socketPath);
  socket.setNoDelay(true);
  socket.on("error", () => {});
  socket.unref?.();

  const send = (message: Record<string, unknown>) => {
    if (socket.destroyed) return;
    socket.write(JSON.stringify(message) + "\n");
  };

  // Queued before any other write: T3 drops connections whose first line is not hello.
  send({ t: "hello", token, protocol: PROTOCOL });
  socket.on("data", (chunk: Buffer) => {
    input += chunk.toString("utf8");
    let newline = input.indexOf("\n");
    while (newline >= 0) {
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      newline = input.indexOf("\n");
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message?.t !== "prompt") continue;
      if (message.active === true) {
        promptActive = true;
        runFrames = [];
      } else {
        promptActive = false;
        // OMP answers a prompt only once idle: a run still open here began
        // after the response, so ACP never carried its frames.
        if (activeRun !== null && message.cancelled !== true) relay(runFrames);
        runFrames = [];
      }
      send({ t: "ack", seq: message.seq });
    }
  });

  const relay = (notifications: Array<unknown>) => {
    if (notifications.length === 0 || sessionId === undefined) return;
    send({ t: "frames", sessionId, notifications });
  };

  const emit = (update: Record<string, unknown>) => {
    if (sessionId === undefined) return;
    const notification = { sessionId, update };
    if (promptActive) runFrames.push(notification);
    else relay([notification]);
  };

  const remember = (ctx: any) => {
    try {
      const id = ctx?.sessionManager?.getSessionId?.();
      if (typeof id === "string" && id.length > 0) {
        if (sessionId === undefined) send({ t: "session", sessionId: id });
        sessionId = id;
      }
    } catch {}
  };

  const asyncState = (result: any): string | undefined => {
    const state = result?.details?.async?.state;
    return typeof state === "string" ? state : undefined;
  };

  const toolStatus = (result: any, terminal: boolean, isError: boolean): string => {
    const state = asyncState(result);
    if (state === "completed") return "completed";
    if (state === "failed" || state === "cancelled") return "failed";
    if (state !== undefined) return "in_progress";
    if (!terminal) return "in_progress";
    return isError ? "failed" : "completed";
  };

  const textContent = (result: any) => {
    const blocks = Array.isArray(result?.content) ? result.content : [];
    const text = blocks
      .filter((block: any) => block?.type === "text" && typeof block.text === "string")
      .map((block: any) => block.text)
      .join("\n");
    return text.length === 0 ? [] : [{ type: "content", content: { type: "text", text } }];
  };

  const toolUpdate = (event: any, terminal: boolean) => {
    const result = terminal ? event.result : event.partialResult;
    const update: Record<string, unknown> = {
      sessionUpdate: "tool_call_update",
      toolCallId: event.toolCallId,
      status: toolStatus(result, terminal, event.isError === true),
      rawOutput: result,
    };
    const content = textContent(result);
    if (content.length > 0) update.content = content;
    const state = asyncState(result);
    if (state !== undefined) {
      // A job's running frames ride ACP inside the prompt; after it, only the
      // terminal frame matters, and relaying progress would open idle wakes.
      // Terminal frames go out even mid-prompt: duplicates are no-ops.
      if (state !== "running" && state !== "queued" && sessionId !== undefined) {
        relay([{ sessionId, update }]);
      }
      return;
    }
    emit(update);
  };

  pi.on("session_start", (_event: any, ctx: any) => remember(ctx));
  pi.on("agent_start", (_event: any, ctx: any) => {
    remember(ctx);
    activeRun = ++runSeq;
    if (promptActive) runFrames = [];
  });
  pi.on("agent_end", (_event: any, ctx: any) => {
    remember(ctx);
    activeRun = null;
    if (promptActive) runFrames = [];
  });
  pi.on("message_end", (event: any, ctx: any) => {
    remember(ctx);
    const message = event?.message;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
    const messageId = "t3-bridge:" + String(runSeq) + ":" + String(++messageSeq);
    for (const block of message.content) {
      if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
        emit({ sessionUpdate: "agent_thought_chunk", messageId, content: { type: "text", text: block.thinking } });
      } else if (block?.type === "text" && typeof block.text === "string" && block.text) {
        emit({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: block.text } });
      }
    }
  });
  pi.on("tool_execution_start", (event: any, ctx: any) => {
    remember(ctx);
    emit({
      sessionUpdate: "tool_call",
      toolCallId: event.toolCallId,
      title: String(event.toolName),
      kind: event.toolName === "bash" ? "execute" : event.toolName === "read" ? "read" : event.toolName === "edit" || event.toolName === "write" ? "edit" : "other",
      status: "in_progress",
      rawInput: event.args,
    });
  });
  pi.on("tool_execution_update", (event: any, ctx: any) => {
    remember(ctx);
    toolUpdate(event, false);
  });
  pi.on("tool_execution_end", (event: any, ctx: any) => {
    remember(ctx);
    toolUpdate(event, true);
  });
}
`;
