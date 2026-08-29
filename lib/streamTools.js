// Stream + stop engine — REAL streaming version.
//
// Previous version waited for the full non-streaming response from the
// fallback loop, THEN re-chunked it with an artificial 20ms-per-chunk delay.
// That made /chat/stream strictly SLOWER than plain /chat (full generation
// time + the fake typing delay on top), while providing zero actual
// first-token latency benefit — the entire point of streaming.
//
// This version calls the provider's real `stream: true` endpoint (Groq,
// OpenRouter, Cerebras all support OpenAI-compatible SSE) and relays each
// token to the client as it arrives. First-token latency now matches the
// provider's real TTFT instead of "however long the whole answer takes."

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Parses an OpenAI-compatible SSE response body and relays each text delta
 * to the client as our own `data: {"delta": "..."}\n\n` event, ending with
 * `data: {"done": true}\n\n`. Returns a ReadableStream for use as a Response body.
 *
 * @param {Response} providerResponse - the raw fetch() Response from a
 *   provider's stream:true endpoint (body is itself an SSE stream of
 *   `data: {...}` lines in OpenAI's chat-completion-chunk shape).
 * @param {(fullText: string) => void} [onComplete] - optional callback fired
 *   once the stream finishes successfully, with the full accumulated text —
 *   used to still log/cache/score the completed response same as the
 *   non-streaming path.
 */
export function relayProviderStream(providerResponse, onComplete) {
  let cancelled = false;
  let fullText = "";

  const stream = new ReadableStream({
    async start(controller) {
      const reader = providerResponse.body.getReader();
      let buffer = "";

      try {
        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop(); // keep the last (possibly incomplete) line for next chunk

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === "[DONE]") continue;

            let json;
            try {
              json = JSON.parse(payload);
            } catch {
              continue; // skip malformed/partial JSON lines
            }

            const delta = json?.choices?.[0]?.delta?.content;
            if (delta) {
              fullText += delta;
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`));
            }
          }
        }
      } catch (err) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: err.message })}\n\n`));
      } finally {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
        controller.close();
        if (onComplete) onComplete(fullText);
      }
    },
    cancel() {
      // Fires when the client disconnects (e.g. AbortController on the
      // fetch) — the stop engine: the reader loop above checks `cancelled`
      // and stops relaying further chunks.
      cancelled = true;
    },
  });

  return stream;
}

/**
 * Fallback path for providers/models that don't support streaming (or when
 * every streaming-capable provider in the pool failed and we fell through
 * to a non-streaming one). Re-chunks an already-complete text response so
 * the client still gets a consistent SSE event shape — clearly a fallback,
 * not the primary path anymore.
 */
export function encodeAsSSE(text) {
  let cancelled = false;
  const CHUNK_SIZE = 24;

  const stream = new ReadableStream({
    async start(controller) {
      for (let i = 0; i < text.length && !cancelled; i += CHUNK_SIZE) {
        const chunk = text.slice(i, i + CHUNK_SIZE);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta: chunk })}\n\n`));
        await new Promise((r) => setTimeout(r, 20));
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
      controller.close();
    },
    cancel() {
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
