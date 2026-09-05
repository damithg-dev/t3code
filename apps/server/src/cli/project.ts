import {
  CommandId,
  AuthAdministrativeScopes,
  EnvironmentHttpApi,
  EnvironmentHttpCommonError,
  type OrchestrationReadModel,
  ProjectId,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";

import * as ServerConfig from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import {
  clearPersistedServerRuntimeState,
  readPersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import { makeWorkspaceFile, type ResolvedWorkspaceFile } from "../workspace/WorkspaceFile.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { type CliAuthLocationFlags, projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

type ProjectMutationTarget = {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
};

type ProjectCommandExecutionMode = "live" | "offline";
export type ProjectCliDispatchCommand = Extract<
  ClientOrchestrationCommand,
  { type: "project.create" | "project.meta.update" | "project.delete" }
>;

/** Dispatches one project command, live over HTTP or offline through the engine. */
type ProjectCliDispatch = (
  command: ProjectCliDispatchCommand,
) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;

const WORKSPACE_FILE_EXTENSION = ".code-workspace";

const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);

export class ProjectCommandIdGenerationError extends Schema.TaggedErrorClass<ProjectCommandIdGenerationError>()(
  "ProjectCommandIdGenerationError",
  {
    operation: Schema.Literal("generateProjectCommandId"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to generate a project command identifier.";
  }
}

export class ProjectLiveServerDeclaredResponseError extends Schema.TaggedErrorClass<ProjectLiveServerDeclaredResponseError>()(
  "ProjectLiveServerDeclaredResponseError",
  {
    operation: Schema.Literal("callLiveServer"),
    code: Schema.String,
    traceId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Server request failed (${this.code}, trace ${this.traceId}).`;
  }
}

export class ProjectLiveServerUndeclaredStatusError extends Schema.TaggedErrorClass<ProjectLiveServerUndeclaredStatusError>()(
  "ProjectLiveServerUndeclaredStatusError",
  {
    operation: Schema.Literal("callLiveServer"),
    status: Schema.Int,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Server request failed with undeclared status ${this.status}.`;
  }
}

export class ProjectLiveServerRequestError extends Schema.TaggedErrorClass<ProjectLiveServerRequestError>()(
  "ProjectLiveServerRequestError",
  {
    operation: Schema.Literal("callLiveServer"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to call the running server.";
  }
}

export class ProjectTitleEmptyError extends Schema.TaggedErrorClass<ProjectTitleEmptyError>()(
  "ProjectTitleEmptyError",
  {
    operation: Schema.Literal("validateProjectTitle"),
    title: Schema.String,
  },
) {
  override get message(): string {
    return "Project title cannot be empty.";
  }
}

export class ProjectIdentifierEmptyError extends Schema.TaggedErrorClass<ProjectIdentifierEmptyError>()(
  "ProjectIdentifierEmptyError",
  {
    operation: Schema.Literal("resolveProjectTarget"),
    identifier: Schema.String,
  },
) {
  override get message(): string {
    return "Project identifier cannot be empty.";
  }
}

export class ProjectNotFoundError extends Schema.TaggedErrorClass<ProjectNotFoundError>()(
  "ProjectNotFoundError",
  {
    operation: Schema.Literal("resolveProjectTarget"),
    identifier: Schema.String,
    normalizedWorkspaceRoot: Schema.optional(Schema.String),
    activeProjectCount: Schema.Number,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `No active project found for '${this.identifier}'.`;
  }
}

export class ProjectAlreadyExistsError extends Schema.TaggedErrorClass<ProjectAlreadyExistsError>()(
  "ProjectAlreadyExistsError",
  {
    operation: Schema.Literal("addProject"),
    projectId: ProjectId,
    workspaceRoot: Schema.String,
    workspaceFile: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.workspaceFile === undefined
      ? `An active project already exists for '${this.workspaceRoot}'.`
      : `An active project already exists for '${this.workspaceFile}'.`;
  }
}

export class ProjectWorkspaceFileEmptyError extends Schema.TaggedErrorClass<ProjectWorkspaceFileEmptyError>()(
  "ProjectWorkspaceFileEmptyError",
  {
    operation: Schema.Literal("resolveWorkspaceFile"),
    workspaceFile: Schema.String,
    folderCount: Schema.Number,
  },
) {
  override get message(): string {
    return `Workspace file '${this.workspaceFile}' resolves no git repositories (${this.folderCount} folder(s) listed).`;
  }
}

export const ProjectCommandError = Schema.Union([
  ProjectCommandIdGenerationError,
  ProjectLiveServerDeclaredResponseError,
  ProjectLiveServerUndeclaredStatusError,
  ProjectLiveServerRequestError,
  ProjectTitleEmptyError,
  ProjectIdentifierEmptyError,
  ProjectNotFoundError,
  ProjectAlreadyExistsError,
  ProjectWorkspaceFileEmptyError,
]);
export type ProjectCommandError = typeof ProjectCommandError.Type;

export function projectCommandErrorFromLiveServerRequest(cause: unknown): ProjectCommandError {
  if (isEnvironmentHttpCommonError(cause)) {
    return new ProjectLiveServerDeclaredResponseError({
      operation: "callLiveServer",
      code: cause.code,
      traceId: cause.traceId,
      cause,
    });
  }
  if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined) {
    return new ProjectLiveServerUndeclaredStatusError({
      operation: "callLiveServer",
      status: cause.response.status,
      cause,
    });
  }

  return new ProjectLiveServerRequestError({ operation: "callLiveServer", cause });
}

const projectCommandUuid = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.mapError(
    (cause) =>
      new ProjectCommandIdGenerationError({
        operation: "generateProjectCommandId",
        cause,
      }),
  ),
);

const ProjectCliRuntimeLive = Layer.mergeAll(
  WorkspacePaths.layer,
  OrchestrationLayerLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceLayerLive),
  ),
);

