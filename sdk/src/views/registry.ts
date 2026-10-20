// The built-in views, by id. Skins can wrap them: `vellum.views.builtin("covers")`.

import type { ViewImpl } from "../core";
import covers from "./covers";
import list from "./list";
import spotlight from "./spotlight";

const BUILTIN: Record<string, ViewImpl> = { list, covers, spotlight };

export function builtinView(id: string): ViewImpl | undefined {
  return BUILTIN[id];
}
