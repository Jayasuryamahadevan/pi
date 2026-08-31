/**
 * Agent ID Card for pi
 * ====================
 *
 * On first run in a workspace, pi is curious about its surroundings
 * (OS, hardware, accelerator/driver, available tools, its own toolset),
 * and turns what it honestly finds into a signed AIC identity
 * (https://github.com/Jayasuryamahadevan/agent-id-card -- SPEC.md is the
 * normative format; HARNESS_BOOTSTRAP.md is the procedure this
 * extension implements). Every tool call is recorded in an append-only,
 * hash-chained action log. `/aic-status` shows the current card;
 * `/aic-reconcile` catches the card's declared capabilities up to what
 * pi's own toolset actually looks like right now.
 *
 * No external dependency: signing uses Node's built-in `node:crypto`
 * Ed25519 support, proven interoperable with the Python reference
 * verifier -- see NO_PYTHON.md in the agent-id-card repo.
 *
 * State lives in `.aic/` under the project root -- identity.json (the
 * private key, 0600), chain.json, detail.json, sensitive.json,
 * renewal.json, action_log.jsonl, experience.jsonl.
 */

import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { verifyChain } from "./epoch.js";
import { AgentHarness } from "./harness.js";
import { collectRuntimeProvenance, discoverPermissionsAndNetwork } from "./provenance.js";
import { verifyDetail } from "./tiers.js";

const PURPOSE =
	"Coding agent (pi) assisting a developer in this workspace: reads, edits, and runs commands as directed.";

function stateDirFor(ctx: { cwd: string }): string {
	return join(ctx.cwd, ".aic");
}

async function bootstrapIfNeeded(harness: AgentHarness, pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (harness.isBootstrapped) {
		try {
			harness.verifyOwnChain();
			harness.ensureLive();
		} catch (error) {
			ctx.ui.notify(
				`agent-id-card: existing identity failed to verify (${(error as Error).message}); leaving it untouched for inspection.`,
				"error",
			);
		}
		return;
	}

	harness.actionLog.append("environment.discovery_started", { cwd: ctx.cwd });
	const provenance = collectRuntimeProvenance();
	const permissions = discoverPermissionsAndNetwork();
	harness.actionLog.append("environment.discovered", { ...provenance, ...permissions });

	const toolNames = pi.getAllTools().map((tool) => tool.name);
	const knownLimitations = [
		"no memory of this workspace beyond entries already written to .aic/ (session context is not preserved across process restarts unless pi's own session storage is used)",
		"bounded by the active model's context window",
		"can only act through the tools actually registered for this session",
	];
	if (permissions.running_as_root === false)
		knownLimitations.push("not running as root: cannot modify files or ports outside the current user's permissions");
	if (!provenance.hardware || (provenance.hardware as Record<string, unknown>).accelerator === "cpu-only")
		knownLimitations.push("no local accelerator detected on this host");

	const genesis = harness.bootstrap(`pi@${process.env.HOSTNAME ?? "workspace"}`, PURPOSE, toolNames, {
		protocols: [],
		knownLimitations,
		sensitive: {
			modelName: "unknown",
			modelVersion: "unknown",
			hardware: provenance.hardware,
			softwareStack: provenance.software_stack,
		},
	});

	ctx.ui.notify(
		[
			"agent-id-card: bootstrapped a new identity for this workspace.",
			`  agent_id: ${genesis.agent_id}`,
			`  capability_categories: ${genesis.capability_categories.join(", ")}`,
			`  known_limitations: ${knownLimitations.length} recorded`,
			"  state saved under .aic/ -- waiting for instructions.",
		].join("\n"),
		"info",
	);
}

export default function (pi: ExtensionAPI) {
	const harnesses = new Map<string, AgentHarness>();

	function harnessFor(cwd: string): AgentHarness {
		const stateDir = stateDirFor({ cwd });
		let harness = harnesses.get(stateDir);
		if (!harness) {
			harness = new AgentHarness(stateDir, { capabilities: () => pi.getAllTools().map((tool) => tool.name) });
			harnesses.set(stateDir, harness);
		}
		return harness;
	}

	pi.on("session_start", async (_event, ctx) => {
		const harness = harnessFor(ctx.cwd);
		await bootstrapIfNeeded(harness, pi, ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		const harness = harnessFor(ctx.cwd);
		if (harness.isBootstrapped) {
			harness.actionLog.append("tool.invoked", { tool: event.toolName, tool_call_id: event.toolCallId });
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		const harness = harnessFor(ctx.cwd);
		if (harness.isBootstrapped) {
			harness.actionLog.append("tool.completed", {
				tool: event.toolName,
				tool_call_id: event.toolCallId,
				is_error: Boolean(event.isError),
			});
		}
	});

	pi.registerCommand("aic-status", {
		description: "Show this workspace's Agent ID Card and verify its chain.",
		async execute(_args, ctx) {
			const harness = harnessFor(ctx.cwd);
			if (!harness.isBootstrapped) {
				ctx.ui.notify("agent-id-card: no identity yet for this workspace.", "info");
				return;
			}
			try {
				harness.verifyOwnChain();
				const detail = harness.detail;
				if (detail) verifyDetail(detail, harness.currentEpoch);
				const epoch = harness.currentEpoch;
				ctx.ui.notify(
					[
						`agent_id: ${epoch.agent_id}`,
						`epoch: #${epoch.epoch_number} (${epoch.transition})`,
						`purpose: ${epoch.purpose}`,
						`capability_categories: ${epoch.capability_categories.join(", ")}`,
						`declared_capabilities: ${detail?.declared_capabilities.join(", ") ?? "(not disclosed)"}`,
						`known_limitations: ${detail?.known_limitations.join("; ") ?? "(not disclosed)"}`,
						"chain: verified OK",
					].join("\n"),
					"info",
				);
			} catch (error) {
				ctx.ui.notify(`agent-id-card: verification FAILED: ${(error as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("aic-reconcile", {
		description: "Reconcile this workspace's Agent ID Card against recorded experience and pi's current toolset.",
		async execute(_args, ctx) {
			const harness = harnessFor(ctx.cwd);
			if (!harness.isBootstrapped) {
				ctx.ui.notify("agent-id-card: no identity yet for this workspace.", "info");
				return;
			}
			const report = harness.reconcile(true);
			ctx.ui.notify(
				report.changed
					? `agent-id-card: reconciled -> epoch #${report.newEpochNumber}. capabilities: ${report.capabilitiesAfter.join(", ")}`
					: "agent-id-card: nothing to reconcile; the card already matches recorded experience and pi's current toolset.",
				"info",
			);
		},
	});
}

// Re-exported for anything that wants to verify this workspace's chain
// programmatically without going through the CLI/session commands above.
export { verifyChain, AgentHarness };
