// Route modules are imported in their original registration order — Hono
// match precedence depends on it. Keep this order when moving modules.
import "./middleware";
import "./admin/test-setup";
import "./admin/tts";
import "./auth/keys";
import "./library/settings";
import "./library/tags";
import "./library/searches";
import "./library/deleted";
import "./library/head-parity";
import "./library/children";
import "./library/metadata";
import "./library/collections";
import "./library/item-mutations";
import "./files/files";
import "./library/items-group";
import "./groups/groups";
import "./library/items-user";

export { compatibility } from "./router";
