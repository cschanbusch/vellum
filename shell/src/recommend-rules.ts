// When the start-up recommendation (recommend.ts) is shown. Kept apart for testing.
import type { CatalogPlugin } from "./api";

/** The skin recommended, by its catalog id (Grand Tour keeps its original id, "redline"). */
export const RECOMMENDED_SKIN = "redline";

/** Whether to recommend `plugin`: offered by the catalog, absent here, and not turned down. */
export function shouldRecommend(plugin: CatalogPlugin | undefined, dismissed: string[]): boolean {
  if (!plugin || plugin.kind !== "skin") return false;
  if (dismissed.includes(plugin.id)) return false;
  if (plugin.installed || plugin.present) return false;
  return plugin.versions.some((v) => !v.unavailable);
}
