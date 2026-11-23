#!/usr/bin/env node
/*
 * liveprofessor-mcp — Donyoku
 * MCP server for LiveProfessor (Audiostrom live plugin host).
 *
 * Bridges MCP tool calls to LiveProfessor's OSC control surface (UDP).
 * LiveProfessor side: enable OSC (Controllers > OSC Setup, or
 * Options > Project Options > Osc Control), Input Port 50055,
 * Output Port 50056 (this bridge listens there for feedback).
 *
 * Env:
 *   LP_HOST           LiveProfessor machine (default 127.0.0.1)
 *   LP_PORT           LiveProfessor OSC input port (default 50055)
 *   LP_FEEDBACK_PORT  Port this bridge listens on for LP feedback (default 50056)
 *   LP_TIMEOUT_MS     Reply wait for status/list tools (default 1500)
 */
"use strict";

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const osc = require("osc");

const LP_HOST = process.env.LP_HOST || "127.0.0.1";
const LP_PORT = parseInt(process.env.LP_PORT || "50055", 10);
const FEEDBACK_PORT = parseInt(process.env.LP_FEEDBACK_PORT || "50056", 10);
const TIMEOUT_MS = parseInt(process.env.LP_TIMEOUT_MS || "1500", 10);

const udpPort = new osc.UDPPort({
  localAddress: "0.0.0.0",
  localPort: FEEDBACK_PORT,
  remoteAddress: LP_HOST,
  remotePort: LP_PORT,
  metadata: true,
});

let portReady = false;
const pendingWaiters = []; // {address, collect, resolve, timer, quietTimer, messages}

udpPort.on("ready", () => {
  portReady = true;
});

udpPort.on("message", (msg) => {
  for (let i = pendingWaiters.length - 1; i >= 0; i--) {
    const w = pendingWaiters[i];
    if (msg.address === w.address) {
      w.messages.push(msg);
      if (!w.collect) {
        finishWaiter(i);
      } else {
        // Collection mode: resolve after a short quiet period.
        clearTimeout(w.quietTimer);
        w.quietTimer = setTimeout(() => finishWaiter(pendingWaiters.indexOf(w)), 300);
      }
    }
  }
});

udpPort.on("error", (err) => {
  console.error(`[liveprofessor-mcp] UDP error: ${err.message}`);
});

function finishWaiter(idx) {
  if (idx < 0 || idx >= pendingWaiters.length) return;
  const [w] = pendingWaiters.splice(idx, 1);
  clearTimeout(w.timer);
  clearTimeout(w.quietTimer);
  w.resolve(w.messages);
}

function sendOsc(address, args = []) {
  udpPort.send({ address, args });
}

/*
 * Send an OSC message and wait for replies on `replyAddress`.
 * collect=false: resolve on first reply. collect=true: gather until quiet.
 * Resolves with [] on timeout.
 */
function sendAndWait(address, args, replyAddress, collect) {
  return new Promise((resolve) => {
    const waiter = {
      address: replyAddress,
      collect,
      resolve,
      messages: [],
      quietTimer: null,
      timer: setTimeout(() => finishWaiter(pendingWaiters.indexOf(waiter)), TIMEOUT_MS),
    };
    pendingWaiters.push(waiter);
    sendOsc(address, args);
  });
}

function noReplyText(what) {
  return (
    `No reply from LiveProfessor at ${LP_HOST}:${LP_PORT} for ${what} within ${TIMEOUT_MS}ms. ` +
    `Check: LiveProfessor is running, OSC is enabled (Controllers > OSC Setup, or Options > Project Options > Osc Control), ` +
    `Input Port = ${LP_PORT}, Output Port = ${FEEDBACK_PORT}.`
  );
}

function fmtArgs(msg) {
  if (!msg.args || msg.args.length === 0) return "(no args)";
  return msg.args.map((a) => String(a.value)).join(", ");
}

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

const server = new McpServer({ name: "liveprofessor", version: "1.0.0" });

server.tool(
  "lp_status",
  "Check LiveProfessor connectivity and DSP load. Sends /StatusPoll and reports the DSP meter value LiveProfessor returns.",
  {},
  async () => {
    const replies = await sendAndWait("/StatusPoll", [], "/DSPmeter", false);
    if (replies.length === 0) return textResult(noReplyText("status poll"), true);
    const v = replies[0].args && replies[0].args[0] ? replies[0].args[0].value : null;
    const pct = typeof v === "number" ? `${(v * 100).toFixed(1)}%` : String(v);
    return textResult(`LiveProfessor reachable at ${LP_HOST}:${LP_PORT}. DSP load: ${pct} (raw ${v}).`);
  }
);

server.tool(
  "lp_list_snapshots",
  "List LiveProfessor global snapshots (asks LiveProfessor to send back all snapshot names).",
  {},
  async () => {
    const replies = await sendAndWait("/GlobalSnapshots/Refresh", [], "/GlobalSnapshots/Name", true);
    if (replies.length === 0) return textResult(noReplyText("snapshot list"), true);
    const lines = replies.map((m, i) => `${i}: ${fmtArgs(m)}`);
    return textResult(`Global snapshots (${replies.length}):\n${lines.join("\n")}`);
  }
);

