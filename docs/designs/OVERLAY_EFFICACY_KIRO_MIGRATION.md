# Overlay-efficacy harness on Kiro: decision doc

**Status:** Decision. Pick a path before implementation. Recommends **Path A**
(construct full system prompt, feed via custom agent config) with a deferred,
low-cost re-evaluation of Path B (measure via Kiro modes) once the Kiro-port
lands and one real dataset exists on the new client.

**Issue:** `gsk-9p0.4`
**Referenced in:** `docs/designs/KIRO_CLI_SCRIPTABLE_INTERFACE.md` §4 gap #2,
§2 row `options.systemPrompt`.
**Implementation follow-up:** filed as a new bead after this decision lands.

---

## TL;DR

- The design doc's original recommendation (**Path B: migrate measurement to
  Kiro modes**) was premised on modes being a distinct "user-facing overlay
  mechanism" that sits on top of an agent's prompt. Closer reading of the ACP
  transcript in §3 shows this is **not accurate**: in Kiro, `availableModes` is
  literally the agent list (`gpu-dev`, `gastown`, ...). "Modes" and "agents"
  are the same object, surfaced twice.
- That collapses the philosophical argument for Path B. The choice reduces to
  "build one agent with our full prompt (A)" vs "build N pre-registered agents
  and switch between them with `current_mode_update` (B)". B is just A with
  extra indirection.
- **Pick Path A.** It preserves the existing overlay-efficacy measurement
  semantics (overlay text is the only variable across arms), keeps the fixture
  table intact, and fits in the `kiro-acp-client.ts` port planned in
  `KIRO_CLI_SCRIPTABLE_INTERFACE.md` §5 without new infrastructure.
- The overlay-on/overlay-off A/B gets **a new baseline** (Claude-Code preset
  append vs Kiro agent prompt are not the same base) but the fixture definitions
  and pass/fail predicates stay unchanged.
- Path B is not dead. It becomes a follow-on "does switching modes mid-session
  actually shift behavior?" experiment if and when mode-switching becomes a
  first-class gstack feature on Kiro. Today it isn't.

---

## 1. Context

`test/skill-e2e-overlay-harness.test.ts` runs an A/B measurement:

- **overlay-on arm:** `systemPrompt: { type: 'preset', preset: 'claude_code', append: <overlay> }`
- **overlay-off arm:** `systemPrompt: ""` (empty)

The measurement is "does appending the overlay text to Claude Code's real system
prompt change behavior on this fixture?" — fanout, bash-vs-tool, effort-match,
literal-scope, etc. Each fixture in `test/fixtures/overlay-nudges.ts` declares a
metric and a pass predicate; ~10 trials per arm, ~$20/run at current fixture
count.

The harness is the "is gstack earning its overlay tokens?" measurement stick.
Results feed back into overlay text revisions.

On Kiro (via `kiro-cli acp`), `systemPrompt: { type: 'preset', preset:
'claude_code', append }` does not exist. Kiro's surface is:

- **Agent config** has a `.prompt` string field (per-agent full system prompt).
- **Session** has a `currentModeId` and `availableModes`. Mid-session, the
  agent can emit a `session/update { current_mode_update }` notification or
  the client can switch modes.

§4 gap #2 of the scriptable-interface design doc offered two paths:

- **Path A:** Build the full system prompt string ourselves and feed via a
  custom agent config. Mechanical port.
- **Path B:** Switch measurement to Kiro's native "modes" system. Doc
  recommended B with the reasoning "modes are Kiro's user-facing overlay
  mechanism — philosophically the correct measurement target for Kiro-first
  gstack."

---

## 2. The collapsed premise

Re-reading the live transcript in §3 of the scriptable-interface doc:

```text
>>> session/new cwd=/tmp mcpServers=[]
<<< id=2 result.sessionId=d1cf288c-...
    result.modes.currentModeId=gpu-dev
    result.modes.availableModes=[{id:"gastown",...}, ...]  // global agent list
```

The `availableModes` list is the user's **agent list**. `gpu-dev` and `gastown`
are agent configs at `~/.kiro/agents/*.json`. There is no separate "mode
overlay" layer in Kiro — the session's "mode" IS the active agent, and
switching modes IS switching agents.

`session/update { current_mode_update }` is how Kiro informs the client that
the active agent changed (via user `/agent` slash command, or programmatic
switch). It is not a layered append-to-existing-prompt primitive.

This invalidates the philosophical argument for Path B. "Modes are Kiro's
user-facing overlay mechanism" is false as stated. Modes are Kiro's
user-facing **agent selector**. There is no overlay layer to measure.

Once that premise falls, Path B reduces to the following concrete shape:

> Pre-register two agent configs per overlay fixture — one with our full
> system prompt embedded as `.prompt`, one with the empty string — then flip
> between them either via `--agent` at session start or via `current_mode_update`
> mid-session.

