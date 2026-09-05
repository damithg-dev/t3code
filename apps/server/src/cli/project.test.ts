import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { FetchHttpClient } from "effect/unstable/http";

import {
  EnvironmentInternalError,
  ProjectId,
  type OrchestrationProject,
  type OrchestrationReadModel,
} from "@t3tools/contracts";

import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { WorkspaceFileError } from "../workspace/WorkspaceFile.ts";

import {
  ProjectAlreadyExistsError,
  ProjectLiveServerDeclaredResponseError,
  ProjectLiveServerRequestError,
  ProjectNotFoundError,
  ProjectWorkspaceFileEmptyError,
  type ProjectCliDispatchCommand,
  projectAddMutation,
  projectCommandErrorFromLiveServerRequest,
  projectSetWorkspaceMutation,
} from "./project.ts";

it("maps declared server failures into structural project command errors", () => {
  const cause = new EnvironmentInternalError({
    code: "internal_error",
    reason: "orchestration_snapshot_failed",
    traceId: "trace-123",
  });

  const error = projectCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, ProjectLiveServerDeclaredResponseError);
  assert.strictEqual(error.operation, "callLiveServer");
  assert.strictEqual(error.code, "internal_error");
  assert.strictEqual(error.traceId, "trace-123");
  assert.strictEqual(error.message, "Server request failed (internal_error, trace trace-123).");
  assert.strictEqual(error.cause, cause);
});

it("preserves unexpected server failures without deriving the message from them", () => {
  const cause = new Error("credential abc123 was rejected");

  const error = projectCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, ProjectLiveServerRequestError);
  assert.strictEqual(error.operation, "callLiveServer");
  assert.strictEqual(error.message, "Failed to call the running server.");
  assert.strictEqual(error.cause, cause);
});

const TestLayer = Layer.mergeAll(WorkspacePaths.layer, FetchHttpClient.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.fn(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  // NOTE: unscoped on purpose — see WorkspaceGitScan.test.ts for the rationale.
  return yield* fileSystem.makeTempDirectory({ prefix });
});

const mkdir = Effect.fn(function* (...segments: ReadonlyArray<string>) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(...segments);
  yield* fileSystem.makeDirectory(absolutePath, { recursive: true });
  return absolutePath;
});

const gitRepo = Effect.fn(function* (...segments: ReadonlyArray<string>) {
  const path = yield* Path.Path;
  const absolutePath = yield* mkdir(...segments);
  yield* mkdir(path.join(absolutePath, ".git"));
  return absolutePath;
});

const writeWorkspaceFile = Effect.fn(function* (
  filePath: string,
  folderPaths: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const folders = folderPaths.map((folderPath) => `    { "path": "${folderPath}" }`).join(",\n");
  yield* fileSystem.writeFileString(filePath, `{\n  "folders": [\n${folders}\n  ]\n}\n`);
  return filePath;
});

function project(overrides: Partial<OrchestrationProject>): OrchestrationProject {
  return {
    id: ProjectId.make("11111111-1111-4111-8111-111111111111"),
    title: "existing",
    workspaceRoot: "/tmp/existing",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  } as OrchestrationProject;
}

function snapshotOf(projects: ReadonlyArray<OrchestrationProject>): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    projects,
    threads: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as OrchestrationReadModel;
}

/** Captures the commands a mutation dispatches instead of hitting a server. */
function recordingDispatch(): {
  readonly commands: Array<ProjectCliDispatchCommand>;
  readonly dispatch: (command: ProjectCliDispatchCommand) => Effect.Effect<void>;
} {
  const commands: Array<ProjectCliDispatchCommand> = [];
  return {
    commands,
    dispatch: (command) =>
      Effect.sync(() => {
        commands.push(command);
      }),
  };
}

function expectDispatched<T extends ProjectCliDispatchCommand["type"]>(
  command: ProjectCliDispatchCommand | undefined,
  type: T,
): Extract<ProjectCliDispatchCommand, { type: T }> {
  assert.strictEqual(command?.type, type);
  return command as Extract<ProjectCliDispatchCommand, { type: T }>;
}

