#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, type GcfConfig } from "./config.js";
import {
  profilePathForRoot,
  readRuntimeConnection,
  readWorkspaceProfile,
  sanitizeWorkspaceProfile,
  type ConnectorMode,
  type TunnelMode,
  type WorkspaceProfile
} from "./profileStore.js";
import { createGcfServer } from "./server.js";
import { gcfBrandMark } from "./gcfBrandMark.js";
import { configuredHttpOrigins, isAllowedHttpOrigin, isAllowedTokenlessHost } from "./httpOriginPolicy.js";

const TUNNELS = ["cloudflare", "none"] as const;
const MODES = ["agent", "handoff", "pro"] as const;
const BASH_MODES = ["safe", "off", "full"] as const;
const BASH_TRANSCRIPTS = ["compact", "full"] as const;
const CODEX_SESSIONS = ["off", "metadata", "read"] as const;
const WRITE_MODES = ["workspace", "handoff", "off"] as const;
const TOOL_MODES = ["standard", "minimal", "full"] as const;

interface ProfileFormValues {
  port: string;
  mode: ConnectorMode;
  tunnel: TunnelMode;
  bash: "off" | "safe" | "full";
  bashTranscript: "compact" | "full";
  codexSessions: "off" | "metadata" | "read";
  codexDir: string;
  bashSession: string;
  requireBashSession: boolean;
  write: "off" | "handoff" | "workspace";
  toolMode: "minimal" | "standard" | "full";
  widgetDomain: string;
  noInstallCloudflared: boolean;
}

function oneOf<T extends readonly string[]>(value: unknown, values: T, fallback: T[number]): T[number] {
  return typeof value === "string" && values.includes(value) ? value : fallback;
}

function envValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

function runtimeTunnelFallback(): TunnelMode {
  const tunnel = envValue("GCF_TUNNEL");
  if (tunnel && TUNNELS.includes(tunnel as TunnelMode)) {
    return tunnel as TunnelMode;
  }
  return envValue("GCF_TUNNEL_MODE") === "0" ? "none" : "cloudflare";
}

function profileValues(config: GcfConfig, profile = readWorkspaceProfile(config.defaultRoot)): ProfileFormValues {
  return {
    port: String(profile.port ?? config.port),
    mode: oneOf(profile.mode ?? envValue("GCF_MODE"), MODES, "agent"),
    tunnel: oneOf(profile.tunnel, TUNNELS, runtimeTunnelFallback()),
    bash: oneOf(profile.bash ?? config.bashMode, BASH_MODES, config.bashMode),
    bashTranscript: oneOf(profile.bashTranscript ?? config.bashTranscript, BASH_TRANSCRIPTS, config.bashTranscript),
    codexSessions: oneOf(profile.codexSessions ?? config.codexSessions, CODEX_SESSIONS, config.codexSessions),
    codexDir: String(profile.codexDir ?? config.codexDir),
    bashSession: String(profile.bashSession ?? config.bashSessionId ?? ""),
    requireBashSession: Boolean(profile.requireBashSession ?? config.requireBashSession),
    write: oneOf(profile.write ?? config.writeMode, WRITE_MODES, config.writeMode),
    toolMode: oneOf(profile.toolMode ?? config.toolMode, TOOL_MODES, config.toolMode),
    widgetDomain: String(profile.widgetDomain ?? config.widgetDomain),
    noInstallCloudflared: Boolean(profile.noInstallCloudflared)
  };
}

function profileResponse(config: GcfConfig): Record<string, unknown> {
  const profile = readWorkspaceProfile(config.defaultRoot);
  const runtime = readRuntimeConnection(config.defaultRoot);
  return {
    ok: true,
    profile_path: profile.profilePath ?? profilePathForRoot(config.defaultRoot),
    exists: Boolean(profile.profilePath),
    profile: sanitizeWorkspaceProfile(profile),
    effective: profileValues(config, profile),
    runtime_connection: runtime,
    runtime: {
      defaultRoot: config.defaultRoot,
      port: config.port,
      bashMode: config.bashMode,
      bashTranscript: config.bashTranscript,
      codexSessions: config.codexSessions,
      writeMode: config.writeMode,
      toolMode: config.toolMode,
      widgetDomain: config.widgetDomain,
      authEnabled: Boolean(config.authToken)
    }
  };
}

function jsonError(res: Response, status: number, code: string, message: string, issues?: unknown): void {
  res.status(status).json({
    ok: false,
    error: { code, message, ...(issues ? { issues } : {}) }
  });
}

