export * from "./plugins/NPCPlugin";
export * from "./sync/sinceStore";
export * from "./types";
export * from "./PluginApi";

import type { NPCPluginApi } from "./PluginApi";

declare module "coco-cashu-core" {
  interface PluginExtensions {
    npc: NPCPluginApi;
  }
}
