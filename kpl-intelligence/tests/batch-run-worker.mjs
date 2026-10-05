// Runs one batch script inside a worker thread: a fresh module registry and database pool, the
// same isolation a separate process would give, without spawning one. The script's console output
// is collected so the test can assert on the failure summary. A script in the legacy shape (no
// exports) runs its top-level main at import; a fixed script exports main() and keeps its resource
// cleanup in the CLI entry, which this worker replicates after calling it.
import { workerData, parentPort } from "node:worker_threads";

const lines = [];
console.log = (...args) => lines.push(args.map((a) => String(a)).join(" "));

try {
  const mod = await import(workerData.url);
  let exit = process.exitCode ?? 0;
  if (typeof mod.main === "function") {
    await mod.main();
    exit = process.exitCode ?? 0;
    process.exitCode = 0;
    const { stopBoss } = await import(workerData.queueUrl);
    const { closeDb } = await import(workerData.dbUrl);
    await stopBoss();
    await closeDb();
  }
  parentPort.postMessage({ exit, lines });
} catch (error) {
  parentPort.postMessage({ exit: 1, lines, crash: String(error?.stack ?? error) });
}
