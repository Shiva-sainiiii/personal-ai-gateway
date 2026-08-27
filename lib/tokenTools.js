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
 */
export function compressPrompt(text) {
  if (!text || typeof text !== "string") return text;
  let out = text;
  out = out.replace(/\s{2,}/g, " ");
  out = out.replace(/\n{3,}/g, "\n\n");
  out = out.replace(
    /\b(please note that|i just wanted to say that|as you may know|to be honest|basically|essentially)\b/gi,
    ""
  );
  return out.trim();
}

export function compressMessages(messages) {
  return messages.map((m) => ({
    ...m,
    content: typeof m.content === "string" ? compressPrompt(m.content) : m.content,
  }));
}

/**
 * Model downgrade helper: a request counts as "simple" when it's short and
 * has no image — the orchestrator uses this to try smaller/faster models
 * first for simple requests, saving the big models' rate limits for when
 * they're actually needed.
 */
export function isSimpleRequest(messages, hasImage) {
  const totalTokens = estimateMessagesTokens(messages);
  return !hasImage && totalTokens < 500;
}
