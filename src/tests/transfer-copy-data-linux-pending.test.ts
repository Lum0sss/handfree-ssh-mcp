import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { after, before, describe, test } from "node:test";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";

/**
 * PLAN.MD P1-06c T12 -- same-server relay through the SFTP server's own
 * copy-data extension, against a REAL OpenSSH (9.0 or newer) server.
 *
 * Why this cannot run in-process: ssh2's SFTP server replies to INIT with a
 * fixed VERSION packet that carries no extensions (SFTP.js:109), so the
 * fixture can never advertise copy-data. The fallback when it is NOT
 * advertised is covered in-process (transfer-correctness-real.test.ts, T11);
 * this suite covers the path where it IS.
 *
 * ============================================================================
 * WHAT THE REVIEWER RUNS (not executed by the author -- no remote host was
 * touched while implementing this):
 * ============================================================================
 *
 *   COPYDATA_LAB_HOST=<host> \
 *   COPYDATA_LAB_USER=<user> \
 *   COPYDATA_LAB_KEY_PATH=/path/to/key \      (or COPYDATA_LAB_PASSWORD=...)
 *   COPYDATA_LAB_PORT=22 \                    (optional)
 *   COPYDATA_LAB_REMOTE_DIR=/tmp \            (optional, default /tmp)
 *     npm run build && node --test build/tests/transfer-copy-data-linux-pending.test.js
 *
 * The host must run OpenSSH sshd >= 9.0 (debian:12 ships 9.2) with the default
 * internal-sftp / sftp-server, and `md5sum` installed. Without
 * COPYDATA_LAB_HOST every test is skipped, not silently passed.
 * ============================================================================
 */

const skipReason = process.env.COPYDATA_LAB_HOST
  ? undefined
  : "MISSING CAPABILITY: COPYDATA_LAB_HOST (+ COPYDATA_LAB_USER and COPYDATA_LAB_KEY_PATH or COPYDATA_LAB_PASSWORD) " +
    "is not set. This test needs a real OpenSSH >= 9.0 sftp-server advertising copy-data; the in-process ssh2 " +
    "fixture cannot advertise SFTP extensions. See this file's module comment.";

describe("P1-06c T12: same-server relay via copy-data on real OpenSSH (SKIPPED unless COPYDATA_LAB_HOST is set)", { concurrency: false, skip: skipReason }, () => {
  const manager = SSHConnectionManager.getInstance();
  const service = manager.getTransferService();
  const SERVER = "copydata-lab";
  const remoteDir = process.env.COPYDATA_LAB_REMOTE_DIR ?? "/tmp";
  const root = `${remoteDir}/handfree-copydata-${crypto.randomBytes(4).toString("hex")}`;
  const run = (command: string) => manager.executeCommand(command, SERVER, { timeout: 60_000 });

  before(async () => {
    manager.setConfig(
      {
        [SERVER]: {
          host: process.env.COPYDATA_LAB_HOST!,
          port: process.env.COPYDATA_LAB_PORT ? Number(process.env.COPYDATA_LAB_PORT) : 22,
          username: process.env.COPYDATA_LAB_USER!,
          password: process.env.COPYDATA_LAB_PASSWORD,
          privateKey: process.env.COPYDATA_LAB_KEY_PATH,
          disableSftpPathPolicy: true,
        },
      },
      [SERVER],
    );
    await run(`mkdir -p ${root}`);
  });

  after(async () => {
    try { await run(`find ${root} -mindepth 0 -delete`); } catch { /* best-effort */ }
    manager.disconnect();
    manager.setConfig({}, undefined);
  });

  const md5Of = async (remotePath: string): Promise<string> => (await run(`md5sum ${remotePath}`)).trim().split(/\s+/)[0];

  test("copies on the server, verifies size and md5, and leaves no temp file", async () => {
    // Larger than one 64 MiB copy-data request, so the chunk loop's offsets
    // are exercised (a wrong offset shows up as an md5 mismatch).
    await run(`head -c 75497477 /dev/urandom > ${root}/src.bin`);

    const message = await service.transferBetweenServers(SERVER, `${root}/src.bin`, SERVER, `${root}/dst.bin`, { vvv: true });

    assert.match(message, /server-side copy-data/);
    assert.match(message, /md5=[0-9a-f]{32}/);
    assert.equal(await md5Of(`${root}/dst.bin`), await md5Of(`${root}/src.bin`));
    assert.equal((await run(`ls -A ${root}`)).split(/\s+/).filter((name) => name.includes(".handfree-copy-")).length, 0);
  });

  test("an identical destination is skipped (remote md5), not copied again", async () => {
    const message = await service.transferBetweenServers(SERVER, `${root}/src.bin`, SERVER, `${root}/dst.bin`, {});

    assert.match(message, /Transfer skipped/);
  });

  test("connections is ignored: connections=4 still takes the server-side copy", async () => {
    await run(`head -c 1000003 /dev/urandom > ${root}/src2.bin`);

    const message = await service.transferBetweenServers(SERVER, `${root}/src2.bin`, SERVER, `${root}/dst2.bin`, { connections: 4 });

    assert.match(message, /server-side copy-data/);
    assert.equal(await md5Of(`${root}/dst2.bin`), await md5Of(`${root}/src2.bin`));
  });

  test("a copy that fails AFTER the temp file was written removes it and leaves the target as it was", async () => {
    // The target is a non-empty directory: the copy into the temp file and its
    // verification succeed, then the final rename fails (EISDIR). This is the
    // only failure here that happens with the temp file already on disk.
    await run(`mkdir -p ${root}/target-dir && printf 'inside' > ${root}/target-dir/keep.txt`);

    await assert.rejects(() =>
      service.transferBetweenServers(SERVER, `${root}/src.bin`, SERVER, `${root}/target-dir`, { skipIfIdentical: false }),
      /Rename/,
    );

    assert.equal((await run(`cat ${root}/target-dir/keep.txt`)).trim(), "inside");
    assert.equal((await run(`ls -A ${root}`)).split(/\s+/).filter((name) => name.includes(".handfree-copy-")).length, 0);
  });

  test("a failed copy leaves the destination untouched and removes the temp file", async (t) => {
    // The sftp-server runs as the login user: a root login ignores file modes,
    // so the unreadable-source failure cannot be produced there.
    if ((await run("id -u")).trim() === "0") {
      t.skip("login user is root; file modes cannot make the source unreadable");
      return;
    }
    await run(`printf 'original-target-content' > ${root}/keep.bin`);
    await run(`head -c 4096 /dev/urandom > ${root}/locked.bin && chmod 000 ${root}/locked.bin`);

    await assert.rejects(() =>
      service.transferBetweenServers(SERVER, `${root}/locked.bin`, SERVER, `${root}/keep.bin`, { skipIfIdentical: false }),
    );

    assert.equal((await run(`cat ${root}/keep.bin`)).trim(), "original-target-content");
    assert.equal((await run(`ls -A ${root}`)).split(/\s+/).filter((name) => name.includes(".handfree-copy-")).length, 0);
  });
});