server.tool(
  "lp_recall_snapshot",
  "Recall a LiveProfessor global snapshot by name (preferred) or by zero-based index.",
  {
    name: z.string().optional().describe("Snapshot name"),
    index: z.number().int().min(0).optional().describe("Zero-based snapshot index (0 = first)"),
  },
  async ({ name, index }) => {
    if (name === undefined && index === undefined) {
      return textResult("Provide either name or index.", true);
    }
    if (name !== undefined) {
      sendOsc("/GlobalSnapshots/Recall", [{ type: "s", value: name }]);
      return textResult(`Sent snapshot recall by name: "${name}".`);
    }
    sendOsc("/GlobalSnapshots/Recall", [{ type: "i", value: index }]);
    return textResult(`Sent snapshot recall by index: ${index} (zero-based).`);
  }
);

server.tool(
  "lp_update_active_snapshot",
  "Update the currently active LiveProfessor global snapshot with the current state.",
  {},
  async () => {
    sendOsc("/Command/GlobalSnapshots/UpdateActiveGlobalSnapshot", []);
    return textResult("Sent: update active global snapshot.");
  }
);

server.tool(
  "lp_recall_cue",
  "Recall a cue in LiveProfessor by cue number or name, optionally within a specific cue list.",
  {
    cue: z.string().describe("Cue number or cue name"),
    list: z.string().optional().describe("Cue list number/name (optional)"),
  },
  async ({ cue, list }) => {
    const args = list !== undefined
      ? [{ type: "s", value: list }, { type: "s", value: cue }]
      : [{ type: "s", value: cue }];
    sendOsc("/Cue/Recall", args);
    return textResult(`Sent cue recall: ${list !== undefined ? `list "${list}", ` : ""}cue "${cue}".`);
  }
);

server.tool("lp_next_cue", "Fire the next cue in LiveProfessor's cue list.", {}, async () => {
  sendOsc("/Command/CueLists/FireNextCue", []);
  return textResult("Sent: fire next cue.");
});

server.tool("lp_previous_cue", "Fire the previous cue in LiveProfessor's cue list.", {}, async () => {
  sendOsc("/Command/CueLists/FirePreviousCue", []);
  return textResult("Sent: fire previous cue.");
});

server.tool("lp_stop_all_cues", "Stop all running cues in LiveProfessor.", {}, async () => {
  sendOsc("/Command/CueLists/StopAllCues", []);
  return textResult("Sent: stop all cues.");
});

server.tool(
  "lp_list_viewsets",
  "List LiveProfessor view sets (asks LiveProfessor to send back all view set updates).",
  {},
  async () => {
    const replies = await sendAndWait("/ViewSets/Refresh", [], "/ViewSets/Update", true);
    if (replies.length === 0) return textResult(noReplyText("view set list"), true);
    const lines = replies.map((m, i) => `${i}: ${fmtArgs(m)}`);
    return textResult(`View sets (${replies.length}):\n${lines.join("\n")}`);
  }
);

server.tool(
  "lp_recall_viewset",
  "Recall a LiveProfessor view set by zero-based index.",
  { index: z.number().int().min(0).describe("Zero-based view set index (0 = first)") },
  async ({ index }) => {
    sendOsc("/ViewSets/Recall", [{ type: "i", value: index }]);
    return textResult(`Sent view set recall: index ${index} (zero-based).`);
  }
);

server.tool(
  "lp_transport",
  "LiveProfessor transport control: start_stop toggles transport, return_to_zero returns to zero, tap_tempo taps the tempo.",
  {
    action: z.enum(["start_stop", "return_to_zero", "tap_tempo"]).describe("Transport action"),
  },
  async ({ action }) => {
    const map = {
      start_stop: "/Command/Transport&Tempo/StartStopTransport",
      return_to_zero: "/Command/Transport&Tempo/ReturnToZero",
      tap_tempo: "/Command/Transport&Tempo/TempoTap",
    };
    sendOsc(map[action], []);
    return textResult(`Sent transport action: ${action}.`);
  }
);

server.tool("lp_midi_panic", "Send MIDI panic (all notes off) in LiveProfessor.", {}, async () => {
  sendOsc("/Command/General/MIDIPanic", []);
  return textResult("Sent: MIDI panic.");
});

server.tool(
  "lp_send_osc",
  "Escape hatch: send a raw OSC message to LiveProfessor. Use for controller-mapped parameters or commands not covered by the other tools.",
  {
    address: z.string().describe("OSC address, e.g. /Command/CueLists/GoToTop"),
    args: z
      .array(
        z.object({
          type: z.enum(["i", "f", "s"]).describe("OSC arg type: i=int, f=float, s=string"),
          value: z.union([z.number(), z.string()]).describe("Arg value"),
        })
      )
      .optional()
      .describe("OSC arguments"),
  },
  async ({ address, args }) => {
    sendOsc(address, args || []);
    return textResult(`Sent OSC: ${address} ${(args || []).map((a) => a.value).join(" ")}`.trim());
  }
);

async function main() {
  udpPort.open();
  // Give the UDP socket a moment to bind before serving.
  await new Promise((r) => setTimeout(r, 200));
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[liveprofessor-mcp] ready. LP ${LP_HOST}:${LP_PORT}, feedback listen :${FEEDBACK_PORT}, udpReady=${portReady}`
  );
}

main().catch((err) => {
  console.error(`[liveprofessor-mcp] fatal: ${err.message}`);
  process.exit(1);
});
