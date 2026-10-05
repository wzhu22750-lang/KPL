import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { wechatBridge } from "@aihot/backend/sources/wechat2rss/index";
import { applyPublicHeaders, sendTextWithEtag } from "../http/respond.ts";

export function registerWechatFeed(app: FastifyInstance) {
  // 预检请求
  app.options("/feed/wechat/:account", async (_req, reply) =>
    reply.code(204).header("Allow", "GET, HEAD, OPTIONS").send()
  );

  // 1. RSS XML 订阅源路由: /feed/wechat/:account (支持 带 .xml 后缀或不带)
  app.get("/feed/wechat/:account", async (req: FastifyRequest<{ Params: { account: string }; Querystring: { force?: string } }>, reply: FastifyReply) => {
    try {
      const rawParam = req.params.account || "";
      const isJson = rawParam.endsWith(".json");
      const accountName = rawParam.replace(/\.(xml|json|rss|atom)$/i, "");
      const force = req.query.force === "1" || req.query.force === "true";

      if (isJson) {
        const json = await wechatBridge.getJsonFeed(accountName, { force });
        applyPublicHeaders(reply, { cors: true });
        return reply.type("application/json; charset=utf-8").send(json);
      }

      const xml = await wechatBridge.getRssXml(accountName, { force });
      applyPublicHeaders(reply, { cors: true });
      return sendTextWithEtag(req, reply, xml, {
        etagPrefix: "wechat-rss",
        cacheControl: "public, max-age=900, s-maxage=900, stale-while-revalidate=1800",
        contentType: "application/rss+xml; charset=utf-8",
      });
    } catch (error) {
      req.log.error({ err: error }, "wechat feed generation error");
      return reply
        .code(503)
        .header("Retry-After", "60")
        .header("Cache-Control", "no-store")
        .type("text/plain; charset=utf-8")
        .send("Wechat RSS Feed temporarily unavailable");
    }
  });

  // 2. 搜索公众号 API
  app.get("/api/wechat/search", async (req: FastifyRequest<{ Querystring: { q?: string } }>, reply: FastifyReply) => {
    const q = req.query.q?.trim();
    if (!q) {
      return reply.code(400).send({ error: "Missing query parameter 'q'" });
    }
    const accounts = await wechatBridge.search(q);
    return reply.send({ data: accounts });
  });

  // 3. 预览公众号文章 API
  app.get("/api/wechat/preview", async (req: FastifyRequest<{ Querystring: { account?: string; force?: string } }>, reply: FastifyReply) => {
    const account = req.query.account?.trim();
    if (!account) {
      return reply.code(400).send({ error: "Missing query parameter 'account'" });
    }
    const force = req.query.force === "1" || req.query.force === "true";
    const result = await wechatBridge.fetchAccountArticles(account, { force });
    if (!result) {
      return reply.code(404).send({ error: `No articles found for account '${account}'` });
    }
    return reply.send({ data: result });
  });
}