it.layer(TestLayer)("project add", (it) => {
  it.effect("creates a workspace-file project anchored at the file's directory", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const base = yield* makeTempDir("t3-cli-project-add-workspace-");
      const mobile = yield* gitRepo(base, "mobile-app");
      const backoffice = yield* gitRepo(base, "backoffice");
      yield* mkdir(base, "docs");
      const workspaceFilePath = yield* writeWorkspaceFile(
        path.join(base, "BabyJourney.code-workspace"),
        ["mobile-app", "backoffice", "docs", "gone"],
      );

      const recorder = recordingDispatch();
      const output = yield* projectAddMutation({
        snapshot: snapshotOf([]),
        dispatch: recorder.dispatch,
        projectPath: workspaceFilePath,
      });

      assert.lengthOf(recorder.commands, 1);
      const command = expectDispatched(recorder.commands[0], "project.create");
      assert.deepStrictEqual(
        {
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          workspaceFile: command.workspaceFile,
          repoRoots: command.repoRoots,
        },
        {
          title: "BabyJourney",
          workspaceRoot: yield* (yield* WorkspacePaths.WorkspacePaths).normalizeWorkspaceRoot(base),
          workspaceFile: workspaceFilePath,
          repoRoots: [mobile, backoffice],
        },
      );
      assert.include(output, "Warning: Missing folders:");
      assert.include(output, "Warning: Folders without a git repository:");
    }),
  );

  it.effect("leaves a plain folder project without workspace-file fields", () =>
    Effect.gen(function* () {
      const base = yield* makeTempDir("t3-cli-project-add-folder-");
      const checkout = yield* gitRepo(base, "checkout");

      const recorder = recordingDispatch();
      yield* projectAddMutation({
        snapshot: snapshotOf([]),
        dispatch: recorder.dispatch,
        projectPath: checkout,
      });

      const command = expectDispatched(recorder.commands[0], "project.create");
      assert.strictEqual(command.title, "checkout");
      assert.strictEqual(command.workspaceFile, undefined);
      assert.strictEqual(command.repoRoots, undefined);
    }),
  );

  it.effect("adds a workspace-file project alongside a folder project on the same root", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const base = yield* makeTempDir("t3-cli-project-add-alongside-");
      yield* gitRepo(base, "mobile-app");
      const workspaceFilePath = yield* writeWorkspaceFile(path.join(base, "team.code-workspace"), [
        "mobile-app",
      ]);
      const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
      const anchorDir = yield* workspacePaths.normalizeWorkspaceRoot(base);
      const snapshot = snapshotOf([project({ workspaceRoot: anchorDir })]);

      const recorder = recordingDispatch();
      yield* projectAddMutation({
        snapshot,
        dispatch: recorder.dispatch,
        projectPath: workspaceFilePath,
      });
      assert.lengthOf(recorder.commands, 1);

      // The same workspace file twice is still a duplicate.
      const failure = yield* projectAddMutation({
        snapshot: snapshotOf([
          project({ workspaceRoot: anchorDir, workspaceFile: workspaceFilePath }),
        ]),
        dispatch: recorder.dispatch,
        projectPath: workspaceFilePath,
      }).pipe(Effect.flip);
      assert.instanceOf(failure, ProjectAlreadyExistsError);
    }),
  );
});

it.layer(TestLayer)("project set-workspace", (it) => {
  it.effect("attaches the workspace file and its git roots to an existing project", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const base = yield* makeTempDir("t3-cli-set-workspace-");
      const mobile = yield* gitRepo(base, "mobile-app");
      const firebase = yield* gitRepo(base, "firebase");
      yield* mkdir(base, "notes");
      const workspaceFilePath = yield* writeWorkspaceFile(
        path.join(base, "BabyJourney.code-workspace"),
        ["mobile-app", "firebase", "notes"],
      );
      const projectId = ProjectId.make("22222222-2222-4222-8222-222222222222");
      const snapshot = snapshotOf([project({ id: projectId, workspaceRoot: base })]);

      const recorder = recordingDispatch();
      const output = yield* projectSetWorkspaceMutation({
        snapshot,
        dispatch: recorder.dispatch,
        identifier: projectId,
        workspaceFilePath,
      });

      const command = expectDispatched(recorder.commands[0], "project.meta.update");
      assert.deepStrictEqual(
        {
          projectId: command.projectId,
          workspaceFile: command.workspaceFile,
          repoRoots: command.repoRoots,
        },
        { projectId, workspaceFile: workspaceFilePath, repoRoots: [mobile, firebase] },
      );
      assert.include(output, workspaceFilePath);
      assert.include(output, "Warning: Folders without a git repository:");
    }),
  );

  it.effect("rejects an unknown project before touching the workspace file", () =>
    Effect.gen(function* () {
      const recorder = recordingDispatch();
      const failure = yield* projectSetWorkspaceMutation({
        snapshot: snapshotOf([]),
        dispatch: recorder.dispatch,
        identifier: "/tmp/not-a-project",
        workspaceFilePath: "/tmp/nowhere.code-workspace",
      }).pipe(Effect.flip);

      assert.instanceOf(failure, ProjectNotFoundError);
      assert.lengthOf(recorder.commands, 0);
    }),
  );

  it.effect("fails when the workspace file is missing", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const base = yield* makeTempDir("t3-cli-set-workspace-missing-");
      const projectId = ProjectId.make("33333333-3333-4333-8333-333333333333");
      const snapshot = snapshotOf([project({ id: projectId, workspaceRoot: base })]);

      const recorder = recordingDispatch();
      const failure = yield* projectSetWorkspaceMutation({
        snapshot,
        dispatch: recorder.dispatch,
        identifier: projectId,
        workspaceFilePath: path.join(base, "absent.code-workspace"),
      }).pipe(Effect.flip);

      assert.instanceOf(failure, WorkspaceFileError);
      assert.lengthOf(recorder.commands, 0);
    }),
  );

  it.effect("fails when no listed folder is a git repository", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const base = yield* makeTempDir("t3-cli-set-workspace-nogit-");
      yield* mkdir(base, "notes");
      const workspaceFilePath = yield* writeWorkspaceFile(path.join(base, "docs.code-workspace"), [
        "notes",
        "gone",
      ]);
      const projectId = ProjectId.make("44444444-4444-4444-8444-444444444444");
      const snapshot = snapshotOf([project({ id: projectId, workspaceRoot: base })]);

      const recorder = recordingDispatch();
      const failure = yield* projectSetWorkspaceMutation({
        snapshot,
        dispatch: recorder.dispatch,
        identifier: projectId,
        workspaceFilePath,
      }).pipe(Effect.flip);

      assert.instanceOf(failure, ProjectWorkspaceFileEmptyError);
      assert.strictEqual(failure.folderCount, 2);
      assert.lengthOf(recorder.commands, 0);
    }),
  );
});
