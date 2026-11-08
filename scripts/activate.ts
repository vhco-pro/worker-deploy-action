import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const safeName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

type Deployment = { id: string; versions: { version_id: string; percentage: number }[]; annotations?: Record<string, string> };
type Release = { project: string; configPath: string; bundle: string; worker: string; tag: string; commit: string; digest: string; configDigest: string };

function git(project: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: project, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error('Could not verify exact source checkout');
  return result.stdout.trim();
}

function readFile(path: string): Buffer {
  if (!lstatSync(path).isFile()) throw new Error('Expected a regular artifact or config file');
  return readFileSync(path);
}

export function verifyRelease(env: NodeJS.ProcessEnv): Release {
  const target = env.WORKER_TARGET ?? '';
  const worker = env.EXPECTED_WORKER ?? '';
  const tag = env.RELEASE_TAG ?? '';
  const commit = env.SOURCE_COMMIT ?? '';
  if (!safeName.test(target) || !safeName.test(worker) || !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag)
    || !/^[0-9a-f]{40}$/.test(commit) || !env.RELEASE_ARTIFACT) throw new Error('Invalid deployment identity');

  const workspace = realpathSync(env.GITHUB_WORKSPACE ?? process.cwd());
  const project = realpathSync(resolve(workspace, env.WORKER_PROJECT ?? '.'));
  if (relative(workspace, project).split('/')[0] === '..') throw new Error('Project must be inside the checkout');
  if (git(project, ['rev-parse', 'HEAD']) !== commit
    || git(project, ['rev-parse', `refs/tags/${tag}^{commit}`]) !== commit
    || git(project, ['status', '--porcelain', '--untracked-files=no'])) throw new Error('Checkout must match the exact clean tag');

  const artifact = realpathSync(env.RELEASE_ARTIFACT);
  const bundle = join(artifact, 'worker.mjs');
  const configPath = join(project, `${target}.wrangler.json`);
  const hash = (path: string) => createHash('sha256').update(readFile(path)).digest('hex');
  const manifest = JSON.parse(readFile(join(artifact, 'manifest.json')).toString());
  const digest = hash(bundle);
  const configDigest = hash(configPath);
  const config = JSON.parse(readFile(configPath).toString());
  const wrangler = JSON.parse(readFile(join(project, 'node_modules/wrangler/package.json')).toString());
  const node = spawnSync('node', ['--version'], { encoding: 'utf8' });
  if (manifest.schema !== 1 || manifest.commit !== commit || manifest.tag !== tag || manifest.target !== target
    || manifest.worker !== worker || config.name !== worker || 'account_id' in config
    || manifest.digest !== digest || manifest.configDigest !== configDigest
    || manifest.lockDigest !== hash(join(project, 'package-lock.json'))
    || manifest.wrangler !== wrangler.version || node.status !== 0 || manifest.node !== node.stdout.trim()) {
    throw new Error('Artifact, toolchain and protected target identities do not match');
  }
  return { project, configPath, bundle, worker, tag, commit, digest, configDigest };
}

function activeVersion(deployment: Deployment | undefined): string {
  const version = deployment?.versions?.[0];
  if (!deployment || !uuid.test(deployment.id) || deployment.versions.length !== 1
    || !version || version.percentage !== 100 || !uuid.test(version.version_id)) {
    throw new Error('Expected an already provisioned Worker with one active version at 100 percent');
  }
  return version.version_id;
}

export async function activate(
  release: Release,
  list: () => Promise<Deployment[]>,
  run: (args: string[]) => string,
  pause = (ms: number) => Bun.sleep(ms),
) {
  const message = `release ${release.tag} sha256:${release.digest} config:${release.configDigest}`;
  const [current, previous] = await list();
  const currentVersion = activeVersion(current);
  if (current.annotations?.['workers/message'] === message) {
    return { version: currentVersion, deployment: current.id, previous_version: previous ? activeVersion(previous) : '' };
  }

  const version = run(['versions', 'upload', release.bundle, '--no-bundle', '--no-upload-source-maps', '--config', release.configPath, '--tag', release.tag, '--message', message]);
  if (!uuid.test(version)) throw new Error('Wrangler returned an invalid version ID');
  if ((await list())[0]?.id !== current.id) throw new Error('Active deployment changed during upload');
  const deployment = run(['versions', 'deploy', `${version}@100%`, '--yes', '--config', release.configPath, '--message', message]);
  if (!uuid.test(deployment)) throw new Error('Wrangler returned an invalid deployment ID');

  for (let attempt = 0; attempt < 5; attempt++) {
    const [live] = await list();
    if (live?.id === deployment && activeVersion(live) === version) {
      return { version, deployment, previous_version: currentVersion };
    }
    await pause(1000);
  }
  throw new Error('Cloudflare did not report the requested deployment as active');
}

async function main(env: NodeJS.ProcessEnv) {
  const release = verifyRelease(env);
  const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token, GITHUB_OUTPUT: output } = env;
  if (!account || !/^[a-f0-9]{32}$/i.test(account) || !token || !output) throw new Error('Missing protected deployment credentials or outputs');
  const dir = mkdtempSync(join(env.RUNNER_TEMP ?? '/tmp', 'worker-deploy-'));
  async function list(): Promise<Deployment[]> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${release.worker}/deployments`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Could not read the active Cloudflare deployment (HTTP ${response.status})`);
    const data = await response.json();
    if (!data.success || !Array.isArray(data.result?.deployments)) throw new Error('Unexpected Cloudflare deployment response');
    return data.result.deployments;
  }

  let invocation = 0;
  function run(args: string[]): string {
    const report = join(dir, `wrangler-${++invocation}.jsonl`);
    const result = spawnSync('node', [join(release.project, 'node_modules/wrangler/bin/wrangler.js'), ...args], {
      cwd: release.project,
      env: {
        ...env,
        WRANGLER_SEND_METRICS: 'false',
        WRANGLER_OUTPUT_FILE_PATH: report,
        WRANGLER_LOG_PATH: join(dir, 'wrangler.log'),
      },
      stdio: 'inherit',
    });
    if (result.error || result.status !== 0) throw new Error(`Wrangler versions ${args[1]} failed`, { cause: result.error });
    const upload = args[1] === 'upload';
    const type = upload ? 'version-upload' : 'version-deploy';
    const record = readFileSync(report, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      .filter(entry => entry.type === type && entry.version === 1 && entry.worker_name === release.worker);
    if (record.length !== 1) throw new Error('Expected one matching structured Wrangler result');
    return upload ? record[0].version_id : record[0].deployment_id;
  }

  const receipt = await activate(release, list, run);
  appendFileSync(output, Object.entries(receipt).map(([key, value]) => `${key}=${value}\n`).join(''));
  console.log(JSON.stringify({ worker: release.worker, tag: release.tag, digest: release.digest, ...receipt }));
}

if (import.meta.main) await main(process.env);