const PROJECT_CLI_LIVE_SERVER_TIMEOUT = Duration.seconds(1);
const withProjectCliSessionToken = <A, E, R>(
  environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
  run: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    environmentAuth.issueSession({
      scopes: AuthAdministrativeScopes,
      label: "t3 project cli",
    }),
    (issued) => run(issued.token),
    (issued) => environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
  );

const withProjectCliLiveServerTimeout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.timeout(PROJECT_CLI_LIVE_SERVER_TIMEOUT));

const makeLiveServerClient = (origin: string) =>
  HttpApiClient.make(EnvironmentHttpApi, {
    baseUrl: origin,
  });

const normalizeWorkspaceRootForProjectCommand = Effect.fn(
  "normalizeWorkspaceRootForProjectCommand",
)(function* (workspaceRoot: string) {
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  return yield* workspacePaths.normalizeWorkspaceRoot(workspaceRoot);
});

/** Validates an explicit title, falling back to the caller's derived default. */
const resolveProjectTitle = Effect.fn("resolveProjectTitle")(function* (
  defaultTitle: string,
  explicitTitle?: string,
) {
  if (explicitTitle !== undefined) {
    const trimmed = explicitTitle.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
    return yield* new ProjectTitleEmptyError({
      operation: "validateProjectTitle",
      title: explicitTitle,
    });
  }

  const trimmedDefault = defaultTitle.trim();
  return trimmedDefault.length > 0 ? trimmedDefault : "project";
});

function isWorkspaceFilePath(candidate: string): boolean {
  return candidate.trim().toLowerCase().endsWith(WORKSPACE_FILE_EXTENSION);
}

/** `/repos/BabyJourney.code-workspace` -> `BabyJourney`, like the palette does. */
function workspaceFileTitle(workspaceFilePath: string, path: Path.Path): string {
  const fileName = path.basename(workspaceFilePath);
  const stripped = fileName.slice(0, fileName.length - WORKSPACE_FILE_EXTENSION.length).trim();
  return stripped.length > 0 ? stripped : fileName;
}

const readProjectWorkspaceFile = Effect.fn("readProjectWorkspaceFile")(function* (
  workspaceFilePath: string,
) {
  const workspaceFile = yield* makeWorkspaceFile;
  return yield* workspaceFile.read(workspaceFilePath);
});

