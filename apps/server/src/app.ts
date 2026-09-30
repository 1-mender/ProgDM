import Fastify, { type FastifyError } from "fastify";
import { createHash } from "node:crypto";
import { isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";
import { openDatabase, type GameDatabase } from "@progdm/database";
import { isDmAuthorized, loadDmToken } from "./dm-auth.js";
import type { KnowledgeCategory, KnowledgeVisibility, NetworkAddress } from "@progdm/shared";

function localAddresses(override?: string): NetworkAddress[] {
  const privateAddress = (address: string) => isIPv4(address) && (
    address.startsWith("10.") || address.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address)
  );
  if (override) return privateAddress(override) ? [{ address: override, label: "Настроенный адрес" }] : [];
  const addresses = Object.entries(networkInterfaces()).flatMap(([label, adapters]) =>
    (adapters ?? []).filter((entry) => entry.family === "IPv4" && !entry.internal && privateAddress(entry.address))
      .map((entry) => ({ address: entry.address, label }))
  );
  return [...new Map(addresses.sort((left, right) => {
    const wireless = (value: string) => /wi-?fi|wireless|wlan|беспровод|hotspot/i.test(value);
    return Number(wireless(right.label)) - Number(wireless(left.label)) ||
      (left.address.startsWith("192.168.") ? 0 : 1) - (right.address.startsWith("192.168.") ? 0 : 1) ||
      left.address.localeCompare(right.address, undefined, { numeric: true });
  }).map((entry) => [entry.address, entry])).values()];
}

