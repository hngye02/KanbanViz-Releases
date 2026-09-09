import { CanvasError } from "@github/copilot-sdk/extension";

const GROUP_DIMENSIONS = [
  "recency",
  "workType",
  "disposition",
  "risk",
  "resumePriority",
];
const GROUP_VALUES = {
  recency: ["inProgress", "done", "forgotten", "closed"],
  workType: [
    "feature",
    "bugfix",
    "refactor",
    "investigation",
    "docs",
    "tests",
    "chore",
    "__unclassified__",
  ],
  disposition: [
    "shipped",
    "completed",
    "blocked",
    "waiting",
    "superseded",
    "deadEnd",
    "abandoned",
    "__unclassified__",
  ],
  risk: [
    "editsWithoutTests",
    "scopeCreep",
    "contextBloat",
    "clean",
    "__unclassified__",
  ],
  resumePriority: ["high", "medium", "low", "__unclassified__"],
};
const TRIAGE_ENUMS = {
  workType: GROUP_VALUES.workType.slice(0, -1),
  disposition: GROUP_VALUES.disposition.slice(0, -1),
  risk: GROUP_VALUES.risk.slice(0, -1),
  resumePriority: GROUP_VALUES.resumePriority.slice(0, -1),
};
const API_TIMEOUT_MS = 8_000;
const MAX_TEXT = 500;
const ATTENTION_WINDOW_MS = 3 * 86_400_000;
const WORK_GRAPH_HEADER = { "X-KanbanViz-Work-Graph": "1" };

const objectSchema = (properties, required = []) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const optionalRepository = {
  type: "string",
  minLength: 1,
  maxLength: 256,
};
const limitSchema = (maximum, defaultValue) => ({
  type: "integer",
  minimum: 1,
  maximum,
  default: defaultValue,
});

function compactText(value, max = MAX_TEXT) {
  if (typeof value !== "string") return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 3)}...`;
}

function dateValue(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function inputOf(ctx) {
  return ctx.input && typeof ctx.input === "object" && !Array.isArray(ctx.input)
    ? ctx.input
    : {};
}

function assertKeys(input, allowed, required = []) {
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new CanvasError("kanbanviz_invalid_action_input", "Action input contains unknown fields.");
  }
  for (const key of required) {
    if (input[key] === undefined || input[key] === null || input[key] === "") {
      throw new CanvasError("kanbanviz_invalid_action_input", `'${key}' is required.`);
    }
  }
}

function assertString(value, name, { max = 256, optional = false } = {}) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max || value.trim().length === 0) {
    throw new CanvasError("kanbanviz_invalid_action_input", `'${name}' is invalid.`);
  }
  return value.trim();
}

function assertLimit(value, maximum, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new CanvasError("kanbanviz_invalid_action_input", `'limit' must be 1-${maximum}.`);
  }
  return value;
}

function insightMap(insights) {
  const map = new Map();
  for (const insight of Array.isArray(insights) ? insights : []) {
    const scope = typeof insight?.scope === "string"
      ? insight.scope.toLowerCase()
      : insight?.scope;
    if (scope === "session" && typeof insight.scopeKey === "string") {
      map.set(insight.scopeKey, insight);
    }
  }
  return map;
}

function repositoryMatches(left, right) {
  return (
    typeof left === "string"
    && left.toLowerCase() === right.toLowerCase()
  );
}

async function apiJson(fetchImpl, baseUrl, path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetchImpl(new URL(path, baseUrl), {
      ...options,
      signal: controller.signal,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(options.headers ?? {}),
      },
    });
    if (!response.ok) {
      throw new CanvasError(
        "kanbanviz_api_error",
        `KanbanViz API ${path} returned HTTP ${response.status}.`,
      );
    }
    return await response.json();
  } catch (error) {
    if (error instanceof CanvasError) throw error;
    throw new CanvasError(
      "kanbanviz_api_unavailable",
      controller.signal.aborted
        ? `KanbanViz API ${path} timed out.`
        : `KanbanViz API ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function loadSessionsAndInsights(fetchImpl, baseUrl, includeDelegated = false) {
  const query = includeDelegated ? "?includeDelegated=true" : "";
  const [sessions, insights] = await Promise.all([
    apiJson(fetchImpl, baseUrl, `/api/sessions${query}`),
    apiJson(fetchImpl, baseUrl, "/api/insights/continuous"),
  ]);
  return {
    sessions: Array.isArray(sessions) ? sessions : [],
    insights: insightMap(insights),
  };
}

