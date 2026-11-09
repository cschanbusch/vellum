// Launch hooks: a skin can hold a launch it started (an animation, a confirmation) or call it
// off. Kept apart from core so the rules can be tested on their own.

/** Return false (or a promise of false) to call the launch off; anything else lets it go ahead. */
export type BeforeLaunch = (id: string, provider?: string) => boolean | void | Promise<boolean | void>;

/**
 * Runs the hooks in the order they were added and resolves to whether the launch may go
 * ahead. A hook that throws is logged and ignored, so a bug in a skin can't stop launches.
 */
/**
 * What a launch does before it reaches the shell, in order: an entry set to "ask me each time"
 * asks first, then the hooks run with the store that was chosen, so a skin's launch ceremony
 * follows the choice and never plays for a launch the user cancelled. Null means don't launch.
 */
export async function prepareLaunch(
  entry: { id: string; askSource?: boolean } | undefined,
  id: string,
  provider: string | undefined,
  choose: () => Promise<string | null>,
  hooks: Iterable<BeforeLaunch>,
): Promise<{ provider?: string } | null> {
  let store = provider;
  if (!store && entry?.askSource) {
    store = (await choose()) ?? undefined;
    if (!store) return null;
  }
  return (await allowLaunch(hooks, id, store)) ? { provider: store } : null;
}

export async function allowLaunch(hooks: Iterable<BeforeLaunch>, id: string, provider?: string): Promise<boolean> {
  for (const hook of [...hooks]) {
    try {
      if ((await hook(id, provider)) === false) return false;
    } catch (e) {
      console.warn("[vellum] a beforeLaunch hook failed; launching anyway", e);
    }
  }
  return true;
}
