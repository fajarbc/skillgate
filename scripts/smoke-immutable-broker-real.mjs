/** Linux root-only smoke for the REAL built SkillGate immutable broker.
 * Run after npm run build: node scripts/smoke-immutable-broker-real.mjs
 * Uses disposable /tmp paths and temporary numeric credentials, no host accounts.
 * This is an integration regression, NOT acceptance of Option B.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmod, chown, copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function main() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) {
    throw new Error('Real broker smoke requires Linux root for cross-UID isolation');
  }
  if (spawnSync('setpriv', ['--help'], { stdio: 'ignore' }).status !== 0) {
    throw new Error('Real broker smoke requires util-linux setpriv');
  }
  const passwd = await readFile('/etc/passwd', 'utf8');
  const groups = await readFile('/etc/group', 'utf8');
  const used = new Set([
    ...passwd.split('\n').map(line => Number(line.split(':')[2])),
    ...groups.split('\n').map(line => Number(line.split(':')[2])),
  ]);
  const free = [];
  for (let n = 61000; n < 65000 && free.length < 5; n++) {
    if (!used.has(n)) free.push(n);
  }
  assert.equal(free.length, 5, 'cannot allocate unused numeric test identities');
  const [brokerUid, clientUid, clientGid, outsiderUid, outsiderGid] = free;
  const repository = dirname(dirname(fileURLToPath(import.meta.url)));
  const sandbox = await mkdtemp(join(tmpdir(), 'skillgate-real-broker-'));
  const code = join(sandbox, 'code');
  const scripts = join(code, 'scripts');
  const dist = join(code, 'dist', 'adapters');
  const socketDir = join(sandbox, 'socket');
  const store = join(sandbox, 'store');
  const socketPath = join(socketDir, 'broker.sock');
  const priv = (uid, gid, args) => [
    '--no-new-privs', '--bounding-set=-all', '--reuid', String(uid),
    '--regid', String(gid), '--clear-groups', process.execPath, ...args,
  ];
  async function runAs(uid, gid, args) {
    const child = spawn('setpriv', priv(uid, gid, args), { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
    try {
      const [exitCode, signal] = await once(child, 'exit');
      assert.equal(signal, null, 'isolated child terminated: ' + errors);
      assert.equal(exitCode, 0, 'isolated child failed: ' + errors);
      return output;
    } finally {
      clearTimeout(timeout);
    }
  }
  let broker;
  try {
    await chmod(sandbox, 0o755);
    await mkdir(scripts, { recursive: true, mode: 0o755 });
    await mkdir(dist, { recursive: true, mode: 0o755 });
    await writeFile(join(code, 'package.json'), '{"type":"module"}\n');
    for (const name of [
      'immutable-store-broker.mjs', 'immutable-broker-identity.mjs',
      'immutable-broker-capabilities.mjs', 'immutable-broker-client.mjs',
    ]) {
      await copyFile(join(repository, 'scripts', name), join(scripts, name));
    }
    await copyFile(join(repository, 'dist', 'adapters', 'immutable-store.js'),
      join(dist, 'immutable-store.js'));
    await mkdir(socketDir, { mode: 0o710 });
    await mkdir(store, { mode: 0o700 });
    await chown(socketDir, brokerUid, clientGid);
    await chown(store, brokerUid, clientGid);
    await chmod(socketDir, 0o710);
    await chmod(store, 0o700);
    broker = spawn('setpriv', priv(brokerUid, clientGid, [
      join(scripts, 'immutable-store-broker.mjs'), socketPath, store,
    ]), {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        SKILLGATE_BROKER_CLIENT_UID: String(clientUid),
        SKILLGATE_BROKER_CLIENT_GID: String(clientGid),
      },
    });
    let brokerErrors = '';
    broker.stderr.on('data', chunk => { brokerErrors += chunk; });
    let ready = false;
    for (let i = 0; i < 400; i++) {
      if (broker.exitCode !== null || broker.signalCode !== null) {
        throw new Error('broker exited before readiness: ' + brokerErrors);
      }
      try {
        // The socket pathname exists before the broker has verified its mode
        // and enabled request handling. Wait for the readiness log as well.
        if ((await lstat(socketPath)).isSocket() &&
            brokerErrors.includes('immutable broker listening')) {
          ready = true;
          break;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(ready, 'broker did not create its socket: ' + brokerErrors);
    // Independently verify the broker-owned, group-only socket boundary.
    const socketEntry = await lstat(socketPath);
    assert.equal(socketEntry.uid, brokerUid, 'broker must own the socket');
    assert.equal(socketEntry.gid, clientGid, 'socket group must be the configured client group');
    assert.equal(socketEntry.mode & 0o777, 0o660, 'socket must not permit other users');
    const outsiderCode = [
      'import assert from "node:assert/strict";',
      'import {createConnection} from "node:net";',
      'const path=' + JSON.stringify(socketPath) + ';',
      'const error=await new Promise((resolve,reject)=>{',
      '  const socket=createConnection({path});',
      '  socket.once("error",resolve);',
      '  socket.once("connect",()=>{socket.destroy();reject(new Error("unauthorized peer connected"));});',
      '});',
      'assert.equal(error.code,"EACCES");',
      'console.log("PASS unauthorized UID/GID denied by socket ancestry and permissions");',
    ].join('\n');
    assert.match(await runAs(outsiderUid, outsiderGid, [
      '--input-type=module', '--eval', outsiderCode,
    ]), /PASS unauthorized UID\/GID denied/);
    const payload = 'SkillGate real cross-UID immutable broker smoke';
    const digest = createHash('sha256').update(payload).digest('hex');
    const clientModule = pathToFileURL(join(scripts, 'immutable-broker-client.mjs')).href;
    const clientCode = [
      'import assert from "node:assert/strict";',
      'import {putBrokerBlob,getBrokerBlob} from ' + JSON.stringify(clientModule) + ';',
      'const path=' + JSON.stringify(socketPath) + ';',
      'const bytes=Buffer.from(' + JSON.stringify(payload) + ');',
      'const trust={expectedBrokerUid:' + brokerUid + ',expectedBrokerGid:' + clientGid + '};',
      'const a=await putBrokerBlob(path,bytes,trust);',
      'const b=await putBrokerBlob(path,bytes,trust);',
      'assert.deepEqual(a,{digest:' + JSON.stringify(digest) + ',created:true});',
      'assert.deepEqual(b,{digest:' + JSON.stringify(digest) + ',created:false});',
      'assert.deepEqual(await getBrokerBlob(path,a.digest,trust),bytes);',
      'await assert.rejects(getBrokerBlob(path,"0".repeat(64),trust));',
      'console.log("PASS real broker put/get/dedup/digest");',
    ].join('\n');
    assert.match(await runAs(clientUid, clientGid, [
      '--input-type=module', '--eval', clientCode,
    ]), /PASS real broker/);
    const attackCode = [
      'import assert from "node:assert/strict";',
      'import {chmod,rename,writeFile} from "node:fs/promises";',
      'const store=' + JSON.stringify(store) + ';',
      'const digest=' + JSON.stringify(digest) + ';',
      'for (const action of [',
      '  ()=>chmod(store,0o777),',
      '  ()=>rename(store,store+".replaced"),',
      '  ()=>chmod(store+"/"+digest,0o600),',
      '  ()=>writeFile(store+"/forged","evil"),',
      ']) await assert.rejects(action(), e=>e.code==="EACCES"||e.code==="EPERM");',
      'console.log("PASS client cannot mutate broker-owned store");',
    ].join('\n');
    assert.match(await runAs(clientUid, clientGid, [
      '--input-type=module', '--eval', attackCode,
    ]), /PASS client cannot mutate/);
    // A private leaf store is insufficient when an untrusted UID owns a
    // seemingly read-only ancestor: that owner can rename the leaf directory.
    // The actual broker must reject such a deployment before listening.
    const unsafeAncestor = join(sandbox, 'client-owned-ancestor');
    const unsafeStore = join(unsafeAncestor, 'broker-store');
    await mkdir(unsafeAncestor, { mode: 0o755 });
    await mkdir(unsafeStore, { mode: 0o700 });
    await chown(unsafeAncestor, clientUid, clientGid);
    await chown(unsafeStore, brokerUid, clientGid);
    const refused = spawnSync('setpriv', priv(brokerUid, clientGid, [
      join(scripts, 'immutable-store-broker.mjs'),
      join(socketDir, 'unsafe-ancestor.sock'), unsafeStore,
    ]), {
      encoding: 'utf8', timeout: 5000,
      env: {
        ...process.env,
        SKILLGATE_BROKER_CLIENT_UID: String(clientUid),
        SKILLGATE_BROKER_CLIENT_GID: String(clientGid),
      },
    });
    assert.ifError(refused.error);
    assert.equal(refused.status, 1, 'broker must reject client-owned store ancestor: ' + refused.stderr);
    assert.match(refused.stderr, /socket ancestor is owned by an untrusted UID/);
    console.log('PASS: actual broker rejects untrusted-owned store ancestry');
    console.log('PASS: actual built broker cross-UID smoke');
  } finally {
    if (broker && broker.exitCode === null && broker.signalCode === null) {
      broker.kill('SIGTERM');
      await Promise.race([
        once(broker, 'exit').catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 2000)),
      ]);
      if (broker.exitCode === null && broker.signalCode === null) broker.kill('SIGKILL');
    }
    await rm(sandbox, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