/**
 * Folders a workspace file lists but cannot contribute as repo roots. Surfaced
 * to the operator rather than silently collapsed into the repo-root list.
 */
function workspaceFolderWarnings(resolved: ResolvedWorkspaceFile): ReadonlyArray<string> {
  const missing = resolved.folders.filter((folder) => !folder.exists);
  const nonGit = resolved.folders.filter((folder) => folder.exists && !folder.isGit);
  return [
    ...(missing.length > 0
      ? [`Missing folders: ${missing.map((folder) => folder.absolutePath).join(", ")}.`]
      : []),
    ...(nonGit.length > 0
      ? [
          `Folders without a git repository: ${nonGit.map((folder) => folder.absolutePath).join(", ")}.`,
        ]
      : []),
  ];
}

export type ProjectAddTarget = {
  readonly workspaceRoot: string;
  readonly workspaceFile?: string;
  readonly repoRoots?: ReadonlyArray<string>;
  readonly defaultTitle: string;
  readonly warnings: ReadonlyArray<string>;
};

/**
 * A `.code-workspace` path anchors the project at the file's directory and
 * carries the file's git folders as `repoRoots`, mirroring what the palette's
 * open-workspace flow dispatches. Any other path stays a plain folder project.
 */
export const resolveProjectAddTarget = Effect.fn("resolveProjectAddTarget")(function* (
  projectPath: string,
) {
  const path = yield* Path.Path;

  if (!isWorkspaceFilePath(projectPath)) {
    const workspaceRoot = yield* normalizeWorkspaceRootForProjectCommand(projectPath);
    return {
      workspaceRoot,
      defaultTitle: path.basename(workspaceRoot),
      warnings: [],
    } satisfies ProjectAddTarget;
  }

  const resolved = yield* readProjectWorkspaceFile(projectPath);
  const workspaceRoot = yield* normalizeWorkspaceRootForProjectCommand(resolved.anchorDir);
  return {
    workspaceRoot,
    workspaceFile: resolved.workspaceFilePath,
    repoRoots: resolved.repoRoots,
    defaultTitle: workspaceFileTitle(resolved.workspaceFilePath, path),
    warnings: workspaceFolderWarnings(resolved),
  } satisfies ProjectAddTarget;
});

export type ProjectWorkspaceFileUpdate = {
  readonly workspaceFile: string;
  readonly repoRoots: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
};

/**
 * Validates a `.code-workspace` before it is attached to an existing project.
 * A file that resolves no git repositories would leave the project without a
 * single usable checkout, so it fails instead of writing an empty root list.
 */
export const resolveProjectWorkspaceFileUpdate = Effect.fn("resolveProjectWorkspaceFileUpdate")(
  function* (workspaceFilePath: string) {
    const resolved = yield* readProjectWorkspaceFile(workspaceFilePath);
    if (resolved.repoRoots.length === 0) {
      return yield* new ProjectWorkspaceFileEmptyError({
        operation: "resolveWorkspaceFile",
        workspaceFile: resolved.workspaceFilePath,
        folderCount: resolved.folders.length,
      });
    }
    return {
      workspaceFile: resolved.workspaceFilePath,
      repoRoots: resolved.repoRoots,
      warnings: workspaceFolderWarnings(resolved),
    } satisfies ProjectWorkspaceFileUpdate;
  },
);

