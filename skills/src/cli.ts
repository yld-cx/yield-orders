#!/usr/bin/env node
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  agentError,
  commandInputs,
  createSkills,
  descriptions,
  jsonSafe,
  type Command,
} from "./index.ts";

const args = process.argv.slice(2);
const name = args[0];
const command = Object.hasOwn(commandInputs, name ?? "")
  ? (name as Command)
  : undefined;
const dasherize = (value: string) =>
  value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

function help(selected?: Command) {
  if (!selected)
    return {
      usage: "yld <command> [--options]",
      commands: descriptions,
      help: "Run yld <command> --help for inputs. Transaction limits and amounts are decimal strings.",
    };
  const schema = z.toJSONSchema(commandInputs[selected], { io: "input" });
  return {
    usage: `yld ${selected} [--options]`,
    description: descriptions[selected],
    options: Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([key, value]) => [
        `--${dasherize(key)}`,
        {
          ...(typeof value === "object" ? value : {}),
          required: schema.required?.includes(key) ?? false,
        },
      ]),
    ),
  };
}

try {
  if (!name || ["--help", "-h", "help"].includes(name)) {
    console.log(JSON.stringify(help(args[1] as Command | undefined), null, 2));
  } else if (!command) {
    throw new Error(`Unknown command: ${name}. Run yld --help.`);
  } else if (args.includes("--help") || args.includes("-h")) {
    console.log(JSON.stringify(help(command), null, 2));
  } else {
    const properties =
      z.toJSONSchema(commandInputs[command], { io: "input" }).properties ?? {};
    const options = Object.fromEntries(
      Object.entries(properties).map(([key, field]) => [
        dasherize(key),
        {
          type:
            typeof field === "object" && field.type === "boolean"
              ? "boolean"
              : "string",
          multiple: typeof field === "object" && field.type === "array",
        } as const,
      ]),
    );
    const { values } = parseArgs({
      args: args.slice(1),
      options,
      strict: true,
    });
    const input = Object.fromEntries(
      Object.entries(properties).flatMap(([key, field]) => {
        const value = values[dasherize(key)];
        return value === undefined
          ? []
          : [
              [
                key,
                typeof field === "object" &&
                (field.type === "integer" || field.type === "number")
                  ? Number(value)
                  : value,
              ],
            ];
      }),
    );
    const api = createSkills({ rpcUrl: process.env.YLD_RPC_URL });
    const result = await api[command](
      commandInputs[command].parse(input) as never,
    );
    console.log(JSON.stringify(jsonSafe(result), null, 2));
  }
} catch (error) {
  const issues =
    error instanceof z.ZodError
      ? error.issues.map(({ path, message }) => ({
          field: path.join("."),
          message,
        }))
      : undefined;
  console.error(
    JSON.stringify({
      error: issues
        ? "Invalid command inputs. Run the command with --help."
        : agentError(error),
      issues,
    }),
  );
  const parseError =
    error instanceof Error &&
    "code" in error &&
    String(error.code).startsWith("ERR_PARSE_ARGS_");
  process.exitCode = issues || !command || parseError ? 2 : 1;
}
