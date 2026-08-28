// Token counter + cutter, prompt compressor, and context window slicer.
//
// These don't call any external tokenizer API (keeps this free/fast) — they
// use a well-known approximation: ~4 characters per token for English text.
// It's not exact but is good enough for staying safely under a model's
// context window and for compression decisions.

export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function estimateMessagesTokens(messages) {
  return messages.reduce((sum, m) => sum + estimateTokens(typeof m.content === "string" ? m.content : ""), 0);
}

/**
 * Context window slicer: trims the OLDEST messages (keeping system prompt
 * and the most recent turns) so the conversation fits inside a model's
 * context window, leaving room for the response.
 */
export function sliceToContextWindow(messages, contextWindow, reserveForResponse = 1024) {
  const budget = contextWindow - reserveForResponse;
  if (estimateMessagesTokens(messages) <= budget) return messages;

  const systemMessages = messages.filter((m) => m.role === "system");
  const otherMessages = messages.filter((m) => m.role !== "system");

  const kept = [];
  let used = estimateMessagesTokens(systemMessages);

  // Walk backwards from the most recent message, keeping what fits.
  for (let i = otherMessages.length - 1; i >= 0; i--) {
    const cost = estimateTokens(otherMessages[i].content);
    if (used + cost > budget) break;
    kept.unshift(otherMessages[i]);
    used += cost;
  }

  return [...systemMessages, ...kept];
}

/**
 * Prompt compressor: light-touch text shrinking for long user messages —
 * collapses redundant whitespace/newlines and strips filler phrases.
 * Deliberately conservative: it never rewrites meaning, only trims noise,
 * so it's safe to apply automatically without changing the answer you get.
 *
 * Bug fix: the filler-phrase strip used to match these phrases ANYWHERE in
 * the text, case-insensitively, with no context check — so a message like
 * "Please note that our meeting is at 5pm" had "Please note that " silently
 * deleted, changing a real instruction into "our meeting is at 5pm" (still
 * grammatical, so the corruption wasn't obvious). These phrases are only
 * ever meaningless filler when they're being used as a transitional opener
 * — i.e. at the very start of the message/sentence, followed by a comma or
 * more filler text, not as the actual subject of a sentence. The regex now
 * requires that position (start of string, or right after ./!/?/\n plus
 * whitespace) instead of matching the phrase in isolation anywhere.
 */
const FILLER_PHRASES = ["please note that", "i just wanted to say that", "as you may know", "to be honest", "basically", "essentially"];
// (^|after sentence-ending punctuation + whitespace), one of the filler
// phrases, then either a comma or more whitespace — i.e. it must be acting
// as a sentence-opening transition, not a phrase embedded mid-sentence.
const FILLER_OPENER_RE = new RegExp(`(^|[.!?\\n]\\s*)(${FILLER_PHRASES.join("|")})[,:]?\\s+`, "gi");

export function compressPrompt(text) {
  if (!text || typeof text !== "string") return text;
  let out = text;
  out = out.replace(/\s{2,}/g, " ");
  out = out.replace(/\n{3,}/g, "\n\n");
  out = out.replace(FILLER_OPENER_RE, "$1");
  return out.trim();
}

export function compressMessages(messages) {
  return messages.map((m) => ({
    ...m,
    content: typeof m.content === "string" ? compressPrompt(m.content) : m.content,
  }));
}

// NOTE: an isSimpleRequest(messages, hasImage) helper used to live here,
// intended for a "try smaller/faster models first for simple requests"
// model-downgrade feature. It was dead code — defined but never imported or
// called by the orchestrator — so it's been removed rather than left as
// unused clutter. The idea is still worth building properly (see README's
// feature list) but needs the orchestrator's pool-selection logic changed
// to actually use it, not just the helper existing.
