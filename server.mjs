#!/usr/bin/env node
// CI/CD at home: a small web app that does what CI/CD does, on your own machine, for any GitHub repo.
// Build = main + the PRs you pick, merged into a private worktree, then the repo's build stages (pipeline.json).
// Deploy (one click, only after a green build) = merge those PRs on GitHub, check main matches, run the deploy stages.
// No dependencies: Node 22, git, gh (signed in). Listens on 127.0.0.1 only. README.md has the details.
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = join(homedir(), '.cicd-at-home');
const PORT = Number(process.env.PIPELINE_PORT || 4321);
const TOKEN = randomBytes(24).toString('hex');
// Agents (mcp.mjs) get their own key, so the app can tell their calls from yours, log each one, and limit what they do.
const AGENT_TOKEN = randomBytes(24).toString('hex');
const MAX_LOG = 4000;
const BOOT = Date.now(); // a page left open from an older server reloads itself when it sees a new one
mkdirSync(HOME, { recursive: true });

// Repos you added, remembered between runs. The first argument (or the launcher's repo) is added too.
const reposFile = join(HOME, 'repos.json');
let repos = existsSync(reposFile) ? JSON.parse(readFileSync(reposFile, 'utf8')) : [];
const saveRepos = () => writeFileSync(reposFile, JSON.stringify(repos, null, 1));