export function createApp(options: {
  database?: GameDatabase;
  logger?: boolean;
  dmToken?: string;
  localIp?: string;
} = {}) {
  const dmToken = options.dmToken ?? loadDmToken();
  const database = options.database ?? openDatabase();
  const app = Fastify({
    logger: options.logger ? { redact: ["req.headers.authorization"] } : false,
    bodyLimit: 4096,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } }
  });
  const playerCredentials = new WeakMap<object, string>();

  app.addHook("onClose", async () => database.close());

  app.get("/health", async () => ({ ok: true, service: "progdm-server" }));
  const addresses = localAddresses(options.localIp ?? process.env.PROGDM_LOCAL_IP);

  const getInvitationParams = {
    type: "object", required: ["token"],
    properties: { token: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" } }
  };
  const nameAndPlayerTokenBody = {
    type: "object", additionalProperties: false, required: ["displayName", "playerToken"],
    properties: {
      displayName: { type: "string", minLength: 1, maxLength: 60, pattern: "\\S" },
      playerToken: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" }
    }
  };

  app.get<{ Params: { token: string } }>("/api/join/:token", {
    schema: { params: getInvitationParams }
  }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const info = database.getJoinInfo(request.params.token);
    if (!info) return reply.code(404).send({ message: "Эта ссылка недействительна или набор уже закрыт." });
    return { campaignName: info.campaignName, sessionName: info.sessionName };
  });

  app.register(async (player) => {
    player.addHook("onRequest", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? "");
      if (!match) return reply.code(401).send({ message: "Заявка ещё не отправлена." });
      const hash = createHash("sha256").update(match[1]!).digest("hex");
      if (!database.getPlayerByTokenHash(hash)) return reply.code(401).send({ message: "Заявка не найдена." });
      playerCredentials.set(request, hash);
    });
    player.get("/api/player/me", async (request, reply) => {
      const tokenHash = playerCredentials.get(request);
      const state = tokenHash ? database.getPlayerState(tokenHash) : null;
      return state ?? reply.code(401).send({ message: "Заявка не найдена." });
    });
  });

  app.post<{ Params: { token: string }; Body: { displayName: string; playerToken: string } }>(
    "/api/join/:token/request", {
      schema: { params: getInvitationParams, body: nameAndPlayerTokenBody }
    }, async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const info = database.getJoinInfo(request.params.token);
      if (!info) return reply.code(404).send({ message: "Эта ссылка недействительна или набор уже закрыт." });
      const tokenHash = createHash("sha256").update(request.body.playerToken).digest("hex");
      try {
        const result = database.submitPlayerRequest(info.sessionId, request.body.displayName, tokenHash);
        return { displayName: result.displayName, status: result.status };
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message.includes("already belongs") || message.includes("already requested")) {
          return reply.code(409).send({ message: message.includes("already requested")
            ? "Такое имя уже занято. Попроси ведущего проверить заявки."
            : "Этот телефон уже отправил заявку в другую сессию." });
        }
        if (message.includes("not accepting")) {
          return reply.code(404).send({ message: "Эта ссылка недействительна или набор уже закрыт." });
        }
        throw error;
      }
    }
  );

  app.register(async (dm) => {
    dm.addHook("onRequest", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!isDmAuthorized(request.headers.authorization, dmToken)) {
        return reply.code(401).send({ message: "Нужен ключ ведущего." });
      }
    });

    dm.setErrorHandler<FastifyError>((error, request, reply) => {
      if (error.validation || error.statusCode === 400) {
        return reply.code(400).send({ message: "Проверьте введённые данные и допустимые значения." });
      }
      if (error.statusCode && error.statusCode < 500) {
        return reply.code(error.statusCode).send({ message: "Не удалось обработать запрос." });
      }
      request.log.error(error);
      return reply.code(500).send({ message: "Не удалось сохранить изменения. Обновите данные перед повтором." });
    });

    const nameBody = {
      type: "object", additionalProperties: false, required: ["name"],
      properties: { name: { type: "string", minLength: 1, maxLength: 120, pattern: "\\S" } }
    };
    const idParams = {
      type: "object", required: ["id"],
      properties: { id: { type: "string", format: "uuid" } }
    };

    dm.get("/api/session/current", async () => ({ snapshot: database.getCurrentSession() }));
    dm.get("/api/dm/state", async () => {
      const campaigns = database.listCampaigns();
      return {
        campaigns,
        sessions: campaigns.flatMap((campaign) => database.listSessions(campaign.id)),
        current: database.getCurrentSession(),
        players: campaigns.flatMap((campaign) => database.listPlayersByCampaign(campaign.id)),
        characters: campaigns.flatMap((campaign) => database.listCharactersByCampaign(campaign.id)),
        itemCatalog: campaigns.flatMap((campaign) => database.listCatalogItemsByCampaign(campaign.id)),
        knowledge: campaigns.flatMap((campaign) => database.listKnowledgeByCampaign(campaign.id)),
        networkAddresses: addresses
      };
    });
    dm.post<{ Body: { name: string } }>("/api/dm/campaigns", { schema: { body: nameBody } }, async (request, reply) => {
      const campaign = database.createCampaign(request.body.name);
      return reply.code(201).send({ campaign });
    });
    dm.post<{ Params: { id: string }; Body: { name: string } }>("/api/dm/campaigns/:id/sessions",
      { schema: { params: idParams, body: nameBody } }, async (request, reply) => {
        if (!database.getCampaign(request.params.id)) {
          return reply.code(404).send({ message: "Кампания не найдена." });
        }
        const session = database.createSession(request.params.id, request.body.name);
        return reply.code(201).send({ session });
      });
    dm.post<{ Params: { id: string }; Body: { name: string } }>("/api/dm/campaigns/:id/characters",
      { schema: { params: idParams, body: nameBody } }, async (request, reply) => {
        try {
          return reply.code(201).send({ character: database.createCharacter(request.params.id, request.body.name) });
        } catch (error) {
          if (error instanceof Error && error.message === "Campaign not found.") {
            return reply.code(404).send({ message: "Кампания не найдена." });
          }
          throw error;
        }
      });
    dm.post<{ Params: { id: string }; Body: { catalogItemId: string; quantity: number } }>("/api/dm/characters/:id/items", {
      schema: {
        params: idParams,
        body: { type: "object", additionalProperties: false, required: ["catalogItemId", "quantity"], properties: {
          catalogItemId: { type: "string", format: "uuid" },
          quantity: { type: "integer", minimum: 1, maximum: 9999 }
        } }
      }
    }, async (request, reply) => {
      try {
        return reply.code(201).send({ item: database.grantInventoryItem(request.params.id, request.body.catalogItemId, request.body.quantity) });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message === "Character is not assigned to an approved player.") {
          return reply.code(409).send({ message: "У этого персонажа нет принятого игрока." });
        }
        if (message === "Character is not in the active session.") {
          return reply.code(409).send({ message: "Выдавать предметы можно персонажам текущей активной сессии." });
        }
        if (message === "Item quantity limit exceeded.") {
          return reply.code(409).send({ message: "В инвентаре нельзя хранить больше 9999 предметов одного вида." });
        }
        if (message === "Catalog item is unavailable for this campaign.") {
          return reply.code(409).send({ message: "Предмет не найден в справочнике этой кампании. Обновите данные." });
        }
        throw error;
      }
    });
    dm.post<{ Params: { id: string }; Body: { name: string } }>("/api/dm/campaigns/:id/items", {
      schema: { params: idParams, body: nameBody }
    }, async (request, reply) => {
      try {
        return reply.code(201).send({ item: database.createCatalogItem(request.params.id, request.body.name) });
      } catch (error) {
        if (error instanceof Error && error.message === "Campaign not found.") {
          return reply.code(404).send({ message: "Кампания не найдена." });
        }
        if (error instanceof Error && error.message === "Catalog item already exists.") {
          return reply.code(409).send({ message: "Такой предмет уже есть в справочнике." });
        }
        throw error;
      }
    });
    dm.post<{ Params: { id: string }; Body: { category: KnowledgeCategory; title: string; description: string } }>(
      "/api/dm/campaigns/:id/knowledge", {
        schema: {
          params: idParams,
          body: {
            type: "object", additionalProperties: false, required: ["category", "title", "description"],
            properties: {
              category: { type: "string", enum: ["npc", "monster", "note", "quest"] },
              title: { type: "string", minLength: 1, maxLength: 120, pattern: "\\S" },
              description: { type: "string", minLength: 1, maxLength: 2000, pattern: "\\S" }
            }
          }
        }
      }, async (request, reply) => {
        try {
          return reply.code(201).send({ entry: database.createKnowledge(
            request.params.id, request.body.category, request.body.title, request.body.description
          ) });
        } catch (error) {
          if (error instanceof Error && error.message === "Campaign not found.") {
            return reply.code(404).send({ message: "Кампания не найдена." });
          }
          throw error;
        }
      }
    );
    type VisibilityBody =
      | { visibility: "hidden" | "party" }
      | { visibility: "player"; playerId: string };
    dm.post<{ Params: { id: string }; Body: VisibilityBody }>("/api/dm/knowledge/:id/visibility", {
      schema: {
        params: idParams,
        body: {
          oneOf: [
            { type: "object", additionalProperties: false, required: ["visibility"], properties: { visibility: { const: "hidden" } } },
            { type: "object", additionalProperties: false, required: ["visibility"], properties: { visibility: { const: "party" } } },
            { type: "object", additionalProperties: false, required: ["visibility", "playerId"], properties: {
              visibility: { const: "player" }, playerId: { type: "string", format: "uuid" }
            } }
          ]
        }
      }
    }, async (request, reply) => {
      try {
        return { entry: database.setKnowledgeVisibility(
          request.params.id, request.body.visibility as KnowledgeVisibility,
          request.body.visibility === "player" ? request.body.playerId : undefined
        ) };
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message === "Knowledge entry not found.") return reply.code(404).send({ message: "Запись не найдена." });
        if (message === "A player must be selected.") return reply.code(400).send({ message: "Выберите игрока." });
        if (message === "Player is not in the active campaign session.") {
          return reply.code(409).send({ message: "Открыть запись можно только принятому игроку текущей сессии." });
        }
        throw error;
      }
    });
    dm.post<{ Params: { id: string }; Body: { expectedActiveSessionId: string | null } }>("/api/dm/sessions/:id/start", {
      schema: {
        params: idParams,
        body: {
          type: "object", additionalProperties: false, required: ["expectedActiveSessionId"],
          properties: { expectedActiveSessionId: { anyOf: [{ type: "null" }, { type: "string", format: "uuid" }] } }
        }
      }
    }, async (request, reply) => {
      const session = database.getSession(request.params.id);
      if (!session) return reply.code(404).send({ message: "Сессия не найдена." });
      if (session.status === "ended") return reply.code(409).send({ message: "Эта сессия уже завершена." });
      try {
        return { session: database.activateSession(session.id, request.body.expectedActiveSessionId) };
      } catch (error) {
        if (error instanceof Error && error.message === "Active session changed.") {
          return reply.code(409).send({ message: "Активная сессия изменилась. Обновите данные и повторите действие." });
        }
        throw error;
      }
    });
    dm.post<{ Params: { id: string } }>("/api/dm/sessions/:id/end",
      { schema: { params: idParams } }, async (request, reply) => {
        const session = database.getSession(request.params.id);
        if (!session) return reply.code(404).send({ message: "Сессия не найдена." });
        if (session.status === "planned") return reply.code(409).send({ message: "Сессия ещё не началась." });
        return { session: database.endSession(session.id) };
      });

    const playerParams = {
      type: "object", required: ["id"],
      properties: { id: { type: "string", format: "uuid" } }
    };
    const playerAssignment = {
      oneOf: [
        { type: "object", additionalProperties: false, required: ["characterId"], properties: { characterId: { type: "string", format: "uuid" } } },
        { type: "object", additionalProperties: false, required: ["characterName"], properties: { characterName: { type: "string", minLength: 1, maxLength: 120, pattern: "\\S" } } }
      ]
    };
    dm.post<{ Params: { id: string }; Body: { characterId: string } | { characterName: string } }>(
      "/api/dm/players/:id/approve", {
        schema: { params: playerParams, body: playerAssignment }
      }, async (request, reply) => {
        try {
          return { player: database.approvePlayer(request.params.id, request.body) };
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (message === "Player request not found.") return reply.code(404).send({ message: "Заявка не найдена." });
          if (message === "Character is unavailable for this campaign.") return reply.code(409).send({ message: "Этот персонаж относится к другой кампании. Обновите список." });
          if (message === "Character is already assigned in this session.") return reply.code(409).send({ message: "Этот персонаж уже назначен игроку в текущей сессии." });
          if (message === "Rejected request cannot be approved." || message === "Session has ended.") {
            return reply.code(409).send({ message: "Заявка закрыта. Обновите список." });
          }
          throw error;
        }
      }
    );
    dm.post<{ Params: { id: string } }>("/api/dm/players/:id/reject", {
      schema: { params: playerParams }
    }, async (request, reply) => {
      try {
        return { player: database.rejectPlayer(request.params.id) };
      } catch (error) {
        if (error instanceof Error && error.message === "Player request not found.") {
          return reply.code(404).send({ message: "Заявка не найдена." });
        }
        if (error instanceof Error && error.message === "Approved player cannot be rejected.") {
          return reply.code(409).send({ message: "Игрок уже принят. Обновите список." });
        }
        throw error;
      }
    });
  });

  return app;
}
