#!/usr/bin/env node
/*
 * OSC codec test for liveprofessor-mcp.
 * This VM blocks UDP at the syscall level (send EPERM), so the live
 * round-trip test (test-client.js) can only run on a normal machine.
 * This test verifies every OSC message the bridge sends/receives
 * encodes and decodes correctly with the osc package.
 */
"use strict";

const osc = require("osc");

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name} ${detail}`);
  }
}

function roundTrip(address, args) {
  const buf = osc.writeMessage({ address, args }, { metadata: true });
  const back = osc.readMessage(buf, { metadata: true });
  return back;
}

function argsEqual(a, b) {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    if (x.type !== b[i].type) return false;
    if (x.type === "f") return Math.abs(x.value - b[i].value) < 1e-6; // OSC floats are float32
    return String(x.value) === String(b[i].value);
  });
}

const cases = [
  ["/StatusPoll", []],
  ["/GlobalSnapshots/Refresh", []],
  ["/GlobalSnapshots/Recall", [{ type: "s", value: "Worship Set" }]],
  ["/GlobalSnapshots/Recall", [{ type: "i", value: 2 }]],
  ["/Command/GlobalSnapshots/UpdateActiveGlobalSnapshot", []],
  ["/Cue/Recall", [{ type: "s", value: "2" }]],
  ["/Cue/Recall", [{ type: "s", value: "1" }, { type: "s", value: "2" }]],
  ["/Command/CueLists/FireNextCue", []],
  ["/Command/CueLists/FirePreviousCue", []],
  ["/Command/CueLists/StopAllCues", []],
  ["/ViewSets/Refresh", []],
  ["/ViewSets/Recall", [{ type: "i", value: 0 }]],
  ["/Command/Transport&Tempo/StartStopTransport", []],
  ["/Command/Transport&Tempo/ReturnToZero", []],
  ["/Command/Transport&Tempo/TempoTap", []],
  ["/Command/General/MIDIPanic", []],
  // Feedback messages LiveProfessor sends back:
  ["/DSPmeter", [{ type: "f", value: 0.42 }]],
  ["/GlobalSnapshots/Name", [{ type: "s", value: "Intro" }, { type: "i", value: 0 }]],
  ["/ViewSets/Update", [{ type: "s", value: "Main" }, { type: "i", value: 0 }]],
];

for (const [address, args] of cases) {
  const back = roundTrip(address, args);
  const ok =
    back.address === address &&
    argsEqual(
      back.args.map((a) => ({ type: a.type, value: a.value })),
      args.map((a) => ({ type: a.type, value: a.value }))
    );
  check(`codec ${address} (${args.length} args)`, ok, JSON.stringify(back));
}

// Float precision spot check (DSP meter value the status tool formats).
const dsp = roundTrip("/DSPmeter", [{ type: "f", value: 0.42 }]);
check("DSPmeter float survives", Math.abs(dsp.args[0].value - 0.42) < 1e-6, String(dsp.args[0].value));

console.log(failures === 0 ? "ALL CODEC TESTS PASSED" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