function compactCard(card, insight) {
  return {
    id: card.id,
    repository: card.repository ?? null,
    summary: compactText(card.summary, 240),
    status: card.status,
    activity: card.activity,
    updatedAt: card.updatedAt ?? null,
    headline: compactText(insight?.payload?.headline, 240),
    priority: insight?.payload?.priority ?? null,
    nextAction: compactText(insight?.payload?.nextAction, 300),
  };
}

function laneFor(card, dimension, insight) {
  if (dimension === "recency") return card.status;
  if (dimension === "disposition" && card.completedAt) return "completed";
  const value = insight?.payload?.[dimension];
  return GROUP_VALUES[dimension].includes(value) ? value : "__unclassified__";
}

function contextFor(ctx, getInstance) {
  const instance = getInstance(ctx.instanceId);
  if (!instance) {
    throw new CanvasError(
      "kanbanviz_canvas_instance_closed",
      "This KanbanViz Canvas instance is no longer open.",
    );
  }
  return instance;
}

async function buildBrief(
  sessionId,
  { fetchImpl, baseUrl, shared = null },
) {
  const common = shared ?? await (async () => {
    const [{ sessions, insights }, reports] = await Promise.all([
      loadSessionsAndInsights(fetchImpl, baseUrl, true),
      apiJson(fetchImpl, baseUrl, "/api/insights/deep/summaries"),
    ]);
    return {
      sessions,
      insights,
      reports: Array.isArray(reports) ? reports : [],
    };
  })();

  const [detail] = await Promise.all([
    apiJson(fetchImpl, baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}`),
  ]);
  const card = common.sessions.find((item) => item.id === sessionId);
  const insight = common.insights.get(sessionId);
  const report = common.reports.find((item) => {
    const scope = typeof item?.scope === "string"
      ? item.scope.toLowerCase()
      : item?.scope;
    return scope === "session" && item.scopeKey === sessionId;
  });

  return {
    id: detail.id,
    repository: detail.repository ?? null,
    summary: compactText(detail.summary, 300),
    branch: compactText(detail.branch, 160),
    status: detail.status,
    activity: card?.activity ?? null,
    createdAt: detail.createdAt ?? null,
    updatedAt: detail.updatedAt ?? null,
    completedAt: detail.completedAt ?? null,
    attention: insight?.payload
      ? {
          headline: compactText(insight.payload.headline, 300),
          priority: insight.payload.priority ?? null,
          summary: compactText(insight.payload.summary, 500),
        }
      : null,
    nextAction: compactText(insight?.payload?.nextAction, 400),
    recentActivity: (card?.recentActivity ?? []).slice(-3).reverse().map((event) => ({
      source: compactText(event.source, 40),
      message: compactText(event.message, 300),
      time: event.time ?? null,
    })),
    counts: {
      turns: Number.isInteger(detail.turnCount) ? detail.turnCount : 0,
      files: Number.isInteger(detail.fileCount) ? detail.fileCount : 0,
      checkpoints: Number.isInteger(detail.checkpointCount) ? detail.checkpointCount : 0,
    },
    refs: (Array.isArray(detail.refs) ? detail.refs : []).slice(0, 3).map((ref) => ({
      type: compactText(ref.refType, 40),
      value: compactText(ref.refValue, 300),
    })),
    filePaths: (Array.isArray(detail.files) ? detail.files : [])
      .slice(-5)
      .reverse()
      .map((file) => compactText(file.filePath, 400))
      .filter(Boolean),
    report: report
      ? {
          status: report.status,
          generatedAt: report.generatedAt ?? null,
          recommendationCount: report.recommendationCount ?? 0,
          topIssue: compactText(report.topIssue, 300),
          trackingCount: report.trackingCount ?? 0,
          improvedCount: report.improvedCount ?? 0,
        }
      : null,
  };
}

export function createCanvasActions({
  getInstance,
  baseUrl = "http://127.0.0.1:5364",
  fetchImpl = fetch,
}) {
  return [
    {
      name: "get_canvas_context",
      description:
        "Get the current view and selection for this exact KanbanViz Canvas instance. "
        + "Check availability before relying on UI context.",
      inputSchema: objectSchema({}),
      handler: (ctx) => {
        assertKeys(inputOf(ctx), []);
        const state = contextFor(ctx, getInstance).contextState;
        return state.available
          ? { available: true, ...state.context }
          : { available: false, reason: state.reason };
      },
    },
    {
      name: "get_attention_queue",
      description:
        "List recent open sessions whose latest conversation activity came from Copilot and needs user attention.",
      inputSchema: objectSchema({
        repository: optionalRepository,
        limit: limitSchema(10, 5),
      }),
      handler: async (ctx) => {
        const input = inputOf(ctx);
        assertKeys(input, ["repository", "limit"]);
        const repository = assertString(
          input.repository,
          "repository",
          { optional: true },
        );
        const limit = assertLimit(input.limit, 10, 5);
        const { sessions, insights } = await loadSessionsAndInsights(fetchImpl, baseUrl);
        const now = Date.now();
        const eligible = sessions
          .filter((card) =>
            (!repository || repositoryMatches(card.repository, repository))
            && card.status !== "done"
            && card.status !== "closed"
            && card.recentActivity?.at(-1)?.source?.toLowerCase() === "copilot"
            && now - dateValue(card.updatedAt) <= ATTENTION_WINDOW_MS)
          .sort((left, right) => dateValue(right.updatedAt) - dateValue(left.updatedAt));
        return {
          repository: repository ?? null,
          total: eligible.length,
          items: eligible.slice(0, limit).map(
            (card) => compactCard(card, insights.get(card.id)),
          ),
        };
      },
    },
    {
      name: "get_running_sessions",
      description: "List recent KanbanViz sessions whose live activity is working.",
      inputSchema: objectSchema({
        repository: optionalRepository,
        limit: limitSchema(10, 5),
      }),
      handler: async (ctx) => {
        const input = inputOf(ctx);
        assertKeys(input, ["repository", "limit"]);
        const repository = assertString(
          input.repository,
          "repository",
          { optional: true },
        );
        const limit = assertLimit(input.limit, 10, 5);
        const { sessions, insights } = await loadSessionsAndInsights(fetchImpl, baseUrl);
        const eligible = sessions
          .filter((card) =>
            (!repository || repositoryMatches(card.repository, repository))
            && card.activity === "working")
          .sort((left, right) => dateValue(right.updatedAt) - dateValue(left.updatedAt));
        return {
          repository: repository ?? null,
          total: eligible.length,
          items: eligible.slice(0, limit).map(
            (card) => compactCard(card, insights.get(card.id)),
          ),
        };
      },
    },
    {
      name: "get_repository_board",
      description:
        "Read one repository board grouped exactly like the KanbanViz UI, including lane counts and bounded cards from one lane.",
      inputSchema: objectSchema({
        repository: optionalRepository,
        groupDimension: { type: "string", enum: GROUP_DIMENSIONS },
        lane: { type: "string", minLength: 1, maxLength: 64 },
        limit: limitSchema(12, 12),
      }, ["repository", "groupDimension"]),
      handler: async (ctx) => {
        const input = inputOf(ctx);
        assertKeys(
          input,
          ["repository", "groupDimension", "lane", "limit"],
          ["repository", "groupDimension"],
        );
        const repository = assertString(input.repository, "repository");
        if (!GROUP_DIMENSIONS.includes(input.groupDimension)) {
          throw new CanvasError("kanbanviz_invalid_action_input", "Unknown group dimension.");
        }
        const requestedLane = assertString(
          input.lane,
          "lane",
          { optional: true, max: 64 },
        );
        const limit = assertLimit(input.limit, 12, 12);
        const allowedLanes = GROUP_VALUES[input.groupDimension];
        if (requestedLane && !allowedLanes.includes(requestedLane)) {
          throw new CanvasError(
            "kanbanviz_invalid_action_input",
            `'${requestedLane}' is not a lane in ${input.groupDimension}.`,
          );
        }

        const { sessions, insights } = await loadSessionsAndInsights(fetchImpl, baseUrl);
        const repositoryCards = sessions.filter(
          (card) => repositoryMatches(card.repository, repository),
        );
        const grouped = new Map(allowedLanes.map((lane) => [lane, []]));
        for (const card of repositoryCards) {
          grouped.get(laneFor(card, input.groupDimension, insights.get(card.id))).push(card);
        }
        const selectedLane = requestedLane
          ?? allowedLanes.find((lane) => grouped.get(lane).length > 0)
          ?? allowedLanes[0];
        const selectedCards = grouped.get(selectedLane)
          .sort((left, right) => dateValue(right.updatedAt) - dateValue(left.updatedAt));
        return {
          repository,
          groupDimension: input.groupDimension,
          totalSessions: repositoryCards.length,
          lanes: allowedLanes.map((lane) => ({
            lane,
            count: grouped.get(lane).length,
          })),
          selectedLane,
          selectedLaneTotal: selectedCards.length,
          cards: selectedCards.slice(0, limit).map(
            (card) => compactCard(card, insights.get(card.id)),
          ),
        };
      },
    },
    {
      name: "get_repository_graph",
      description:
        "Read one repository Work Graph with top-level sessions, typed relationships, bounded evidence, and current indexing/AI freshness.",
      inputSchema: objectSchema({
        repository: optionalRepository,
        nodeLimit: limitSchema(200, 100),
        edgeLimit: limitSchema(500, 200),
      }, ["repository"]),
      handler: async (ctx) => {
        const input = inputOf(ctx);
        assertKeys(
          input,
          ["repository", "nodeLimit", "edgeLimit"],
          ["repository"],
        );
        const repository = assertString(input.repository, "repository");
        const nodeLimit = assertLimit(input.nodeLimit, 200, 100);
        const edgeLimit = assertLimit(input.edgeLimit, 500, 200);
        const graph = await apiJson(
          fetchImpl,
          baseUrl,
          `/api/work-graph?key=${encodeURIComponent(repository)}`,
        );
        const allNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
        const allEdges = Array.isArray(graph.edges) ? graph.edges : [];
        const nodes = [...allNodes]
          .sort((left, right) => dateValue(right.updatedAt) - dateValue(left.updatedAt))
          .slice(0, nodeLimit);
        const nodeIds = new Set(nodes.map((node) => node.id));
        const edges = allEdges
          .filter((edge) =>
            nodeIds.has(edge.sourceSessionId)
            && nodeIds.has(edge.targetSessionId))
          .slice(0, edgeLimit);
        return {
          repository: graph.repository ?? repository,
          state: graph.state ?? null,
          totalNodes: allNodes.length,
          totalEdges: allEdges.length,
          nodesTruncated: nodes.length < allNodes.length,
          edgesTruncated: edges.length < allEdges.length,
          warnings: Array.isArray(graph.warnings)
            ? graph.warnings.slice(0, 10).map((warning) => compactText(warning, 300))
            : [],
          nodes: nodes.map((node) => ({
            id: node.id,
            summary: compactText(node.summary, 240),
            branch: compactText(node.branch, 160),
            status: node.status,
            createdAt: node.createdAt ?? null,
            updatedAt: node.updatedAt ?? null,
            completedAt: node.completedAt ?? null,
          })),
          edges: edges.map((edge) => ({
            id: edge.id,
            sourceSessionId: edge.sourceSessionId,
            targetSessionId: edge.targetSessionId,
            relationships: (Array.isArray(edge.relationships) ? edge.relationships : [])
              .map((relationship) => ({
                kind: relationship.kind,
                origin: relationship.origin,
                confidence: relationship.confidence,
                summary: compactText(relationship.summary, 300),
                generatedAt: relationship.generatedAt ?? null,
                evidence: (Array.isArray(relationship.evidence)
                  ? relationship.evidence
                  : [])
                  .slice(0, 10)
                  .map((evidence) => ({
                    type: compactText(evidence.type, 80),
                    label: compactText(evidence.label, 120),
                    detail: compactText(evidence.detail, 400),
                    sessionIds: Array.isArray(evidence.sessionIds)
                      ? evidence.sessionIds.slice(0, 10)
                      : [],
                  })),
              })),
          })),
        };
      },
    },
    {
      name: "refresh_repository_graph",
      description:
        "Request the same AI Work Graph refresh available in the KanbanViz repository graph UI.",
      inputSchema: objectSchema({
        repository: optionalRepository,
        force: { type: "boolean", default: false },
      }, ["repository"]),
      handler: async (ctx) => {
        const input = inputOf(ctx);
        assertKeys(input, ["repository", "force"], ["repository"]);
        const repository = assertString(input.repository, "repository");
        if (input.force !== undefined && typeof input.force !== "boolean") {
          throw new CanvasError(
            "kanbanviz_invalid_action_input",
            "'force' must be boolean.",
          );
        }
        const graph = await apiJson(
          fetchImpl,
          baseUrl,
          `/api/work-graph/refresh?key=${encodeURIComponent(repository)}&force=${input.force === true}`,
          {
            method: "POST",
            headers: WORK_GRAPH_HEADER,
          },
        );
        return {
          repository: graph.repository ?? repository,
          state: graph.state ?? null,
          nodeCount: Array.isArray(graph.nodes) ? graph.nodes.length : 0,
          edgeCount: Array.isArray(graph.edges) ? graph.edges.length : 0,
          warnings: Array.isArray(graph.warnings)
            ? graph.warnings.slice(0, 10).map((warning) => compactText(warning, 300))
            : [],
        };
      },
    },
    {
      name: "get_session_brief",
      description:
        "Get a bounded session brief with identity, attention, recent activity, counts, refs, files, and saved report summary. Never returns raw turns or logs.",
      inputSchema: objectSchema({
        sessionId: { type: "string", minLength: 1, maxLength: 128 },
      }, ["sessionId"]),
      handler: async (ctx) => {
        const input = inputOf(ctx);
        assertKeys(input, ["sessionId"], ["sessionId"]);
        const sessionId = assertString(input.sessionId, "sessionId", { max: 128 });
        return buildBrief(sessionId, { fetchImpl, baseUrl });
      },
    },
    {
      name: "search_sessions",
      description:
        "Run deterministic local KanbanViz full-text search with optional exact repository, triage, date, and delegated-session filters.",
      inputSchema: objectSchema({
        query: { type: "string", minLength: 1, maxLength: 512 },
        repository: optionalRepository,
        workType: { type: "string", enum: TRIAGE_ENUMS.workType },
        disposition: { type: "string", enum: TRIAGE_ENUMS.disposition },
        risk: { type: "string", enum: TRIAGE_ENUMS.risk },
        resumePriority: { type: "string", enum: TRIAGE_ENUMS.resumePriority },
        updatedAfter: { type: "string", format: "date" },
        updatedBefore: { type: "string", format: "date" },
        includeDelegated: { type: "boolean", default: false },
        limit: limitSchema(10, 10),
      }, ["query"]),
      handler: async (ctx) => {
        const input = inputOf(ctx);
        const fields = [
          "query",
          "repository",
          "workType",
          "disposition",
          "risk",
          "resumePriority",
          "updatedAfter",
          "updatedBefore",
          "includeDelegated",
          "limit",
        ];
        assertKeys(input, fields, ["query"]);
        const query = assertString(input.query, "query", { max: 512 });
        const repository = assertString(
          input.repository,
          "repository",
          { optional: true },
        );
        for (const name of ["workType", "disposition", "risk", "resumePriority"]) {
          if (input[name] !== undefined && !TRIAGE_ENUMS[name].includes(input[name])) {
            throw new CanvasError("kanbanviz_invalid_action_input", `'${name}' is invalid.`);
          }
        }
        for (const name of ["updatedAfter", "updatedBefore"]) {
          if (
            input[name] !== undefined
            && (
              typeof input[name] !== "string"
              || !/^\d{4}-\d{2}-\d{2}$/.test(input[name])
            )
          ) {
            throw new CanvasError("kanbanviz_invalid_action_input", `'${name}' is invalid.`);
          }
        }
        if (
          input.includeDelegated !== undefined
          && typeof input.includeDelegated !== "boolean"
        ) {
          throw new CanvasError(
            "kanbanviz_invalid_action_input",
            "'includeDelegated' must be boolean.",
          );
        }
        const limit = assertLimit(input.limit, 10, 10);
        const requestBody = {
          ftsText: query,
          repository: repository ?? null,
          workType: input.workType ?? null,
          disposition: input.disposition ?? null,
          risk: input.risk ?? null,
          resumePriority: input.resumePriority ?? null,
          updatedAfter: input.updatedAfter ?? null,
          updatedBefore: input.updatedBefore ?? null,
          includeDelegated: input.includeDelegated ?? false,
        };
        const response = await apiJson(fetchImpl, baseUrl, "/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        });
        const results = Array.isArray(response?.results) ? response.results : [];
        return {
          query,
          total: results.length,
          weakResults: Boolean(response?.weakResults),
          results: results.slice(0, limit).map((result) => ({
            id: result.id,
            repository: result.repository ?? null,
            summary: compactText(result.summary, 240),
            status: result.status,
            updatedAt: result.updatedAt ?? null,
            isDelegated: Boolean(result.isDelegated),
            workType: result.workType ?? null,
            disposition: result.disposition ?? null,
            risk: result.risk ?? null,
            resumePriority: result.resumePriority ?? null,
            matches: (Array.isArray(result.matches) ? result.matches : [])
              .slice(0, 3)
              .map((match) => ({
                sourceType: compactText(match.sourceType, 50),
                snippet: compactText(match.snippet, 280),
              })),
          })),
        };
      },
    },
    {
      name: "compare_sessions",
      description:
        "Compare two to four unique KanbanViz sessions using bounded session briefs.",
      inputSchema: objectSchema({
        sessionIds: {
          type: "array",
          minItems: 2,
          maxItems: 4,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 128 },
        },
      }, ["sessionIds"]),
      handler: async (ctx) => {
        const input = inputOf(ctx);
        assertKeys(input, ["sessionIds"], ["sessionIds"]);
        if (
          !Array.isArray(input.sessionIds)
          || input.sessionIds.length < 2
          || input.sessionIds.length > 4
          || new Set(input.sessionIds).size !== input.sessionIds.length
          || input.sessionIds.some(
            (id) => typeof id !== "string" || id.length === 0 || id.length > 128,
          )
        ) {
          throw new CanvasError(
            "kanbanviz_invalid_action_input",
            "'sessionIds' must contain 2-4 unique session ids.",
          );
        }
        const sessionIds = input.sessionIds.map((id) => id.trim());
        if (
          sessionIds.some((id) => id.length === 0)
          || new Set(sessionIds).size !== sessionIds.length
        ) {
          throw new CanvasError(
            "kanbanviz_invalid_action_input",
            "'sessionIds' must contain 2-4 unique session ids.",
          );
        }
        const [{ sessions, insights }, reports] = await Promise.all([
          loadSessionsAndInsights(fetchImpl, baseUrl, true),
          apiJson(fetchImpl, baseUrl, "/api/insights/deep/summaries"),
        ]);
        const shared = {
          sessions,
          insights,
          reports: Array.isArray(reports) ? reports : [],
        };
        const briefs = await Promise.all(sessionIds.map(
          (sessionId) => buildBrief(
            sessionId,
            { fetchImpl, baseUrl, shared },
          ),
        ));
        return {
          rows: briefs.map((brief) => ({
            id: brief.id,
            repository: brief.repository,
            summary: brief.summary,
            status: brief.status,
            activity: brief.activity,
            updatedAt: brief.updatedAt,
            priority: brief.attention?.priority ?? null,
            headline: brief.attention?.headline ?? null,
            nextAction: brief.nextAction,
            counts: brief.counts,
            report: brief.report,
          })),
        };
      },
    },
    {
      name: "focus_canvas",
      description:
        "Focus this Canvas instance on an overview, repository board, repository graph, all-repositories work-graph, session, search, or board lane.",
      inputSchema: objectSchema({
        target: {
          type: "string",
          enum: ["overview", "repository", "graph", "work-graph", "session", "search", "lane"],
        },
        repository: { ...optionalRepository, type: ["string", "null"] },
        sessionId: { type: "string", minLength: 1, maxLength: 128 },
        groupDimension: { type: "string", enum: GROUP_DIMENSIONS },
        lane: { type: "string", minLength: 1, maxLength: 64 },
        searchScope: { type: "string", enum: ["repository", "all", "smart"] },
        query: { type: "string", maxLength: 512 },
      }, ["target"]),
      handler: (ctx) => {
        const input = inputOf(ctx);
        assertKeys(input, [
          "target",
          "repository",
          "sessionId",
          "groupDimension",
          "lane",
          "searchScope",
          "query",
        ], ["target"]);
        const instance = contextFor(ctx, getInstance);
        const current = instance.contextState.available
          ? instance.contextState.context
          : null;
        const command = { target: input.target };

        if (input.target === "work-graph") {
          instance.updateContext({
            view: "work-graph",
            repository: null,
            sessionId: null,
          });
        } else if (input.target === "repository" || input.target === "graph") {
          const repository = input.repository ?? current?.repository;
          const normalizedRepository = assertString(repository, "repository");
          command.repository = normalizedRepository;
          instance.updateContext({
            view: "repository",
            repository: normalizedRepository,
            repositoryMode: input.target === "graph" ? "graph" : "board",
            sessionId: null,
          });
        } else if (input.target === "session") {
          const sessionId = assertString(input.sessionId, "sessionId", { max: 128 });
          const repository = input.repository === null
            ? null
            : assertString(
                input.repository,
                "repository",
                { optional: true },
              );
          command.sessionId = sessionId;
          if (input.repository !== undefined) command.repository = repository;
          instance.updateContext({
            view: "session",
            sessionId,
            ...(input.repository !== undefined ? { repository } : {}),
          });
        } else if (input.target === "search") {
          if (
            input.searchScope !== undefined
            && !["repository", "all", "smart"].includes(input.searchScope)
          ) {
            throw new CanvasError(
              "kanbanviz_invalid_action_input",
              "Unknown search scope.",
            );
          }
          if (
            input.query !== undefined
            && (typeof input.query !== "string" || input.query.length > 512)
          ) {
            throw new CanvasError(
              "kanbanviz_invalid_action_input",
              "'query' is invalid.",
            );
          }
          const repository = input.repository === null
            ? null
            : assertString(
                input.repository,
                "repository",
                { optional: true },
              );
          command.searchScope = input.searchScope ?? current?.searchScope ?? "all";
          command.query = input.query?.trim() ?? current?.searchQuery ?? "";
          if (input.repository !== undefined) command.repository = repository;
          instance.updateContext({
            view: "search",
            searchScope: command.searchScope,
            searchQuery: command.query,
            ...(input.repository !== undefined
              ? { searchRepository: repository }
              : {}),
          });
        } else if (input.target === "lane") {
          const repository = input.repository ?? current?.repository;
          const dimension = input.groupDimension ?? current?.groupDimension;
          const normalizedRepository = assertString(repository, "repository");
          if (!GROUP_DIMENSIONS.includes(dimension)) {
            throw new CanvasError(
              "kanbanviz_invalid_action_input",
              "A valid group dimension is required.",
            );
          }
          const lane = assertString(input.lane, "lane", { max: 64 });
          if (!GROUP_VALUES[dimension].includes(lane)) {
            throw new CanvasError(
              "kanbanviz_invalid_action_input",
              `'${lane}' is not a lane in ${dimension}.`,
            );
          }
          Object.assign(command, {
            repository: normalizedRepository,
            groupDimension: dimension,
            lane,
          });
          instance.updateContext({
            view: "repository",
            repository: normalizedRepository,
            groupDimension: dimension,
            activeLane: lane,
            sessionId: null,
          });
        } else if (input.target === "overview") {
          instance.updateContext({ view: "overview", sessionId: null });
        } else {
          throw new CanvasError("kanbanviz_invalid_action_input", "Unknown focus target.");
        }

        instance.broadcastFocus(command);
        return { success: true, command };
      },
    },
  ];
}
