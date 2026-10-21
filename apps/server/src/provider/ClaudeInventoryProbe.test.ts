import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ClaudeSettings } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

import { probeClaudeInventory } from "./ClaudeProvider.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

const settings = Schema.decodeSync(ClaudeSettings)({});

it.effect("can refresh Claude inventory repeatedly and closes each probe", () =>
  Effect.gen(function* () {
    const controllers: Array<AbortController> = [];
    using query = vi.spyOn(ClaudeSdk, "query").mockImplementation((input) => {
      const controller = input.options!.abortController!;
      assert.isFalse(controller.signal.aborted);
      controllers.push(controller);
      return {
        initializationResult: async () => ({}),
        mcpServerStatus: async () => [],
        reloadPlugins: async () => ({ plugins: [] }),
        reloadSkills: async () => ({ skills: [{ name: "pdf", description: "Read PDFs" }] }),
      } as unknown as ReturnType<typeof ClaudeSdk.query>;
    });

    const probe = probeClaudeInventory(settings, {}, "/inventory-test");
    const first = yield* probe;
    const second = yield* probe;

    assert.deepStrictEqual(first, second);
    assert.deepStrictEqual(first.skills, {
      _tag: "Listed",
      canDisable: true,
      items: [{ id: "pdf", name: "pdf", description: "Read PDFs" }],
    });
    assert.strictEqual(query.mock.calls.length, 2);
    assert.notStrictEqual(controllers[0], controllers[1]);
    assert.isTrue(controllers.every((controller) => controller.signal.aborted));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("closes a Claude inventory probe if initialization fails", () =>
  Effect.gen(function* () {
    let controller: AbortController | undefined;
    using _query = vi.spyOn(ClaudeSdk, "query").mockImplementation((input) => {
      controller = input.options!.abortController!;
      return {
        initializationResult: async () => {
          throw new Error("Initialization failed");
        },
      } as unknown as ReturnType<typeof ClaudeSdk.query>;
    });

    const result = yield* probeClaudeInventory(settings, {}, "/inventory-test").pipe(Effect.exit);

    assert.isTrue(Exit.isFailure(result));
    assert.isTrue(controller?.signal.aborted);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("closes a Claude inventory probe when the request is cancelled", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let controller: AbortController | undefined;
    using _query = vi.spyOn(ClaudeSdk, "query").mockImplementation((input) => {
      controller = input.options!.abortController!;
      return {
        initializationResult: () => {
          Deferred.doneUnsafe(started, Effect.void);
          return new Promise(() => {});
        },
      } as unknown as ReturnType<typeof ClaudeSdk.query>;
    });

    const probe = yield* probeClaudeInventory(settings, {}, "/inventory-test").pipe(
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    yield* Fiber.interrupt(probe);

    assert.isTrue(controller?.signal.aborted);
  }).pipe(Effect.provide(NodeServices.layer)),
);
