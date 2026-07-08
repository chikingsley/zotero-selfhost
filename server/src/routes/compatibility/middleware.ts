import { schemaVersionHeader } from "../../schema";
import { compatibility } from "./router";


compatibility.use("*", async (c, next) => {
  await next();
  c.header("Zotero-API-Version", "3");
  c.header("Zotero-Schema-Version", schemaVersionHeader());
});
