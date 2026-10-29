import { createServer, createConnection, type Server } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unlink } from "node:fs/promises";
import { home, hash } from "./io.js";
import { currentWorkspace, herdrSession } from "./herdr.js";
export const socketPath = () =>
  join(tmpdir(), `prsit-${process.getuid?.() ?? "user"}-${hash(home()).slice(0, 16)}.sock`);
export async function controllerInfo(): Promise<
  { pid: number; workspace?: string; session?: string } | undefined
> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath());
    socket.setTimeout(1000);
    const finish = (value: { pid: number; workspace?: string; session?: string } | undefined) => {
      socket.destroy();
      resolve(value);
    };
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString();
      if (data.includes("\n")) {
        try {
          finish(JSON.parse(data));
        } catch {
          finish(undefined);
        }
      }
    });
    socket.on("error", () => finish(undefined));
    socket.on("timeout", () => finish(undefined));
    socket.on("end", () => finish(undefined));
    socket.on("connect", () => socket.write("ping\n"));
  });
}
export async function ping(): Promise<boolean> {
  return !!(await controllerInfo());
}
export async function stopController(): Promise<boolean> {
  const controller = await controllerInfo();
  if (!controller) return false;
  if (
    !Number.isSafeInteger(controller.pid) ||
    controller.pid <= 1 ||
    controller.pid === process.pid
  )
    throw new Error("Controller returned an invalid process ID");
  try {
    process.kill(controller.pid, "SIGTERM");
  } catch (e: any) {
    if (e.code === "ESRCH") return false;
    throw e;
  }
  return true;
}
export async function acquire(workspace?: string): Promise<Server> {
  const session = workspace ? herdrSession() : undefined;
  const server = createServer((s) => {
    s.on("error", () => {});
    s.resume();
    s.end(JSON.stringify({ pid: process.pid, workspace, ...(session ? { session } : {}) }) + "\n");
  });
  const listen = () =>
    new Promise<void>((resolve, reject) => {
      const error = (e: Error) => {
        server.removeListener("listening", ready);
        reject(e);
      };
      const ready = () => {
        server.removeListener("error", error);
        resolve();
      };
      server.once("error", error);
      server.once("listening", ready);
      server.listen(socketPath());
    });
  try {
    await listen();
  } catch (e: any) {
    if (e.code !== "EADDRINUSE") throw e;
    if (await ping())
      throw new Error("A prsit controller is already running for this state directory");
    // Only an unresponsive, pre-existing socket is eligible for stale cleanup.
    await unlink(socketPath()).catch((e: any) => {
      if (e.code !== "ENOENT") throw e;
    });
    await listen();
  }
  return server;
}

export async function viewWorkspace() {
  const controller = await controllerInfo();
  if (controller?.workspace) {
    if (controller.session !== herdrSession())
      throw new Error(
        "The controller is in another Herdr session. Open its session to view these PRs.",
      );
    return controller.workspace;
  }
  return currentWorkspace();
}
