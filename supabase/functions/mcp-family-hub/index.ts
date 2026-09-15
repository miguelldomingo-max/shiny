// MCP (Model Context Protocol) server for the Domingo Family Hub.
//
// Exposes the same data the family-hub web app reads/writes in Supabase
// (the `hub_data` table's 4 boards, plus the `allowed_emails` access list)
// as MCP tools, so a Claude Chat conversation can be added as a custom
// connector and read/update this data directly.
//
// Auth: every request must carry `Authorization: Bearer <MCP_SHARED_SECRET>`
// matching the Edge Function secret of the same name — this endpoint is
// public on the internet, so this bearer token is the only thing standing
// between anyone and full read/write access to the family's data. It uses
// the service_role key internally (bypasses RLS) because the token check
// above is what makes that safe.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MCP_SHARED_SECRET = Deno.env.get("MCP_SHARED_SECRET")!;

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const BOARD_KEYS = [
  "listboard:mika-private-school-apps",
  "projecttracker:mika-private-school-apps",
  "checklist:household-todos",
  "listboard:travel-tracker",
] as const;

const BOARD_DESCRIPTIONS: Record<string, string> = {
  "listboard:mika-private-school-apps":
    "School applications key-dates board. JSON array of items: " +
    "{id, school, destination (title), start, end (YYYY-MM-DD), approx (bool), " +
    "status ('researching'|'planning'|'confirmed'|'break'), notes, link, " +
    "itinerary (array, usually []), itinSource}.",
  "projecttracker:mika-private-school-apps":
    "School applications project tracker. JSON array of phases: " +
    "{id, name, items: [{id, label, done (bool), tag}]}.",
  "checklist:household-todos":
    "Household to-dos. JSON array of phases: {id, name, items: " +
    "[{id, label, done (bool), notes, dueDate (YYYY-MM-DD or '')}]}.",
  "listboard:travel-tracker":
    "Travel tracker. JSON array of trips: {id, destination, start, end " +
    "(YYYY-MM-DD), approx (bool), status ('researching'|'planning'|" +
    "'confirmed'|'break'), notes, itinerary (array of {day, label, " +
    "stops: [{time, title, detail}]}), itinSource}.",
};

const TOOLS = [
  {
    name: "list_boards",
    description: "List the family hub's data boards (keys) with a description of each one's JSON shape.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_board",
    description: "Get the full current JSON content of one board.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string", enum: BOARD_KEYS } },
      required: ["key"],
    },
  },
  {
    name: "update_board",
    description:
      "Replace a board's full JSON content (same as how the web app saves). " +
      "Fetch it with get_board first, modify the array, and pass the whole " +
      "thing back — this is a full replace, not a merge.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", enum: BOARD_KEYS },
        value: { description: "The full new JSON array for this board." },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "list_allowed_emails",
    description: "List the email addresses currently allowed to log into the family hub app.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "add_allowed_email",
    description: "Grant access to the family hub app to another email address (they still need a login account created in Supabase separately).",
    inputSchema: {
      type: "object",
      properties: { email: { type: "string" } },
      required: ["email"],
    },
  },
  {
    name: "remove_allowed_email",
    description: "Revoke a previously-allowed email's access to the family hub app.",
    inputSchema: {
      type: "object",
      properties: { email: { type: "string" } },
      required: ["email"],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case "list_boards": {
      return BOARD_KEYS.map((key) => ({ key, description: BOARD_DESCRIPTIONS[key] }));
    }
    case "get_board": {
      const key = args.key as string;
      if (!BOARD_KEYS.includes(key as (typeof BOARD_KEYS)[number])) throw new Error("Unknown board key: " + key);
      const { data, error } = await sb.from("hub_data").select("value").eq("key", key).maybeSingle();
      if (error) throw error;
      return data ? data.value : null;
    }
    case "update_board": {
      const key = args.key as string;
      if (!BOARD_KEYS.includes(key as (typeof BOARD_KEYS)[number])) throw new Error("Unknown board key: " + key);
      const { error } = await sb
        .from("hub_data")
        .upsert({ key, value: args.value, updated_at: new Date().toISOString() });
      if (error) throw error;
      return { ok: true };
    }
    case "list_allowed_emails": {
      const { data, error } = await sb.from("allowed_emails").select("email").order("added_at");
      if (error) throw error;
      return data.map((r: { email: string }) => r.email);
    }
    case "add_allowed_email": {
      const { error } = await sb.from("allowed_emails").insert({ email: (args.email as string).trim().toLowerCase() });
      if (error) throw error;
      return { ok: true };
    }
    case "remove_allowed_email": {
      const { error } = await sb.from("allowed_emails").delete().eq("email", (args.email as string).trim().toLowerCase());
      if (error) throw error;
      return { ok: true };
    }
    default:
      throw new Error("Unknown tool: " + name);
  }
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version, mcp-session-id, accept",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonRpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  // Accept the shared secret either as a Bearer header (preferred, if the
  // connector UI supports custom headers) or as a `?secret=` query param on
  // the URL itself (fallback, since a URL is the one thing every MCP
  // connector UI lets you configure).
  const authHeader = req.headers.get("authorization") || "";
  const headerToken = authHeader.replace(/^Bearer\s+/i, "");
  const url = new URL(req.url);
  const queryToken = url.searchParams.get("secret") || "";
  const token = headerToken || queryToken;
  if (token !== MCP_SHARED_SECRET) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  let body: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify(jsonRpcError(null, -32700, "Parse error")), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const { id, method, params } = body;

  // Notifications (no id) get no response body.
  if (id === undefined) {
    return new Response(null, { status: 202, headers: CORS_HEADERS });
  }

  try {
    if (method === "initialize") {
      // Echo back whatever protocol version the client asked for rather than
      // pinning one: a client that only speaks a newer revision will refuse
      // to connect if we answer with an older one. This server's surface is
      // just tools/list + tools/call, which is unchanged across revisions.
      const requested = params?.protocolVersion;
      const protocolVersion = typeof requested === "string" && requested ? requested : "2025-06-18";
      return new Response(
        JSON.stringify(
          jsonRpcResult(id, {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "family-hub", version: "1.0.0" },
          }),
        ),
        { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    if (method === "tools/list") {
      return new Response(JSON.stringify(jsonRpcResult(id, { tools: TOOLS })), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    if (method === "tools/call") {
      const name = params?.name as string;
      const args = (params?.arguments as Record<string, unknown>) || {};
      try {
        const result = await callTool(name, args);
        return new Response(
          JSON.stringify(
            jsonRpcResult(id, {
              content: [{ type: "text", text: JSON.stringify(result) }],
            }),
          ),
          { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
        );
      } catch (e) {
        return new Response(
          JSON.stringify(
            jsonRpcResult(id, {
              content: [{ type: "text", text: "Error: " + (e instanceof Error ? e.message : String(e)) }],
              isError: true,
            }),
          ),
          { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
        );
      }
    }

    return new Response(JSON.stringify(jsonRpcError(id, -32601, "Method not found: " + method)), {
      status: 404,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(
      JSON.stringify(jsonRpcError(id, -32603, e instanceof Error ? e.message : String(e))),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }
});
