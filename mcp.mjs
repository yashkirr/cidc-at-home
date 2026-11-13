#!/usr/bin/env node
// Lets Claude Code (or any MCP client) see and drive the running pipeline: `claude mcp add cicd -- node /path/to/mcp.mjs`.
// MCP over stdio, no dependencies. It talks to the app on localhost with the token the app writes to ~/.cicd-at-home/mcp.json.
// No deploy or rollback tool: anything that changes what is live stays a click on the page.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const TAIL = 300; // log lines per stage: enough for a clash or a failing test, small enough for Claude to read

async function call(path, body = {}) {
  let app;
  try { app = JSON.parse(readFileSync(join(homedir(), '.cicd-at-home', 'mcp.json'), 'utf8')); } catch { throw new Error('The pipeline app is not running. Start it with ./start.sh.'); }
  let r;
  try { r = await fetch(`http://127.0.0.1:${app.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-token': app.token }, body: JSON.stringify(body) }); }
  catch { throw new Error('The pipeline app is not running. Start it with ./start.sh.'); }
  const out = await r.json();
  if (r.status === 403) throw new Error('The pipeline app restarted or is a different one. Try again.');
  if (!r.ok) throw new Error(out.error);
  return out;
}

const num = { type: 'integer', minimum: 1 };
const tools = {
  pipeline_status: {
    description: 'What the pipeline is doing now: open PRs, the newest build and its stages (status and steps), the deploy queue, what is live in each environment, any error, and recent builds. Start here when a build or deploy failed. A failed "batch" stage means picked PRs clash; its steps name them.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => { const v = await call('/api/status'); return v && { ...v, builds: v.builds?.slice(-10) }; },
  },
  build_log: {
    description: `Stages of one build from this run of the app, with the last ${TAIL} log lines of each. Use the build number from pipeline_status. Pass stage (its id or name) to get one stage only.`,
    inputSchema: { type: 'object', properties: { build: num, stage: { type: 'string' } }, required: ['build'] },
    run: async ({ build, stage }) => {
      const { number, stages } = await call('/api/build-log', { number: build });
      const picked = stage ? stages.filter((s) => s.id === stage || s.name === stage) : stages;
      if (!picked.length) throw new Error(`Build #${number} has no stage "${stage}". Stages: ${stages.map((s) => s.name).join(', ')}.`);
      return { number, stages: picked.map((s) => ({ ...s, log: s.log?.slice(-TAIL) })) };
    },
  },
  build: {
    description: 'Start a build: main plus these PR numbers, merged and checked. Same as ticking them and pressing Build. Use it after fixing a clash or a failing check (push the fix to the PR branch first). It does not deploy.',
    inputSchema: { type: 'object', properties: { prs: { type: 'array', items: num, minItems: 1 } }, required: ['prs'] },
    run: async ({ prs }) => { await call('/api/prs'); return call('/api/build', { prs }); }, // fresh PR list, so a PR opened since is pickable
  },
  retry_stage: {
    description: 'Run the failed stage of the last deploy again, and the stages after it, on the same build. Nothing is merged again. Pass that deploy\'s build number (deployRow in pipeline_status). The queue stays paused until resume_queue.',
    inputSchema: { type: 'object', properties: { build: num }, required: ['build'] },
    run: ({ build }) => call('/api/retry', { number: build }),
  },
  resume_queue: {
    description: 'Unpause the deploy queue after a failed deploy, so queued builds deploy again. Only do this once the cause is fixed or the user says so.',
    inputSchema: { type: 'object', properties: {} },
    run: () => call('/api/queue', { action: 'resume' }),
  },
};

async function handle({ id, method, params }) {
  if (method === 'initialize') return { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'cicd-at-home', version: '1.0.0' } };
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: Object.entries(tools).map(([name, { description, inputSchema }]) => ({ name, description, inputSchema })) };
  if (method === 'tools/call') {
    const tool = tools[params?.name];
    if (!tool) throw Object.assign(new Error(`No tool ${params?.name}`), { code: -32602 });
    try { return { content: [{ type: 'text', text: JSON.stringify(await tool.run(params.arguments ?? {}), null, 1) }] }; }
    catch (e) { return { content: [{ type: 'text', text: e.message }], isError: true }; }
  }
  if (id === undefined) return; // a notification
  throw Object.assign(new Error(`No method ${method}`), { code: -32601 });
}

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  let msg;
  try { msg = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); continue; }
  const reply = (body) => msg.id !== undefined && process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...body }) + '\n');
  handle(msg).then((result) => reply({ result }), (e) => reply({ error: { code: e.code ?? -32603, message: e.message } }));
}