// Audit trail: every call an agent makes, allowed or not, one JSON line each. Only appended to, never rewritten.
const agentFile = join(HOME, 'agent-log.jsonl');
// The page shows the last 100, so read only the file's tail: it grows with every status check an agent makes.
function lastEntries() {
  if (!existsSync(agentFile)) return [];
  const fd = openSync(agentFile, 'r');
  try {
    const size = fstatSync(fd).size, buf = Buffer.alloc(Math.min(size, 256 * 1024));
    readSync(fd, buf, 0, buf.length, size - buf.length);
    return buf.toString('utf8').split('\n').slice(size > buf.length ? 1 : 0).filter(Boolean).slice(-100).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  } finally { closeSync(fd); }
}
const agentLog = lastEntries();
function audit(entry) {
  agentLog.push(entry);
  if (agentLog.length > 100) agentLog.shift();
  try { appendFileSync(agentFile, JSON.stringify(entry) + '\n', { mode: 0o600 }); } catch (e) { console.error(`Could not write the agent log: ${e.message}`); }
  send({ type: 'agent', entry });
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function addRepo(path) {
  const dir = git(resolve(path), 'rev-parse', '--show-toplevel'); // throws if not a git repo
  if (!repos.includes(dir)) { repos.push(dir); saveRepos(); }
  return dir;
}

// pipeline.json: { "branch": "main", "environment": "prod", "build": [stage], "deploy": [stage] },
// stage = { "name": "...", "run": "shell command", "env": { "KEY": "value, ~/ = your home folder" }, "parallel": true }.
// "parallel" starts a stage together with the one before it. Ignored on a list's first stage, so a deploy stage never
// runs beside the merge. "environment" (deploy stages): what the stage makes live, e.g. "TestFlight"; default: the
// pipeline's own "environment". Each environment goes live when the merge and all of its own stages pass.
export function readConfig(dir) {
  const file = join(dir, 'pipeline.json');
  if (!existsSync(file)) throw new Error(`No pipeline.json in ${dir}. The README shows what goes in it.`);
  const c = JSON.parse(readFileSync(file, 'utf8'));
  const stages = (list, environment) => (Array.isArray(list) ? list : []).map((s, i) => {
    if (typeof s?.name !== 'string' || typeof s?.run !== 'string') throw new Error('Every stage in pipeline.json needs a name and a run command.');
    if (s.environment != null && (typeof s.environment !== 'string' || !s.environment.trim())) throw new Error(`pipeline.json: "${s.name}" has an empty environment.`);
    return { name: s.name, run: s.run, parallel: i > 0 && s.parallel === true, environment: environment && (s.environment?.trim() ?? environment), env: Object.fromEntries(Object.entries(s.env ?? {}).map(([k, v]) => [k, String(v).replace(/^~\//, homedir() + '/')])) };
  });
  const branch = c.branch ?? 'main';
  if (!/^\w[\w./-]*$/.test(branch)) throw new Error('pipeline.json: branch is not a valid branch name.');
  const environment = typeof c.environment === 'string' && c.environment.trim() ? c.environment : 'prod';
  return { branch, environment, build: stages(c.build), deploy: stages(c.deploy, environment) };
}

// One pipeline state for the open repo. Stages: batch, build stages, (gate), merge, deploy stages.
// Every batch is a numbered build. state.build is the newest one; state.queue holds green (or still building) builds
// waiting to deploy, oldest first; state.deploy is the one deploying (or the last one that did). Each build in flight
// has its own worktree and is stacked on the one in front of it, so they can deploy one after another without rebuilds.
let state = null;
const clients = new Set();
const send = (msg) => { const data = `data: ${JSON.stringify(msg)}\n\n`; for (const c of clients) c.write(data); };

const fresh = { status: 'waiting', steps: [], log: [], started: null, ended: null, interrupted: false };
const makeStages = (config) => [
  { id: 'batch', group: 'build', name: 'Batch PRs', run: `bash "${join(HERE, 'batch.sh')}"` },
  ...config.build.map((s, i) => ({ id: `build${i}`, group: 'build', ...s })),
  { id: 'merge', group: 'deploy', name: 'Merge on GitHub', run: `bash "${join(HERE, 'merge.sh')}"` },
  ...config.deploy.map((s, i) => ({ id: `deploy${i}`, group: 'deploy', ...s })),
].map((s) => ({ ...s, ...fresh, steps: [], log: [] }));
const newRun = (work, picked = [], buildEnv = {}, under = null, number = null, by = null) => ({
  number, at: Date.now(), by, work, picked, buildEnv, under, buildOk: false, head: null, kids: new Set(), done: false, bad: null,
  prs: picked.map((n) => ({ number: n, title: state.prs.find((p) => p.number === n)?.title ?? '' })), stages: makeStages(state.config),
});

const deploying = () => (state?.deploy && !state.deploy.done ? state.deploy : null);
const building = () => !!state && state.build !== deploying() && state.build.kids.size > 0;
// The next build can start once the newest one has its batch (its commit to stack on), even while its checks run.
const batching = () => building() && !state.build.head;
const kids = (runs) => runs.flatMap((r) => (r ? [...r.kids] : []));
// A stage that just exited can still be listed until its close event, so a failed kill must not skip the others.
const stop = (cs) => { for (const c of cs) try { process.kill(-c.pid, 'SIGTERM'); } catch {} };
const children = () => kids([...new Set([state?.build, ...(state?.queue ?? []), state?.deploy])]);
const inFlight = () => [deploying(), ...(state?.queue ?? [])].filter(Boolean);
const saveRecord = () => writeFileSync(state.recordFile, JSON.stringify(state.record, null, 1));
// The last deploy with its stage results and logs, so Retry still works after the app restarts. Logs can hold secrets,
// so only you can read the file; written whole then renamed, so a kill mid-write leaves the old one.
const saveDeploy = () => {
  const r = state?.deploy;
  if (!r) return;
  try {
    writeFileSync(state.deployFile + '.tmp', JSON.stringify({ number: r.number, at: r.at, by: r.by ?? null, work: r.work, picked: r.picked, buildEnv: r.buildEnv, head: r.head, prs: r.prs,
      rollbackOf: r.rollbackOf ?? null, live: !!r.live, deployedSha: r.deployedSha ?? null,
      stages: r.stages.map((s) => ({ id: s.id, status: s.status, steps: s.steps, log: s.log, started: s.started, ended: s.ended, interrupted: !!s.interrupted, pid: s.status === 'running' ? s.pid : null })) }), { mode: 0o600 });
    renameSync(state.deployFile + '.tmp', state.deployFile);
  } catch (e) { console.error(`Could not save the deploy: ${e.message}`); }
};
// Stage commands come from the build's own pipeline.json, as when it ran; only results come from the file.
// A stage that was running when the app stopped comes back stopped, so Retry can run it again.
function restoreDeploy() {
  if (!existsSync(state.deployFile)) return null;
  try {
    const d = JSON.parse(readFileSync(state.deployFile, 'utf8'));
    // A newer build used its folder since: nothing there to retry, and its pipeline.json is not this build's.
    if (git(String(d.work), 'rev-parse', 'HEAD^{tree}') !== git(String(d.work), 'rev-parse', `${d.head}^{tree}`)) return null;
    const run = newRun(String(d.work), d.picked.map(Number), profileEnv(d.buildEnv?.AWS_PROFILE), null, Number(d.number));
    const byId = new Map(makeStages(readConfig(run.work)).map((s) => [s.id, s]));
    run.stages = d.stages.filter((s) => byId.has(s.id)).map((s) => {
      const st = { ...byId.get(s.id), status: s.status, steps: s.steps, log: s.log, started: s.started, ended: s.ended, interrupted: !!s.interrupted };
      if (st.status === 'running') {
        Object.assign(st, { status: 'stopped', interrupted: true }); // its run time is unknown: the app was down
        for (const t of st.steps) if (t.status === 'running') t.status = 'failed';
        st.log.push('The app stopped while this stage ran. Retry runs it again.');
        // Ctrl+C stops stages with the app, but a crash leaves them running: say so, so it does not run twice.
        try { if (s.pid) { process.kill(-s.pid, 0); st.log.push(`It may still be running (process ${s.pid}). Check before you retry.`); } } catch {}
      }
      return st;
    });
    Object.assign(run, { at: d.at, by: d.by ?? null, head: d.head, prs: d.prs, rollbackOf: d.rollbackOf, live: d.live, deployedSha: d.deployedSha, done: true });
    state.runs.set(run.number, run);
    return run;
  } catch (e) {
    console.error(`Could not load the last deploy: ${e.message}`);
    return null;
  }
}

function status(r) {
  if (r === deploying()) return 'deploying';
  if (r.live) return 'live';
  if (r.done) return 'failed';
  if (r.bad || r.stages.some((s) => s.group === 'build' && ['failed', 'stopped'].includes(s.status))) return 'bad';
  if (state.queue.includes(r)) return 'queued';
  return r.buildOk ? 'good' : r.stages.some((s) => s.status === 'running') ? 'building' : 'new';
}
// Every build there has been, newest first: this run's builds from memory, older ones as saved. Where a build is
// (queued, deploying, live, replaced...) comes from the live runs; a build in flight when the app stopped is 'stopped'.
function history() {
  const live = state.record.live[state.config.environment]?.number;
  const all = new Map((state.record.builds ?? []).map((b) => [b.number, b]));
  for (const r of state.runs.values()) all.set(r.number, { number: r.number, prs: r.prs, at: r.at, by: r.by ?? null, status: status(r), deployedSha: r.deployedSha ?? null, rollbackOf: r.rollbackOf ?? null });
  return [...all.values()].map((b) => (b.status === 'live' && b.number !== live ? { ...b, status: 'replaced' } : b))
    .sort((a, b) => b.number - a.number).slice(0, 200); // shortcut: last 200 builds only, page it if you need more
}
const summary = (r) => r && { number: r.number, prs: r.prs, status: status(r), bad: r.bad, building: r.stages.some((s) => s.group === 'build' && s.status === 'running') };

function openRepo(dir) {
  if (children().length) throw new Error('Wait for the running stage to finish, or stop it.');
  const config = readConfig(dir);
  const id = `${basename(dir)}-${createHash('sha256').update(dir).digest('hex').slice(0, 10)}`;
  const work = join(HOME, 'work', id), recordFile = join(HOME, `builds-${id}.json`), deployFile = join(HOME, `deploy-${id}.json`);
  // Build numbers and what is live, kept between runs of the app.
  const record = existsSync(recordFile) ? JSON.parse(readFileSync(recordFile, 'utf8')) : { next: 1, live: {} };
  record.builds = (record.builds ?? []).map((b) => (['new', 'building', 'good', 'queued', 'deploying'].includes(b.status) ? { ...b, status: 'stopped' } : b));
  state = { repo: dir, name: basename(dir), work, config, prs: [], error: null, deploy: null, queue: [], paused: false, record, recordFile, deployFile, runs: new Map(), saved: '' };
  state.build = newRun(work);
  state.deploy = restoreDeploy();
  send({ type: 'state', state: view() });
}

// What the page sees. Logs only on first connect; after that they stream as 'log' messages.
// Row 2 shows the deploy running (or the last one) until the newest build is green and ready to go.
function view(withLogs = false) {
  if (!state) return null;
  const b = state.build, dep = deploying(), d = dep ?? (b.buildOk && !state.queue.length ? b : state.deploy ?? b);
  const stages = [...b.stages.filter((s) => s.group === 'build'), ...d.stages.filter((s) => s.group === 'deploy')];
  const builds = history(), saved = JSON.stringify(builds);
  if (saved !== state.saved) { state.record.builds = builds; state.saved = saved; saveRecord(); }
  return {
    builds, planned: state.record.steps ?? {},
    repo: state.repo, name: state.name, repos, prs: state.prs, error: state.error, work: b.work,
    config: { branch: state.config.branch, environment: state.config.environment },
    picked: b.picked, buildOk: b.buildOk, build: summary(b), stackedOn: b.under?.number ?? null,
    queued: state.queue.includes(b), queue: state.queue.map(summary), paused: state.paused,
    live: state.record.live[state.config.environment] ?? null,
    // Every environment the deploy stages make live, the pipeline's own first, with the build live in each.
    lives: [...new Set([state.config.environment, ...state.config.deploy.map((s) => s.environment)])].map((e) => ({ environment: e, live: state.record.live[e] ?? null })),
    deployingBuild: summary(dep), deployRow: d.number,
    building: building(), canBuild: !batching(), deploying: !!dep, deployingPrs: [...inFlight(), ...(building() ? [b] : [])].flatMap((r) => r.picked), deployWork: state.deploy?.work ?? null,
    retry: d === state.deploy ? retryable()?.id ?? null : null,
    running: stages.filter((s) => s.status === 'running').map((s) => s.id),
    stages: stages.map(({ env, run, log, ...s }) => (withLogs ? { ...s, log } : s)),
  };
}

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

// Runs one stage in the lane's worktree. Lines starting "== " are the stage's steps; the last step fails if the stage does.
// A line starting "!! " fails the current step; the stage can go on to show what else is wrong before it exits.
// A retried stage is told which steps passed last time (CICD_RESUME_FROM, CICD_PASSED_STEPS; see README), and shows
// them as skipped. A stage that ignores that prints them again, and they run as before.
function runStage(run, stage, extraArgs, env) {
  return new Promise((res) => {
    const prev = ['failed', 'stopped'].includes(stage.status) ? stage.steps : [];
    const i = prev.findIndex((t) => !['passed', 'skipped'].includes(t.status)), done = i > 0 ? prev.slice(0, i) : [];
    const resume = done.length ? { CICD_RESUME_FROM: prev[i].name, CICD_PASSED_STEPS: done.map((t) => t.name).join('\n') } : {};
    Object.assign(stage, { ...fresh, status: 'running', steps: done.map((t) => ({ name: t.name, status: 'skipped' })), log: [], started: Date.now() });
    send({ type: 'reset', stage: stage.id });
    send({ type: 'state', state: view() });
    const args = extraArgs.map((a) => ` ${a}`).join('');
    const child = spawn('bash', ['-c', stage.run + args], {
      cwd: run.work, detached: true,
      env: { ...process.env, ...env, ...stage.env, ...resume, PIPELINE_WORK: run.work, PIPELINE_BRANCH: state.config.branch, FORCE_COLOR: '0', CI: '1' },
    });
    run.kids.add(child);
    stage.pid = child.pid;
    if (run === state.deploy) saveDeploy();
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
      run.kids.delete(child);
      const ok = code === 0;
      for (const s of stage.steps) if (s.status === 'running') s.status = ok ? 'passed' : 'failed';
      Object.assign(stage, { status: ok ? 'passed' : signal ? 'stopped' : 'failed', ended: Date.now() });
      // A stage's steps are only known once it prints them, so remember a full run's steps to show before the next.
      if (ok) { (state.record.steps ??= {})[stage.name] = [...new Set(stage.steps.map((t) => t.name.replace(/#\d+/g, '#N')))]; saveRecord(); }
      if (run === state.deploy) saveDeploy();
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
    const skipped = stage.steps.find((s) => s.status === 'skipped' && s.name === step[1]);
    if (skipped) skipped.status = 'running'; // the stage ran a step it could have skipped
    else stage.steps.push({ name: step[1], status: 'running' });
    send({ type: 'state', state: view() });
  }
  if (line.startsWith('!! ') && stage.steps.at(-1)?.status === 'running') {
    stage.steps.at(-1).status = 'failed';
    send({ type: 'state', state: view() });
  }
  stage.log.push(line);
  if (stage.log.length > MAX_LOG) stage.log.splice(0, stage.log.length - MAX_LOG);
  send({ type: 'log', stage: stage.id, line });
}

// Runs stages in order. A "parallel" stage starts with the one before it; the next stage waits for all of them.
// A stage that does not pass stops the later stages of its environment, once its whole group has finished. Other
// environments go on. Build stages and the merge have none, so they stop everything.
async function runStages(run, stages, env) {
  const failed = new Set();
  for (let i = 0; i < stages.length;) {
    let j = i + 1;
    while (stages[j]?.parallel) j++;
    const group = stages.slice(i, j).filter((s) => !failed.has(s.environment));
    const oks = await Promise.all(group.map((s) => runStage(run, s, [], env)));
    group.forEach((s, k) => oks[k] || failed.add(s.environment));
    if (failed.has(undefined) || group.some((s) => s.status === 'stopped')) return false; // and Stop stops it all
    i = j;
  }
  return !failed.size;
}

// Marks live each environment whose stages all passed in this deploy (the merge too, if it has one). A retry that
// only reran another environment's stage keeps the time a build first went live.
function markLive(run, extra = {}) {
  const deploy = run.stages.filter((s) => s.group === 'deploy');
  if (deploy.some((s) => s.id === 'merge' && s.status !== 'passed')) return [];
  const envs = [...new Set([state.config.environment, ...deploy.map((s) => s.environment).filter(Boolean)])];
  const went = envs.filter((e) => deploy.every((s) => s.environment !== e || s.status === 'passed'));
  for (const e of went) {
    const was = state.record.live[e];
    state.record.live[e] = { number: run.number, prs: run.prs, at: was?.number === run.number ? was.at : Date.now(), ...extra };
  }
  if (went.length) saveRecord();
  return went;
}

function ensureWorktree(work) {
  if (existsSync(join(work, '.git'))) return;
  mkdirSync(dirname(work), { recursive: true });
  git(state.repo, 'fetch', '-q', 'origin', state.config.branch);
  git(state.repo, 'worktree', 'add', '--detach', work, `origin/${state.config.branch}`);
}

// A new build is stacked on the last build in flight (queued or deploying), in a worktree none of them is using.
// Once the one under it is merged, main has the same files as its tested commit, so it can go next without a rebuild.
// A build still running its checks goes into the queue first: the new one is stacked on it, so it must deploy first.
async function build(picked, env, by = null) {
  if (building() && !state.queue.includes(state.build)) state.queue.push(state.build);
  const under = inFlight().at(-1) ?? null;
  const work = freeWork();
  const run = state.build = newRun(work, picked, env, under, state.record.next++, by);
  state.runs.set(run.number, run);
  saveRecord();
  state.error = null;
  send({ type: 'state', state: view(true) });
  let ok = await runStage(run, run.stages[0], picked.map(String), under ? { ...env, PIPELINE_BASE: under.head } : env);
  if (ok) {
    run.head = git(run.work, 'rev-parse', 'HEAD'); // what the next build stacks on
    send({ type: 'state', state: view() });
    // The batch's own pipeline.json runs, as CI runs a PR's own workflow files.
    refreshStagesFromBatch(run);
    send({ type: 'state', state: view(true) });
    ok = await runStages(run, run.stages.filter((s) => s.group === 'build' && s.id !== 'batch'), env);
  }
  if (!ok) drop(run, 'failed its build'); // and every build stacked on it while its checks ran
  else if (under?.bad || under?.stages.some((s) => s.group === 'build' && ['failed', 'stopped'].includes(s.status))) run.bad ??= `Build #${under.number} under it did not make it, so build again.`;
  else if (!run.bad) run.buildOk = true;
  send({ type: 'state', state: view(true) });
  pump();
}

function refreshStagesFromBatch(run) {
  state.config = { ...readConfig(run.work), branch: state.config.branch };
  const [batch] = run.stages;
  run.stages = [batch, ...makeStages(state.config).slice(1)];
}

// A worktree no build in flight is using. Up to 10, one per build.
function freeWork() {
  // A failed deploy keeps its folder, so Retry can still run there.
  const used = [...inFlight(), ...(building() ? [state.build] : []), ...(retryable() ? [state.deploy] : [])].map((r) => r.work);
  const work = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (i === 0 ? state.work : i === 1 ? `${state.work}-next` : `${state.work}-${i + 1}`)).find((w) => !used.includes(w));
  if (!work) throw new Error('Too many builds waiting. Let some deploy first.');
  ensureWorktree(work);
  return work;
}

// Rollback: rebuild the commit an earlier build deployed (main as it was then) and run only the deploy stages.
// Main on GitHub is not touched, so it is now ahead of what is live: the queue pauses, so the next deploy does not
// ship the bad change again. Revert it on GitHub, then resume the queue. It is a build of its own, "rollback to #N".
async function rollback(to, env) {
  const target = history().find((b) => b.number === to);
  const run = newRun(freeWork(), [], env, null, state.record.next++);
  Object.assign(run, { prs: target.prs, rollbackOf: to });
  state.runs.set(run.number, run);
  state.deploy = run; // the deploy lane: nothing else deploys meanwhile
  state.paused = true;
  state.error = null;
  send({ type: 'state', state: view(true) });
  try {
    let ok = await runStage(run, run.stages[0], [], { ...env, PIPELINE_BASE: target.deployedSha, PIPELINE_ROLLBACK: String(to) });
    if (ok) refreshStagesFromBatch(run); // that commit's own stages
    run.stages = run.stages.filter((s) => s.id !== 'merge');
    send({ type: 'state', state: view(true) });
    if (ok) await runStages(run, run.stages.slice(1), env);
  } finally {
    run.done = true;
    const went = run.stages[0].status === 'passed' ? markLive(run, { rollbackOf: to }) : [];
    if (went.includes(state.config.environment)) {
      Object.assign(run, { live: true, deployedSha: target.deployedSha });
      state.error = `Rolled back to build #${to}. Main on GitHub is still ahead of what is live, so the queue is paused. Revert the bad change on GitHub, then resume the queue.`;
    } else state.error = `The rollback to build #${to} did not finish. Check its log.`;
    saveDeploy();
    send({ type: 'state', state: view(true) });
  }
}

// A build that will never be deployed takes every build stacked on it down with it.
function drop(r, why) {
  state.queue = state.queue.filter((q) => q !== r);
  for (const x of [...state.queue, state.build].filter((x) => x.under === r && !x.bad)) {
    Object.assign(x, { bad: `Build #${r.number} under it ${why}, so build again.`, buildOk: false });
    drop(x, 'was dropped');
  }
}

// Deploys go one at a time, oldest queued build first, each once it is green.
function pump() {
  const next = state.queue[0];
  if (!deploying() && !state.paused && next?.buildOk) deploy(state.queue.shift()).catch((e) => { state.error = e.message; send({ type: 'state', state: view() }); });
}

// Same AWS profile as the build that was checked, whatever the box says now.
// from: a retry starts at the failed stage, in the same folder, with the merge already done.
async function deploy(run, from = 'merge') {
  state.deploy = run;
  Object.assign(run, { buildOk: false, done: false }); // one deploy per green build
  try {
    // A retry skips stages that already passed beside the failed one, so a parallel peer does not run twice.
    const stages = run.stages.filter((s) => s.group === 'deploy');
    const todo = stages.slice(stages.findIndex((s) => s.id === from)).filter((s) => from === 'merge' || s.status !== 'passed');
    await runStages(run, todo, run.buildEnv);
    // Never deploy a build stacked on one that did not merge.
    if (run.stages.find((s) => s.id === 'merge')?.status !== 'passed') drop(run, 'did not merge');
  } finally {
    run.done = true;
    const went = markLive(run), missed = [...new Set(run.stages.filter((s) => s.group === 'deploy' && s.status !== 'passed').map((s) => s.environment))];
    if (went.includes(state.config.environment)) {
      run.live = true;
      run.deployedSha = git(run.work, 'rev-parse', 'HEAD'); // main's commit after the merge: what a rollback redeploys
      if (missed.length) state.error = `Build #${run.number} is live in ${state.config.environment}, but not in ${missed.join(', ')}. Open its failed stage to retry it.`;
    } else if (state.queue.length) {
      // A deploy that did not make the pipeline's own environment live holds the queue: you look first, then resume it.
      // Another environment failing (say TestFlight) does not: the next deploy ships it again.
      state.paused = true;
      state.error = `Build #${run.number} did not deploy, so the queue is paused. Check, then resume it.`;
    }
    saveDeploy();
    send({ type: 'state', state: view(true) });
    loadPrs().catch(() => {}); // merged PRs drop off the list
    pump();
  }
}

// The last deploy's failed stage, if it can run again: its merge passed, nothing is deploying, not a rollback.
function retryable() {
  const r = state?.deploy;
  if (!r || deploying() || r.rollbackOf || r.stages.find((s) => s.id === 'merge')?.status !== 'passed') return null;
  return r.stages.find((s) => s.group === 'deploy' && ['failed', 'stopped'].includes(s.status)) ?? null;
}
// Retry reruns that stage and the ones after it, for the same build. It does not merge again or touch the queue:
// a paused queue stays paused until you resume it.
function retryStart(number) {
  const s = retryable(), r = state?.deploy;
  if (!s || r.number !== number) throw new Error('Only a failed stage of the last deploy can run again.');
  // The build's folder must still hold what it merged: a newer build may have taken it since.
  const used = [...state.queue, ...(building() ? [state.build] : [])].some((x) => x.work === r.work);
  if (used || git(r.work, 'rev-parse', 'HEAD^{tree}') !== git(r.work, 'rev-parse', `${r.head}^{tree}`)) throw new Error(`A newer build has used build #${number}'s folder since. Build again to deploy it.`);
  state.error = null;
  deploy(r, s.id).catch((e) => { state.error = e.message; send({ type: 'state', state: view() }); });
}

// Checks that can fail fast happen before the response; the rollback itself runs on.
async function rollbackStart(to, env) {
  const target = history().find((b) => b.number === to);
  if (!target?.deployedSha) throw new Error(`Build #${to} was never live, so there is nothing to roll back to.`);
  if (deploying()) throw new Error('Wait for the deploy that is running to finish.');
  rollback(to, env).catch((e) => { state.error = e.message; send({ type: 'state', state: view() }); });
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
      res.write(`data: ${JSON.stringify({ type: 'state', state: view(true), repos, boot: BOOT, agentLog })}\n\n`); // then each new one as an 'agent' message
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    // Self-reported by mcp.mjs (the MCP client's name), so it says which agent, not who. The key proves it came via mcp.mjs.
    const agent = req.method === 'POST' && req.headers['x-token'] === AGENT_TOKEN ? String(req.headers['x-agent'] ?? '').replace(/[^\w .@/:()-]/g, '').slice(0, 80) || 'Unnamed agent' : null;
    if (req.method !== 'POST' || (req.headers['x-token'] !== TOKEN && !agent)) return json(res, 403, { error: 'Not allowed.' });
    let b = null, made = null;
    // Only the fields the actions read are kept, so a huge or odd body can't bloat the log.
    if (agent) res.on('close', () => audit({ at: Date.now(), agent, repo: state?.name ?? null, action: url.pathname.replace('/api/', ''), args: b && { number: b.number, prs: b.prs, action: b.action }, ok: res.writableFinished && res.statusCode < 400, refused: res.statusCode === 403, error: res.agentError ?? null, build: made }));
    b = await body(req);
    if (!b || typeof b !== 'object') b = {};
    // What agents can do: read, build, retry, resume. Deploy, rollback, stop, queue changes and repos stay clicks on the page.
    if (agent && !(['/api/status', '/api/prs', '/api/build', '/api/build-log', '/api/retry'].includes(url.pathname) || (url.pathname === '/api/queue' && b.action === 'resume'))) {
      return json(res, 403, { error: (res.agentError = "Agents can't do that. Deploy, rollback, stop and queue changes stay a click on the page.") });
    }
    switch (url.pathname) {
      case '/api/status': return json(res, 200, view()); // for mcp.mjs: Claude reads the pipeline
      case '/api/repo': openRepo(addRepo(String(b.path))); await loadPrs().catch((e) => (state.error = `Could not list PRs: ${e.message}`)); break;
      case '/api/prs': await loadPrs(); break;
      case '/api/build': {
        if (!state) throw new Error('Add a repo first.');
        if (batching()) throw new Error('Wait for Batch PRs to finish. The next build stacks on its result.');
        // A new build queues the one still checking (it stacks on it), and the queue deploys on its own: that's a deploy click.
        if (agent && building() && !state.queue.includes(state.build)) throw new Error(`Build #${state.build.number} is still running its checks. Wait for it to finish, then build again.`);
        const picked = (b.prs ?? []).map(Number);
        if (!picked.every((n) => state.prs.some((p) => p.number === n && !p.draft))) throw new Error('Pick ready PRs from the list. Drafts can not be merged.');
        const busy = [...inFlight(), ...(building() ? [state.build] : [])];
        if (picked.some((n) => busy.some((r) => r.picked.includes(n)))) throw new Error('That PR is already in a build that is running, queued or deploying.');
        // No profile sent (mcp.mjs): sign in like the last build from the page did, also after a restart.
        // An agent can't pick the sign-in: deploys reuse the build's, so that stays yours.
        if (b.profile !== undefined && !agent) { profileEnv(b.profile); state.record.profile = b.profile; saveRecord(); } // check before keeping it
        const before = state.build;
        build(picked, profileEnv(state.record.profile), agent).catch((e) => { state.error = e.message; send({ type: 'state', state: view() }); });
        if (state.build !== before) made = state.build.number; // numbered before build() first waits; unchanged if it failed first
        break;
      }
      case '/api/deploy': {
        // Queue the newest build. It deploys on its own once it is green and every build in front of it has deployed.
        const r = state?.build;
        if (r?.bad) throw new Error(r.bad);
        if (!r?.buildOk && !building()) throw new Error('Run a build first. Deploy unlocks when every build stage passes.');
        if (!state.queue.includes(r)) state.queue.push(r);
        pump();
        send({ type: 'state', state: view() });
        break;
      }
      case '/api/build-log': {
        // Stages and logs of any build from this run of the app (the pipeline only shows the newest).
        const r = state?.runs.get(Number(b.number));
        if (!r) throw new Error('Logs are only kept while the app runs. This build is from before a restart.');
        return json(res, 200, { number: r.number, stages: r.stages.map(({ env, run, ...s }) => s) });
      }
      case '/api/rollback':
        if (!state) throw new Error('Add a repo first.');
        await rollbackStart(Number(b.number), profileEnv(b.profile));
        break;
      case '/api/retry':
        if (!state) throw new Error('Add a repo first.');
        retryStart(Number(b.number));
        break;
      case '/api/queue':
        // remove: only the last build in the queue, since the ones behind a build are stacked on it. resume: after a failed deploy.
        if (b.action === 'remove' && state?.queue.at(-1)?.number === b.number) drop(state.queue.at(-1), 'came off the queue');
        else if (b.action === 'resume' && state) { state.paused = false; state.error = null; pump(); }
        else throw new Error('Only the last build in the queue can come off it.');
        send({ type: 'state', state: view() });
        break;
      case '/api/stop':
        // The whole stage, not just bash. lane picks the build or the deploy; no lane stops both.
        stop(b.lane === 'build' ? kids([state.build, ...state.queue].filter((r) => r !== deploying())) : b.lane === 'deploy' ? kids([deploying()]) : children());
        break;
      default: return json(res, 404, { error: 'No such action.' });
    }
    json(res, 200, { ok: true });
  } catch (e) {
    json(res, 400, { error: (res.agentError = e.message) });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const first = process.argv[2] ?? repos[0];
  if (first) { try { openRepo(addRepo(first)); loadPrs().catch((e) => (state.error = `Could not list PRs: ${e.message}`)); } catch (e) { console.error(e.message); } }
  server.listen(PORT, '127.0.0.1', () => {
    // mcp.mjs reads the port and this run's token here. Only you can read it, like the page.
    const tmp = join(HOME, `mcp.json.${process.pid}`);
    writeFileSync(tmp, JSON.stringify({ port: PORT, token: AGENT_TOKEN }), { mode: 0o600 });
    renameSync(tmp, join(HOME, 'mcp.json'));
    const url = `http://localhost:${PORT}/`;
    console.log(`CI/CD at home: ${url} (keep this window open; close it to stop)`);
    if (!process.env.PIPELINE_NO_OPEN) {
      const opener = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'explorer' : 'xdg-open';
      spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    }
  });
  // Closing the window stops a running stage too, rather than leaving a deploy running unseen.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => {
    stop(children());
    for (const s of state?.deploy?.stages ?? []) s.pid = null; // stopped just now, so no "may still be running" next time
    saveDeploy();
    process.exit(1);
  });
  server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is busy. Is the pipeline already open? Try ${`http://localhost:${PORT}/`}` : e.message); process.exit(1); });
}
