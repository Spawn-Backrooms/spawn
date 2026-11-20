#!/usr/bin/env node
// Validate the Backroom catalogue, examples and proposals. No dependencies.
//
//   node backrooms/check.mjs            # everything
//   node backrooms/check.mjs FILE...    # specific proposal files
//
// The rules mirror what SPAWN's room store accepts when a room is created,
// so a proposal that passes here can be provisioned without reshaping.
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const ROLES_BY_KIND = {
  coding: ["builder", "reviewer"],
  research: ["researcher", "synthesizer"],
  art: ["artist"],
  video: ["director", "editor"],
  live_avatar: ["presenter"],
};
export const CAPABILITIES = [
  "text.generate",
  "research.cited_findings",
  "research.web_search",
  "coding.diff_review",
  "coding.repository_write",
  "art.image_generate",
  "video.render",
  "avatar.live_session",
  "avatar.image_generate",
  "media.upload",
];
/** Every room of a kind needs at least these capabilities. */
export const KIND_MINIMUM = {
  coding: ["text.generate", "coding.diff_review"],
  research: ["text.generate", "research.cited_findings"],
  art: ["art.image_generate"],
  video: ["video.render"],
  live_avatar: ["avatar.live_session"],
};
const SECRET = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /api[-_]?key=[A-Za-z0-9-]{16,}/i,
];
const TEMPLATE_KEYS = [
  "seed_id", "template_version", "name", "description", "mapping_status", "kind", "purpose",
  "input_brief", "config", "roles", "contact_role", "output_sections", "deliverable_brief",
  "required_work_capabilities", "optional_work_capabilities",
];
const bytes = (value) => new TextEncoder().encode(value).length;

function check(errors, where, condition, message) {
  if (!condition) errors.push(`${where}: ${message}`);
  return condition;
}
function exactKeys(errors, where, value, required, optional = []) {
  if (!check(errors, where, value && typeof value === "object" && !Array.isArray(value), "must be an object")) return false;
  for (const key of required) check(errors, where, Object.hasOwn(value, key), `missing "${key}"`);
  for (const key of Object.keys(value))
    check(errors, where, required.includes(key) || optional.includes(key), `unknown field "${key}"`);
  return true;
}
function text(errors, where, value, max, { required = true } = {}) {
  if (!check(errors, where, typeof value === "string", "must be a string")) return;
  if (required) check(errors, where, value.trim().length > 0, "must not be empty");
  check(errors, where, bytes(value) <= max, `must be at most ${max} bytes`);
  check(errors, where, !SECRET.some((pattern) => pattern.test(value)), "looks like it contains a secret");
}
function nullableText(errors, where, value, max) {
  if (value !== null) text(errors, where, value, max);
}

function checkConfig(errors, where, kind, config) {
  switch (kind) {
    case "coding":
      if (!exactKeys(errors, where, config, ["kind", "language", "repository_label"])) return;
      nullableText(errors, where + ".language", config.language, 100);
      nullableText(errors, where + ".repository_label", config.repository_label, 200);
      break;
    case "research":
      if (!exactKeys(errors, where, config, ["kind", "questions", "citation_policy"])) return;
      if (check(errors, where + ".questions", Array.isArray(config.questions) && config.questions.length >= 1 && config.questions.length <= 16, "must be a list of 1-16 questions"))
        config.questions.forEach((question, i) => text(errors, `${where}.questions[${i}]`, question, 2048));
      check(errors, where + ".citation_policy", config.citation_policy === "provided_sources_only", 'must be "provided_sources_only"');
      break;
    case "art":
      if (!exactKeys(errors, where, config, ["kind", "style_notes"])) return;
      text(errors, where + ".style_notes", config.style_notes, 8192, { required: false });
      break;
    case "video": {
      if (!exactKeys(errors, where, config, ["kind", "storyboard", "shots"], ["tool", "workspace_mode"])) return;
      text(errors, where + ".storyboard", config.storyboard, 16384, { required: false });
      if (config.tool !== undefined)
        check(errors, where + ".tool", ["clips", "memes", "affiliate"].includes(config.tool), 'must be "clips", "memes" or "affiliate"');
      if (config.workspace_mode !== undefined)
        check(errors, where + ".workspace_mode", config.workspace_mode === "clips", 'must be "clips"');
      if (!check(errors, where + ".shots", Array.isArray(config.shots) && config.shots.length >= 1 && config.shots.length <= 32, "must be a list of 1-32 shots")) return;
      const ids = new Set();
      config.shots.forEach((shot, i) => {
        const at = `${where}.shots[${i}]`;
        if (!exactKeys(errors, at, shot, ["shot_id", "description", "duration_seconds"])) return;
        check(errors, at + ".shot_id", typeof shot.shot_id === "string" && shot.shot_id.length >= 1 && shot.shot_id.length <= 160, "must be 1-160 characters");
        check(errors, at + ".shot_id", !ids.has(shot.shot_id), "must be unique");
        ids.add(shot.shot_id);
        text(errors, at + ".description", shot.description, 4096);
        check(errors, at + ".duration_seconds",
          shot.duration_seconds === null || (typeof shot.duration_seconds === "number" && shot.duration_seconds >= 0.1 && shot.duration_seconds <= 600),
          "must be null or between 0.1 and 600");
      });
      break;
    }
    case "live_avatar":
      if (!exactKeys(errors, where, config, ["kind", "persona", "scene", "feed_mode"])) return;
      text(errors, where + ".persona", config.persona, 8192);
      text(errors, where + ".scene", config.scene, 8192);
      check(errors, where + ".feed_mode", config.feed_mode === "text", 'must be "text"');
      break;
  }
  check(errors, where + ".kind", config.kind === kind, `must match the room kind "${kind}"`);
}

