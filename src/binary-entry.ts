// Entry of the release executable (`scripts/build-binary.mjs`). It registers the
// Claude CLI shipped next to the executable before importing the agent:
// index.ts starts serving (or, with --cli, spawns the CLI) while it evaluates,
// and a static import would evaluate it before this module's body runs.
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { useBundledClaudeCli } from "./claude-cli.js";

// realpath, so a symlink to the executable (e.g. in /usr/local/bin) still finds
// the CLI next to the real file.
useBundledClaudeCli(dirname(realpathSync(process.execPath)));
await import("./index.js");
