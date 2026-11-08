import { expect, test } from 'bun:test';
import { activate, verifyRelease } from '../scripts/activate';

const env = process.env;
const fixtureRoot = env.WORKER_RELEASE_PROOF;
const oldVersion = 'a023e105-f2a4-44f8-ba1c-173f6a2a30c0';
const newVersion = 'b023e105-f2a4-44f8-ba1c-173f6a2a30c0';
const oldID = 'c023e105-f2a4-44f8-ba1c-173f6a2a30c0';
const newID = 'd023e105-f2a4-44f8-ba1c-173f6a2a30c0';
const otherID = 'e023e105-f2a4-44f8-ba1c-173f6a2a30c0';
const old = { id: oldID, versions: [{ version_id: oldVersion, percentage: 100 }] };
const other = { id: otherID, versions: [{ version_id: oldVersion, percentage: 100 }] };
const release = {
  project: '/checkout', configPath: '/checkout/stackweaver.wrangler.json',
  bundle: '/artifact/worker.mjs', worker: 'vhco-contact-stackweaver', tag: 'v1.2.3',
  commit: 'a'.repeat(40), digest: 'b'.repeat(64), configDigest: 'c'.repeat(64),
};
const message = `release ${release.tag} sha256:${release.digest} config:${release.configDigest}`;
const live = {
  id: newID, versions: [{ version_id: newVersion, percentage: 100 }],
  annotations: { 'workers/message': message },
};

test('passes the artifact path without bundling and activates only the uploaded version', async () => {
  const calls: string[][] = [];
  let reads = 0;
  const result = await activate(release, async () => ++reads < 3 ? [old] : [live, old], args => {
    calls.push(args);
    return args[1] === 'upload' ? newVersion : newID;
  });
  expect(calls[0]).toEqual(['versions', 'upload', release.bundle, '--no-bundle', '--no-upload-source-maps',
    '--config', release.configPath, '--tag', release.tag, '--message', message]);
  expect(calls[1]).toEqual(['versions', 'deploy', `${newVersion}@100%`, '--yes', '--config', release.configPath, '--message', message]);
  expect(result).toEqual({ version: newVersion, deployment: newID, previous_version: oldVersion });
});

test('recognizes an exact active release on retry without another upload or deployment', async () => {
  const result = await activate(release, async () => [live, old], () => { throw new Error('Unexpected mutation'); });
  expect(result.deployment).toBe(newID);
  expect(result.previous_version).toBe(oldVersion);
});

test('stops when another deployment changes the active ID during upload', async () => {
  let reads = 0;
  const calls: string[] = [];
  await expect(activate(release, async () => ++reads === 1 ? [old] : [other], args => {
    calls.push(args[1]!);
    return newVersion;
  })).rejects.toThrow('Active deployment changed during upload');
  expect(calls).toEqual(['upload']);
});

test('rejects initial provisioning or a split-traffic deployment before a mutation', async () => {
  const unexpected = () => { throw new Error('Unexpected mutation'); };
  await expect(activate(release, async () => [], unexpected)).rejects.toThrow('already provisioned');
  const split = { ...old, versions: [{ version_id: oldVersion, percentage: 50 }] };
  await expect(activate(release, async () => [split], unexpected)).rejects.toThrow('100 percent');
});

test('requires a provider read-back of the exact active deployment', async () => {
  await expect(activate(release, async () => [old], args => args[1] === 'upload' ? newVersion : newID,
    async () => {})).rejects.toThrow('did not report the requested deployment as active');
});

test('rejects invalid upload IDs before asking Cloudflare to activate a version', async () => {
  const calls: string[] = [];
  await expect(activate(release, async () => [old], args => {
    calls.push(args[1]!);
    return 'not-a-version';
  })).rejects.toThrow('invalid version ID');
  expect(calls).toEqual(['upload']);
});

test.skipIf(!fixtureRoot)('accepts both actual CI artifacts and rejects crossed, edited and mistagged artifacts', async () => {
  const { mkdtempSync, cpSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const makeEnv = (target: string) => ({
    GITHUB_WORKSPACE: env.WORKER_RELEASE_PROJECT,
    WORKER_TARGET: target,
    EXPECTED_WORKER: target === 'vitepress' ? 'vhco-contact' : 'vhco-contact-stackweaver',
    RELEASE_TAG: env.WORKER_RELEASE_TEST_TAG,
    SOURCE_COMMIT: env.WORKER_RELEASE_TEST_COMMIT,
    RELEASE_ARTIFACT: join(fixtureRoot!, target),
  });
  const stackweaver = makeEnv('stackweaver');
  const vitepress = makeEnv('vitepress');
  expect(verifyRelease(stackweaver).worker).toBe('vhco-contact-stackweaver');
  expect(verifyRelease(vitepress).worker).toBe('vhco-contact');
  expect(() => verifyRelease({ ...stackweaver, RELEASE_ARTIFACT: vitepress.RELEASE_ARTIFACT })).toThrow('identities do not match');
  expect(() => verifyRelease({ ...stackweaver, EXPECTED_WORKER: vitepress.EXPECTED_WORKER })).toThrow('identities do not match');
  expect(() => verifyRelease({ ...stackweaver, SOURCE_COMMIT: '0'.repeat(40) })).toThrow('exact clean tag');
  expect(() => verifyRelease({ ...stackweaver, RELEASE_TAG: 'v99.0.0' })).toThrow('exact source checkout');
  const temp = mkdtempSync(join(fixtureRoot!, 'tampered-'));
  cpSync(stackweaver.RELEASE_ARTIFACT, temp, { recursive: true });
  writeFileSync(join(temp, 'worker.mjs'), 'edited after verification');
  expect(() => verifyRelease({ ...stackweaver, RELEASE_ARTIFACT: temp })).toThrow('identities do not match');
});
