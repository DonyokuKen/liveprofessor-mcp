# liveprofessor-mcp

**Donyoku** · MCP server for LiveProfessor

MCP server that lets an AI agent (Antigravity, Claude, etc.) control
**LiveProfessor** (Audiostrom live plugin host) through LiveProfessor's
built-in OSC control surface.

## Tools

| Tool | What it does |
| --- | --- |
| `lp_status` | Connectivity check + DSP load (sends `/StatusPoll`, reads `/DSPmeter`) |
| `lp_list_snapshots` | List global snapshots |
| `lp_recall_snapshot` | Recall a global snapshot by name or zero-based index |
| `lp_update_active_snapshot` | Update the active global snapshot |
| `lp_recall_cue` | Recall a cue by number/name, optional cue list |
| `lp_next_cue` / `lp_previous_cue` / `lp_stop_all_cues` | Cue list transport |
| `lp_list_viewsets` / `lp_recall_viewset` | View sets |
| `lp_transport` | Start/stop transport, return to zero, tap tempo |
| `lp_midi_panic` | All notes off |
| `lp_send_osc` | Raw OSC escape hatch (for controller-mapped parameters) |

Recall/transport commands are fire-and-forget (LiveProfessor sends no ack
for them). Status and list tools wait for LiveProfessor's feedback.

## LiveProfessor setup (once)

1. Open **Controllers > OSC Setup** (or Options > Project Options > Osc Control).
2. Enable OSC control.
3. **Input Port:** `50055` (LiveProfessor listens here; the bridge sends here)
4. **Output Port:** `50056` (LiveProfessor sends feedback here; the bridge listens here)

If LiveProfessor runs on a different machine than the MCP server, set
`LP_HOST` to that machine's IP and make sure LiveProfessor's feedback
goes to the MCP machine's IP on port 50056.

## Install (on the PC with Antigravity)

1. Copy this folder to the PC, e.g. `C:\Users\<user>\liveprofessor-mcp`.
2. In that folder: `npm install`
3. Add to Antigravity's `mcp_config.json`
   (`C:\Users\<user>\.gemini\config\mcp_config.json`):

```json
"liveprofessor": {
  "command": "node",
  "args": ["C:\\Users\\<user>\\liveprofessor-mcp\\index.js"],
  "env": {
    "LP_HOST": "127.0.0.1",
    "LP_PORT": "50055",
    "LP_FEEDBACK_PORT": "50056"
  }
}
```

4. Restart Antigravity's language_server so it reloads the config.
5. In Antigravity, ask the agent to run `lp_status`. It should report
   the DSP load. If it times out, re-check the OSC setup above and
   that LiveProfessor is running with a project open.

Write `mcp_config.json` **without BOM** (Antigravity's parser chokes on
BOM). Back up the file before editing.

## Environment variables

| Var | Default | Meaning |
| --- | --- | --- |
| `LP_HOST` | `127.0.0.1` | LiveProfessor machine |
| `LP_PORT` | `50055` | LiveProfessor OSC input port |
| `LP_FEEDBACK_PORT` | `50056` | Port this bridge listens on for feedback |
| `LP_TIMEOUT_MS` | `1500` | Reply wait for status/list tools |

## Tests

- `npm run test:codec` — OSC encode/decode for every message (no network).
- `npm test` — full end-to-end against a mock LiveProfessor
  (`mock-liveprofessor.js`): MCP initialize, tools/list, and tool calls
  with OSC round-trip. Needs working UDP (run it on the PC).

## Author

**Donyoku**

## Notes

- Plugin-level parameters are controlled through LiveProfessor's
  **Hardware Controllers Setup** mapping: map a parameter to an OSC
  address there, then drive it with `lp_send_osc`.
