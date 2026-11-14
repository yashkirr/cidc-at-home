// End to end: a throwaway repo with four open PRs (3 and 4 clash with 1), a fake gh, and fake stages. Build main + PR 1 and deploy it; while
// that deploy runs, build PR 2 stacked on it and queue it, then a third build behind that; they deploy on their own, in order. Main on the "GitHub" remote ends up with both merged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const sh = (cwd, cmd) => execFileSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });

test('build a batch with a PR, then deploy merges it and runs the deploy stages', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pipeline-'));
  const remote = join(tmp, 'remote.git'), repo = join(tmp, 'repo'), bin = join(tmp, 'bin'), home = join(tmp, 'home');
  mkdirSync(bin); mkdirSync(home); writeFileSync(join(tmp, 'checkgate'), '');
  sh(tmp, `git init -q --bare -b main remote.git && git clone -q remote.git repo`);
  writeFileSync(join(repo, 'pipeline.json'), JSON.stringify({
    environment: 'test',
    // Checks wait for checkgate, so the test can start a build while the one before is still checking.
    build: [{ name: 'Checks', run: `echo "== Lint"; until [ -f "${join(tmp, 'checkgate')}" ]; do sleep 0.1; done; echo ok; echo "== Tests"; test -f a.txt && test -f pr.txt` }],
    // Waits for the test to open the gate, so the next batch is built while this deploy is still running.
    deploy: [{ name: 'Release', run: `echo "== Upload"; until [ -f "${join(tmp, 'gate')}" ]; do sleep 0.1; done; if [ -f "${join(tmp, 'failonce')}" ]; then rm "${join(tmp, 'failonce')}"; exit 1; fi; echo "$WHO" > deployed.txt`, env: { WHO: 'me' } },
      // Starts together with Release, so it is done while Release still waits at the gate. Counts its runs for the retry check.
      // Its own environment ("store"): it goes live there on its own. failapp makes it fail once.
      { name: 'App', parallel: true, environment: 'store', run: `echo "== Send"; echo app > app.txt; echo x >> "${join(tmp, 'app-runs')}"; if [ -f "${join(tmp, 'failapp')}" ]; then rm "${join(tmp, 'failapp')}"; exit 1; fi` }],
  }));
  sh(repo, `echo a > a.txt && git add -A && git -c user.name=t -c user.email=t@t commit -qm init && git push -q origin main
    git checkout -qb pr && echo pr > pr.txt && git add -A && git -c user.name=t -c user.email=t@t commit -qm pr && git push -q origin pr:refs/pull/1/head
    git checkout -q main && git checkout -qb pr2 && echo pr2 > pr2.txt && git add -A && git -c user.name=t -c user.email=t@t commit -qm pr2 && git push -q origin pr2:refs/pull/2/head
    git checkout -q main && git checkout -qb pr3 && echo clash > pr.txt && git add -A && git -c user.name=t -c user.email=t@t commit -qm pr3 && git push -q origin pr3:refs/pull/3/head
    git checkout -q main && git checkout -qb pr4 && echo clash4 > pr.txt && git add -A && git -c user.name=t -c user.email=t@t commit -qm pr4 && git push -q origin pr4:refs/pull/4/head
    git checkout -q main`);
  // Fake gh: lists PRs 1 and 2, and "merges" one on the remote like GitHub's merge button.
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
case "$*" in
  *pulls\\?state=open*) echo '[{"number":1,"title":"Add pr.txt","draft":false,"branch":"pr","author":"t"},{"number":2,"title":"Add pr2.txt","draft":false,"branch":"pr2","author":"t"},{"number":3,"title":"Clashes with PR 1","draft":false,"branch":"pr3","author":"t"},{"number":4,"title":"Also clashes with PR 1","draft":false,"branch":"pr4","author":"t"}]' ;;
  *pulls/*/merge*) n=\${4#*pulls/} && n=\${n%%/*} && d=$(mktemp -d) && git clone -q "${remote}" "$d" && cd "$d" && git fetch -q origin pull/$n/head &&
    git -c user.name=gh -c user.email=gh@gh merge -q --no-ff -m "Merge pull request #$n" FETCH_HEAD && git push -q origin HEAD:main && echo merged ;;
  *) echo "fake gh: $*" >&2; exit 1 ;;
esac
`);
  chmodSync(join(bin, 'gh'), 0o755);

  const port = 43000 + Math.floor(Math.random() * 1000);
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, PIPELINE_PORT: String(port), PIPELINE_NO_OPEN: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const base = `http://localhost:${port}`;
  let server, mcp, token, events, state; // state: the latest from the event stream
  const post = (p, b = {}) => fetch(base + p, { method: 'POST', headers: { 'x-token': token, 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const start = async () => {
    server = spawn(process.execPath, [join(HERE, '..', 'server.mjs'), repo], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((res) => server.stdout.once('data', res));
    token = (await (await fetch(base + '/')).text()).match(/const TOKEN = '(\w+)'/)[1];
    state = null;
    events = await fetch(base + '/events');
    (async () => { const dec = new TextDecoder(); let buf = '';
      for await (const chunk of events.body) { buf += dec.decode(chunk); let i;
        while ((i = buf.indexOf('\n\n')) >= 0) { const m = JSON.parse(buf.slice(6, i)); buf = buf.slice(i + 2); if (m.type === 'state') state = m.state; } } })().catch(() => {});
  };
  const restart = async () => { events.body.cancel().catch(() => {}); const gone = new Promise((r) => server.once('exit', r)); server.kill(); await gone; await start(); };
  try {
    await start();
    const until = async (ok, what) => { for (let i = 0; i < 300; i++) { if (state && ok(state)) return; await new Promise((r) => setTimeout(r, 100)); } assert.fail(`timed out: ${what}; ${JSON.stringify(state?.stages?.map((s) => [s.id, s.status, s.log?.slice(-3), s.steps]))}`); };

    await until((s) => s.prs.length === 4, 'PR list');
    assert.equal((await fetch(base + '/api/deploy', { method: 'POST', headers: { 'x-token': 'wrong' } })).status, 403, 'no token, no deploy');
    assert.equal((await post('/api/deploy')).status, 400, 'deploy is locked before a build');

    // PRs 3 and 4 both clash with PR 1: the batch fails, and one run names them both. PR 2 in between still fits.
    assert.equal((await post('/api/build', { prs: [1, 3, 2, 4] })).status, 200);
    await until((s) => s.stages[0].status === 'failed', 'batch fails on the clash');
    assert.deepEqual(state.stages[0].steps.map((s) => s.status), ['passed', 'passed', 'failed', 'passed', 'failed', 'failed']);
    assert.equal(state.buildOk, false);

    // Claude's view (mcp.mjs): it finds the clash in the log and can start the next build itself.
    mcp = spawn(process.execPath, [join(HERE, '..', 'mcp.mjs')], { env, stdio: ['pipe', 'pipe', 'inherit'] });
    const replies = new Map(); let mbuf = '';
    mcp.stdout.on('data', (d) => { mbuf += d; let i; while ((i = mbuf.indexOf('\n')) >= 0) { const m = JSON.parse(mbuf.slice(0, i)); mbuf = mbuf.slice(i + 1); replies.get(m.id)?.(m); } });
    let mid = 0;
    const rpc = (method, params) => new Promise((res) => { replies.set(++mid, res); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }) + '\n'); });
    const tool = async (name, args) => { const r = (await rpc('tools/call', { name, arguments: args })).result; return r.isError ? r.content[0].text : JSON.parse(r.content[0].text); };
    assert.equal((await rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code', version: '2.1' } })).result.serverInfo.name, 'cicd-at-home');
    assert.deepEqual((await rpc('tools/list')).result.tools.map((t) => t.name), ['pipeline_status', 'build_log', 'build', 'retry_stage', 'resume_queue']);
    const seen = await tool('pipeline_status', {});
    assert.equal(seen.stages[0].status, 'failed');
    const log = await tool('build_log', { build: seen.build.number, stage: 'batch' });
    assert.match(log.stages[0].log.join('\n'), /PR #3 clashes/);
    assert.match(await tool('build_log', { build: seen.build.number, stage: 'nope' }), /no stage "nope"/);
    assert.match(await tool('retry_stage', { build: seen.build.number }), /Only a failed stage/);

    assert.deepEqual(await tool('build', { prs: [1] }), { ok: true }, 'Claude builds again once the clash is gone');
    mcp.kill();
    // Audit trail: the agent's key can't deploy, and every call, refused ones too, is logged with the agent's name.
    const agentKey = JSON.parse(sh(home, 'cat .cicd-at-home/mcp.json')).token;
    assert.notEqual(agentKey, token, 'agents have their own key');
    assert.equal((await fetch(base + '/api/deploy', { method: 'POST', headers: { 'x-token': agentKey, 'x-agent': 'rogue' } })).status, 403, 'agents can not deploy');
    for (let i = 0; i < 50 && !sh(home, 'cat .cicd-at-home/agent-log.jsonl').includes('rogue'); i++) await new Promise((r) => setTimeout(r, 100));
    const audit = sh(home, 'cat .cicd-at-home/agent-log.jsonl').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(audit.map((a) => [a.agent, a.action, a.ok]), [['claude-code 2.1', 'status', true], ['claude-code 2.1', 'build-log', true], ['claude-code 2.1', 'build-log', true],
      ['claude-code 2.1', 'retry', false], ['claude-code 2.1', 'prs', true], ['claude-code 2.1', 'build', true], ['rogue', 'deploy', false]]);
    assert.equal(audit[5].build, 2);
    assert.equal(audit[6].refused, true);
    await until((s) => s.builds.find((b) => b.number === 2)?.by === 'claude-code 2.1', 'build #2 marked as the agent\'s');
    await until((s) => s.buildOk, 'green build');
    assert.deepEqual(state.stages.find((s) => s.name === 'Checks').steps.map((s) => [s.name, s.status]), [['Lint', 'passed'], ['Tests', 'passed']]);

    assert.equal((await post('/api/deploy')).status, 200);
    await until((s) => s.running.includes('deploy0') && s.stages.find((x) => x.id === 'deploy1')?.status === 'passed', 'App passed beside Release, which waits at the gate');
    assert.equal(state.buildOk, false, 'one deploy per build');
    assert.equal((await post('/api/build', { prs: [1] })).status, 400, 'PR 1 is being deployed');

    // Step 2 is busy; the next batch builds anyway, in its own worktree, on top of the build being deployed.
    assert.equal((await post('/api/build', { prs: [2] })).status, 200);
    await until((s) => s.build.number === 3 && s.buildOk, 'green stacked build');
    assert.equal(state.build.number, 3, 'build #1 clashed, #2 is PR 1, #3 is PR 2');
    assert.equal(state.stackedOn, 2);
    assert.notEqual(state.work, state.deployWork);
    // Deploys go one at a time, so Deploy queues it behind build #2; it goes on its own when that is done.
    assert.equal((await post('/api/deploy')).status, 200);
    await until((s) => s.queued, 'build #3 queued');

    // The queue can be deeper than one: build #4 (main, no new PRs) stacks on #3 and queues behind it.
    assert.equal((await post('/api/build', { prs: [] })).status, 200);
    await until((s) => s.build.number === 4 && s.buildOk, 'green build #4');
    assert.equal(state.stackedOn, 3);
    assert.equal((await post('/api/deploy')).status, 200);
    await until((s) => s.queue.map((b) => b.number).join() === '3,4', 'queue is #3, #4');
    assert.equal((await post('/api/queue', { action: 'remove', number: 3 })).status, 400, 'only the last build comes off the queue');
    assert.equal(state.deployingBuild.number, 2);
    assert.equal(state.live, null);

    writeFileSync(join(tmp, 'gate'), '');
    await until((s) => !s.deploying && !s.queue.length && s.live?.number === 4, 'builds #2, #3, #4 deployed in order');
    assert.deepEqual(state.stages.map((s) => s.status), ['passed', 'passed', 'passed', 'passed', 'passed']);
    assert.equal(sh(tmp, `git --git-dir=remote.git log --format=%s main | grep 'Merge pull request'`), 'Merge pull request #2\nMerge pull request #1\n');
    assert.equal(sh(tmp, 'git --git-dir=remote.git show main:pr.txt main:pr2.txt'), 'pr\npr2\n');
    assert.equal(sh(state.deployWork, 'cat deployed.txt').trim(), 'me');
    // Build numbers and what is live survive a restart of the app.
    const record = JSON.parse(sh(home, 'cat .cicd-at-home/builds-*.json'));
    assert.equal(record.next, 5);
    assert.deepEqual(record.live.test.prs, []);

    // The next build can start while the one before it is still in its checks: build #5 goes into the queue, and
    // build #6 is stacked on it. #5 deploys on its own once green.
    rmSync(join(tmp, 'checkgate'));
    assert.equal((await post('/api/build', { prs: [] })).status, 200);
    await until((s) => s.build.number === 5 && s.running.includes('build0') && s.canBuild, 'build #5 in its checks');
    assert.equal((await post('/api/build', { prs: [] })).status, 200);
    await until((s) => s.build.number === 6 && s.queue.map((b) => b.number).join() === '5', 'build #5 queued, #6 building');
    assert.equal(state.stackedOn, 5);
    writeFileSync(join(tmp, 'checkgate'), '');
    await until((s) => s.live?.number === 5 && s.build.number === 6 && s.buildOk, 'build #5 live, #6 green');

    // All builds, newest first, with where each one is now; any build from this run of the app has its logs.
    assert.deepEqual(state.builds.map((b) => [b.number, b.status]), [[6, 'good'], [5, 'live'], [4, 'replaced'], [3, 'replaced'], [2, 'replaced'], [1, 'bad']]);
    assert.deepEqual(state.builds.find((b) => b.number === 3).prs.map((p) => p.number), [2]);
    const old = await (await post('/api/build-log', { number: 3 })).json();
    assert.match(old.stages.find((s) => s.id === 'deploy0').log.join('\n'), /== Upload/);
    assert.equal(JSON.parse(sh(home, 'cat .cicd-at-home/builds-*.json')).builds.length, 6, 'saved for after a restart');
    // Each stage's steps from its last full run, shown in the stage before a build reaches it. PR numbers are generic.
    assert.deepEqual(state.planned.Checks, ['Lint', 'Tests']);
    assert.deepEqual(state.planned['Merge on GitHub'], ['Main unchanged', 'Main matches the tested batch']);
    assert.ok(state.planned['Batch PRs'].includes('Get main'));

    // Rollback to build #2 (main with PR 1 only): rebuilds the commit #2 deployed and runs the deploy stages, as build
    // #7. Main on GitHub stays as it is, and the queue pauses so the next deploy does not ship PR 2 again by itself.
    const main = sh(tmp, 'git --git-dir=remote.git rev-parse main');
    assert.equal((await post('/api/rollback', { number: 6 })).status, 400, 'build #6 was never live');
    assert.equal((await post('/api/rollback', { number: 2 })).status, 200);
    await until((s) => s.live?.number === 7 && !s.deploying, 'rolled back to #2 as build #7');
    assert.equal(state.live.rollbackOf, 2);
    assert.equal(state.paused, true);
    assert.equal(sh(tmp, 'git --git-dir=remote.git rev-parse main'), main, 'main untouched');
    assert.equal(sh(state.deployWork, 'git rev-parse HEAD').trim(), state.builds.find((b) => b.number === 2).deployedSha);
    assert.equal(sh(state.deployWork, 'test -f pr.txt && ! test -f pr2.txt && echo ok').trim(), 'ok', 'PR 1 is in what was deployed, PR 2 is not');
    const rb = await (await post('/api/build-log', { number: 7 })).json();
    assert.deepEqual(rb.stages.map((s) => [s.name, s.status]), [['Batch PRs', 'passed'], ['Checks', 'passed'], ['Release', 'passed'], ['App', 'passed']], 'no merge on GitHub in a rollback');
    assert.deepEqual(state.builds.slice(0, 3).map((b) => [b.number, b.status]), [[7, 'live'], [6, 'good'], [5, 'replaced']]);

    // A deploy stage fails after the merge: Retry runs just that stage again for the same build, with no new merge.
    assert.equal((await post('/api/queue', { action: 'resume' })).status, 200);
    writeFileSync(join(tmp, 'failonce'), '');
    assert.equal((await post('/api/build', { prs: [] })).status, 200);
    await until((s) => s.build.number === 8 && s.buildOk, 'green build #8');
    assert.equal((await post('/api/deploy')).status, 200);
    await until((s) => s.retry === 'deploy0' && !s.deploying, 'build #8 fails its Release');
    assert.equal(state.live.number, 7);
    assert.equal((await post('/api/retry', { number: 7 })).status, 400, 'only the last deploy');
    // The failed stage survives a restart of the app. So does one that was running when the app stopped: it comes back
    // stopped, and Retry runs it again.
    rmSync(join(tmp, 'gate'));
    await restart();
    await until((s) => s.retry === 'deploy0' && s.deployRow === 8, 'failed Release back after restart');
    const merges0 = sh(tmp, 'git --git-dir=remote.git rev-list --count main');
    assert.equal((await post('/api/retry', { number: 8 })).status, 200);
    await until((s) => s.running.includes('deploy0'), 'Release running again, at the gate');
    await restart();
    await until((s) => s.retry === 'deploy0', 'interrupted Release back after restart');
    const rel = state.stages.find((s) => s.id === 'deploy0');
    assert.equal(rel.status, 'stopped');
    assert.equal(rel.interrupted, true);
    assert.equal(rel.log.at(-1), 'The app stopped while this stage ran. Retry runs it again.');
    assert.equal(state.builds.find((b) => b.number === 8).status, 'failed');
    assert.equal(sh(tmp, 'git --git-dir=remote.git rev-list --count main'), merges0, 'no merge on restart');
    writeFileSync(join(tmp, 'gate'), '');
    const merges = sh(tmp, 'git --git-dir=remote.git rev-list --count main'), appRuns = sh(tmp, 'wc -l < app-runs');
    assert.equal((await post('/api/retry', { number: 8 })).status, 200);
    await until((s) => s.live?.number === 8 && !s.deploying, 'retried build #8 is live');
    assert.equal(state.retry, null);
    assert.equal(sh(tmp, 'git --git-dir=remote.git rev-list --count main'), merges, 'no new merge');
    assert.equal(sh(tmp, 'wc -l < app-runs'), appRuns, 'App passed beside the failed Release, so the retry does not run it again');
    assert.deepEqual((await (await post('/api/build-log', { number: 8 })).json()).stages.map((s) => s.status), ['passed', 'passed', 'passed', 'passed', 'passed']);

    // Each environment goes live on its own. App ("store") fails: build #9 is live in test anyway, the queue does not
    // pause, store keeps build #8, and Retry runs just App.
    assert.deepEqual(state.lives.map((l) => [l.environment, l.live.number]), [['test', 8], ['store', 8]]);
    writeFileSync(join(tmp, 'failapp'), '');
    assert.equal((await post('/api/build', { prs: [] })).status, 200);
    await until((s) => s.build.number === 9 && s.buildOk, 'green build #9');
    assert.equal((await post('/api/deploy')).status, 200);
    await until((s) => s.live?.number === 9 && !s.deploying, 'build #9 live in test without App');
    assert.deepEqual(state.lives.map((l) => [l.environment, l.live.number]), [['test', 9], ['store', 8]]);
    assert.equal(state.paused, false);
    assert.match(state.error, /live in test, but not in store/);
    assert.equal(state.retry, 'deploy1');
    const at = state.live.at;
    assert.equal((await post('/api/retry', { number: 9 })).status, 200);
    await until((s) => s.lives[1].live.number === 9 && !s.deploying, 'App passes on retry: store has #9');
    assert.equal(state.live.at, at, 'live in test since the first deploy');
    assert.equal(state.retry, null);
    events.body.cancel().catch(() => {});
  } finally {
    server.kill();
    mcp?.kill();
  }
});

test('parallel is ignored on the first stage of a list, so nothing deploys beside the merge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-cfg-')), home = process.env.HOME;
  process.env.HOME = dir; // importing the server makes its state folder in HOME
  try {
    const { readConfig } = await import('../server.mjs');
    writeFileSync(join(dir, 'pipeline.json'), JSON.stringify({ deploy: [{ name: 'A', run: 'a', parallel: true }, { name: 'B', run: 'b', parallel: true }, { name: 'C', run: 'c', parallel: 'yes' }] }));
    assert.deepEqual(readConfig(dir).deploy.map((s) => s.parallel), [false, true, false]);
    writeFileSync(join(dir, 'pipeline.json'), JSON.stringify({ environment: 'web', build: [{ name: 'A', run: 'a', environment: 'x' }], deploy: [{ name: 'B', run: 'b', environment: 'TestFlight' }, { name: 'C', run: 'c' }] }));
    assert.deepEqual([...readConfig(dir).build, ...readConfig(dir).deploy].map((s) => s.environment), [undefined, 'TestFlight', 'web'], 'environment is for deploy stages, default the pipeline\'s');
    writeFileSync(join(dir, 'pipeline.json'), JSON.stringify({ deploy: [{ name: 'B', run: 'b', environment: ' ' }] }));
    assert.throws(() => readConfig(dir), /empty environment/);
  } finally {
    process.env.HOME = home;
    rmSync(dir, { recursive: true });
  }
});
