// Scanning is implemented in Phase 2. Until then this provider reports no games.
export default {
  scan(ctx) {
    return { games: [] };
  },
  launch(ctx, game) {},
};
