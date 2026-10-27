// Simulate the Host package tree: load the plugin with DSH_APP_DIR set, then
// read the Remote markers through the Host's own protocol copy.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { env } from "../shared/env.mjs";

const plugin = await import(pathToFileURL(join(process.cwd(), "dsh2phone-dsh-plugin/host.js")).href);
const hostReq = createRequire(join(env("DSH_APP_DIR"), "package.json"));
const { remoteMethods, TypertRemoteService } = hostReq("@deepseek-ai/dsh-typert-protocol");

const markers = remoteMethods(Object.create(plugin.Dsh2PhoneService.prototype));
const instance = Object.create(plugin.Dsh2PhoneService.prototype);
console.log(JSON.stringify({
  apply: typeof plugin.apply,
  markers: markers.map((m) => m.method),
  extendsHostTypertRemoteService: instance instanceof TypertRemoteService,
}, null, 2));
