import { Hono } from "hono";
import type { Bindings } from "../../bindings";

export const compatibility = new Hono<{ Bindings: Bindings }>();
