import { OpenAPIHono } from "@hono/zod-openapi";
import type { Bindings } from "./bindings";
import { compatibility } from "./routes/compatibility";
import { health } from "./routes/health";
import { selfhost } from "./routes/selfhost";

export { ZoteroStreamHub } from "./streaming/zotero-stream-hub";

const app = new OpenAPIHono<{ Bindings: Bindings }>();

app.route("/", health);
app.route("/", selfhost);
app.route("/", compatibility);

app.doc("/openapi.json", {
  info: {
    title: "Zotero Self-Host Server",
    version: "0.0.0",
  },
  openapi: "3.1.0",
});

export default app;