That is **the same construction as Path A** (we build the full prompt ourselves
either way), plus extra filesystem plumbing (write agent configs to
`~/.kiro/agents/` before each run, clean up after), plus a decision about
whether to switch at session-start (no different from A) or mid-session (which
raises new questions we have no reason to answer yet — see §4).

---

## 3. Why Path A

1. **It preserves the measurement.** The overlay-on/overlay-off contract is
   "overlay text is the only variable." Under Path A we construct the full
   system prompt from (a) the Kiro base prompt we pick as our baseline, plus
   (b) the overlay text. The arm diff is still exactly the overlay text. Under
   Path B with pre-registered agent configs, the diff is also exactly the
   overlay text — but the configs live on disk and the test has to manage
   their lifecycle. Same signal, more moving parts.

2. **The port stays cheap.** `KIRO_CLI_SCRIPTABLE_INTERFACE.md` §5 estimates
   ~350 lines for the ACP client + ~200 for types + ~100 for handlers. Path A
   adds zero to that — the runner just constructs a prompt string and stuffs
   it into `session/new`'s embedded agent config. Path B adds a
   `test/helpers/kiro-agent-registry.ts` or similar plus the Path A machinery
   anyway (because we still have to construct the full prompt to register in
   the first place).

3. **Fixtures don't move.** Every entry in `OVERLAY_FIXTURES` stays exactly as
   written — `setupWorkspace`, `userPrompt`, `metric`, `pass`, `trials`. The
   harness loop stays exactly as written. `runAgentSdkTest` swaps the
   `systemPrompt: SystemPromptOption` field for a `prompt: string` that the
   Kiro client embeds in the session's agent config.

4. **`AgentSdkResult` shape survives.** §5 already calls this out as a design
   goal — same field names across the port so `toSkillTestResult` and fixtures
   don't churn.

5. **Path B is recoverable.** If six months from now we want to measure
   mid-session mode switching as a real gstack feature (e.g. a `/mode polite`
   slash command), we can add a new harness for that without disturbing the
   overlay-efficacy one. Path A does not close any door.

### 3a. The baseline question

The existing overlay-efficacy benchmark data was measured with the overlay-off
arm at `systemPrompt: ""` — i.e. **no system prompt at all** under the Claude
Agent SDK, which in practice means the SDK's own defaults applied.

On Kiro, the overlay-off arm becomes "agent with `.prompt = ""`". Whether this
produces the same bare-baseline behavior as Claude Agent SDK with empty
`systemPrompt` is an open empirical question. The honest answer: **we are
starting a new baseline.** Model family is different, binary is different,
tool layer is different. The previous fanout/bash-count/turns-used numbers
belong to the Claude-Code-era harness. Keep them for history; do not compare
across harnesses.

This is true under Path B too — Kiro agents have different base behavior than
Claude Code regardless of which mechanism we use to inject overlay text. The
baseline reset is a cost of the Kiro migration itself, not of Path A
specifically.

### 3b. Kiro modes API stability

The ACP protocol is Zed's public schema plus Kiro's `_kiro.dev/*` extensions.
`modes.currentModeId`, `modes.availableModes`, and `current_mode_update` are
part of the **standard ACP surface** (not `_kiro.dev/`-prefixed), so they are
as stable as ACP itself. Zed publishes the schema and uses it in production
for Claude Code and Gemini integrations.

This means Path B would not be blocked on API instability. The case against
Path B is not "Kiro might remove modes"; it is "modes don't give us the
measurement Path B claimed they did."

---

## 4. Open questions resolved

From the bead description:

**Q1: Does the existing overlay-efficacy benchmark data survive the
measurement-methodology change, or do we start a new baseline?**

New baseline, regardless of A or B (see §3a). The binary, model family, and
base prompt all change when we move from Claude Agent SDK to Kiro ACP. Path A
does not make this worse. Archive the current harness transcripts under
`~/.gstack-dev/evals/overlay-harness-claude-era/` before the port; don't
delete them, but don't compare across the boundary either.

**Q2: How stable is Kiro's modes API?**

Stable (see §3b). Not a blocker for either path. The answer does not change
the recommendation.

**Q3: Does Path B require infra (new eval harness helpers) that would dwarf
the port savings from Path A?**

Modestly, yes. Path B needs:
- A per-fixture agent-config writer/cleaner (writes to `~/.kiro/agents/<test-agent>.json`
  before each trial, removes after).
- A decision about session-start vs mid-session switching. Mid-session
  introduces a "was the prompt actually active before the first tool call?"
  question we do not want to answer in a measurement harness.
- A rename in the test output and `EvalCollector` surface ("overlay" vs
  "mode"), which cascades into transcript dir names, eval-store keys, and
  `tools/eval-compare` scripts. Not huge, but nonzero.

None of that is prohibitive, but it is new infrastructure in exchange for a
measurement that is semantically identical to Path A.

---

## 5. Decision

**Path A.** Implementation plan (for the follow-up bead):

