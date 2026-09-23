import { spawn } from "node:child_process";

function openCommand(url: string): [string, string[]] {
  const browser = process.env.BROWSER;
  if (browser) return [browser, [url]];
  if (process.platform === "win32") return ["rundll32", ["url,OpenURL", url]];
  if (process.platform === "darwin") return ["open", [url]];
  return ["xdg-open", [url]];
}

export function openUrl(url: string): Promise<void> {
  const [command, args] = openCommand(url);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
