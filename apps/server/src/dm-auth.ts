import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveDatabaseFile } from "@progdm/database";

export function loadDmToken(): string {
  const path = join(dirname(resolveDatabaseFile()), "dm-key");
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, randomBytes(32).toString("base64url"), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const token = readFileSync(path, "utf8").trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid local DM key: " + path);
  return token;
}

export function isDmAuthorized(authorization: string | undefined, token: string): boolean {
  const expected = Buffer.from("Bearer " + token);
  const actual = Buffer.from(authorization ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