const findActiveProjectTarget = Effect.fn("findActiveProjectTarget")(function* (input: {
  readonly snapshot: OrchestrationReadModel;
  readonly identifier: string;
}) {
  const trimmedIdentifier = input.identifier.trim();
  if (trimmedIdentifier.length === 0) {
    return yield* new ProjectIdentifierEmptyError({
      operation: "resolveProjectTarget",
      identifier: input.identifier,
    });
  }

  const activeProjects = input.snapshot.projects.filter((project) => project.deletedAt === null);
  const exactIdMatch = activeProjects.find((project) => project.id === trimmedIdentifier);
  if (exactIdMatch) {
    return {
      id: exactIdMatch.id,
      title: exactIdMatch.title,
      workspaceRoot: exactIdMatch.workspaceRoot,
    } satisfies ProjectMutationTarget;
  }

  const normalizedWorkspaceRootResult = yield* Effect.result(
    normalizeWorkspaceRootForProjectCommand(trimmedIdentifier),
  );
  const normalizedWorkspaceRoot =
    normalizedWorkspaceRootResult._tag === "Success" ? normalizedWorkspaceRootResult.success : null;

  // A stored workspace path still identifies its project after the directory is gone.
  const exactWorkspaceMatch = activeProjects.find(
    (project) => project.workspaceRoot === (normalizedWorkspaceRoot ?? trimmedIdentifier),
  );

  const resolved = exactWorkspaceMatch;
  if (!resolved) {
    return yield* new ProjectNotFoundError({
      operation: "resolveProjectTarget",
      identifier: trimmedIdentifier,
      activeProjectCount: activeProjects.length,
      ...(normalizedWorkspaceRoot === null ? {} : { normalizedWorkspaceRoot }),
      ...(normalizedWorkspaceRootResult._tag === "Failure"
        ? { cause: normalizedWorkspaceRootResult.failure }
        : {}),
    });
  }

  return {
    id: resolved.id,
    title: resolved.title,
    workspaceRoot: resolved.workspaceRoot,
  } satisfies ProjectMutationTarget;
});

const fetchLiveOrchestrationSnapshot = (origin: string, bearerToken: string) =>
  Effect.gen(function* () {
    const client = yield* makeLiveServerClient(origin);
    return yield* client.orchestration.snapshot({
      headers: { authorization: `Bearer ${bearerToken}` },
    });
  }).pipe(
    withProjectCliLiveServerTimeout,
    Effect.mapError(projectCommandErrorFromLiveServerRequest),
  );

const dispatchLiveOrchestrationCommand = (
  origin: string,
  bearerToken: string,
  command: ProjectCliDispatchCommand,
) =>
  Effect.gen(function* () {
    const client = yield* makeLiveServerClient(origin);
    yield* client.orchestration.dispatch({
      headers: { authorization: `Bearer ${bearerToken}` },
      payload: command,
    } as Parameters<typeof client.orchestration.dispatch>[0]);
  }).pipe(
    withProjectCliLiveServerTimeout,
    Effect.mapError(projectCommandErrorFromLiveServerRequest),
  );

const getOfflineSnapshot = Effect.fn("getOfflineSnapshot")(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  // Project commands only read the project list, so use the lightweight
  // command read model instead of hydrating every thread body in the database.
  return yield* projectionSnapshotQuery.getCommandReadModel();
});

const tryResolveLiveProjectExecutionMode = Effect.fn("tryResolveLiveProjectExecutionMode")(
  function* (
    environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
    config: ServerConfig.ServerConfig["Service"],
  ) {
    const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtimeState)) {
      return Option.none<{ readonly origin: string }>();
    }

    const attempt = withProjectCliSessionToken(environmentAuth, (token) =>
      fetchLiveOrchestrationSnapshot(runtimeState.value.origin, token).pipe(
        Effect.as({
          origin: runtimeState.value.origin,
        }),
      ),
    );

    const attempted = yield* Effect.result(attempt);
    if (attempted._tag === "Success") {
      return Option.some(attempted.success);
    }

    yield* Effect.logDebug("Failed to connect to the persisted project CLI server.", {
      origin: runtimeState.value.origin,
      cause: attempted.failure,
    });
    yield* clearPersistedServerRuntimeState(config.serverRuntimeStatePath);
    return Option.none<{ readonly origin: string }>();
  },
);

