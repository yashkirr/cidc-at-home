#!/usr/bin/env node
// CI/CD at home: a small web app that does what CI/CD does, on your own machine, for any GitHub repo.
// Build = main + the PRs you pick, merged into a private worktree, then the repo's build stages (pipeline.json).
// Deploy (one click, only after a green build) = merge those PRs on GitHub, check main matches, run the deploy stages.
// No dependencies: Node 22, git, gh (signed in). Listens on 127.0.0.1 only. README.md has the details.
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = join(homedir(), '.cicd-at-home');
const PORT = Number(process.env.PIPELINE_PORT || 4321);
const TOKEN = randomBytes(24).toString('hex');
const MAX_LOG = 4000;
mkdirSync(HOME, { recursive: true });

// Repos you added, remembered between runs. The first argument (or the launcher's repo) is added too.
const reposFile = join(HOME, 'repos.json');
let repos = existsSync(reposFile) ? JSON.parse(readFileSync(reposFile, 'utf8')) : [];
const saveRepos = () => writeFileSync(reposFile, JSON.stringify(repos, null, 1));

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function addRepo(path) {
  const dir = git(resolve(path), 'rev-parse', '--show-toplevel'); // throws if not a git repo
  if (!repos.includes(dir)) { repos.push(dir); saveRepos(); }
  return dir;
}

