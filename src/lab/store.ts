import fs from "node:fs";
import path from "node:path";
import type { AgentConfig } from "../agent/types.js";
import type { BatchRecord, RunRecord, TestDef } from "./types.js";

/** Plain JSON files under the data directory. Good enough for a local lab; easy to inspect and commit. */
export class Store {
  constructor(readonly dir: string) {
    fs.mkdirSync(path.join(dir, "runs"), { recursive: true });
  }

  private read<T>(file: string, fallback: T): T {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, file), "utf8")) as T;
    } catch {
      return fallback;
    }
  }

  private write(file: string, data: unknown) {
    const p = path.join(this.dir, file);
    fs.writeFileSync(`${p}.tmp`, JSON.stringify(data, null, 1));
    fs.renameSync(`${p}.tmp`, p);
  }

  loadAgents(): { current: AgentConfig[]; history: AgentConfig[] } {
    return this.read("agents.json", { current: [], history: [] });
  }
  saveAgents(data: { current: AgentConfig[]; history: AgentConfig[] }) {
    this.write("agents.json", data);
  }

  loadTests(): TestDef[] {
    return this.read("tests.json", []);
  }
  saveTests(tests: TestDef[]) {
    this.write("tests.json", tests);
  }

  loadBatches(): BatchRecord[] {
    return this.read("batches.json", []);
  }
  saveBatches(b: BatchRecord[]) {
    this.write("batches.json", b);
  }

  loadRuns(): RunRecord[] {
    const dir = path.join(this.dir, "runs");
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as RunRecord;
        } catch {
          return null;
        }
      })
      .filter((r): r is RunRecord => !!r)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }
  saveRun(r: RunRecord) {
    this.write(path.join("runs", `${r.id}.json`), r);
  }
}
