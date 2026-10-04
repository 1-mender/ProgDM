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
  assert.match(app, /`\/api\/dm\/campaigns\/\$\{campaignId\}\/knowledge\/\$\{entryId\}\/facts\/reveals`/);
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
  assert.match(app, /Факт исчезнет из текущих знаний\. История уже совершённых раскрытий сохранится\./);
  assert.match(app, /Факты открываются отдельно и не меняют доступ к краткому описанию\./);
});

test("DM live Knowledge Facts provide campaign and current-character reveal controls", () => {
  assert.match(app, /workspaceMode === "live" && knowledgeFacts\.length > 0 && <div className="knowledge-live-reveal"/);
  assert.match(app, /partyRevealedCount\} \/ \{knowledgeFacts\.length\} открыто группе/);
  assert.match(app, /nextPartyFact\.body/);
  assert.match(app, /onClick=\{\(\) => revealNextFact\("party"\)\}>\s*<Eye \/>Открыть группе/);
  assert.match(app, /liveRevealCharacters\.map\(/);
  assert.match(app, /revealNextFact\("character", knowledgeRevealCharacterId\)/);
  assert.match(app, /revealAllFacts\("party"\)/);
  assert.match(app, /revealAllFacts\("character", knowledgeRevealCharacterId\)/);
  assert.match(app, /workspaceMode === "live" && <details className="knowledge-fact-live-menu"/);
  assert.match(app, /setRevokingKnowledgeFact\(\{ fact, reveal \}\)/);
  assert.match(app, /Отозвать доступ\?/);
  assert.match(app, /История уже совершённых раскрытий сохранится\./);
});

test("ambiguous reveal retries reuse the same operation ID and never consume the next fact", () => {
  assert.match(app, /pendingRevealOperations\.current\.getOrCreate\(operationKey\)/);
  assert.match(app, /pendingRevealOperations\.current\.complete\(operationKey, operationId\)/);
  assert.match(app, /throw new AmbiguousRevealFailure/);
  assert.match(app, /failure instanceof AmbiguousRevealFailure/);
  assert.match(app, /повтор использует тот же запрос и не откроет следующий факт случайно/);
  assert.match(app, /operationId\s*\n\s*\}/);
  assert.match(app, /\/facts\/reveal-next/);
});
