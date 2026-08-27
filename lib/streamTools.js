// Stream + stop engine.
//
// Most of the free-tier providers in this gateway don't reliably expose
// token-level streaming on every model, so instead of half-supporting real
// upstream streaming, this takes the final text result from the fallback
// loop and re-emits it to the client as chunked Server-Sent Events. This
// gives consuming apps a consistent "typing" UX regardless of which
// provider actually answered, and lets the client abort early (stop
// engine) without waiting for the full text to render client-side.
//
// If a specific provider's SDK/API for a given model DOES support true
// upstream token streaming later, that can be swapped in per-provider
// without changing this file's contract: encodeAsSSE(text) always emits
// the same event shape.

const CHUNK_SIZE = 24; // characters per SSE chunk — tuned for a smooth typing feel

export function encodeAsSSE(text) {
  const encoder = new TextEncoder();
  let cancelled = false;

  const stream = new ReadableStream({
    async start(controller) {
      for (let i = 0; i < text.length && !cancelled; i += CHUNK_SIZE) {
        const chunk = text.slice(i, i + CHUNK_SIZE);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta: chunk })}\n\n`));
        // Small delay so the client sees incremental output instead of one burst.
        await new Promise((r) => setTimeout(r, 20));
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
      controller.close();
    },
    cancel() {
      // Fires when the client disconnects (e.g. AbortController on the fetch) —
      // this is the "stop engine" half: no more chunks are enqueued after this.
      cancelled = true;
    },
  });

  return stream;
}

export function sseHeaders() {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  };
}