/** Validate one Backroom template. `status` is the required mapping_status. */
export function checkTemplate(template, where, status) {
  const errors = [];
  if (!exactKeys(errors, where, template, TEMPLATE_KEYS)) return errors;
  check(errors, where + ".seed_id", typeof template.seed_id === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(template.seed_id) && template.seed_id.length <= 64,
    "must be lowercase letters, digits and single hyphens, at most 64 characters (for example \"spool-21\")");
  check(errors, where + ".template_version", Number.isInteger(template.template_version) && template.template_version >= 1, "must be a whole number, 1 or more");
  text(errors, where + ".name", template.name, 400);
  check(errors, where + ".name", typeof template.name === "string" && Array.from(template.name.trim()).length <= 100, "must be at most 100 characters");
  text(errors, where + ".description", template.description, 2048);
  check(errors, where + ".mapping_status", template.mapping_status === status, `must be "${status}"`);
  const roles = ROLES_BY_KIND[template.kind];
  if (!check(errors, where + ".kind", !!roles, `must be one of ${Object.keys(ROLES_BY_KIND).join(", ")}`)) return errors;
  text(errors, where + ".purpose", template.purpose, 4096);
  text(errors, where + ".input_brief", template.input_brief, 16384);
  text(errors, where + ".deliverable_brief", template.deliverable_brief, 16384);
  checkConfig(errors, where + ".config", template.kind, template.config);
  if (check(errors, where + ".roles", Array.isArray(template.roles) && template.roles.length >= 1 && template.roles.length <= roles.length,
    `must list 1-${roles.length} roles from: ${roles.join(", ")}`)) {
    const seen = new Set();
    template.roles.forEach((role, i) => {
      const at = `${where}.roles[${i}]`;
      if (!exactKeys(errors, at, role, ["role", "instructions"])) return;
      check(errors, at + ".role", roles.includes(role.role), `must be one of ${roles.join(", ")} for a ${template.kind} room`);
      check(errors, at + ".role", !seen.has(role.role), "must not repeat");
      seen.add(role.role);
      text(errors, at + ".instructions", role.instructions, 16384);
    });
    check(errors, where + ".contact_role", seen.has(template.contact_role), "must be one of the room's roles");
  }
  if (check(errors, where + ".output_sections", Array.isArray(template.output_sections) && template.output_sections.length >= 1 && template.output_sections.length <= 12, "must list 1-12 sections"))
    template.output_sections.forEach((section, i) => text(errors, `${where}.output_sections[${i}]`, section, 200));
  for (const field of ["required_work_capabilities", "optional_work_capabilities"]) {
    const list = template[field];
    if (!check(errors, `${where}.${field}`, Array.isArray(list) && new Set(list).size === list.length, "must be a list without duplicates")) continue;
    for (const capability of list)
      check(errors, `${where}.${field}`, CAPABILITIES.includes(capability), `unknown capability "${capability}"; use one of ${CAPABILITIES.join(", ")}`);
  }
  if (Array.isArray(template.required_work_capabilities) && Array.isArray(template.optional_work_capabilities)) {
    for (const capability of KIND_MINIMUM[template.kind])
      check(errors, where + ".required_work_capabilities", template.required_work_capabilities.includes(capability), `a ${template.kind} room must require "${capability}"`);
    for (const capability of template.optional_work_capabilities)
      check(errors, where + ".optional_work_capabilities", !template.required_work_capabilities.includes(capability), `"${capability}" is already required`);
  }
  return errors;
}

async function json(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`${path}: not valid JSON (${error.message})`);
  }
}
async function jsonFiles(dir) {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith(".json")).sort().map((name) => join(dir, name));
  } catch {
    return [];
  }
}

async function main() {
  const errors = [];
  const catalogue = await json(join(here, "catalogue/platform-rooms.v1.json"));
  const taken = { ids: new Set(), names: new Set() };
  catalogue.templates.forEach((template, i) => {
    errors.push(...checkTemplate(template, `catalogue/platform-rooms.v1.json templates[${i}]`, "editable_proposed_default"));
    taken.ids.add(template.seed_id);
    taken.names.add(String(template.name).toLowerCase());
  });
  const args = process.argv.slice(2);
  const proposals = args.length ? args : [...(await jsonFiles(join(here, "examples"))), ...(await jsonFiles(join(here, "proposals")))];
  for (const path of proposals) {
    const where = relative(here, path);
    const template = await json(path);
    errors.push(...checkTemplate(template, where, "proposed"));
    if (basename(dirname(path)) === "examples") continue;
    check(errors, where, basename(path) === `${template.seed_id}.json`, `file name must be "${template.seed_id}.json"`);
    check(errors, where + ".seed_id", !taken.ids.has(template.seed_id), `"${template.seed_id}" is already used`);
    check(errors, where + ".name", !taken.names.has(String(template.name).toLowerCase()), `the name "${template.name}" is already used`);
    taken.ids.add(template.seed_id);
    taken.names.add(String(template.name).toLowerCase());
  }
  if (errors.length) {
    console.error(errors.map((error) => "✗ " + error).join("\n"));
    console.error(`\n${errors.length} problem(s).`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ catalogue (${catalogue.templates.length} rooms) and ${proposals.length} proposal file(s) are valid.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
