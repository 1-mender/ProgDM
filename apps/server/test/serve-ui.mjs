import { openDatabase } from "@progdm/database";
import { createApp } from "../dist/app.js";

// Isolated browser-test fixture; never opens the DM's working database.
const app = createApp({ database: openDatabase({ file: ":memory:" }), dmToken: "progdm-ui-test" });
await app.listen({ host: "127.0.0.1", port: 3334 });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => void app.close());
}
