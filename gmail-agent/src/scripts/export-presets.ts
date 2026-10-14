import { runExportPresetsCli } from "../export-presets.js";

process.exitCode = await runExportPresetsCli(process.argv.slice(2));
