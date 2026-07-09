import { decodeNotificationHeader } from "../../domain/notifications";
import { schemaVersionHeader } from "../../domain/schema";
import { publishStreamingNotifications } from "../../domain/streaming";
import { compatibility } from "./router";

compatibility.use("*", async (c, next) => {
  await next();
  c.header("Zotero-API-Version", "3");
  c.header("Zotero-Schema-Version", schemaVersionHeader());
});

compatibility.use("*", async (c, next) => {
  await next();
  const notifications = decodeNotificationHeader(
    c.res.headers.get("zotero-debug-notifications")
  );
  if (notifications.length === 0) {
    return;
  }

  c.executionCtx.waitUntil(
    publishStreamingNotifications(c.env, notifications).catch((error) => {
      console.error(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          message: "failed to publish Zotero streaming notification",
        })
      );
    })
  );
});

// The official server pretty-prints JSON responses (PHP JSON_PRETTY_PRINT,
// 4-space indent); some official tests assert on the formatted body.
compatibility.use("*", async (c, next) => {
  await next();
  const contentType = c.res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return;
  }
  const body = await c.res.text();
  if (!body) {
    return;
  }
  try {
    const pretty = JSON.stringify(JSON.parse(body), null, 4);
    const headers = new Headers(c.res.headers);
    headers.delete("content-length");
    c.res = new Response(pretty, {
      headers,
      status: c.res.status,
    });
  } catch {
    c.res = new Response(body, c.res);
  }
});