// pipeline.json: { "branch": "main", "environment": "prod", "build": [stage], "deploy": [stage] },
// stage = { "name": "...", "run": "shell command", "env": { "KEY": "value, ~/ = your home folder" } }.
export function readConfig(dir) {
  const file = join(dir, 'pipeline.json');
  if (!existsSync(file)) throw new Error(`No pipeline.json in ${dir}. The README shows what goes in it.`);
  const c = JSON.parse(readFileSync(file, 'utf8'));
  const stages = (list) => (Array.isArray(list) ? list : []).map((s) => {
    if (typeof s?.name !== 'string' || typeof s?.run !== 'string') throw new Error('Every stage in pipeline.json needs a name and a run command.');
    return { name: s.name, run: s.run, env: Object.fromEntries(Object.entries(s.env ?? {}).map(([k, v]) => [k, String(v).replace(/^~\//, homedir() + '/')])) };
  });
  const branch = c.branch ?? 'main';
  if (!/^\w[\w./-]*$/.test(branch)) throw new Error('pipeline.json: branch is not a valid branch name.');
  return { branch, environment: c.environment ?? 'prod', build: stages(c.build), deploy: stages(c.deploy) };
}

// One pipeline state for the open repo. Stages: batch, build stages, (gate), merge, deploy stages.
let state = null;
let child = null;
const clients = new Set();
const send = (msg) => { const data = `data: ${JSON.stringify(msg)}\n\n`; for (const c of clients) c.write(data); };

const fresh = { status: 'waiting', steps: [], log: [], started: null, ended: null };
const makeStages = (config) => [
  { id: 'batch', group: 'build', name: 'Batch PRs', run: `bash "${join(HERE, 'batch.sh')}"` },
  ...config.build.map((s, i) => ({ id: `build${i}`, group: 'build', ...s })),
  { id: 'merge', group: 'deploy', name: 'Merge on GitHub', run: `bash "${join(HERE, 'merge.sh')}"` },
  ...config.deploy.map((s, i) => ({ id: `deploy${i}`, group: 'deploy', ...s })),
].map((s) => ({ ...s, ...fresh, steps: [], log: [] }));

function openRepo(dir) {
  if (child) throw new Error('Wait for the running stage to finish, or stop it.');
  const config = readConfig(dir);
  const work = join(HOME, 'work', `${basename(dir)}-${createHash('sha256').update(dir).digest('hex').slice(0, 10)}`);
  state = { repo: dir, name: basename(dir), work, config, prs: [], picked: [], buildOk: false, buildEnv: {}, running: null, error: null, stages: makeStages(config) };
  send({ type: 'state', state: view() });
}

// What the page sees. Logs only on first connect; after that they stream as 'log' messages.
const view = (withLogs = false) => state && {
  ...state, repos, buildEnv: undefined, config: { branch: state.config.branch, environment: state.config.environment },
  stages: state.stages.map(({ env, run, log, ...s }) => (withLogs ? { ...s, log } : s)),
};

async function loadPrs() {
  // Only PRs into the pipeline's branch, from this repo itself: fork PRs would run a stranger's code with your keys.
  const out = await capture('gh', ['api', `repos/{owner}/{repo}/pulls?state=open&per_page=100&base=${state.config.branch}`, '--jq',
    '[.[] | select(.head.repo.full_name == .base.repo.full_name) | {number, title, draft, branch: .head.ref, author: .user.login}]'], state.repo);
  state.prs = JSON.parse(out);
  send({ type: 'state', state: view() });
}

function capture(cmd, args, cwd) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { cwd });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', rej);
    p.on('close', (code) => (code === 0 ? res(out) : rej(new Error(err.trim() || `${cmd} failed`))));
  });
}

// Runs one stage in the worktree. Lines starting "== " are the stage's steps; the last step fails if the stage does.
function runStage(stage, extraArgs, env) {
  return new Promise((res) => {
    Object.assign(stage, { ...fresh, status: 'running', steps: [], log: [], started: Date.now() });
    state.running = stage.id;
    send({ type: 'reset', stage: stage.id });
    send({ type: 'state', state: view() });
    const args = extraArgs.map((a) => ` ${a}`).join('');
    child = spawn('bash', ['-c', stage.run + args], {
      cwd: state.work, detached: true,
      env: { ...process.env, ...env, ...stage.env, PIPELINE_WORK: state.work, PIPELINE_BRANCH: state.config.branch, FORCE_COLOR: '0', CI: '1' },
    });
    let partial = '';
    const onData = (d) => {
      const lines = (partial + d).split(/\r?\n/);
      partial = lines.pop();
      for (const raw of lines) addLine(stage, raw);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => addLine(stage, `Could not start: ${e.message}`));
    child.on('close', (code, signal) => {
      if (partial) addLine(stage, partial);
      child = null;
      const ok = code === 0;
      for (const s of stage.steps) if (s.status === 'running') s.status = ok ? 'passed' : 'failed';
      Object.assign(stage, { status: ok ? 'passed' : signal ? 'stopped' : 'failed', ended: Date.now() });
      state.running = null;
      send({ type: 'state', state: view() });
      res(ok);
    });
  });
}

function addLine(stage, raw) {
  const line = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''); // strip terminal colours
  const step = line.match(/^== (.+)/);
  if (step) {
    for (const s of stage.steps) if (s.status === 'running') s.status = 'passed';
    stage.steps.push({ name: step[1], status: 'running' });
    send({ type: 'state', state: view() });
  }
  stage.log.push(line);
  if (stage.log.length > MAX_LOG) stage.log.splice(0, stage.log.length - MAX_LOG);
  send({ type: 'log', stage: stage.id, line });
}

function ensureWorktree() {
  if (existsSync(join(state.work, '.git'))) return;
  mkdirSync(dirname(state.work), { recursive: true });
  git(state.repo, 'fetch', '-q', 'origin', state.config.branch);
  git(state.repo, 'worktree', 'add', '--detach', state.work, `origin/${state.config.branch}`);
}

async function build(picked, env) {
  ensureWorktree();
  Object.assign(state, { buildOk: false, picked, buildEnv: env, error: null, stages: makeStages(state.config) });
  send({ type: 'state', state: view(true) });
  if (!(await runStage(state.stages[0], picked.map(String), env))) return;
  // The batch's own pipeline.json runs, as CI runs a PR's own workflow files.
  refreshStagesFromBatch();
  send({ type: 'state', state: view(true) });
  for (const s of state.stages.filter((s) => s.group === 'build' && s.id !== 'batch')) if (!(await runStage(s, [], env))) return;
  state.buildOk = true;
  send({ type: 'state', state: view() });
}

