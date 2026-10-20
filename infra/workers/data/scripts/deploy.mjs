import { writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { indexingNetwork, supportedNetworks } from "../src/networks.ts";
import { experimental_readRawConfig } from "wrangler";

const temporary = ".deploy.config.json";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const readConfig = (path) =>
  experimental_readRawConfig({ config: path }).rawConfig;

// The same sequence runs locally and in Cloudflare's native GitHub integration.
// Inject command/config I/O so provisioning and activation order can be tested offline.
export function deploy(config, { run, save, load }) {
  for (const network of supportedNetworks)
    indexingNetwork(config.vars, network);
  const binding = config.d1_databases[0];
  const existingDatabase = () => {
    const matches = JSON.parse(run(["d1", "list", "--json"], true)).filter(
      (d) => d.name === binding.database_name,
    );
    if (matches.length > 1)
      throw new Error("Ambiguous databases; set YLD_D1_DATABASE_ID");
    return matches[0]?.uuid;
  };
  if (binding.database_id && !uuid.test(binding.database_id))
    throw new Error("Invalid D1 database ID");
  binding.database_id ||= existingDatabase();
  if (!binding.database_id) {
    // Provision without a Cron Trigger. A failed migration cannot activate indexing.
    save({ ...config, triggers: { ...config.triggers, crons: [] } });
    run(["deploy", "--config", temporary]);
    binding.database_id =
      load().d1_databases[0].database_id || existingDatabase();
  }
  if (!binding.database_id || !uuid.test(binding.database_id)) {
    throw new Error(
      "Cannot resolve D1 database ID. Inspect the Worker binding before retrying.",
    );
  }
  save(config);
  run(["d1", "migrations", "apply", "DB", "--remote", "--config", temporary]);
  // All later deployments bind the resolved ID and cannot provision a duplicate DB.
  run(["deploy", "--config", temporary, "--no-x-provision"]);
  return binding.database_id;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.chdir(fileURLToPath(new URL("..", import.meta.url)));
  const wrangler = fileURLToPath(
    new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
  );
  const run = (args, capture = false) => {
    const result = spawnSync(process.execPath, [wrangler, ...args], {
      stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit",
      encoding: "utf8",
    });
    if (result.error || result.status !== 0)
      throw new Error(`Wrangler ${args[0]} failed`);
    return result.stdout;
  };
  try {
    const config = readConfig("wrangler.jsonc");
    for (const key of Object.keys(config.vars)) {
      if (process.env[key] !== undefined) config.vars[key] = process.env[key];
    }
    config.d1_databases[0].database_id =
      process.env.YLD_D1_DATABASE_ID || config.d1_databases[0].database_id;
    const id = deploy(config, {
      run,
      save: (value) => writeFileSync(temporary, JSON.stringify(value, null, 2)),
      load: () => readConfig(temporary),
    });
    console.log(
      `Deployed yld-data with D1 ${id}. Indexing follows the configured Cron Trigger; no enable flag is required.`,
    );
    console.log(
      "Optionally pin database_id in wrangler.jsonc or YLD_D1_DATABASE_ID in Workers Builds. Future deployments also recover the named database automatically.",
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    rmSync(temporary, { force: true });
  }
}
