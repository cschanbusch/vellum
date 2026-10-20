export default { scan(ctx) { ctx.fs.readText(ctx.locations.root + "/config/loginusers.vdf"); return { games: [] }; } };
