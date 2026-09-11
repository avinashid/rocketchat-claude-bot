// Split a long reply into Rocket.Chat-sized messages.
//
// Rocket.Chat's default Message_MaxAllowedSize is 5000 characters; we stay well
// under it. Splits prefer paragraph, then line, then hard-cut boundaries, and
// fenced code blocks are reopened across the seam so a split never leaves a
// half-open ``` fence rendering the rest of the channel as code.

const LIMIT = Number(process.env.BOT_MAX_MESSAGE_CHARS || 3500);

export function chunk(text, limit = LIMIT) {
  const body = String(text ?? "").trim();
  if (!body) return [];
  if (body.length <= limit) return [body];

  const parts = [];
  let rest = body;

  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit * 0.5) cut = limit; // no good boundary: hard cut

    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);

  // Balance code fences: if a part opens a fence it doesn't close, close it and
  // reopen on the next part.
  let openFence = null;
  return parts.map((part) => {
    let out = part;
    if (openFence !== null) out = `${openFence}\n${out}`;

    const fences = out.match(/^```.*$/gm) || [];
    if (fences.length % 2 === 1) {
      // Reopen with the same language tag on the next part.
      openFence = fences[fences.length - 1].trim();
      out = `${out}\n\`\`\``;
    } else {
      openFence = null;
    }
    return out;
  });
}
