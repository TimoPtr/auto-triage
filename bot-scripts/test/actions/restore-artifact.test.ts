import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../../actions/restore-index/restore-artifact.sh', import.meta.url));
const fakeBin = fileURLToPath(new URL('../fixtures/bin', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'kb-restore-artifact-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

/** Builds a zip from a directory with the system zip (symlinks kept). */
function zipDir(name: string, fill: (dir: string) => void): string {
  const dir = join(tmp, `${name}-src`); mkdirSync(dir, { recursive: true }); fill(dir);
  const zip = join(tmp, `${name}.zip`);
  const r = spawnSync('zip', ['-q', '-r', '-y', zip, '.'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return zip;
}

function run(args: string[], zip: string, id = '42') {
  return spawnSync('bash', [script, ...args], {
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, GITHUB_REPOSITORY: 'o/r', GH_TOKEN: 'x', FAKE_ARTIFACT_ID: id, FAKE_ZIP: zip }, encoding: 'utf8',
  });
}

test('restores a directory artifact of regular files', () => {
  const zip = zipDir('flat', (d) => { writeFileSync(join(d, 'summary.json'), '{}'); writeFileSync(join(d, 'cases.jsonl'), '{"id":"a"}\n'); });
  const dest = join(tmp, 'flat-dest');
  const r = run(['eval-x', dest, 'dir'], zip);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '42');
  assert.deepEqual(readdirSync(dest).sort(), ['cases.jsonl', 'summary.json']);
});

test('discards an artifact with a symlink, a directory or an escaping entry', () => {
  const cases: [string, string][] = [
    ['symlink', zipDir('symlink', (d) => { writeFileSync(join(d, 'summary.json'), '{}'); symlinkSync('/etc/passwd', join(d, 'cases.jsonl')); })],
    ['subdir', zipDir('subdir', (d) => { writeFileSync(join(d, 'summary.json'), '{}'); mkdirSync(join(d, 'nested')); writeFileSync(join(d, 'nested', 'x.txt'), 'x'); })],
    ['hidden', zipDir('hidden', (d) => { writeFileSync(join(d, 'summary.json'), '{}'); writeFileSync(join(d, '.profile'), 'x'); })],
  ];
  const python = spawnSync('python3', ['-c', `import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('summary.json','{}'); z.writestr('../evil.txt','x'); z.close()`, join(tmp, 'escaping.zip')], { encoding: 'utf8' });
  if (python.status === 0) cases.push(['escaping', join(tmp, 'escaping.zip')]);
  for (const [name, zip] of cases) {
    const dest = join(tmp, `${name}-dest`);
    const r = run(['eval-x', dest, 'dir'], zip);
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.equal(r.stdout.trim(), '0', name);
    assert.match(r.stderr, /ignoring it/, name);
    assert.ok(!existsSync(dest) || readdirSync(dest).length === 0, `${name}: destination stays empty`);
  }
  assert.ok(!existsSync(join(tmp, 'evil.txt')));
});

test('keeps the single-file mode', () => {
  const zip = zipDir('single', (d) => writeFileSync(join(d, 'knowledge.sqlite'), 'db'));
  const dest = join(tmp, 'single-dest', 'knowledge.sqlite');
  const r = run(['x-index', dest], zip);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '42');
  assert.ok(existsSync(dest));
  const two = zipDir('two', (d) => { writeFileSync(join(d, 'knowledge.sqlite'), 'db'); writeFileSync(join(d, 'extra'), 'x'); });
  const r2 = run(['x-index', join(tmp, 'two-dest', 'knowledge.sqlite')], two);
  assert.equal(r2.stdout.trim(), '0');
  const none = run(['x-index', join(tmp, 'none-dest', 'knowledge.sqlite')], zip, '');
  assert.equal(none.stdout.trim(), '0');
});