const runProjectMutation = Effect.fn("runProjectMutation")(function* (
  flags: CliAuthLocationFlags,
  run: (input: {
    readonly snapshot: OrchestrationReadModel;
    readonly dispatch: ProjectCliDispatch;
    readonly mode: ProjectCommandExecutionMode;
  }) => Effect.Effect<
    string,
    Error,
    | Crypto.Crypto
    | FileSystem.FileSystem
    | HttpClient.HttpClient
    | Path.Path
    | WorkspacePaths.WorkspacePaths
  >,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  const minimumLogLevel = config.logLevel;

  return yield* Effect.gen(function* () {
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const liveMode = yield* tryResolveLiveProjectExecutionMode(environmentAuth, config);

    if (Option.isSome(liveMode)) {
      return yield* withProjectCliSessionToken(environmentAuth, (token) =>
        Effect.gen(function* () {
          const snapshot = yield* fetchLiveOrchestrationSnapshot(liveMode.value.origin, token);
          const output = yield* run({
            snapshot,
            dispatch: (command) =>
              dispatchLiveOrchestrationCommand(liveMode.value.origin, token, command),
            mode: "live",
          });
          yield* Console.log(output);
        }),
      );
    }

    const offlineRuntimeLayer = ProjectCliRuntimeLive.pipe(
      Layer.provide(ServerConfig.layer(config)),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
    );

    return yield* Effect.gen(function* () {
      const snapshot = yield* getOfflineSnapshot();
      const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
      const output = yield* run({
        snapshot,
        dispatch: (command) => orchestrationEngine.dispatch(command),
        mode: "offline",
      });
      yield* Console.log(output);
    }).pipe(Effect.provide(offlineRuntimeLayer));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(EnvironmentAuth.runtimeLayer, WorkspacePaths.layer).pipe(
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
      ),
    ),
  );
});

export const projectAddMutation = Effect.fn("projectAddMutation")(function* (input: {
  readonly snapshot: OrchestrationReadModel;
  readonly dispatch: ProjectCliDispatch;
  readonly projectPath: string;
  readonly title?: string | undefined;
}) {
  const target = yield* resolveProjectAddTarget(input.projectPath);
  // A `.code-workspace` anchored at an existing folder project's root is a
  // different project, so identity is the root plus the workspace file.
  const existingProject = input.snapshot.projects.find(
    (project) =>
      project.deletedAt === null &&
      project.workspaceRoot === target.workspaceRoot &&
      (project.workspaceFile ?? null) === (target.workspaceFile ?? null),
  );
  if (existingProject) {
    return yield* new ProjectAlreadyExistsError({
      operation: "addProject",
      projectId: existingProject.id,
      workspaceRoot: target.workspaceRoot,
      ...(target.workspaceFile === undefined ? {} : { workspaceFile: target.workspaceFile }),
    });
  }

  const title = yield* resolveProjectTitle(target.defaultTitle, input.title);
  const projectId = ProjectId.make(yield* projectCommandUuid);
  yield* input.dispatch({
    type: "project.create",
    commandId: CommandId.make(yield* projectCommandUuid),
    projectId,
    title,
    workspaceRoot: target.workspaceRoot,
    ...(target.workspaceFile === undefined ? {} : { workspaceFile: target.workspaceFile }),
    ...(target.repoRoots && target.repoRoots.length > 0 ? { repoRoots: target.repoRoots } : {}),
    createdAt: DateTime.formatIso(yield* DateTime.now),
  });

  return [
    `Added project ${projectId} (${title}) at ${target.workspaceRoot}.`,
    ...(target.workspaceFile === undefined ? [] : [`Workspace file: ${target.workspaceFile}`]),
    ...(target.repoRoots && target.repoRoots.length > 0
      ? [`Repo roots (${target.repoRoots.length}): ${target.repoRoots.join(", ")}`]
      : []),
    ...target.warnings.map((warning) => `Warning: ${warning}`),
  ].join("\n");
});

const projectAddCommand = Command.make("add", {
  ...projectLocationFlags,
  projectPath: Argument.string("path").pipe(
    Argument.withDescription("Workspace root, or a .code-workspace file, to add as a project."),
  ),
  title: Flag.string("title").pipe(Flag.withDescription("Optional project title."), Flag.optional),
}).pipe(
  Command.withDescription("Add a project."),
  Command.withHandler((flags) =>
    runProjectMutation(flags, ({ snapshot, dispatch }) =>
      projectAddMutation({
        snapshot,
        dispatch,
        projectPath: flags.projectPath,
        title: Option.getOrUndefined(flags.title),
      }),
    ),
  ),
);

