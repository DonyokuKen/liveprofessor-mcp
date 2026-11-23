#!/usr/bin/env node
/*
 * Mock LiveProfessor for testing liveprofessor-mcp without the real app.
 * Listens on UDP 50055 (LP input port), sends feedback to 127.0.0.1:50056.
 * Logs every received OSC address to stdout, one per line, prefixed RX.
 */
"use strict";

const osc = require("osc");

const port = new osc.UDPPort({
  localAddress: "0.0.0.0",
  localPort: 50055,
  remoteAddress: "127.0.0.1",
  remotePort: 50056,
  metadata: true,
});

port.on("ready", () => console.log("MOCK-READY"));

port.on("message", (msg) => {
  console.log(`RX ${msg.address} ${msg.args.map((a) => a.value).join(" ")}`.trim());
  if (msg.address === "/StatusPoll") {
    port.send({ address: "/DSPmeter", args: [{ type: "f", value: 0.42 }] });
  } else if (msg.address === "/GlobalSnapshots/Refresh") {
    ["Intro", "Worship Set", "Sermon"].forEach((name, i) => {
      port.send({
        address: "/GlobalSnapshots/Name",
        args: [
          { type: "s", value: name },
          { type: "i", value: i },
        ],
      });
    });
  } else if (msg.address === "/ViewSets/Refresh") {
    ["Main", "Rehearsal"].forEach((name, i) => {
      port.send({
        address: "/ViewSets/Update",
        args: [
          { type: "s", value: name },
          { type: "i", value: i },
        ],
      });
    });
  }
});

port.open();