1. In the new `lib/kiro-acp-client.ts` (from `KIRO_CLI_SCRIPTABLE_INTERFACE.md`
   §5), expose a `createAgentConfig({ prompt, tools, allowedTools, model }):
   AgentConfig` helper that produces an in-memory agent config object matching
   Kiro's JSON schema. No filesystem writes.

2. In `test/helpers/agent-sdk-runner.ts` (to be renamed or replaced by
   `kiro-acp-runner.ts`), replace the `systemPrompt: SystemPromptOption`
   field of `RunAgentSdkOptions` with `systemPrompt: string` (no preset
   tagged union — just the resolved string). Callers pass:
   - overlay-on arm: the overlay text (passed as the full `.prompt`).
   - overlay-off arm: empty string.
   The runner embeds this as the agent's `.prompt` via `session/new`'s agent
   config parameter.

3. Keep `AgentSdkResult` shape identical. Keep `runAgentSdkTest` signature
   compatible. Fixtures in `OVERLAY_FIXTURES` do not change.

4. In `test/skill-e2e-overlay-harness.test.ts`:
   - Drop `resolveClaudeBinary` / `SystemPromptOption` imports.
   - Replace the `systemPrompt: { type: 'preset', preset: 'claude_code', append: <x> }`
     construction with `systemPrompt: <x>`.
   - Update the harness docstring to reflect the new baseline (overlay vs
     no-prompt on Kiro, not overlay vs Claude-Code preset).
   - Bump `transcripts/` dir prefix to `overlay-harness-kiro-` so old and new
     eras don't commingle.

5. Leave the overlay files under `model-overlays/` unchanged. The resolver
   `scripts/resolvers/model-overlay.ts` stays as-is — the content is
   harness-agnostic.

6. Archive the Claude-era harness output directory per §4 Q1 before the
   first Kiro run.

**Path B is not taken now.** File a separate low-priority bead if mode
switching becomes a first-class gstack feature on Kiro and we want a harness
to measure its effect. That harness would be NEW, not a migration — it would
measure "does mid-session `current_mode_update` actually shift the model?",
which is a different question from overlay efficacy.

---

## 6. Out of scope

- Whether the overlay-efficacy harness should exist at all post-migration.
  (Assumed yes — the fixtures encode real gstack guarantees and the measurement
  is cheap at $20/run.)
- Whether to port overlay content to Kiro-native idioms (e.g. replace
  Claude-Code-specific tool names like `Bash` / `Read` with Kiro names like
  `shell` / `read`). **Yes, but separate bead** — a `grep -r` on the overlays
  under `model-overlays/` should drive that work and it is mechanical.
- Renaming `agent-sdk-runner` → `kiro-acp-runner`. Cosmetic; happens naturally
  in the §5 port.
- Metric definitions (`bashToolCallCount`, `turnsToCompletion`,
  `uniqueFilesEdited`). These operate on `AgentSdkResult.toolCalls` /
  `.turnsUsed` which the Kiro port preserves. The name `Bash` inside
  `bashToolCallCount` becomes slightly quaint once Kiro ships `shell` as the
  tool name; fix in the same port.

---

## 7. Follow-up work

- **New bead:** "Port overlay-efficacy harness to Kiro ACP (Path A)" — blocks
  on `kiro-acp-client.ts` from `KIRO_CLI_SCRIPTABLE_INTERFACE.md` §5.
- **New bead (optional, low priority):** "Measure mid-session
  `current_mode_update` efficacy on Kiro" — file only if mode switching
  becomes a gstack-owned user-facing feature.
- **Existing bead:** overlay content uses Claude-Code tool names
  (`Bash`, `Read`, `Edit`, ...). After the port, audit overlays for
  Kiro-native rewrites. Should probably be its own bead since it touches
  prose, not infra.

---

## Appendix: the philosophical argument, stated precisely

The design doc's original pitch for Path B:

> modes are Kiro's user-facing overlay mechanism — philosophically the correct
> measurement target for Kiro-first gstack.

Sharpened against reality: in Kiro, "the user's user-facing overlay
mechanism" is **the agent config itself**. `/agent mine` at the REPL swaps
the whole system prompt to the `.prompt` of the selected agent. There is no
separate overlay-on-top-of-agent layer.

The measurement target question becomes: **what part of a gstack user's
configuration are we measuring the efficacy of?**

- If we are measuring **gstack overlay text efficacy** (the current
  harness's purpose): Path A. The variable is overlay text. Injection
  mechanism is irrelevant as long as it is consistent across arms. `.prompt`
  works.
- If we are measuring **gstack-as-a-switchable-mode efficacy** (a
  hypothetical future feature): a new harness. The variable is "did mode N
  get activated at the right moment and did it change behavior thereafter?".
  Not this bead.

The two are different experiments with different nulls and different
hypotheses. Path B conflated them, because the design doc treated "modes"
as a distinct API surface from "agents" when they are in fact the same
surface. Split them, take A today, revisit mode switching as its own
experiment if it becomes a real feature.
