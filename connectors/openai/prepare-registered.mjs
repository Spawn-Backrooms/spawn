import { cp, mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { dirname, basename, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const template = resolve(dirname(fileURLToPath(import.meta.url)), "spawn");
export function registeredAppMapping(appId) {
  if (typeof appId !== "string" || !/^asdk_app_[a-f0-9]{32}$/.test(appId))
    throw new Error(
      "Use the verified canonical asdk_app ID from the intended SPAWN registration, not a link or plugin ID",
    );
  return { apps: { spawn: { id: appId } } };
}

/** Package only: does not install, register, authenticate or change host settings. */
export async function prepareRegistered(appId, outputDirectory) {
  const mapping = registeredAppMapping(appId);
  const output = resolve(outputDirectory);
  const canonicalTemplate = await realpath(template);
  const canonicalOutput = resolve(
    await realpath(dirname(output)),
    basename(output),
  );
  const relation = relative(canonicalTemplate, canonicalOutput);
  if (
    !relation ||
    (relation !== ".." && !relation.startsWith("../") && !isAbsolute(relation))
  )
    throw new Error("Output must be outside the template");
  await mkdir(output); // Fail if it already exists. Never overwrite user files.
  await cp(template, output, { recursive: true });
  const path = resolve(output, ".codex-plugin/plugin.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.apps = "./.app.json";
  await writeFile(path, JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(
    resolve(output, ".app.json"),
    JSON.stringify(mapping, null, 2) + "\n",
  );
  return {
    status: "packaged_not_installed",
    format: "codex-compatibility",
    installed: false,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv.length !== 4)
      throw new Error(
        "Usage: node connectors/openai/prepare-registered.mjs VERIFIED_CANONICAL_APP_ID NEW_OUTPUT_DIRECTORY",
      );
    console.log(
      JSON.stringify(await prepareRegistered(process.argv[2], process.argv[3])),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
