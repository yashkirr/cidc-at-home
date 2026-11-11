// End to end: a throwaway repo with one open PR, a fake gh, and fake stages. Build main + the PR, deploy,
// and check that main on the "GitHub" remote ends up with the PR merged and every stage passed.
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
    deploy: [{ name: 'Release', run: 'echo "== Upload"; echo "$WHO" > deployed.txt', env: { WHO: 'me' } }],
  }));
  sh(repo, `echo a > a.txt && git add -A && git -c user.name=t -c user.email=t@t commit -qm init && git push -q origin main
    git checkout -qb pr && echo pr > pr.txt && git add -A && git -c user.name=t -c user.email=t@t commit -qm pr && git push -q origin pr:refs/pull/1/head
    git checkout -q main`);
  // Fake gh: lists PR 1, and "merges" it on the remote like GitHub's merge button.
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
case "$*" in
  *pulls\\?state=open*) echo '[{"number":1,"title":"Add pr.txt","draft":false,"branch":"pr","author":"t","sha":"x","url":"u"}]' ;;
  *pulls/1/merge*) d=$(mktemp -d) && git clone -q "${remote}" "$d" && cd "$d" && git fetch -q origin pull/1/head &&
    git -c user.name=gh -c user.email=gh@gh merge -q --no-ff -m "Merge pull request #1" FETCH_HEAD && git push -q origin HEAD:main && echo merged ;;
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
    const until = async (ok, what) => { for (let i = 0; i < 300; i++) { if (state && ok(state)) return; await new Promise((r) => setTimeout(r, 100)); } assert.fail(`timed out: ${what}; ${JSON.stringify(state?.stages?.map((s) => [s.id, s.status, s.log.slice(-3)]))}`); };

    await until((s) => s.prs.length === 1, 'PR list');
    assert.equal((await fetch(base + '/api/deploy', { method: 'POST', headers: { 'x-token': 'wrong' } })).status, 403, 'no token, no deploy');
    assert.equal((await post('/api/deploy')).status, 400, 'deploy is locked before a build');

    assert.equal((await post('/api/build', { prs: [1] })).status, 200);
    await until((s) => s.buildOk, 'green build');
    assert.deepEqual(state.stages.find((s) => s.name === 'Checks').steps.map((s) => [s.name, s.status]), [['Lint', 'passed'], ['Tests', 'passed']]);

    assert.equal((await post('/api/deploy')).status, 200);
    await until((s) => !s.running && s.stages.at(-1).status !== 'waiting', 'deploy finished');
    assert.deepEqual(state.stages.map((s) => s.status), ['passed', 'passed', 'passed', 'passed']);
    assert.match(sh(tmp, `git --git-dir=remote.git log -1 --format=%s main`), /Merge pull request #1/);
    assert.equal(sh(state.work, 'cat deployed.txt').trim(), 'me');
    assert.equal(state.buildOk, false, 'one deploy per build');
    events.body.cancel().catch(() => {});
  } finally {
    server.kill();
  }
});
