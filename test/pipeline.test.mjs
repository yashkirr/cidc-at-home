// End to end: a throwaway repo with two open PRs, a fake gh, and fake stages. Build main + PR 1 and deploy it; while
// that deploy runs, build PR 2 stacked on it; then deploy PR 2. Main on the "GitHub" remote ends up with both merged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const sh = (cwd, cmd) => execFileSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });

test('build a batch with a PR, then deploy merges it and runs the deploy stages', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pipeline-'));
  const remote = join(tmp, 'remote.git'), repo = join(tmp, 'repo'), bin = join(tmp, 'bin'), home = join(tmp, 'home');
  mkdirSync(bin); mkdirSync(home);
  sh(tmp, `git init -q --bare -b main remote.git && git clone -q remote.git repo`);
  writeFileSync(join(repo, 'pipeline.json'), JSON.stringify({
    environment: 'test',
    build: [{ name: 'Checks', run: 'echo "== Lint"; echo ok; echo "== Tests"; test -f a.txt && test -f pr.txt' }],
    // Waits for the test to open the gate, so the next batch is built while this deploy is still running.
    deploy: [{ name: 'Release', run: `echo "== Upload"; until [ -f "${join(tmp, 'gate')}" ]; do sleep 0.1; done; echo "$WHO" > deployed.txt`, env: { WHO: 'me' } }],
  }));
  sh(repo, `echo a > a.txt && git add -A && git -c user.name=t -c user.email=t@t commit -qm init && git push -q origin main
    git checkout -qb pr && echo pr > pr.txt && git add -A && git -c user.name=t -c user.email=t@t commit -qm pr && git push -q origin pr:refs/pull/1/head
    git checkout -q main && git checkout -qb pr2 && echo pr2 > pr2.txt && git add -A && git -c user.name=t -c user.email=t@t commit -qm pr2 && git push -q origin pr2:refs/pull/2/head
    git checkout -q main`);
  // Fake gh: lists PRs 1 and 2, and "merges" one on the remote like GitHub's merge button.
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
case "$*" in
  *pulls\\?state=open*) echo '[{"number":1,"title":"Add pr.txt","draft":false,"branch":"pr","author":"t"},{"number":2,"title":"Add pr2.txt","draft":false,"branch":"pr2","author":"t"}]' ;;
  *pulls/*/merge*) n=\${4#*pulls/} && n=\${n%%/*} && d=$(mktemp -d) && git clone -q "${remote}" "$d" && cd "$d" && git fetch -q origin pull/$n/head &&
    git -c user.name=gh -c user.email=gh@gh merge -q --no-ff -m "Merge pull request #$n" FETCH_HEAD && git push -q origin HEAD:main && echo merged ;;
  *) echo "fake gh: $*" >&2; exit 1 ;;
esac
`);
  chmodSync(join(bin, 'gh'), 0o755);

  const port = 43000 + Math.floor(Math.random() * 1000);
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, PIPELINE_PORT: String(port), PIPELINE_NO_OPEN: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const server = spawn(process.execPath, [join(HERE, '..', 'server.mjs'), repo], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((res) => server.stdout.once('data', res));
    const base = `http://localhost:${port}`;
    const token = (await (await fetch(base + '/')).text()).match(/const TOKEN = '(\w+)'/)[1];
    const post = (p, b = {}) => fetch(base + p, { method: 'POST', headers: { 'x-token': token, 'content-type': 'application/json' }, body: JSON.stringify(b) });

    // Latest state from the event stream.
    let state;
    const events = await fetch(base + '/events');
    (async () => { const dec = new TextDecoder(); let buf = '';
      for await (const chunk of events.body) { buf += dec.decode(chunk); let i;
        while ((i = buf.indexOf('\n\n')) >= 0) { const m = JSON.parse(buf.slice(6, i)); buf = buf.slice(i + 2); if (m.type === 'state') state = m.state; } } })().catch(() => {});
    const until = async (ok, what) => { for (let i = 0; i < 300; i++) { if (state && ok(state)) return; await new Promise((r) => setTimeout(r, 100)); } assert.fail(`timed out: ${what}; ${JSON.stringify(state?.stages?.map((s) => [s.id, s.status, s.log?.slice(-3), s.steps]))}`); };

    await until((s) => s.prs.length === 2, 'PR list');
    assert.equal((await fetch(base + '/api/deploy', { method: 'POST', headers: { 'x-token': 'wrong' } })).status, 403, 'no token, no deploy');
    assert.equal((await post('/api/deploy')).status, 400, 'deploy is locked before a build');

    assert.equal((await post('/api/build', { prs: [1] })).status, 200);
    await until((s) => s.buildOk, 'green build');
    assert.deepEqual(state.stages.find((s) => s.name === 'Checks').steps.map((s) => [s.name, s.status]), [['Lint', 'passed'], ['Tests', 'passed']]);

    assert.equal((await post('/api/deploy')).status, 200);
    await until((s) => s.running.includes('deploy0'), 'deploy of PR 1 waiting at the gate');
    assert.equal(state.buildOk, false, 'one deploy per build');
    assert.equal((await post('/api/build', { prs: [1] })).status, 400, 'PR 1 is being deployed');

    // Step 2 is busy; the next batch builds anyway, in its own worktree, on top of the batch being deployed.
    assert.equal((await post('/api/build', { prs: [2] })).status, 200);
    await until((s) => s.buildOk, 'green stacked build');
    assert.deepEqual(state.stackedOn, [1]);
    assert.notEqual(state.work, state.deployWork);
    assert.equal((await post('/api/deploy')).status, 400, 'one deploy at a time');

    writeFileSync(join(tmp, 'gate'), '');
    await until((s) => !s.deploying, 'deploy of PR 1 finished');
    assert.match(sh(tmp, `git --git-dir=remote.git log -1 --format=%s main`), /Merge pull request #1/);
    assert.equal(sh(state.deployWork, 'cat deployed.txt').trim(), 'me');

    assert.equal((await post('/api/deploy')).status, 200);
    await until((s) => !s.deploying && s.stages.at(-1).status !== 'waiting', 'deploy of PR 2 finished');
    assert.deepEqual(state.stages.map((s) => s.status), ['passed', 'passed', 'passed', 'passed']);
    assert.match(sh(tmp, `git --git-dir=remote.git log -1 --format=%s main`), /Merge pull request #2/);
    assert.equal(sh(tmp, 'git --git-dir=remote.git show main:pr.txt main:pr2.txt'), 'pr\npr2\n');
    events.body.cancel().catch(() => {});
  } finally {
    server.kill();
  }
});
