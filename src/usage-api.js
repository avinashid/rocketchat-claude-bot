// Read-only HTTP endpoint over .rc-usage.json, for the /usage slash command app.
// Deterministic: reads the counters file and returns JSON. No Claude invocation.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const PORT = Number(process.env.USAGE_API_PORT || 8791);
const TOKEN = process.env.USAGE_API_TOKEN || '';
const USAGE_FILE = process.env.USAGE_FILE
  || '/home/ubuntu/projects/rocketchat-claude-workspace/.rc-usage.json';

const send = (res, code, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/health') return send(res, 200, { ok: true });

  if (url.pathname !== '/usage') return send(res, 404, { error: 'not found' });

  if (TOKEN && req.headers['x-usage-token'] !== TOKEN) {
    return send(res, 401, { error: 'bad token' });
  }

  let usage;
  try {
    usage = JSON.parse(await readFile(USAGE_FILE, 'utf8'));
  } catch (err) {
    return send(res, 500, { error: `cannot read usage file: ${err.message}` });
  }

  const totals = Object.values(usage).reduce(
    (acc, r) => ({
      messages: acc.messages + (r.messages || 0),
      turns: acc.turns + (r.turns || 0),
      tools: acc.tools + (r.tools || 0),
      cost: acc.cost + (r.cost || 0),
    }),
    { messages: 0, turns: 0, tools: 0, cost: 0 },
  );

  const rid = url.searchParams.get('rid');
  send(res, 200, {
    rid,
    room: rid && usage[rid] ? usage[rid] : null,
    totals,
    rooms: Object.keys(usage).length,
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`usage-api listening on 0.0.0.0:${PORT} (file: ${USAGE_FILE})`);
});
