import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

test("DM Knowledge Detail loads facts lazily and rejects stale selected-entry responses", () => {
  assert.match(app, /knowledgeFactRequests = useRef\(new LatestRequest\(\)\)/);
  assert.match(app, /section !== "knowledge" \|\| !selectedId \|\| !entryId \|\| !token/);
  assert.match(app, /knowledgeFactRequests\.current\.begin\(\)/);
  assert.match(app, /knowledgeFactRequests\.current\.isCurrent\(ticket\)/);
  assert.match(app, /`\/api\/dm\/campaigns\/\$\{campaignId\}\/knowledge\/\$\{entryId\}\/facts`/);
  assert.doesNotMatch(app.match(/dm\.get\("\/api\/dm\/state",[\s\S]*?networkAddresses: addresses[\s\S]*?\}\);/)?.[0] ?? "", /facts/);
});

test("Knowledge Facts preparation controls are available only in prepare mode", () => {
  assert.match(app, /workspaceMode === "prepare" && <div className="knowledge-fact-actions"/);
  assert.match(app, /workspaceMode === "prepare" && <form className="knowledge-fact-create"/);
  assert.match(app, /workspaceMode === "prepare" && editingKnowledgeFact\?\.id === fact\.id/);
  assert.match(app, /disabled=\{locked \|\| index === 0\}/);
  assert.match(app, /disabled=\{locked \|\| index === knowledgeFacts\.length - 1\}/);
  assert.match(app, /`\/api\/dm\/campaigns\/\$\{selected\.id\}\/knowledge\/\$\{entry\.id\}\/facts\/reorder`/);
  assert.match(app, /"PATCH"\);/);
  assert.match(app, /"DELETE"\);/);
  assert.doesNotMatch(app.match(/className="knowledge-facts"[\s\S]*?<\/section>/)?.[0] ?? "", /<Eye\s*\/>|revealKnowledgeFact/);
  assert.match(app, /Факт исчезнет из текущих знаний\. История уже совершённых раскрытий сохранится\./);
  assert.match(app, /Факты подготавливаются здесь; доступ к ним открывается отдельно\./);
});
