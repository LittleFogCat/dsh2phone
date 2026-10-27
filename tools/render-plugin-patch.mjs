// Render dsh2phone-dsh-plugin/cordis.patch.yml from the checked-in template.
//
// The patch row must carry the absolute file:/// URL of host.js (see the
// template's comment), which is why the generated file is git-ignored. Re-run
// this after moving the checkout, and before reinstalling the plugin.
//
// usage: node tools/render-plugin-patch.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT, env } from "../shared/env.mjs";

const pluginDir = join(REPO_ROOT, "dsh2phone-dsh-plugin");
const templatePath = join(pluginDir, "cordis.patch.example.yml");
const targetPath = join(pluginDir, "cordis.patch.yml");

// DSH2PHONE_HOME lets an install live somewhere other than this checkout;
// it defaults to the checkout this script runs from.
const home = env("DSH2PHONE_HOME", REPO_ROOT).replaceAll("\\", "/").replace(/\/+$/u, "");
const entry = pathToFileURL(join(home, "dsh2phone-dsh-plugin", "host.js")).href;

const rendered = readFileSync(templatePath, "utf8").replace("__DSH2PHONE_HOME__", home);
writeFileSync(targetPath, rendered, "utf8");
console.log(`wrote ${targetPath}`);
console.log(`  entry: ${entry}`);
