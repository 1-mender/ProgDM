import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@progdm/database";
import { createApp } from "../dist/app.js";

// Isolated browser-test fixture; never opens the DM's working database.
const dataDirectory = mkdtempSync(join(tmpdir(), "progdm-ui-test-"));
const database = openDatabase({
  file: ":memory:", backupsDirectory: join(dataDirectory, "backups"), uploadsDirectory: join(dataDirectory, "uploads")
});
const app = createApp({ database, dmToken: "progdm-ui-test" });
await app.listen({ host: "127.0.0.1", port: 3334 });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => void app.close().finally(() => rmSync(dataDirectory, { recursive: true, force: true })));
}
