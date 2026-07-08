import { OpenAPIHono } from "@hono/zod-openapi";
import type { Bindings } from "./bindings";
import { compatibility } from "./routes/compatibility";
import { health } from "./routes/health";

const app = new OpenAPIHono<{ Bindings: Bindings }>();

app.route("/", health);
app.route("/", compatibility);

app.doc("/openapi.json", {
  info: {
    title: "Zotero Compatible Server",
    version: "0.0.0",
  },
  openapi: "3.1.0",
});

export default app;
