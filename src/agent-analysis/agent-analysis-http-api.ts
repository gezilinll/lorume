import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthSessionContext } from "../auth/auth-store";
import type { OperationStore } from "../operations/operation-store";
import { createAgentAnalysisRun } from "./agent-analysis-service";
import type { AgentAnalysisStore } from "./agent-analysis-store";

const maxJsonBodyChars = 1_000_000;

export interface AgentAnalysisHttpAuth {
  requireUserSession: (request: IncomingMessage) => Promise<AuthSessionContext | null>;
}

export interface AgentAnalysisHttpApiHandlerOptions {
  agentAnalysisStore: AgentAnalysisStore;
  operationStore: OperationStore;
  requireUserSession: AgentAnalysisHttpAuth["requireUserSession"];
  now?: () => Date;
}

export type AgentAnalysisHttpApiHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) => Promise<void>;

export function createAgentAnalysisHttpApiHandler(
  options: AgentAnalysisHttpApiHandlerOptions,
): AgentAnalysisHttpApiHandler {
  const now = options.now ?? (() => new Date());

  return async function agentAnalysisHttpApiHandler(request, response, next) {
    const requestUrl = new URL(request.url || "/", "http://lorume.local");

    if (request.method === "POST" && requestUrl.pathname === "/api/agent-analysis-runs") {
      const session = await requireSession(request, response, options);
      if (!session) return;
      const body = await readJsonBody(request);
      const record = asRecord(body);
      const organizationId = resolveOrganizationId(requestUrl, record, session);
      if (!ensureOrganizationMember(response, session, organizationId)) return;
      const agentId = readString(record.agentId);
      if (!agentId) {
        sendJson(response, 400, { error: "agent_id_required" });
        return;
      }
      const run = await createAgentAnalysisRun({
        agentAnalysisStore: options.agentAnalysisStore,
        now,
        operationStore: options.operationStore,
      }, {
        agentId,
        organizationId,
        periodEnd: readString(record.periodEnd) || undefined,
        periodStart: readString(record.periodStart) || undefined,
        requestedByUserId: session.user.id,
      });
      if (run.status === "rejected" && run.reason === "invalid_period") {
        sendJson(response, 400, { error: "agent_analysis_period_invalid" });
        return;
      }
      if (run.status === "rejected") {
        sendJson(response, 422, { error: "agent_analysis_unsupported" });
        return;
      }

      sendJson(response, 202, { job: run.job, operation: run.operation });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/agent-analysis-reports") {
      const session = await requireSession(request, response, options);
      if (!session) return;
      const organizationId = resolveOrganizationId(requestUrl, {}, session);
      if (!ensureOrganizationMember(response, session, organizationId)) return;
      const reports = await options.agentAnalysisStore.listReports({
        agentId: readParam(requestUrl, "agentId"),
        limit: readLimit(requestUrl),
        organizationId,
      });
      sendJson(response, 200, { reports });
      return;
    }

    const detailMatch = requestUrl.pathname.match(/^\/api\/agent-analysis-reports\/([^/]+)$/);
    if (request.method === "GET" && detailMatch) {
      const session = await requireSession(request, response, options);
      if (!session) return;
      const organizationId = resolveOrganizationId(requestUrl, {}, session);
      if (!ensureOrganizationMember(response, session, organizationId)) return;
      const reportId = decodeURIComponent(detailMatch[1] ?? "");
      const report = await options.agentAnalysisStore.readReport({ organizationId, reportId });
      if (!report) {
        sendJson(response, 404, { error: "agent_analysis_report_not_found" });
        return;
      }
      sendJson(response, 200, { report });
      return;
    }

    next();
  };
}

async function requireSession(
  request: IncomingMessage,
  response: ServerResponse,
  options: AgentAnalysisHttpApiHandlerOptions,
): Promise<AuthSessionContext | null> {
  const session = await options.requireUserSession(request);
  if (!session) {
    sendJson(response, 401, { error: "unauthorized" });
    return null;
  }
  return session;
}

function resolveOrganizationId(
  requestUrl: URL,
  body: Record<string, unknown>,
  session: AuthSessionContext,
): string {
  return requestUrl.searchParams.get("organizationId")?.trim()
    || readString(body.organizationId)
    || session.organizations[0]?.organizationId
    || "";
}

function ensureOrganizationMember(
  response: ServerResponse,
  session: AuthSessionContext,
  organizationId: string,
): boolean {
  if (!organizationId) {
    sendJson(response, 400, { error: "organization_id_required" });
    return false;
  }
  if (!session.organizations.some((organization) => organization.organizationId === organizationId)) {
    sendJson(response, 403, { error: "forbidden" });
    return false;
  }
  return true;
}

function readParam(requestUrl: URL, key: string): string | undefined {
  const value = requestUrl.searchParams.get(key)?.trim();
  return value || undefined;
}

function readLimit(requestUrl: URL): number | undefined {
  const rawLimit = requestUrl.searchParams.get("limit");
  if (!rawLimit) return undefined;
  const limit = Number(rawLimit);
  return Number.isFinite(limit) ? limit : undefined;
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxJsonBodyChars) reject(new Error("request body too large"));
    });
    request.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
