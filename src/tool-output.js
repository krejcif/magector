// Caps long process output before it goes back to an MCP client. The full text is
// logged by the caller; the client gets the end, where the summary and errors are.

export const CLIENT_OUTPUT_LIMIT = 16 * 1024;
export const TRUNCATED_PREFIX = '…(truncated; full output in .magector/magector.log)';

/** `text` unchanged when it fits, else its last `limit` characters after TRUNCATED_PREFIX. */
export function clientOutputTail(text, limit = CLIENT_OUTPUT_LIMIT) {
  if (typeof text !== 'string' || text.length <= limit) return text;
  return `${TRUNCATED_PREFIX}\n${text.slice(-limit)}`;
}
