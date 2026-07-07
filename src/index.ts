export * from "./plugins/NPCPlugin";
export * from "./sync/sinceStore";
export * from "./types";
export * from "./PluginApi";

import type { NPCPluginApi } from "./PluginApi";

declare module "@cashu/coco-core/plugin" {
  interface PluginExtensions {
    npc: NPCPluginApi;
  }
}
