// This family's hub: the cc-family-hub app with this repo's config.
// .generated/ is written by cc-family-hub/app/build.mjs (wrangler build.command).
import { createHub } from "cc-family-hub/app/worker/index.js";
import config from "./.generated/hub-config.json";

export default createHub(config);
