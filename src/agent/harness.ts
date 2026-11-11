import { callTool, type ToolOutcome } from "../engine/tools.js";
import { injectChaos } from "../engine/chaos.js";
import { HOUR } from "../engine/types.js";
import type { World } from "../engine/world.js";
import type { Scenario, TimelineStep } from "../scenarios/library.js";

/** Actions a person can take on a live run from the dashboard. */
export type ControlAction =
  | { type: "chaos"; kind: string; params?: Record<string, unknown> }
  | { type: "advance_clock"; hours: number }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "step" }
  | { type: "stop" };

/** Lets the dashboard pause, step, stop, and push chaos or clock changes between agent actions. */
export class RunControl {
  paused = false;
  stopped = false;
  private queue: ControlAction[] = [];
  private wake?: () => void;
  private stepOnce = false;

  push(a: ControlAction) {
    if (a.type === "pause") this.paused = true;
    else if (a.type === "resume") this.paused = false;
    else if (a.type === "stop") this.stopped = true;
    else if (a.type === "step") this.stepOnce = true;
    else this.queue.push(a);
    this.wake?.();
  }

  drain(): ControlAction[] {
    const q = this.queue;
    this.queue = [];
    return q;
  }

  /** Waits while paused, applying queued actions as they arrive. */
  async gate(apply: (a: ControlAction) => void) {
    for (;;) {
      for (const a of this.drain()) apply(a);
      if (this.stopped || !this.paused || this.stepOnce) {
        this.stepOnce = false;
        return;
      }
      await new Promise<void>((r) => (this.wake = r));
      this.wake = undefined;
    }
  }
}

/**
 * Everything that happens around an agent's tool calls: the scenario's exception
 * timeline, the clock, and operator controls. Shared by the built-in runner and
 * by external agents connected over MCP, so both are tested identically.
 */
export class RunHarness {
  readonly control: RunControl;
  private readonly timeline: TimelineStep[];
  private readonly fired = new Set<number>();
  private readonly startAt: number;
  private calls = 0;

  constructor(readonly world: World, readonly scenario: Scenario, extraTimeline: TimelineStep[] = [], control?: RunControl) {
    this.control = control ?? new RunControl();
    this.startAt = world.state.now;
    // Generated tests sometimes repeat an exception the scenario already has; fire each one once.
    const seen = new Set<string>();
    this.timeline = [...scenario.timeline, ...extraTimeline].filter((s) => {
      const key = `${JSON.stringify(s.trigger)}|${s.chaos}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private fire(pred: (s: TimelineStep) => boolean) {
    this.timeline.forEach((s, i) => {
      if (this.fired.has(i) || !pred(s)) return;
      this.fired.add(i);
      injectChaos(this.world, s.chaos, s.params);
    });
  }

  private fireTimed() {
    this.fire((s) => typeof s.trigger === "object" && "atHour" in s.trigger && this.world.state.now - this.startAt >= s.trigger.atHour * HOUR);
  }

  start(note: string) {
    this.fire((s) => s.trigger === "start");
    this.world.emit("system", { type: "run.note", data: { text: note } });
  }

  readonly apply = (a: ControlAction) => {
    if (a.type === "chaos") injectChaos(this.world, a.kind, a.params, "user");
    if (a.type === "advance_clock") {
      this.world.advanceBy(a.hours * HOUR, `operator moved the clock +${a.hours}h`, "user");
      this.fireTimed();
    }
  };

  /** Honors pause/step and applies queued operator actions. */
  gate() {
    return this.control.gate(this.apply);
  }

  /** Run one tool call with every trigger that surrounds it. */
  callTool(name: string, input: unknown): ToolOutcome {
    this.fire((s) => typeof s.trigger === "object" && "onTool" in s.trigger && s.trigger.onTool === name);
    const out = callTool(this.world, name, input);
    this.calls++;
    this.fire((s) => typeof s.trigger === "object" && "afterCalls" in s.trigger && this.calls >= s.trigger.afterCalls);
    this.fireTimed();
    return out;
  }
}
