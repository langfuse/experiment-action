import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { discoverScripts, runtimesIn } from "@/discover";

async function mkTmp(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "discover-test-"));
}

describe("discoverScripts", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkTmp();
  });

  it("returns a single script for a file path", async () => {
    const file = path.join(dir, "exp.py");
    await fs.writeFile(file, "# empty");
    const scripts = await discoverScripts(file);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toEqual({ path: file, runtime: "python" });
  });

  it("assigns runtime by extension", async () => {
    const tsFile = path.join(dir, "exp.ts");
    const jsFile = path.join(dir, "exp.js");
    const mjsFile = path.join(dir, "exp.mjs");
    await fs.writeFile(tsFile, "");
    await fs.writeFile(jsFile, "");
    await fs.writeFile(mjsFile, "");
    expect((await discoverScripts(tsFile))[0].runtime).toBe("node");
    expect((await discoverScripts(jsFile))[0].runtime).toBe("node");
    expect((await discoverScripts(mjsFile))[0].runtime).toBe("node");
  });

  it("enumerates directory contents and sorts them", async () => {
    await fs.writeFile(path.join(dir, "b.py"), "");
    await fs.writeFile(path.join(dir, "a.ts"), "");
    await fs.writeFile(path.join(dir, "c.js"), "");
    const scripts = await discoverScripts(dir);
    expect(scripts.map((s) => path.basename(s.path))).toEqual(["a.ts", "b.py", "c.js"]);
    expect(runtimesIn(scripts)).toEqual(new Set(["python", "node"]));
  });

  it("skips dotfiles, underscore-prefixed helpers, and unknown extensions", async () => {
    await fs.writeFile(path.join(dir, "exp.py"), "");
    await fs.writeFile(path.join(dir, ".hidden.py"), "");
    await fs.writeFile(path.join(dir, "__init__.py"), "");
    await fs.writeFile(path.join(dir, "notes.md"), "");
    const scripts = await discoverScripts(dir);
    expect(scripts.map((s) => path.basename(s.path))).toEqual(["exp.py"]);
  });

  it("throws a uniform 'no matches' error regardless of input shape", async () => {
    // Nonexistent path.
    await expect(discoverScripts(path.join(dir, "missing.py"))).rejects.toThrow(
      /No experiment scripts matched/,
    );
    // File with an unsupported extension.
    const rb = path.join(dir, "exp.rb");
    await fs.writeFile(rb, "");
    await expect(discoverScripts(rb)).rejects.toThrow(/No experiment scripts matched/);
    // Directory containing only unsupported files.
    await fs.writeFile(path.join(dir, "notes.md"), "");
    await expect(discoverScripts(dir)).rejects.toThrow(/No experiment scripts matched/);
  });

  it("resolves a glob pattern and filters to supported extensions", async () => {
    await fs.writeFile(path.join(dir, "keep_one.py"), "");
    await fs.writeFile(path.join(dir, "keep_two.ts"), "");
    await fs.writeFile(path.join(dir, "skip.md"), "");
    const scripts = await discoverScripts(path.join(dir, "keep_*"));
    expect(scripts.map((s) => path.basename(s.path)).sort()).toEqual([
      "keep_one.py",
      "keep_two.ts",
    ]);
  });
});
