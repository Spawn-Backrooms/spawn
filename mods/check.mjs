#!/usr/bin/env node
// Validate SPAWN mods. No dependencies.
//
//   node mods/check.mjs            # every mods/<id>/mod.json
//   node mods/check.mjs FILE...    # specific manifests
//
// v1 mods are data only. These rules mirror the schemas SPAWN enforces when a
// room installs a mod, so a mod that passes here can be accepted unchanged.
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const KINDS = ["caption-style", "clip-recipe"];
export const LICENSES = ["Apache-2.0", "MIT", "CC0-1.0", "CC-BY-4.0"];
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COLOR = /^#[0-9A-Fa-f]{6}$/;
const SECRET = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bsk-[A-Za-z0-9_-]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{30,}/, /api[-_]?key=[A-Za-z0-9-]{16,}/i];

function exact(errors, at, value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) { errors.push(`${at}: must be an object`); return false; }
  for (const key of keys) if (!Object.hasOwn(value, key)) errors.push(`${at}: missing "${key}"`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) errors.push(`${at}: unknown field "${key}"`);
  return true;
}
const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const num = (v, min, max) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
function text(errors, at, value, max) {
  if (typeof value !== "string" || !value.trim()) return errors.push(`${at}: must be non-empty text`);
  if (value.trim().length > max) errors.push(`${at}: at most ${max} characters`);
  if (/[<>]/.test(value)) errors.push(`${at}: no markup`);
  if (SECRET.some((p) => p.test(value))) errors.push(`${at}: looks like it contains a secret`);
}

function captionStyle(errors, at, c) {
  const keys = ["enabled", "font", "font_size", "text_color", "highlight_color", "outline_color", "outline_width", "shadow",
    "x_pct", "y_pct", "words_per_group", "uppercase", "animation", "animation_ms"];
  if (!exact(errors, at, c, keys)) return;
  const rule = (ok, field, message) => { if (!ok) errors.push(`${at}.${field}: ${message}`); };
  rule(typeof c.enabled === "boolean", "enabled", "true or false");
  rule(["sans", "condensed", "mono"].includes(c.font), "font", '"sans", "condensed" or "mono"');
  rule(int(c.font_size, 40, 112), "font_size", "a whole number from 40 to 112");
  for (const field of ["text_color", "highlight_color", "outline_color"])
    rule(typeof c[field] === "string" && COLOR.test(c[field]), field, 'a color like "#FF3EA5"');
  rule(int(c.outline_width, 0, 10), "outline_width", "a whole number from 0 to 10");
  rule(int(c.shadow, 0, 6), "shadow", "a whole number from 0 to 6");
  rule(num(c.x_pct, 10, 90), "x_pct", "from 10 to 90 (percent across)");
  rule(num(c.y_pct, 10, 90), "y_pct", "from 10 to 90 (percent down)");
  rule(int(c.words_per_group, 1, 4), "words_per_group", "a whole number from 1 to 4");
  rule(typeof c.uppercase === "boolean", "uppercase", "true or false");
  rule(["none", "pop", "fade", "rise"].includes(c.animation), "animation", '"none", "pop", "fade" or "rise"');
  rule(int(c.animation_ms, 80, 400), "animation_ms", "a whole number from 80 to 400");
}
function clipRecipe(errors, at, c) {
  if (!exact(errors, at, c, ["base", "clips"])) return;
  if (!["clip-one", "three-clips", "walkthrough"].includes(c.base)) errors.push(`${at}.base: "clip-one", "three-clips" or "walkthrough"`);
  if (!Array.isArray(c.clips) || c.clips.length < 1 || c.clips.length > 6) return errors.push(`${at}.clips: 1 to 6 clips`);
  c.clips.forEach((clip, i) => {
    const where = `${at}.clips[${i}]`;
    if (!exact(errors, where, clip, ["length_ms", "aspect", "framing"])) return;
    if (!int(clip.length_ms, 3000, 60000)) errors.push(`${where}.length_ms: a whole number of milliseconds from 3000 to 60000`);
    if (!["9:16", "1:1", "16:9"].includes(clip.aspect)) errors.push(`${where}.aspect: "9:16", "1:1" or "16:9"`);
    if (!["contain", "cover"].includes(clip.framing)) errors.push(`${where}.framing: "contain" or "cover"`);
  });
}

/** Validate one manifest object. Returns a list of problems (empty when valid). */
export function checkManifest(m, at = "mod.json") {
  const errors = [];
  if (!exact(errors, at, m, ["schema_version", "id", "version", "kind", "name", "description", "author", "license", "content"])) return errors;
  if (m.schema_version !== "spawn.mod.v1") errors.push(`${at}.schema_version: must be "spawn.mod.v1"`);
  if (typeof m.id !== "string" || !ID.test(m.id) || m.id.length > 64) errors.push(`${at}.id: lowercase letters, digits and single hyphens, at most 64 characters`);
  if (!int(m.version, 1, 10000)) errors.push(`${at}.version: a whole number, 1 or more`);
  if (!KINDS.includes(m.kind)) errors.push(`${at}.kind: one of ${KINDS.join(", ")}`);
  text(errors, `${at}.name`, m.name, 60);
  text(errors, `${at}.description`, m.description, 200);
  if (typeof m.author !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(m.author)) errors.push(`${at}.author: your GitHub handle`);
  if (!LICENSES.includes(m.license)) errors.push(`${at}.license: one of ${LICENSES.join(", ")}`);
  if (m.kind === "caption-style") captionStyle(errors, `${at}.content`, m.content);
  if (m.kind === "clip-recipe") clipRecipe(errors, `${at}.content`, m.content);
  return errors;
}

async function manifests() {
  const out = [];
  for (const entry of await readdir(here)) {
    const path = join(here, entry, "mod.json");
    if ((await stat(join(here, entry))).isDirectory()) out.push(path);
  }
  return out.sort();
}
async function main() {
  const files = process.argv.length > 2 ? process.argv.slice(2) : await manifests();
  const errors = [];
  const ids = new Set();
  for (const file of files) {
    const at = relative(here, file);
    let manifest;
    try { manifest = JSON.parse(await readFile(file, "utf8")); } catch (error) { errors.push(`${at}: not valid JSON (${error.message})`); continue; }
    errors.push(...checkManifest(manifest, at));
    if (basename(dirname(file)) !== manifest.id) errors.push(`${at}: the folder name must be the mod id "${manifest.id}"`);
    if (ids.has(manifest.id)) errors.push(`${at}: "${manifest.id}" is already used`);
    ids.add(manifest.id);
    for (const entry of await readdir(dirname(file)))
      if (!["mod.json", "preview.png", "preview.webp"].includes(entry)) errors.push(`${relative(here, join(dirname(file), entry))}: v1 mods contain only mod.json and an optional preview image`);
  }
  if (errors.length) {
    console.error(errors.map((e) => "✗ " + e).join("\n") + `\n\n${errors.length} problem(s).`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ ${files.length} mod(s) are valid.`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
