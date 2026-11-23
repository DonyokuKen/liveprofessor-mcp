#!/usr/bin/env node
/*
 * End-to-end test for liveprofessor-mcp:
 * starts the mock LiveProfessor, spawns the MCP server over stdio,
 * runs initialize + tools/list + several tools/call, asserts results.
 * Exit code 0 = all passed.
 */
"use strict";

const { spawn } = require("child_process");
const path = require("path");

const dir = __dirname;
let failures = 0;

function check(name, cond, detail = "") {
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name} ${detail}`);
  }
}

function startMock() {
  return new Promise((resolve) => {
    const mock = spawn("node", [path.join(dir, "mock-liveprofessor.js")], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const rx = [];
    mock.stdout.on("data", (d) => {
      const s = d.toString();
      s.split("\n").forEach((line) => {
        if (line.startsWith("RX ")) rx.push(line.trim());
      });
      if (s.includes("MOCK-READY")) resolve({ mock, rx });
    });
    mock.stderr.on("data", (d) => process.stderr.write(`[mock] ${d}`));
  });
}

function startServer() {
  const proc = spawn("node", [path.join(dir, "index.js")], {
    env: {
      ...process.env,
      LP_HOST: "127.0.0.1",
      LP_PORT: "50055",
      LP_FEEDBACK_PORT: "50056",
      LP_TIMEOUT_MS: "1500",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

  let buffer = "";
  const waiters = new Map();
  proc.stdout.on("data", (d) => {
    buffer += d.toString();
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && waiters.has(msg.id)) {
          waiters.get(msg.id)(msg);
          waiters.delete(msg.id);
        }
      } catch (e) {
        /* ignore non-JSON */
      }
    }
  });

  let nextId = 1;
  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      waiters.set(id, resolve);
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => reject(new Error(`timeout on ${method}`)), 8000);
    });
  }
  function notify(method, params) {
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  return { proc, request, notify };
}

function toolText(resp) {
  const c = resp.result && resp.result.content && resp.result.content[0];
  return c ? c.text : "";
}

(async () => {
  const { mock, rx } = await startMock();
  const { proc, request, notify } = startServer();
  await new Promise((r) => setTimeout(r, 500));

  try {
    const init = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    });
    check("initialize", !!init.result, JSON.stringify(init).slice(0, 200));
    notify("notifications/initialized", {});

    const tools = await request("tools/list", {});
    const names = (tools.result.tools || []).map((t) => t.name);
    const expected = [
      "lp_status",
      "lp_list_snapshots",
      "lp_recall_snapshot",
      "lp_update_active_snapshot",
      "lp_recall_cue",
      "lp_next_cue",
      "lp_previous_cue",
      "lp_stop_all_cues",
      "lp_list_viewsets",
      "lp_recall_viewset",
      "lp_transport",
      "lp_midi_panic",
      "lp_send_osc",
    ];
    check(
      "tools/list has all 13 tools",
      expected.every((n) => names.includes(n)),
      `got: ${names.join(",")}`
    );

    const status = await request("tools/call", { name: "lp_status", arguments: {} });
    check("lp_status DSP 42.0%", toolText(status).includes("42.0%"), toolText(status));

    const snaps = await request("tools/call", { name: "lp_list_snapshots", arguments: {} });
    const snapText = toolText(snaps);
    check(
      "lp_list_snapshots returns 3",
      snapText.includes("Intro") && snapText.includes("Worship Set") && snapText.includes("Sermon"),
      snapText
    );

    const views = await request("tools/call", { name: "lp_list_viewsets", arguments: {} });
    check("lp_list_viewsets returns 2", toolText(views).includes("Main"), toolText(views));

    await request("tools/call", {
      name: "lp_recall_snapshot",
      arguments: { name: "Worship Set" },
    });
    await request("tools/call", { name: "lp_next_cue", arguments: {} });
    await request("tools/call", {
      name: "lp_recall_cue",
      arguments: { cue: "2", list: "1" },
    });
    await request("tools/call", { name: "lp_transport", arguments: { action: "tap_tempo" } });
    await new Promise((r) => setTimeout(r, 400));

    check(
      "mock received snapshot recall by name",
      rx.some((l) => l.startsWith("RX /GlobalSnapshots/Recall") && l.includes("Worship Set")),
      rx.join(" | ")
    );
    check(
      "mock received fire next cue",
      rx.some((l) => l.includes("/Command/CueLists/FireNextCue")),
      rx.join(" | ")
    );
    check(
      "mock received cue recall list+cue",
      rx.some((l) => l.startsWith("RX /Cue/Recall") && l.includes("1 2")),
      rx.join(" | ")
    );
    check(
      "mock received tempo tap",
      rx.some((l) => l.includes("/Command/Transport&Tempo/TempoTap")),
      rx.join(" | ")
    );
  } catch (err) {
    failures++;
    console.log(`FAIL exception: ${err.message}`);
  } finally {
    proc.kill();
    mock.kill();
  }

  console.log(failures === 0 ? "ALL TESTS PASSED" : `${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
