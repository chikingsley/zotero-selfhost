import type { Bindings } from "./bindings";

export interface AppConfig {
  zoteroApiKey?: string;
}

export const getConfig = (bindings: Bindings): AppConfig => ({
  zoteroApiKey: bindings.ZOTERO_API_KEY,
});
