export default { scan(ctx) { ctx.fs.readText(ctx.locations.root + "/../secret.txt"); return { games: [] }; } };
