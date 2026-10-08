import { buildApp } from "./app.js";

const PORT = Number(process.env.PORT ?? 3100);
const HOST = process.env.HOST ?? "127.0.0.1";

async function main(): Promise<void> {
  const { app } = await buildApp();
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`Droparr server listening on http://${HOST}:${PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
