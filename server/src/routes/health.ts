import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Bindings } from "../bindings";

const healthResponseSchema = z
  .object({
    ok: z.literal(true),
    service: z.literal("zotero-selfhost"),
  })
  .openapi("HealthResponse");

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: healthResponseSchema,
        },
      },
      description: "Service health",
    },
  },
  tags: ["System"],
});

export const health = new OpenAPIHono<{ Bindings: Bindings }>().openapi(
  healthRoute,
  (c) =>
    c.json({
      ok: true,
      service: "zotero-selfhost",
    } as const)
);
