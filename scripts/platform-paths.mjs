// Single source of truth for the user-level config file path. Both
// extensions/scrapling.ts (reads) and scripts/cli.mjs (writes) import from
// this file. Drift between the two is detected by `npm run validate`.
//
// Convention (in priority order):
//   1. $XDG_CONFIG_HOME/pi-scrapling/config.json  (POSIX)
//   2. %APPDATA%/pi-scrapling/config.json         (Windows)
//   3. ~/.config/pi-scrapling/config.json         (POSIX fallback)

import { homedir, platform } from "node:os";
import { join } from "node:path";

export const CONFIG_FILE = "pi-scrapling/config.json";

export function configFilePath() {
	const xdg = process.env.XDG_CONFIG_HOME?.trim();
	if (xdg) return join(xdg, CONFIG_FILE);
	if (platform() === "win32") {
		const appData = process.env.APPDATA?.trim();
		if (appData) return join(appData, CONFIG_FILE);
	}
	// POSIX default; also the Windows fallback when APPDATA is unset, so the
	// path always contains a dedicated config segment rather than dropping
	// the file loose in the home directory.
	return join(homedir(), ".config", CONFIG_FILE);
}
