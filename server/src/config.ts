import type { Bindings } from "./bindings";

export interface AppConfig {
  selfhostTestApiKey?: string;
}

export const getConfig = (bindings: Bindings): AppConfig => ({
  selfhostTestApiKey: bindings.SELFHOST_TEST_API_KEY,
});
