export * from "./plugins/NPCPlugin";
export * from "./sync/sinceStore";
export * from "./types";
export * from "./PluginApi";

import type { PluginApi } from "./PluginApi";

declare module "coco-cashu-core" {
  interface PluginExtensions {
    npc: PluginApi;
  }
}