const projectRemoveCommand = Command.make("remove", {
  ...projectLocationFlags,
  project: Argument.string("project").pipe(
    Argument.withDescription("Project id or workspace root to remove."),
  ),
  force: Flag.boolean("force").pipe(
    Flag.withDescription("Delete the project and all of its threads."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Remove a project."),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      Effect.fn("projectRemoveMutation")(function* ({
        snapshot,
        dispatch,
      }: {
        readonly snapshot: OrchestrationReadModel;
        readonly dispatch: ProjectCliDispatch;
      }) {
        const project = yield* findActiveProjectTarget({
          snapshot,
          identifier: flags.project,
        });
        yield* dispatch({
          type: "project.delete",
          commandId: CommandId.make(yield* projectCommandUuid),
          projectId: project.id,
          force: flags.force,
        });
        return `Removed project ${project.id} (${project.title}).`;
      }),
    ),
  ),
);

const projectRenameCommand = Command.make("rename", {
  ...projectLocationFlags,
  project: Argument.string("project").pipe(
    Argument.withDescription("Project id or workspace root to rename."),
  ),
  title: Argument.string("title").pipe(Argument.withDescription("New project title.")),
}).pipe(
  Command.withDescription("Rename a project."),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      Effect.fn("projectRenameMutation")(function* ({
        snapshot,
        dispatch,
      }: {
        readonly snapshot: OrchestrationReadModel;
        readonly dispatch: ProjectCliDispatch;
      }) {
        const project = yield* findActiveProjectTarget({
          snapshot,
          identifier: flags.project,
        });
        const nextTitle = yield* resolveProjectTitle(project.title, flags.title);
        if (nextTitle === project.title) {
          return `Project ${project.id} is already named ${nextTitle}.`;
        }

        yield* dispatch({
          type: "project.meta.update",
          commandId: CommandId.make(yield* projectCommandUuid),
          projectId: project.id,
          title: nextTitle,
        });
        return `Renamed project ${project.id} to ${nextTitle}.`;
      }),
    ),
  ),
);

export const projectSetWorkspaceMutation = Effect.fn("projectSetWorkspaceMutation")(
  function* (input: {
    readonly snapshot: OrchestrationReadModel;
    readonly dispatch: ProjectCliDispatch;
    readonly identifier: string;
    readonly workspaceFilePath: string;
  }) {
    const project = yield* findActiveProjectTarget({
      snapshot: input.snapshot,
      identifier: input.identifier,
    });
    const update = yield* resolveProjectWorkspaceFileUpdate(input.workspaceFilePath);

    yield* input.dispatch({
      type: "project.meta.update",
      commandId: CommandId.make(yield* projectCommandUuid),
      projectId: project.id,
      workspaceFile: update.workspaceFile,
      repoRoots: update.repoRoots,
    });

    return [
      `Project ${project.id} (${project.title}) now uses ${update.workspaceFile}.`,
      `Repo roots (${update.repoRoots.length}): ${update.repoRoots.join(", ")}`,
      ...update.warnings.map((warning) => `Warning: ${warning}`),
    ].join("\n");
  },
);

const projectSetWorkspaceCommand = Command.make("set-workspace", {
  ...projectLocationFlags,
  project: Argument.string("project").pipe(
    Argument.withDescription("Project id or workspace root to update."),
  ),
  workspaceFile: Argument.string("workspace-file").pipe(
    Argument.withDescription("Path to the .code-workspace file backing the project."),
  ),
}).pipe(
  Command.withDescription("Back a project with a .code-workspace file."),
  Command.withHandler((flags) =>
    runProjectMutation(flags, ({ snapshot, dispatch }) =>
      projectSetWorkspaceMutation({
        snapshot,
        dispatch,
        identifier: flags.project,
        workspaceFilePath: flags.workspaceFile,
      }),
    ),
  ),
);

export const projectCommand = Command.make("project").pipe(
  Command.withDescription("Manage projects."),
  Command.withSubcommands([
    projectAddCommand,
    projectRemoveCommand,
    projectRenameCommand,
    projectSetWorkspaceCommand,
  ]),
);
