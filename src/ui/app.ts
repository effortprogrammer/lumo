import React from "react";
import { Box, Newline, Text } from "ink";
import { type UiTaskSnapshot } from "../runtime/sample-task.js";

export function LumoApp(props: { snapshot: UiTaskSnapshot }): unknown {
  const { pairing, actorLogs, supervisorDecisions } = props.snapshot;
  const { task } = pairing;

  return React.createElement(
    Box,
    {
      flexDirection: "column",
      borderStyle: "round",
      borderColor: "cyan",
      paddingX: 1,
      paddingY: 0,
    },
    React.createElement(Text, { bold: true }, `Task: ${pairing.context.instruction.text}`),
    React.createElement(
      Text,
      null,
      `Supervisor: ${task.supervisor.model}`,
    ),
    React.createElement(
      Text,
      null,
      `Status: ${task.status} | Step: ${task.currentStep}/? | Last update: ${task.lastUpdatedAt}`,
    ),
    React.createElement(Newline, null),
    React.createElement(Text, { bold: true }, "Actor Log"),
    ...actorLogs.map((log) =>
      React.createElement(
        Text,
        { key: `log-${log.step}` },
        `[${log.timestamp}] ${log.tool}: ${log.input}${
          log.screenshotRef ? ` [screenshot:${log.screenshotRef.id}]` : ""
        }`,
      ),
    ),
    React.createElement(Newline, null),
    React.createElement(Text, { bold: true }, "Supervisor"),
    ...supervisorDecisions.map((decision, index) =>
      React.createElement(
        Text,
        { key: `decision-${index}` },
        `${decision.status.toUpperCase()} (${decision.confidence.toFixed(2)}): ${decision.reason}`,
      ),
    ),
    React.createElement(Newline, null),
    React.createElement(Text, { dimColor: true }, "Controls: [p]ause  [k]ill  [q]uit"),
    React.createElement(Text, { dimColor: true }, "Pane placeholders: alerts | screenshots | human input"),
  );
}
