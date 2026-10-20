/**
 * Optional internet link for the desktop app using a free Cloudflare Quick Tunnel (no account, no card).
 * cloudflared is downloaded from Cloudflare's official GitHub releases on first use. The address is random and
 * changes every time the link is started; Cloudflare describes Quick Tunnels as intended for testing.
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const BASE = "https://github.com/cloudflare/cloudflared/releases/latest/download/";

function assetName(): { asset: string; exe: string; tgz: boolean } {
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  if (process.platform === "win32") return { asset: `cloudflared-windows-${arch}.exe`, exe: "cloudflared.exe", tgz: false };
  if (process.platform === "darwin") return { asset: `cloudflared-darwin-${arch}.tgz`, exe: "cloudflared", tgz: true };
  return { asset: `cloudflared-linux-${arch}`, exe: "cloudflared", tgz: false };
}

export async function ensureCloudflared(binDir: string, download: (url: string) => Promise<ArrayBuffer>): Promise<string> {
  const { asset, exe, tgz } = assetName();
  const target = join(binDir, exe);
  try { if ((await stat(target)).size > 1_000_000) return target; } catch { /* not downloaded yet */ }
  await mkdir(binDir, { recursive: true });
  const bytes = Buffer.from(await download(BASE + asset));
  if (bytes.length < 1_000_000) throw new Error("Download of cloudflared looks incomplete");
  if (tgz) {
    const archive = join(binDir, "cloudflared.tgz");
    await writeFile(archive, bytes);
    await promisify(execFile)("tar", ["-xzf", archive, "-C", binDir]);
    await rm(archive, { force: true });
  } else {
    await writeFile(target + ".part", bytes);
    await rename(target + ".part", target);
  }
  if (process.platform !== "win32") await chmod(target, 0o755);
  return target;
}

export interface Tunnel { url: string; host: string; stop: () => void }

/** Start a Quick Tunnel to the local server. `allowedMail` adds Cloudflare's emailed one-time PIN in front of the app. */
export function startTunnel(binary: string, port: number, allowedMail: string[], onExit: (msg: string) => void): Promise<Tunnel> {
  const args = ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`];
  if (allowedMail.length) args.push("--allowed-mail", allowedMail.join(","));
  const child: ChildProcess = spawn(binary, args, { windowsHide: true });
  let log = "";
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; child.kill(); reject(new Error("Timed out waiting for the internet link. Check the internet connection and try again.")); } }, 45_000);
    const onData = (d: Buffer) => {
      log = (log + d.toString()).slice(-8000);
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(log);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ url: m[0], host: new URL(m[0]).host, stop: () => child.kill() });
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    child.on("exit", (code) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`cloudflared exited (${code}). ${log.split("\n").slice(-5).join(" ")}`)); }
      else onExit(`Internet link stopped (cloudflared exited with code ${code}).`);
    });
  });
}
