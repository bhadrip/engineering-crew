// Codex 0.163 reports an upstream openai-model header through these two
// codex_core::session diagnostics. The regular exec JSON omits this header.
// Set this filter only on the one ephemeral exec child whose stderr we read.
export const codexModelLogFilter = 'error,codex_core::session=info';

const timestamp = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z`;
const slug = '[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}';
const match = new RegExp(`^${timestamp} +INFO codex_core::session: server reported model (${slug}) \\(matches requested model\\)$`);
const reroute = new RegExp(`^${timestamp} +WARN codex_core::session: server reported model (${slug}) while requested model was ${slug}$`);
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const maxLine = 512;

export function codexModelTelemetry() {
  let tail = '', oversized = false, threadId = null, model = null, ambiguous = false;
  function consume(line) {
    const observation = match.exec(line) ?? reroute.exec(line);
    if (!observation) return;
    if (model !== null && model !== observation[1]) ambiguous = true;
    model = observation[1];
  }
  return {
    // The diagnostic has no thread field. Scope it to one CLI process with
    // exactly one native thread.started ID. Subagents are disabled by Crew.
    thread(id) {
      if (typeof id !== 'string' || !uuid.test(id) || (threadId !== null && threadId !== id)) ambiguous = true;
      threadId = id;
    },
    write(chunk) {
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf('\n', start);
        const end = newline === -1 ? chunk.length : newline;
        if (tail.length + end - start > maxLine) {
          oversized = true;
          tail = '';
        }
        if (!oversized) tail += chunk.slice(start, end);
        if (newline === -1) return;
        if (!oversized) consume(tail);
        tail = '';
        oversized = false;
        start = newline + 1;
      }
    },
    finish(expectedThread) {
      if (!oversized) consume(tail);
      tail = '';
      return !ambiguous && threadId !== null && threadId === expectedThread ? model : null;
    },
  };
}
