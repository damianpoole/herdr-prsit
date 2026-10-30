// Optional capture tool; dependencies stay outside the plugin's install.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
const root = fileURLToPath(new URL("../", import.meta.url));
const requireTools = createRequire(
  join(resolve(process.env.PRSIT_SCREENSHOT_TOOLS ?? "/tmp/prsit-capture-tools"), "package.json"),
);
const { chromium } = requireTools("playwright");
const xterm = dirname(dirname(requireTools.resolve("@xterm/xterm")));
const browser = await chromium.launch({
  executablePath: process.env.PRSIT_CHROMIUM_PATH,
  headless: true,
});
try {
  for (const name of ["wide", "narrow", "activity", "stopped", "empty"]) {
    const cols = name === "narrow" ? 72 : 120;
    const page = await browser.newPage({
      viewport: { width: 1400, height: 900 },
      deviceScaleFactor: 2,
    });
    await page.setContent(
      '<html><body style="margin:0;padding:24px;background:#10151e"><div id="terminal"></div></body></html>',
    );
    await page.addStyleTag({ path: join(xterm, "css/xterm.css") });
    await page.addScriptTag({ path: join(xterm, "lib/xterm.js") });
    await page.evaluate(
      ({ cols }) => {
        window.term = new window.Terminal({
          cols,
          rows: 32,
          fontFamily: "monospace",
          fontSize: 15,
          lineHeight: 1,
          drawBoldTextInBrightColors: false,
          cursorBlink: false,
          theme: {
            background: "#10151e",
            foreground: "#d5deeb",
            black: "#10151e",
            red: "#f57983",
            green: "#98d9aa",
            yellow: "#e5c98a",
            blue: "#89b4fa",
            magenta: "#c9a6ef",
            cyan: "#78dce8",
            white: "#e4ecf7",
            brightBlack: "#8896ad",
          },
        });
        window.term.open(document.querySelector("#terminal"));
      },
      { cols },
    );
    const env = { ...process.env, FORCE_COLOR: "1" };
    delete env.NO_COLOR;
    const output = execFileSync(
      process.execPath,
      [join(root, "scripts/dashboard-preview.mjs"), name],
      { env, encoding: "utf8" },
    );
    await page.evaluate(
      (data) => new Promise((done) => window.term.write("\x1b[?25l" + data, done)),
      output,
    );
    const bounds = await page.locator(".xterm-screen").boundingBox();
    await page.setViewportSize({
      width: Math.ceil(bounds.width) + 48,
      height: Math.ceil(bounds.height) + 48,
    });
    await page.screenshot({ path: join(root, `docs/screenshots/dashboard-${name}.png`) });
    await page.close();
  }
} finally {
  await browser.close();
}
