import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deploy, readConfig } from "../scripts/deploy.mjs";

const id = "11111111-1111-4111-8111-111111111111";
const configuration = () => ({
  name: "yld-data",
  d1_databases: [{ binding: "DB", database_name: "yld-data" }],
  vars: { NETWORK_CONFIG: "{}" },
  triggers: { crons: ["0 * * * *"] },
});
function harness(existing = [], failMigration = false, writeBack = true) {
  const commands = [],
    deployed = [];
  let current,
    databases = existing;
  return {
    commands,
    deployed,
    save: (config) => {
      current = structuredClone(config);
    },
    load: () => current,
    run: (args) => {
      commands.push(args);
      if (args[0] === "d1" && args[1] === "list")
        return JSON.stringify(databases);
      if (args[0] === "deploy") {
        deployed.push(structuredClone(current));
        if (!current.d1_databases[0].database_id) {
          databases = [{ name: "yld-data", uuid: id }];
          if (writeBack) current.d1_databases[0].database_id = id;
        }
      }
      if (args[1] === "migrations" && failMigration)
        throw new Error("Migration failed");
    },
  };
}

test("first GitHub deployment provisions without cron, migrates, then activates hourly indexing", () => {
  const io = harness();
  assert.equal(deploy(configuration(), io), id);
  assert.deepEqual(
    io.commands.map((c) => c.slice(0, 2)),
    [
      ["d1", "list"],
      ["deploy", "--config"],
      ["d1", "migrations"],
      ["deploy", "--config"],
    ],
  );
  assert.deepEqual(io.deployed[0].triggers.crons, []);
  assert.deepEqual(io.deployed[1].triggers.crons, ["0 * * * *"]);
  assert.ok(io.commands.at(-1).includes("--no-x-provision"));
});

test("later builds recover the named database even when GitHub never wrote its ID into the repository", () => {
  const io = harness([{ name: "yld-data", uuid: id }]);
  assert.equal(deploy(configuration(), io), id);
  assert.equal(io.deployed.length, 1);
  assert.equal(io.deployed[0].d1_databases[0].database_id, id);
  assert.ok(io.commands.at(-1).includes("--no-x-provision"));
});

test("pinned IDs skip discovery and provisioning", () => {
  const config = configuration();
  config.d1_databases[0].database_id = id;
  const io = harness();
  deploy(config, io);
  assert.equal(io.commands.length, 2);
  assert.equal(io.commands[0][1], "migrations");
});

test("migration failure never activates the initial cron", () => {
  const io = harness([], true);
  assert.throws(() => deploy(configuration(), io), /Migration failed/);
  assert.equal(io.deployed.length, 1);
  assert.deepEqual(io.deployed[0].triggers.crons, []);
});

test("provisioned ID can be resolved without config writeback", () => {
  const io = harness([], false, false);
  assert.equal(deploy(configuration(), io), id);
  assert.equal(io.commands.filter((c) => c[1] === "list").length, 2);
});

test("ambiguous databases and invalid explicit starts fail before deployment", () => {
  const io = harness([
    { name: "yld-data", uuid: id },
    { name: "yld-data", uuid: id },
  ]);
  assert.throws(() => deploy(configuration(), io), /Ambiguous/);
  assert.equal(io.deployed.length, 0);
  const config = configuration();
  config.vars.NETWORK_CONFIG = '{"1":{"startBlock":"bad"}}';
  const invalid = harness();
  assert.throws(() => deploy(config, invalid), /startBlock/);
  assert.equal(invalid.commands.length, 0);
});

test("public RPCs are configured for every supported production network with no enable flag", () => {
  const config = readConfig(
    fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
  );
  assert.deepEqual(JSON.parse(config.vars.RPC_URLS), {
    1: "https://ethereum-rpc.publicnode.com",
    8453: "https://mainnet.base.org",
    4663: "https://rpc.mainnet.chain.robinhood.com",
  });
  assert.equal("SYNC_ENABLED" in config.vars, false);
});

test("deployment config accepts JSONC comments and trailing commas without damaging URLs", () => {
  const directory = mkdtempSync(join(tmpdir(), "yld-jsonc-"));
  try {
    const path = join(directory, "wrangler.jsonc");
    writeFileSync(
      path,
      '{ /* configuration */ "vars": { "RPC_URLS": "https://example.test/rpc", }, // trailing comma\n }',
    );
    assert.deepEqual(readConfig(path).vars, {
      RPC_URLS: "https://example.test/rpc",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