const LOCAL_FAVICON = gcfBrandMark;

async function main(): Promise<void> {
  const config = loadConfig();
  if ((config.requireHttpToken || config.httpAuthMode === "header-only") && !config.authToken) {
    throw new Error(
      "GCF_HTTP_TOKEN is required for this HTTP binding. " +
        "Set GCF_HTTP_TOKEN or use `gcf start` to generate one. " +
        (config.httpAuthMode === "header-only"
          ? "Header-only mode never allows missing HTTP credentials."
          : "GCF_ALLOW_NO_HTTP_TOKEN=1 is permitted only for a trusted local-only setup.")
    );
  }

  configuredHttpOrigins(config); // Fail fast on malformed explicit origin configuration.
  const app = express();
  const logRequests = process.env.GCF_LOG_REQUESTS === "1";

  function tokenMatches(value: unknown): boolean {
    if (!config.authToken || typeof value !== "string") return false;
    const expected = Buffer.from(config.authToken);
    const actual = Buffer.from(value);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  const adminRateWindow = new Map<string, { count: number; resetAt: number }>();

  function adminRateLimit(req: Request, res: Response, next: NextFunction): void {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || "local";
    const current = adminRateWindow.get(key);
    if (!current || current.resetAt <= now) {
      adminRateWindow.set(key, { count: 1, resetAt: now + 60_000 });
      next();
      return;
    }
    current.count += 1;
    if (current.count > 30) {
      jsonError(res, 429, "rate_limited", "Too many profile save attempts. Try again in a minute.");
      return;
    }
    next();
  }

  function adminBodyLimit(req: Request, res: Response, next: NextFunction): void {
    const length = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(length) && length > 32_768) {
      jsonError(res, 413, "payload_too_large", "Profile request body is too large.");
      return;
    }
    next();
  }

  app.use((req, res, next) => {
    if (!logRequests) {
      next();
      return;
    }
    const started = Date.now();
    res.on("finish", () => {
      console.error(`[GCF] ${req.method} ${req.path} -> ${res.statusCode} ${Date.now() - started}ms`);
    });
    next();
  });
  // Tokenless local mode must reject DNS-rebinding hosts even without Origin.
  app.use((req, res, next) => {
    if (!config.authToken && !isAllowedTokenlessHost(req.headers.host, config.port)) {
      res.status(403).send("Forbidden Host");
      return;
    }
    next();
  });
  // The Streamable HTTP transport requires rejecting invalid browser Origins.
  // Headerless server-to-server MCP requests continue through normal authentication.
  app.use((req, res, next) => {
    if (req.headers.origin !== undefined &&
        !isAllowedHttpOrigin(req.headers.origin, configuredHttpOrigins(config))) {
      res.status(403).send("Forbidden Origin");
      return;
    }
    next();
  });
  app.use(cors({
    origin: (origin, callback) => callback(null, Boolean(origin)),
    exposedHeaders: ["Mcp-Session-Id"]
  }));
  // This listener may be tunneled: owner control never belongs on the MCP plane.
  app.use((req, res, next) => {
    const route = req.path.toLowerCase();
    if (route === "/owner" || route.startsWith("/owner/") ||
        (route.startsWith("/admin/") && req.method !== "GET")) {
      res.status(403).json({error: {code: "owner_local_policy_required", message: "Owner control is available only through the separate local Control Center / Terminal."}});
      return;
    }
    next();
  });
  app.get("/favicon.ico", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.type("image/svg+xml").send(LOCAL_FAVICON);
  });
  app.use((req, res, next) => {
    if (!config.authToken) {
      next();
      return;
    }
    const bearer = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice("Bearer ".length)
      : undefined;
    const queryToken = typeof req.query.gcf_token === "string"
      ? req.query.gcf_token
      : typeof req.query.gcf_token === "string"
          ? req.query.gcf_token
          : typeof req.query.token === "string"
              ? req.query.token
              : undefined;
    const queryCredentialSupplied = Object.prototype.hasOwnProperty.call(req.query, "gcf_token") ||
      Object.prototype.hasOwnProperty.call(req.query, "gcf_token") ||
      Object.prototype.hasOwnProperty.call(req.query, "token");
    const authorized = config.httpAuthMode === "header-only"
      ? !queryCredentialSupplied && tokenMatches(bearer)
      : tokenMatches(bearer) || tokenMatches(queryToken);
    if (!authorized) {
      res.status(401).send("Unauthorized");
      return;
    }
    next();
  });

  type TransportRecord = {
    transport: StreamableHTTPServerTransport;
    createdAt: number;
    lastSeenAt: number;
  };

  const transports = new Map<string, TransportRecord>();
  const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function closeTransport(record: TransportRecord): void {
    void record.transport.close?.();
  }

  function pruneTransports(): void {
    const now = Date.now();
    for (const [sessionId, record] of transports) {
      if (now - record.lastSeenAt > config.httpSessionTtlMs) {
        transports.delete(sessionId);
        closeTransport(record);
      }
    }
    while (transports.size > config.maxHttpSessions) {
      const oldest = [...transports.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)[0];
      if (!oldest) break;
      transports.delete(oldest[0]);
      closeTransport(oldest[1]);
    }
  }

  function getTransport(sessionId: string | undefined): StreamableHTTPServerTransport | undefined {
    if (!sessionId || !sessionIdPattern.test(sessionId)) return undefined;
    pruneTransports();
    const record = transports.get(sessionId);
    if (!record) return undefined;
    record.lastSeenAt = Date.now();
    return record.transport;
  }

  const pruneTimer = setInterval(pruneTransports, Math.min(config.httpSessionTtlMs, 60_000));
  pruneTimer.unref();

  app.get("/", (_req, res) => {
    res.status(410).json({error:"Legacy Admin retired. Open the local Control Center with npm run gcf:ui."});
  });

  app.get("/setup", (_req, res) => {
    res.status(410).json({error:"Legacy Admin retired. Open the local Control Center with npm run gcf:ui."});
  });

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      name: "GPT Codex Flow",
      defaultRoot: config.defaultRoot,
      allowedRoots: config.allowedRoots,
      bashMode: config.bashMode,
      bashTranscript: config.bashTranscript,
      bashSessionId: config.bashSessionId ?? null,
      requireBashSession: config.requireBashSession,
      codexSessions: config.codexSessions,
      writeMode: config.writeMode,
      toolMode: config.toolMode,
      widgetDomain: config.widgetDomain,
      contextDir: config.contextDir,
      authEnabled: Boolean(config.authToken),
      authRequired: config.requireHttpToken || config.httpAuthMode === "header-only",
      httpAuthMode: config.httpAuthMode,
      clientIdentityVerified: false
    });
  });

  app.get("/admin/profile", (_req, res) => {
    res.json(profileResponse(config));
  });

  app.post("/admin/profile", (_req, res) => {
    jsonError(res, 403, "owner_local_policy_required", "Use owner-local Terminal configuration. MCP credentials cannot authorize owner changes.");
  });

  app.all("/admin/profile", (_req, res) => {
    jsonError(res, 405, "method_not_allowed", "Use GET or POST for /admin/profile.");
  });

  app.post("/mcp", express.json({ limit: "20mb" }), async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      const existingTransport = getTransport(sessionId);
      if (existingTransport) {
        transport = existingTransport;
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId: string) => {
            pruneTransports();
            transports.set(newSessionId, {
              transport,
              createdAt: Date.now(),
              lastSeenAt: Date.now()
            });
            pruneTransports();
          }
        } as any);

        (transport as any).onclose = () => {
          const closedSessionId = (transport as any).sessionId;
          if (closedSessionId) transports.delete(closedSessionId);
        };

        const server = createGcfServer(config);
        await server.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: missing or invalid MCP session id" },
          id: null
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
          id: null
        });
      }
    }
  });

  const handleSessionRequest = async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = getTransport(sessionId);
    if (!transport) {
      res.status(400).send("Invalid or missing MCP session id");
      return;
    }
    await transport.handleRequest(req, res);
  };

  app.get("/mcp", handleSessionRequest);
  app.delete("/mcp", handleSessionRequest);

  app.listen(config.port, config.host, () => {
    console.error(`[GCF] HTTP MCP listening on http://${config.host}:${config.port}/mcp`);
    console.error(`[GCF] defaultRoot=${config.defaultRoot}`);
    console.error(`[GCF] allowedRoots=${config.allowedRoots.join(", ")}`);
    console.error(`[GCF] bashMode=${config.bashMode}`);
    console.error(`[GCF] writeMode=${config.writeMode}`);
    console.error(`[GCF] widgetDomain=${config.widgetDomain}`);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
