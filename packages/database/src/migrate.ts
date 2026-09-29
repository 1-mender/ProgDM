import { openDatabase } from "./index.js";

const database = openDatabase();
try {
  console.log(`Database ready: ${database.file}`);
} finally {
  database.close();
}