function refreshStagesFromBatch() {
  state.config = { ...readConfig(state.work), branch: state.config.branch };
  const [batch] = state.stages;
  state.stages = [batch, ...makeStages(state.config).slice(1)];
}

// Same AWS profile as the build that was checked, whatever the box says now.
async function deploy() {
  state.buildOk = false; // one deploy per green build
  for (const s of state.stages.filter((s) => s.group === 'deploy')) if (!(await runStage(s, [], state.buildEnv))) return;
}

// HTTP. Only this machine, only this page: Host must be ours, and every POST carries the page's secret token.
const page = readFileSync(join(HERE, 'index.html'), 'utf8');
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
async function body(req) { let b = ''; for await (const c of req) { b += c; if (b.length > 1e5) throw new Error('Too big'); } return JSON.parse(b || '{}'); }
const profileEnv = (p) => {
  if (p == null || p === '') return {};
  if (!/^[\w.@-]{1,64}$/.test(p)) throw new Error('That AWS profile name has odd characters.');
  return { AWS_PROFILE: p };
};

const server = http.createServer(async (req, res) => {
  if (![`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(req.headers.host)) return json(res, 403, { error: 'Wrong host.' });
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'", 'x-frame-options': 'DENY' });
      return res.end(page.replace('__TOKEN__', TOKEN));
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write(`data: ${JSON.stringify({ type: 'state', state: view(true), repos })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method !== 'POST' || req.headers['x-token'] !== TOKEN) return json(res, 403, { error: 'Not allowed.' });
    const b = await body(req);
    switch (url.pathname) {
      case '/api/repo': openRepo(addRepo(String(b.path))); await loadPrs().catch((e) => (state.error = `Could not list PRs: ${e.message}`)); break;
      case '/api/prs': await loadPrs(); break;
      case '/api/build': {
        if (!state) throw new Error('Add a repo first.');
        if (child) throw new Error('Something is already running.');
        const picked = (b.prs ?? []).map(Number);
        if (!picked.every((n) => state.prs.some((p) => p.number === n && !p.draft))) throw new Error('Pick ready PRs from the list. Drafts can not be merged.');
        build(picked, profileEnv(b.profile)).catch((e) => { state.error = e.message; send({ type: 'state', state: view() }); });
        break;
      }
      case '/api/deploy':
        if (child) throw new Error('Something is already running.');
        if (!state?.buildOk) throw new Error('Run a build first. Deploy unlocks when every build stage passes.');
        deploy().catch((e) => { state.error = e.message; send({ type: 'state', state: view() }); });
        break;
      case '/api/stop':
        if (child) process.kill(-child.pid, 'SIGTERM'); // the whole stage, not just bash
        break;
      default: return json(res, 404, { error: 'No such action.' });
    }
    json(res, 200, { ok: true });
  } catch (e) {
    json(res, 400, { error: e.message });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const first = process.argv[2] ?? repos[0];
  if (first) { try { openRepo(addRepo(first)); loadPrs().catch((e) => (state.error = `Could not list PRs: ${e.message}`)); } catch (e) { console.error(e.message); } }
  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://localhost:${PORT}/`;
    console.log(`CI/CD at home: ${url} (keep this window open; close it to stop)`);
    if (!process.env.PIPELINE_NO_OPEN) {
      const opener = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'explorer' : 'xdg-open';
      spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    }
  });
  // Closing the window stops a running stage too, rather than leaving a deploy running unseen.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { if (child) process.kill(-child.pid, 'SIGTERM'); process.exit(1); });
  server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is busy. Is the pipeline already open? Try ${`http://localhost:${PORT}/`}` : e.message); process.exit(1); });
}
